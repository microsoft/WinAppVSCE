using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace Surface;

/// <summary>
/// The design-time XAML cleaner (S4 "Layer 1"). Transforms a real project Page / UserControl /
/// ResourceDictionary document — which normally only the XAML compiler can consume — into markup
/// that the runtime <c>XamlReader.Load</c> will accept, WITHOUT changing what it renders.
///
/// It is a proper namespace-aware XML transform over an <see cref="XDocument"/> (XAML *is* XML;
/// attribute order and namespaces are preserved). The rule set (see each <c>// Rule N</c> below):
/// <list type="number">
///   <item>strip <c>x:Class</c> from the root (a Page/UserControl/ResourceDictionary root is then
///     directly constructible);</item>
///   <item>drop <c>{x:Bind ...}</c> attributes (property falls back to its default);</item>
///   <item>remove compiler-only <c>x:</c> directives (FieldModifier, ClassModifier, Load,
///     DeferLoadStrategy, DataType, Uid, Phase) — keeping <c>x:Name</c>/<c>x:Key</c> and
///     <c>x:Null</c>/<c>x:Static</c> references;</item>
///   <item>remove event-handler attributes, detected by resolving the element's CLR type and
///     asking <see cref="Type.GetEvent(string)"/> (per-element, so a property that merely shares a
///     name with an unrelated event is preserved);</item>
///   <item>strip the design namespaces (<c>mc:Ignorable</c>, the <c>mc:</c> markup-compat namespace
///     and everything in the Blend <c>d:</c> namespace), first mapping <c>d:DesignWidth</c>/
///     <c>d:DesignHeight</c> to root <c>Width</c>/<c>Height</c> and any <c>d:*</c> that mirrors a
///     real property to that runtime property so design-time data still renders;</item>
///   <item>optionally drop a <c>{StaticResource}</c>/<c>{ThemeResource}</c> whose key is defined
///     neither in the document nor anywhere in the supplied app scope (belt-and-braces so one bad
///     reference doesn't fail the whole document — the primary resolver is Layer 2).</item>
/// </list>
///
/// It is deliberately DEFENSIVE: it never throws on malformed input. If anything goes wrong it
/// returns the original markup so the render path can surface the real parse error (with original
/// line/column) and keep the server alive.
/// </summary>
internal static class XamlCleaner
{
    // Canonical XAML namespaces.
    private static readonly XNamespace Xaml = "http://schemas.microsoft.com/winfx/2006/xaml";
    private static readonly XNamespace Pres = "http://schemas.microsoft.com/winfx/2006/xaml/presentation";
    private static readonly XNamespace Design = "http://schemas.microsoft.com/expression/blend/2008";
    private static readonly XNamespace Mc = "http://schemas.openxmlformats.org/markup-compatibility/2006";

    /// <summary>Compiler-only directives in the <c>x:</c> namespace that the runtime loader rejects.</summary>
    private static readonly HashSet<string> RemovableXDirectives = new(StringComparer.Ordinal)
    {
        "FieldModifier", "ClassModifier", "Load", "DeferLoadStrategy", "DataType", "Uid", "Phase",
    };

    /// <summary>
    /// CLR namespaces the default presentation xmlns projects onto, in probe order. Used to resolve
    /// an element's <see cref="Type"/> for per-element event detection.
    /// </summary>
    private static readonly string[] WinUiClrNamespaces =
    {
        "Microsoft.UI.Xaml.Controls",
        "Microsoft.UI.Xaml.Controls.Primitives",
        "Microsoft.UI.Xaml",
        "Microsoft.UI.Xaml.Shapes",
        "Microsoft.UI.Xaml.Documents",
        "Microsoft.UI.Xaml.Media",
        "Microsoft.UI.Xaml.Media.Animation",
        "Microsoft.UI.Xaml.Media.Imaging",
        "Microsoft.UI.Xaml.Navigation",
        "Microsoft.UI.Xaml.Automation",
    };

    /// <summary>
    /// Fallback set of common WinUI event names, consulted ONLY when an element's type cannot be
    /// resolved (custom type in an unloaded assembly, typo, etc.). Kept intentionally broad; a false
    /// positive only ever strips an attribute that shares a name with a real WinUI event.
    /// </summary>
    private static readonly HashSet<string> CuratedEventNames = new(StringComparer.Ordinal)
    {
        // Pointer / input
        "Tapped", "DoubleTapped", "RightTapped", "Holding", "PointerPressed", "PointerReleased",
        "PointerMoved", "PointerEntered", "PointerExited", "PointerCanceled", "PointerCaptureLost",
        "PointerWheelChanged", "KeyDown", "KeyUp", "PreviewKeyDown", "PreviewKeyUp",
        "CharacterReceived", "GotFocus", "LostFocus", "ContextRequested", "ContextCanceled",
        "ManipulationStarting", "ManipulationStarted", "ManipulationDelta", "ManipulationInertiaStarting",
        "ManipulationCompleted", "DragStarting", "DropCompleted", "DragEnter", "DragLeave", "DragOver",
        "Drop", "ProcessKeyboardAccelerators",
        // Lifecycle / layout
        "Loaded", "Unloaded", "Loading", "SizeChanged", "LayoutUpdated", "DataContextChanged",
        "ActualThemeChanged", "EffectiveViewportChanged", "BringIntoViewRequested",
        // Button / toggle / selection / input controls
        "Click", "Checked", "Unchecked", "Indeterminate", "Toggled", "SelectionChanged",
        "SelectionChanging", "TextChanged", "TextChanging", "BeforeTextChanging", "ValueChanged",
        "QuerySubmitted", "SuggestionChosen", "TextSubmitted", "DropDownOpened", "DropDownClosed",
        "ItemClick", "ItemInvoked", "Expanding", "Collapsed", "Invoked", "DateChanged",
        "TimeChanged", "SelectedDatesChanged", "ContextMenuOpening",
        // Flyout / dialog / navigation / media
        "Opened", "Closed", "Opening", "Closing", "Completed", "Navigated", "Navigating",
        "MediaEnded", "MediaFailed", "MediaOpened", "ImageOpened", "ImageFailed",
    };

    // Resolved-type cache keyed by full CLR name (value may be null = "known not resolvable").
    private static readonly ConcurrentDictionary<string, Type?> TypeCache = new(StringComparer.Ordinal);

    // The WinUI managed-projection assembly, discovered from a well-known framework type.
    private static readonly Assembly? WinUiAssembly = SafeGetWinUiAssembly();

    private static readonly Regex MarkupExtensionHead =
        new(@"^\{\s*(?:(?<prefix>[\w]+):)?(?<name>[\w]+)\b", RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex ResourceExtension =
        new(@"^\{\s*(?:[\w]+:)?(?:Static|Theme)Resource\s+(?<key>[^}]+?)\s*\}$",
            RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex DesignExtension =
        new(@"^\{\s*[\w]+:Design", RegexOptions.Compiled | RegexOptions.CultureInvariant);

    // Rule 7c: a Converter={StaticResource key} / {ThemeResource key} clause inside a binding, with an
    // optional leading and/or trailing comma so it can be excised from any position in the argument list.
    private static readonly Regex ConverterClause =
        new(@"(?<lead>,\s*)?Converter\s*=\s*\{\s*(?:[\w]+:)?(?:Static|Theme)Resource\s+(?<key>[^}]+?)\s*\}(?<trail>\s*,)?",
            RegexOptions.Compiled | RegexOptions.CultureInvariant);

    /// <summary>
    /// Cleans <paramref name="rawXaml"/> per the rules above. Never throws — returns the original
    /// markup on any failure so the caller's parse-error path still fires with original positions.
    /// </summary>
    /// <param name="rawXaml">The real project XAML document.</param>
    /// <param name="knownResourceKeys">
    /// Keys available in the surface's application resource scope (Layer 2). Supplied so Rule 6 can
    /// tell a genuinely-undefined <c>{StaticResource}</c> from a resolvable one. May be null (Rule 6
    /// then only trusts keys defined inside the document).
    /// </param>
    /// <param name="providerMapsFullName">
    /// Rule 7 (T2) predicate: returns true when the runtime <c>IXamlMetadataProvider</c> chain that
    /// <c>XamlReader.Load</c> consults (<c>Application.Current</c>) maps the given CLR full type name.
    /// This is the EXACT resolver <c>XamlReader.Load</c> uses, so "provider maps it" == "Load can
    /// instantiate it": a custom child the chain cannot map (the AI Dev Gallery controls) fails the
    /// whole document, whereas a provider-mapped custom control (a user app's own controls) renders.
    /// When null (unit tests / no host), Rule 7 is a no-op and the legacy cleaning is unchanged.
    /// </param>
    /// <param name="forcePlaceholderTypes">
    /// Rule 7 (T2, Layer 2) set of type names (full or simple) to substitute for a placeholder even
    /// when the provider chain CAN map them — used by the render host's instantiation-throw safety net
    /// to retire a control whose constructor threw at <c>XamlReader.Load</c>, so one throwing control
    /// does not fail the whole page. May be null (no forced substitutions beyond the built-in
    /// heavy-constructor pre-swap list).
    /// </param>
    public static string Clean(
        string rawXaml,
        ISet<string>? knownResourceKeys = null,
        Func<string, bool>? providerMapsFullName = null,
        ISet<string>? forcePlaceholderTypes = null)
    {
        if (string.IsNullOrWhiteSpace(rawXaml))
        {
            return rawXaml;
        }

        XDocument doc;
        try
        {
            // PreserveWhitespace keeps the author's formatting (and thus most line numbers) intact.
            doc = XDocument.Parse(rawXaml, LoadOptions.PreserveWhitespace);
        }
        catch
        {
            // Not well-formed XML: leave it to XamlReader.Load, which reports the real position.
            return rawXaml;
        }

        try
        {
            var root = doc.Root;
            if (root is null)
            {
                return rawXaml;
            }

            // Rule 1: an x:Class names a compiler-generated partial that does not exist at runtime and
            // is invalid for XamlReader.Load on ANY element. On the root, dropping it makes the root
            // directly constructible; a stray x:Class on a NON-root element (e.g. an inner
            // ResourceDictionary or a nested template root) otherwise fails the whole document with
            // "Object writer 'xClassCanOnlyBeUsedOnLoadComponent'". Remove it everywhere.
            foreach (var withClass in root.DescendantsAndSelf().ToList())
            {
                withClass.Attribute(Xaml + "Class")?.Remove();
            }

            // Rule 1b: XamlReader.Load resolves the document ROOT against the framework, so it cannot
            // instantiate a custom (non-framework) root type — whether abstract (e.g. a project's
            // `abstract class ItemsPageBase : Page`) OR concrete-with-public-ctor (e.g. AI Dev Gallery's
            // `class BaseSamplePage : Page`, the root of ~53 sample pages) — and fails the whole document
            // with "type not found". Rewrite the root to its first public, concrete, default-constructible
            // WinUI base type (Page/UserControl/Control/…) so the markup loads AS that base — the
            // documented VS design-time behavior. Concrete FRAMEWORK roots (the common case) are untouched.
            TryRebaseNonConstructibleRoot(root);

            // Collect every x:Key defined anywhere in the document (Rule 6 treats these as resolvable).
            var docKeys = new HashSet<string>(StringComparer.Ordinal);
            foreach (var el in root.DescendantsAndSelf())
            {
                var key = el.Attribute(Xaml + "Key")?.Value;
                if (!string.IsNullOrEmpty(key))
                {
                    docKeys.Add(key.Trim());
                }
            }

            // Rule 5 (elements): remove whole design-namespace elements (e.g. <d:DesignData>) up front
            // so the attribute pass never touches dead subtrees.
            foreach (var el in root.DescendantsAndSelf().Where(e => e.Name.Namespace == Design).ToList())
            {
                el.Remove();
            }

            // Rule 7 (T2): pre-emptively neutralise custom (using:/clr-namespace:) elements the runtime
            // provider chain cannot map, so a single unresolvable child does not fail the whole document
            // at XamlReader.Load. Visual children become a visible placeholder; unmapped resource entries
            // are dropped (their keys recorded so references can be dropped too). Only runs when the host
            // supplied the provider predicate — the exact resolver XamlReader.Load consults.
            var droppedKeys = new HashSet<string>(StringComparer.Ordinal);
            if (providerMapsFullName is not null)
            {
                SubstituteUnresolvableElements(root, docKeys, droppedKeys, providerMapsFullName, forcePlaceholderTypes);
            }

            // Attribute pass over every surviving element.
            foreach (var el in root.DescendantsAndSelf().ToList())
            {
                CleanElementAttributes(el, root, knownResourceKeys, docKeys, droppedKeys, providerMapsFullName);
            }

            // Drop the now-unused Blend/markup-compat namespace declarations for tidiness (all their
            // usages are gone). Leaving them would be harmless, but removing keeps the output honest.
            foreach (var el in root.DescendantsAndSelf().ToList())
            {
                foreach (var decl in el.Attributes()
                             .Where(a => a.IsNamespaceDeclaration &&
                                         (a.Value == Design.NamespaceName || a.Value == Mc.NamespaceName))
                             .ToList())
                {
                    decl.Remove();
                }
            }

            return doc.ToString(SaveOptions.DisableFormatting);
        }
        catch
        {
            // Any unexpected transform failure: fall back to the original document.
            return rawXaml;
        }
    }

    private static void CleanElementAttributes(
        XElement el,
        XElement root,
        ISet<string>? knownKeys,
        HashSet<string> docKeys,
        HashSet<string> droppedKeys,
        Func<string, bool>? providerMapsFullName)
    {
        var toRemove = new List<XAttribute>();
        var toAdd = new List<(XName name, string value)>();
        var toRewrite = new List<(XAttribute attr, string value)>();

        foreach (var a in el.Attributes())
        {
            if (a.IsNamespaceDeclaration)
            {
                continue; // handled in the dedicated declaration sweep
            }

            var ns = a.Name.Namespace;
            var local = a.Name.LocalName;

            // Rule 5: markup-compatibility (mc:Ignorable, ...) — always drop.
            if (ns == Mc)
            {
                toRemove.Add(a);
                continue;
            }

            // Rule 5: design (d:*) attributes — map the useful ones, then drop.
            if (ns == Design)
            {
                MapDesignAttribute(el, root, a, toAdd);
                toRemove.Add(a);
                continue;
            }

            // Rule 3: compiler-only x: directives — drop; keep x:Name / x:Key / x:Null / x:Static.
            if (ns == Xaml)
            {
                if (RemovableXDirectives.Contains(local))
                {
                    toRemove.Add(a);
                }
                continue;
            }

            // Rule 7a (T2): an attached property whose OWNER is a custom type the provider cannot map
            // (e.g. animations:Implicit.ShowAnimations) — the whole attribute is unloadable; strip it.
            // Framework attached properties (Grid.Row, Canvas.Left, …) resolve and are kept.
            if (providerMapsFullName is not null && IsUnmappedCustomAttachedAttribute(el, a, providerMapsFullName))
            {
                toRemove.Add(a);
                continue;
            }

            var value = a.Value;

            // Rule 7b (T2): a markup-extension value whose type the provider cannot map — e.g.
            // Content="{ui:FontIcon Glyph=...}" (CommunityToolkit's FontIconExtension). Strip the
            // attribute so the element renders without it. The framework <FontIcon> ELEMENT is
            // unaffected (it resolves; only the custom {ui:FontIcon} extension does not).
            if (providerMapsFullName is not null && IsUnmappedCustomMarkupExtension(el, value, providerMapsFullName))
            {
                toRemove.Add(a);
                continue;
            }

            // Rule 2: {x:Bind ...} — drop so the property takes its default. (Classic {Binding} stays;
            // it binds to a null DataContext and renders empty, which is intended.)
            if (IsMarkupExtension(el, value, "Bind", Xaml))
            {
                toRemove.Add(a);
                continue;
            }

            // Rule 6: a {StaticResource}/{ThemeResource} whose key is defined nowhere we can see — or was
            // dropped by Rule 7 (its resource entry was unmappable) — drop the attribute so the rest of the
            // document still renders (degraded element vs. whole-doc fail).
            if (TryGetResourceKey(value, out var resKey))
            {
                bool resolvable =
                    (docKeys.Contains(resKey) || (knownKeys?.Contains(resKey) ?? false)) &&
                    !droppedKeys.Contains(resKey);
                if (!resolvable)
                {
                    toRemove.Add(a);
                }
                continue; // resolvable resource reference: keep as-is
            }

            // Rule 7c (T2): a {Binding ... Converter={StaticResource droppedKey} ...} — strip only the
            // converter clause (the converter resource was dropped by Rule 7). The binding survives and
            // renders its raw value, which is acceptable for a static preview.
            if (droppedKeys.Count > 0 && TryStripDroppedConverter(value, droppedKeys, out var rewritten))
            {
                toRewrite.Add((a, rewritten));
                continue;
            }

            // Rule 4: event handler — drop (an event has no runtime meaning without code-behind).
            if (IsEventAttribute(el, a))
            {
                toRemove.Add(a);
            }
        }

        foreach (var (attr, value) in toRewrite)
        {
            attr.Value = value;
        }

        foreach (var a in toRemove)
        {
            a.Remove();
        }

        // Add mapped design->runtime attributes last, never clobbering an existing real property.
        foreach (var (name, value) in toAdd)
        {
            if (el.Attribute(name) is null)
            {
                el.SetAttributeValue(name, value);
            }
        }
    }

    /// <summary>
    /// Bonus mapping for Rule 5: <c>d:DesignWidth</c>/<c>d:DesignHeight</c> on the root become
    /// <c>Width</c>/<c>Height</c>; any other <c>d:*</c> that names a real property of the element's
    /// type (e.g. <c>d:Text</c>) becomes that runtime property so design-time data still renders.
    /// Design-only markup extensions (<c>{d:DesignInstance}</c>, <c>{d:DesignData}</c>) are never mapped.
    /// </summary>
    private static void MapDesignAttribute(XElement el, XElement root, XAttribute a, List<(XName, string)> toAdd)
    {
        var local = a.Name.LocalName;
        var value = a.Value;

        if (local is "DesignWidth" or "DesignHeight")
        {
            if (el == root)
            {
                var target = local == "DesignWidth" ? "Width" : "Height";
                if (root.Attribute(target) is null)
                {
                    toAdd.Add((target, value));
                }
            }
            return;
        }

        // Never promote a design-only markup extension to a runtime property.
        if (DesignExtension.IsMatch(value.TrimStart()))
        {
            return;
        }

        // Only map when the runtime property genuinely exists on the element's type — this prevents
        // Blend-only attributes (d:LayoutOverrides, d:IsHidden, ...) from becoming invalid properties.
        var type = ResolveElementType(el);
        if (type is not null &&
            type.GetProperty(local, BindingFlags.Public | BindingFlags.Instance) is not null &&
            el.Attribute(local) is null)
        {
            toAdd.Add((local, value));
        }
    }

    // ---- markup-extension / resource helpers ---------------------------------

    /// <summary>
    /// True when <paramref name="value"/> is a markup extension named <paramref name="member"/> whose
    /// prefix resolves to <paramref name="ns"/> in the element's scope (e.g. <c>{x:Bind ...}</c>).
    /// </summary>
    private static bool IsMarkupExtension(XElement el, string value, string member, XNamespace ns)
    {
        var trimmed = value.TrimStart();
        if (trimmed.Length == 0 || trimmed[0] != '{')
        {
            return false;
        }

        var m = MarkupExtensionHead.Match(trimmed);
        if (!m.Success || !string.Equals(m.Groups["name"].Value, member, StringComparison.Ordinal))
        {
            return false;
        }

        var prefix = m.Groups["prefix"].Value;
        if (prefix.Length == 0)
        {
            return false; // {Bind} with no prefix is not x:Bind
        }

        // Resolve the prefix against the element's in-scope namespace declarations.
        var resolved = el.GetNamespaceOfPrefix(prefix);
        return resolved is not null && resolved.NamespaceName == ns.NamespaceName;
    }

    /// <summary>Extracts KEY from <c>{StaticResource KEY}</c> / <c>{ThemeResource ResourceKey=KEY}</c>.</summary>
    private static bool TryGetResourceKey(string value, out string key)
    {
        key = string.Empty;
        var trimmed = value.TrimStart();
        if (trimmed.Length == 0 || trimmed[0] != '{')
        {
            return false;
        }

        var m = ResourceExtension.Match(value.Trim());
        if (!m.Success)
        {
            return false;
        }

        var raw = m.Groups["key"].Value.Trim();
        // Support the explicit "ResourceKey=Foo" form as well as the positional "Foo".
        var eq = raw.IndexOf('=');
        key = (eq >= 0 ? raw[(eq + 1)..] : raw).Trim();
        return key.Length > 0;
    }

    // ---- event detection (per-element type resolution) -----------------------

    /// <summary>
    /// True if <paramref name="a"/> is an event on <paramref name="el"/>'s type (or an attached event
    /// on the named owner type). Resolves the CLR type from the element's xmlns and asks
    /// <see cref="Type.GetEvent(string)"/>; falls back to <see cref="CuratedEventNames"/> only when the
    /// type cannot be resolved.
    /// </summary>
    private static bool IsEventAttribute(XElement el, XAttribute a)
    {
        var local = a.Name.LocalName;

        // Attached member: "Owner.Member" (owner resolved in the attribute's namespace, or the
        // element's default xmlns when the attribute is unprefixed).
        int dot = local.IndexOf('.');
        if (dot > 0)
        {
            var ownerName = local[..dot];
            var member = local[(dot + 1)..];
            var ownerXmlns = a.Name.Namespace == XNamespace.None
                ? el.GetDefaultNamespace().NamespaceName
                : a.Name.Namespace.NamespaceName;
            var ownerType = ResolveType(ownerXmlns, ownerName);
            return ownerType is not null && HasEvent(ownerType, member);
        }

        // A non-dotted event handler attribute is always unprefixed (XML "no namespace").
        if (a.Name.Namespace != XNamespace.None)
        {
            return false;
        }

        var elType = ResolveElementType(el);
        if (elType is not null)
        {
            return HasEvent(elType, local);
        }

        // Type unresolved: last-resort curated match.
        return CuratedEventNames.Contains(local);
    }

    private static bool HasEvent(Type type, string name)
    {
        try
        {
            return type.GetEvent(name, BindingFlags.Public | BindingFlags.Instance | BindingFlags.FlattenHierarchy) is not null;
        }
        catch
        {
            return false;
        }
    }

    // ---- CLR type resolution -------------------------------------------------

    private static Type? ResolveElementType(XElement el)
        => ResolveType(el.Name.NamespaceName, el.Name.LocalName);

    /// <summary>
    /// Rewrites the root element name to its first public, concrete, default-constructible WinUI
    /// framework base type (in the default presentation namespace) so <c>XamlReader.Load</c> can
    /// instantiate it. Fires for any <b>non-framework (custom) root</b> — not just abstract ones —
    /// because design-time markup activation resolves the ROOT against the framework, so
    /// <c>XamlReader.Load</c> cannot instantiate a custom root type even when it is concrete with a
    /// public ctor (e.g. <c>class BaseSamplePage : Page</c> / <c>abstract class ItemsPageBase : Page</c>).
    /// The body then loads AS that base — the documented VS design-time behavior. A concrete,
    /// default-constructible <b>framework</b> root (Page/UserControl/Grid/…, the common case) is left
    /// untouched. Best-effort: any failure leaves the root unchanged.
    /// </summary>
    private static void TryRebaseNonConstructibleRoot(XElement root)
    {
        try
        {
            var rootType = ResolveElementType(root);
            if (rootType is null)
            {
                return;
            }

            // Only a concrete, default-constructible FRAMEWORK root is directly loadable. Everything
            // else (any custom/non-framework root, or an abstract/non-constructible framework root)
            // rebases to a framework base below.
            var isFrameworkType = rootType.Namespace is not null
                && Array.IndexOf(WinUiClrNamespaces, rootType.Namespace) >= 0;
            if (isFrameworkType && !rootType.IsAbstract && HasPublicParameterlessCtor(rootType))
            {
                return;
            }

            for (var t = rootType.BaseType; t is not null; t = t.BaseType)
            {
                if (t.IsAbstract || !t.IsPublic || t.Namespace is null)
                {
                    continue;
                }
                if (Array.IndexOf(WinUiClrNamespaces, t.Namespace) < 0)
                {
                    continue;
                }
                if (!HasPublicParameterlessCtor(t))
                {
                    continue;
                }
                // Rewrite to e.g. {presentation}Page — the default xmlns is already declared on the root,
                // so it serializes as <Page …> while keeping every namespace decl, attribute and child.
                var oldRootName = root.Name;
                root.Name = Pres + t.Name;
                RewriteRootPropertyElements(root, oldRootName, root.Name);
                StripCustomBaseOnlyRootAttributes(root, rootType, t);
                return;
            }
        }
        catch
        {
            // best-effort rebase only
        }
    }

    /// <summary>
    /// After a custom root has been rebased to a framework <paramref name="baseType"/>, drops any ROOT
    /// attribute that only made sense on the original <paramref name="originalType"/>: a
    /// custom-namespaced (<c>using:</c>/<c>clr-namespace:</c>) attribute, or a bare property the original
    /// type declared that the framework base does not expose. Namespace declarations, <c>x:</c>
    /// directives, design/compat attributes, inherited framework properties (Width, Margin, …) and
    /// attached properties (dotted, e.g. Grid.Row — they resolve independently of the root type) are all
    /// kept. Conservative: it never removes an attribute it cannot prove is base-incompatible.
    /// </summary>
    private static void StripCustomBaseOnlyRootAttributes(XElement root, Type originalType, Type baseType)
    {
        foreach (var attr in root.Attributes().ToList())
        {
            if (attr.IsNamespaceDeclaration)
            {
                continue;
            }

            var ns = attr.Name.NamespaceName;
            if (ns == Xaml.NamespaceName || ns == Design.NamespaceName || ns == Mc.NamespaceName)
            {
                continue;
            }

            // A custom-namespaced root attribute (custom attached property or directive) cannot bind to
            // the framework base — drop it.
            if (ns.StartsWith("using:", StringComparison.Ordinal) ||
                ns.StartsWith("clr-namespace:", StringComparison.Ordinal))
            {
                attr.Remove();
                continue;
            }

            // Bare/default-namespace attribute. Attached properties (dotted) resolve independently — keep.
            // A plain property is base-incompatible only if the original custom type declared it and the
            // framework base does not.
            var local = attr.Name.LocalName;
            if (local.Contains('.'))
            {
                continue;
            }
            if (baseType.GetProperty(local) is null && originalType.GetProperty(local) is not null)
            {
                attr.Remove();
            }
        }
    }

    // ---- T2 (Rule 7): per-element fallback for unresolvable custom types --------

    /// <summary>
    /// After the root is rebased Old→NewBase, a property element that named the OLD root type as its
    /// owner — e.g. <c>&lt;samples:BaseSamplePage.Resources&gt;</c> — no longer resolves ("attachable
    /// property 'Resources' not found in type 'BaseSamplePage'"). Rewrite the owner of any such property
    /// element to the new framework base so it becomes <c>&lt;Page.Resources&gt;</c>. Only the exact
    /// old-root owner (same namespace + local name) is touched.
    /// </summary>
    private static void RewriteRootPropertyElements(XElement root, XName oldRootName, XName newRootName)
    {
        foreach (var el in root.Descendants().ToList())
        {
            var ln = el.Name.LocalName;
            int dot = ln.IndexOf('.');
            if (dot <= 0)
            {
                continue;
            }
            if (el.Name.Namespace != oldRootName.Namespace ||
                !string.Equals(ln[..dot], oldRootName.LocalName, StringComparison.Ordinal))
            {
                continue;
            }
            el.Name = newRootName.Namespace + (newRootName.LocalName + "." + ln[(dot + 1)..]);
        }
    }

    /// <summary>
    /// Layer 2 (T2) pre-swap list: controls whose CONSTRUCTOR is known to be heavy — camera/hardware
    /// access, heavy DI, or model-download I/O — matched by simple type name. Even though the Layer 1
    /// provider chain can now resolve these, they are swapped for a placeholder at CLEAN time and NEVER
    /// constructed: a constructor that HANGS (blocking I/O) cannot be recovered by the render host's
    /// Load-time try/catch (it would wedge the whole Surface), so avoidance must be pre-emptive. A
    /// constructor that merely THROWS is caught by the safety net; hangs are why this list exists.
    /// </summary>
    private static readonly HashSet<string> PreSwapConstructorSimpleNames = new(StringComparer.Ordinal)
    {
        // AI Dev Gallery app controls with model-download / DI / service constructors.
        "WcrModelDownloader", "OverviewPageHeader", "SmartPasteForm", "SmartTextBox",
        "SemanticComboBox", "OpacityMaskView",
        // Toolkit control that initialises camera hardware in its constructor.
        "CameraPreview",
    };

    /// <summary>
    /// Rule 7 (T2): walk every non-root element and, for any custom (using:/clr-namespace:) type the
    /// provider chain cannot map, substitute it so a single unknown child does not fail the whole
    /// document. A resource entry is dropped (its key recorded in <paramref name="droppedKeys"/> and
    /// removed from <paramref name="docKeys"/>); any other element (a visual child) becomes a visible
    /// placeholder that preserves the surrounding layout. Framework/default-xmlns elements and elements
    /// the provider CAN map (a user app's own controls) are left untouched, so already-rendering pages
    /// never regress. The document ROOT is owned by <see cref="TryRebaseNonConstructibleRoot"/>.
    ///
    /// Layer 2 additions: an element is ALSO substituted (even when the provider maps it) when its simple
    /// name is in <see cref="PreSwapConstructorSimpleNames"/> (heavy/hanging constructor — never
    /// construct) or its name is in <paramref name="forcePlaceholderTypes"/> (the render host's
    /// instantiation-throw safety net flagged it as throwing at Load).
    /// </summary>
    private static void SubstituteUnresolvableElements(
        XElement root,
        HashSet<string> docKeys,
        HashSet<string> droppedKeys,
        Func<string, bool> providerMapsFullName,
        ISet<string>? forcePlaceholderTypes = null)
    {
        foreach (var el in root.Descendants().ToList())
        {
            // Skip elements already removed with a substituted ancestor.
            if (!IsConnectedTo(el, root))
            {
                continue;
            }

            // Property elements (<Owner.Member>): the root's are rewritten by the rebase, framework
            // owners (Grid.RowDefinitions, Page.Resources) resolve at Load, and a custom element's own
            // property elements are removed together with it. But a property element whose OWNER is an
            // unmappable CUSTOM type sitting under a framework parent — e.g. the XAML-Behaviors pattern
            // <interactivity:Interaction.Behaviors> or <animations:Implicit.ShowAnimations> — would fail
            // Load on its own, so drop it (static preview needs neither behaviors nor animations).
            int ownerDot = el.Name.LocalName.IndexOf('.');
            if (ownerDot > 0)
            {
                var ownerFull = CustomTypeFullName(el.Name.NamespaceName, el.Name.LocalName[..ownerDot]);
                if (ownerFull is not null && !SafeProviderMaps(providerMapsFullName, ownerFull))
                {
                    el.Remove();
                }
                continue;
            }

            // Only custom types are candidates; framework/default-xmlns elements resolve at Load.
            var fullName = CustomTypeFullName(el.Name.NamespaceName, el.Name.LocalName);
            if (fullName is null)
            {
                continue;
            }

            // Layer 2: force a placeholder for heavy-constructor controls (never construct — hang-safe)
            // and for types the safety net flagged as throwing, EVEN IF the provider maps them.
            bool forced =
                PreSwapConstructorSimpleNames.Contains(el.Name.LocalName) ||
                (forcePlaceholderTypes is not null &&
                 (forcePlaceholderTypes.Contains(fullName) || forcePlaceholderTypes.Contains(el.Name.LocalName)));

            // Keep any custom type the provider CAN map (it renders for real) — unless forced above.
            if (!forced && SafeProviderMaps(providerMapsFullName, fullName))
            {
                continue;
            }

            if (IsResourceEntry(el))
            {
                RecordDroppedKey(el, docKeys, droppedKeys);
                el.Remove();
            }
            else
            {
                ReplaceWithPlaceholder(el);
            }
        }
    }

    private static bool IsConnectedTo(XElement el, XElement root)
    {
        for (XElement? p = el; p is not null; p = p.Parent)
        {
            if (p == root)
            {
                return true;
            }
        }
        return false;
    }

    /// <summary>
    /// The CLR full type name for a custom (<c>using:</c>/<c>clr-namespace:</c>) xmlns, or null for the
    /// framework/default presentation xmlns (and <c>x:</c>/design/compat), which the loader resolves
    /// itself and which Rule 7 must therefore never substitute. A dotted local name (property element)
    /// also returns null.
    /// </summary>
    private static string? CustomTypeFullName(string xmlNamespace, string localName)
    {
        if (string.IsNullOrEmpty(localName) || localName.IndexOf('.') >= 0)
        {
            return null;
        }
        if (xmlNamespace.StartsWith("using:", StringComparison.Ordinal))
        {
            return xmlNamespace["using:".Length..] + "." + localName;
        }
        if (xmlNamespace.StartsWith("clr-namespace:", StringComparison.Ordinal))
        {
            var body = xmlNamespace["clr-namespace:".Length..];
            var semi = body.IndexOf(';');
            var clrNs = semi >= 0 ? body[..semi] : body;
            return clrNs + "." + localName;
        }
        return null;
    }

    /// <summary>
    /// Asks the host predicate whether the runtime provider chain maps <paramref name="fullName"/>.
    /// Any exception is treated as "mapped" (keep) so Rule 7 never risks substituting a good element.
    /// </summary>
    private static bool SafeProviderMaps(Func<string, bool> providerMapsFullName, string fullName)
    {
        try
        {
            return providerMapsFullName(fullName);
        }
        catch
        {
            return true;
        }
    }

    /// <summary>True when <paramref name="el"/> is a resource-dictionary entry (a direct child of a
    /// <c>*.Resources</c> property element or a <c>ResourceDictionary</c>).</summary>
    private static bool IsResourceEntry(XElement el)
    {
        var parent = el.Parent;
        if (parent is null)
        {
            return false;
        }
        var pn = parent.Name.LocalName;
        return pn.EndsWith(".Resources", StringComparison.Ordinal) || pn == "ResourceDictionary";
    }

    /// <summary>Records a dropped resource entry's <c>x:Key</c> and/or <c>x:Name</c> so later passes can
    /// drop references to it, and removes it from the resolvable-key set.</summary>
    private static void RecordDroppedKey(XElement el, HashSet<string> docKeys, HashSet<string> droppedKeys)
    {
        foreach (var keyAttr in new[] { el.Attribute(Xaml + "Key"), el.Attribute(Xaml + "Name") })
        {
            var key = keyAttr?.Value?.Trim();
            if (!string.IsNullOrEmpty(key))
            {
                droppedKeys.Add(key);
                docKeys.Remove(key);
            }
        }
    }

    // Layout-affecting direct properties copied onto a placeholder so surrounding layout is undisturbed.
    private static readonly HashSet<string> PreservedLayoutProps = new(StringComparer.Ordinal)
    {
        "Width", "Height", "MinWidth", "MinHeight", "MaxWidth", "MaxHeight",
        "Margin", "HorizontalAlignment", "VerticalAlignment",
    };

    /// <summary>
    /// Replaces an unmappable visual child with a subtle bordered placeholder labelled with the
    /// unresolved type name (the design-time stand-in concept). Preserves the element's <c>x:Name</c>,
    /// its framework attached-layout properties (Grid.Row, Canvas.Left, RelativePanel/DockPanel, …) and
    /// its direct layout properties so the page's layout is not disturbed. Uses literal colours (no
    /// resource lookups) so the placeholder itself can never fail to parse.
    /// </summary>
    private static void ReplaceWithPlaceholder(XElement el)
    {
        var placeholder = new XElement(
            Pres + "Border",
            new XAttribute("BorderBrush", "#FF9E9E9E"),
            new XAttribute("BorderThickness", "1"),
            new XAttribute("Background", "#14808080"),
            new XAttribute("CornerRadius", "2"),
            new XAttribute("MinWidth", "24"),
            new XAttribute("MinHeight", "24"),
            new XAttribute("Padding", "6,4"));

        CopyPreservedAttributes(el, placeholder);

        placeholder.Add(new XElement(
            Pres + "TextBlock",
            new XAttribute("Text", el.Name.LocalName),
            new XAttribute("Foreground", "#FF9E9E9E"),
            new XAttribute("FontSize", "11"),
            new XAttribute("FontStyle", "Italic"),
            new XAttribute("TextWrapping", "Wrap"),
            new XAttribute("TextTrimming", "CharacterEllipsis"),
            new XAttribute("HorizontalAlignment", "Center"),
            new XAttribute("VerticalAlignment", "Center")));

        el.ReplaceWith(placeholder);
    }

    private static void CopyPreservedAttributes(XElement src, XElement dst)
    {
        foreach (var a in src.Attributes())
        {
            if (a.IsNamespaceDeclaration)
            {
                continue;
            }

            // Keep x:Name so ElementName bindings / VisualState targets still find the node.
            if (a.Name.Namespace == Xaml && a.Name.LocalName == "Name")
            {
                dst.SetAttributeValue(Xaml + "Name", a.Value);
                continue;
            }

            var local = a.Name.LocalName;
            int dot = local.IndexOf('.');
            if (dot > 0)
            {
                // Attached layout property (Grid.Row, Canvas.Left, RelativePanel.*, DockPanel.Dock) —
                // preserve it only when its owner is a framework type (resolves independently of the
                // placeholdered child's type). Custom attached props are dropped.
                var ownerXmlns = a.Name.Namespace == XNamespace.None
                    ? src.GetDefaultNamespace().NamespaceName
                    : a.Name.Namespace.NamespaceName;
                if (CustomTypeFullName(ownerXmlns, local[..dot]) is null &&
                    ResolveType(ownerXmlns, local[..dot]) is not null)
                {
                    dst.SetAttributeValue(a.Name, a.Value);
                }
                continue;
            }

            // Direct layout property on the default/no namespace — preserve.
            if (a.Name.Namespace == XNamespace.None && PreservedLayoutProps.Contains(local))
            {
                dst.SetAttributeValue(a.Name, a.Value);
            }
        }
    }

    /// <summary>
    /// True when <paramref name="a"/> is an attached property whose OWNER type is custom
    /// (using:/clr-namespace:) and the provider chain cannot map it — e.g.
    /// <c>animations:Implicit.ShowAnimations</c>. Framework attached properties (Grid.Row, Canvas.Left,
    /// …) have a non-custom owner and return false (kept).
    /// </summary>
    private static bool IsUnmappedCustomAttachedAttribute(XElement el, XAttribute a, Func<string, bool> providerMapsFullName)
    {
        var local = a.Name.LocalName;
        int dot = local.IndexOf('.');
        if (dot <= 0)
        {
            return false;
        }
        var ownerXmlns = a.Name.Namespace == XNamespace.None
            ? el.GetDefaultNamespace().NamespaceName
            : a.Name.Namespace.NamespaceName;
        var ownerFull = CustomTypeFullName(ownerXmlns, local[..dot]);
        if (ownerFull is null)
        {
            return false; // framework attached property — keep.
        }
        return !SafeProviderMaps(providerMapsFullName, ownerFull);
    }

    /// <summary>
    /// True when <paramref name="value"/> is a markup extension <c>{prefix:Type ...}</c> whose prefix
    /// resolves to a custom (using:/clr-namespace:) namespace and whose extension type the provider
    /// chain cannot map — e.g. <c>{ui:FontIcon Glyph=...}</c> (CommunityToolkit's FontIconExtension).
    /// Both the bare name and the <c>...Extension</c> form are probed (XAML markup-extension naming).
    /// A framework/default-namespace or provider-mapped extension returns false and is kept — the
    /// framework <c>&lt;FontIcon&gt;</c> ELEMENT is never affected, only the custom extension.
    /// </summary>
    private static bool IsUnmappedCustomMarkupExtension(XElement el, string value, Func<string, bool> providerMapsFullName)
    {
        var trimmed = value.TrimStart();
        if (trimmed.Length == 0 || trimmed[0] != '{')
        {
            return false;
        }
        var m = MarkupExtensionHead.Match(trimmed);
        if (!m.Success)
        {
            return false;
        }
        var prefix = m.Groups["prefix"].Value;
        if (prefix.Length == 0)
        {
            return false; // no prefix -> {Binding}/{StaticResource}/… (framework, or Rule 6's job).
        }
        var resolved = el.GetNamespaceOfPrefix(prefix);
        if (resolved is null)
        {
            return false;
        }
        var full = CustomTypeFullName(resolved.NamespaceName, m.Groups["name"].Value);
        if (full is null)
        {
            return false; // extension in a framework namespace — keep.
        }
        return !SafeProviderMaps(providerMapsFullName, full) &&
               !SafeProviderMaps(providerMapsFullName, full + "Extension");
    }

    /// <summary>
    /// If <paramref name="value"/> is a binding expression carrying <c>Converter={StaticResource key}</c>
    /// where <c>key</c> names a dropped resource, removes just that converter clause (keeping the binding,
    /// which then renders its raw value) and returns the rewritten expression via <paramref name="rewritten"/>.
    /// </summary>
    private static bool TryStripDroppedConverter(string value, HashSet<string> droppedKeys, out string rewritten)
    {
        rewritten = value;
        var trimmed = value.TrimStart();
        if (trimmed.Length == 0 || trimmed[0] != '{')
        {
            return false;
        }

        var changed = false;
        rewritten = ConverterClause.Replace(value, m =>
        {
            var key = m.Groups["key"].Value.Trim();
            var eq = key.IndexOf('=');
            if (eq >= 0)
            {
                key = key[(eq + 1)..].Trim(); // support "ResourceKey=Foo"
            }
            if (!droppedKeys.Contains(key))
            {
                return m.Value; // a converter we did not drop — leave untouched.
            }
            changed = true;
            // Keep a single separator when the clause sat between two other arguments.
            return m.Groups["lead"].Success && m.Groups["trail"].Success ? ", " : string.Empty;
        });
        return changed;
    }

    private static bool HasPublicParameterlessCtor(Type t)
    {
        try
        {
            var c = t.GetConstructor(Type.EmptyTypes);
            return c is not null && c.IsPublic;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>Resolves an element/owner name in the given xmlns to a CLR <see cref="Type"/>, or null.</summary>
    private static Type? ResolveType(string xmlNamespace, string localName)
    {
        if (string.IsNullOrEmpty(localName))
        {
            return null;
        }

        if (xmlNamespace.StartsWith("using:", StringComparison.Ordinal))
        {
            return FindClrType(xmlNamespace["using:".Length..], localName);
        }

        if (xmlNamespace.StartsWith("clr-namespace:", StringComparison.Ordinal))
        {
            // clr-namespace:Some.Ns;assembly=Foo -> take the namespace part only.
            var body = xmlNamespace["clr-namespace:".Length..];
            var semi = body.IndexOf(';');
            var clrNs = semi >= 0 ? body[..semi] : body;
            return FindClrType(clrNs, localName);
        }

        if (xmlNamespace == Pres.NamespaceName || xmlNamespace.Length == 0)
        {
            foreach (var ns in WinUiClrNamespaces)
            {
                var t = FindClrType(ns, localName);
                if (t is not null)
                {
                    return t;
                }
            }
        }

        return null;
    }

    private static Type? FindClrType(string clrNamespace, string localName)
    {
        var full = clrNamespace + "." + localName;
        return TypeCache.GetOrAdd(full, static f =>
        {
            try
            {
                // Prefer the WinUI projection assembly for framework namespaces.
                var t = WinUiAssembly?.GetType(f, throwOnError: false, ignoreCase: false);
                if (t is not null)
                {
                    return t;
                }

                foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
                {
                    try
                    {
                        t = asm.GetType(f, throwOnError: false, ignoreCase: false);
                        if (t is not null)
                        {
                            return t;
                        }
                    }
                    catch
                    {
                        // Some dynamic/reflection-only assemblies can throw; skip them.
                    }
                }
            }
            catch
            {
                // best-effort resolution only
            }
            return null;
        });
    }

    private static Assembly? SafeGetWinUiAssembly()
    {
        try
        {
            return typeof(Microsoft.UI.Xaml.DependencyObject).Assembly;
        }
        catch
        {
            return null;
        }
    }
}
