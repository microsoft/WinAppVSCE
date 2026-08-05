using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using Microsoft.CodeAnalysis;

namespace WinUiXaml.Workspace
{
    /// <summary>
    /// The XAML type-system provider (#5): resolves XAML namespace URIs and element/attribute names to
    /// Roslyn symbols, and enumerates the types and members that can legally appear in a document.
    /// This is the semantic foundation for element/attribute completion (#7), hover, and validation.
    /// </summary>
    /// <remarks>
    /// Namespace resolution understands three XAML schemes:
    /// <list type="bullet">
    /// <item>Registered URIs (e.g. the WinUI <c>presentation</c> namespace) discovered from
    /// <c>XmlnsDefinitionAttribute</c> assembly attributes on the referenced assemblies.</item>
    /// <item><c>using:Clr.Namespace</c> — a CLR namespace searched across the compilation.</item>
    /// <item><c>clr-namespace:Clr.Namespace;assembly=Name</c> — a CLR namespace in a named assembly.</item>
    /// </list>
    /// </remarks>
    public sealed class XamlTypeSystem
    {
        /// <summary>The WinUI/WPF-style default presentation namespace.</summary>
        public const string PresentationNamespace =
            "http://schemas.microsoft.com/winfx/2006/xaml/presentation";

        /// <summary>The XAML language namespace (<c>x:</c> — x:Class, x:Name, x:Bind, ...).</summary>
        public const string XamlLanguageNamespace =
            "http://schemas.microsoft.com/winfx/2006/xaml";

        private const string UsingScheme = "using:";
        private const string ClrNamespaceScheme = "clr-namespace:";

        // WinUI (unlike WPF) ships no XmlnsDefinitionAttribute; the presentation namespace maps to these
        // CLR namespace roots by convention. We expand each root to all of its descendant namespaces
        // found in the referenced assemblies, so the mapping tracks the actual SDK version in use.
        private static readonly string[] PresentationRoots = { "Microsoft.UI.Xaml", "Windows.UI.Xaml" };

        private readonly Compilation _compilation;
        private readonly ImmutableArray<IAssemblySymbol> _assemblies;

        // Lazily-computed, cached referenced-metadata using: namespaces (the reference closure is large, so
        // the walk runs at most once per type-system instance).
        private IReadOnlyList<string>? _referencedUsingNamespaces;

        // Lazily-computed, cached WinUI named-color names (Microsoft.UI.Colors static properties). Derived
        // purely from the immutable compilation, so it can never be stale relative to this instance.
        private IReadOnlyList<string>? _namedColors;

        // Lazily-computed, cached WinUI named font-weight names (Microsoft.UI.Text.FontWeights static
        // properties). Same immutable-compilation contract as _namedColors.
        private IReadOnlyList<string>? _fontWeights;

        // Lazily-computed, cached third-party (referenced-assembly) element types — public classes assignable
        // to Microsoft.UI.Xaml.DependencyObject that are NOT declared in the project's own source. Used by
        // element-name completion to offer NuGet-package controls (e.g. Windows Community Toolkit) that
        // register no XmlnsDefinitionAttribute and so are reachable only via using:. The reference closure is
        // large, so the walk runs at most once per type-system instance; derived purely from the immutable
        // compilation, so it can never be stale (same contract as _referencedUsingNamespaces).
        private IReadOnlyList<INamedTypeSymbol>? _referencedElementTypes;

        // Registered xmlns URI -> the (assembly, CLR namespace) pairs it expands to.
        private readonly Dictionary<string, List<NamespaceBinding>> _xmlnsMap;

        // XAML intrinsic language types (the x: namespace) map to CLR types by language rule, not via an
        // xmlns->CLR-namespace binding: e.g. {x:String} is System.String, so <DataTemplate x:DataType="x:String">
        // re-roots {x:Bind} against string members. Kept in metadata-name form and resolved on demand.
        private static readonly Dictionary<string, string> XamlIntrinsicTypes = new(StringComparer.Ordinal)
        {
            ["Object"] = "System.Object",
            ["Boolean"] = "System.Boolean",
            ["Byte"] = "System.Byte",
            ["Char"] = "System.Char",
            ["Decimal"] = "System.Decimal",
            ["Single"] = "System.Single",
            ["Double"] = "System.Double",
            ["Int16"] = "System.Int16",
            ["Int32"] = "System.Int32",
            ["Int64"] = "System.Int64",
            ["String"] = "System.String",
            ["TimeSpan"] = "System.TimeSpan",
            ["Uri"] = "System.Uri",
            ["Type"] = "System.Type",
        };

        private XamlTypeSystem(
            Compilation compilation,
            ImmutableArray<IAssemblySymbol> assemblies,
            Dictionary<string, List<NamespaceBinding>> xmlnsMap)
        {
            _compilation = compilation;
            _assemblies = assemblies;
            _xmlnsMap = xmlnsMap;
        }

        /// <summary>Builds a type system from a resolved XAML file's project context.</summary>
        public static XamlTypeSystem FromResolution(XamlResolution resolution)
        {
            if (resolution is null)
            {
                throw new ArgumentNullException(nameof(resolution));
            }

            return FromCompilation(resolution.Compilation, resolution.ReferencedAssemblies);
        }

        /// <summary>
        /// Builds a type system from a compilation and the assemblies whose types can appear in the
        /// document. The compilation's own assembly is always included so <c>using:</c>/<c>local:</c>
        /// references to the project's own types resolve.
        /// </summary>
        public static XamlTypeSystem FromCompilation(
            Compilation compilation, ImmutableArray<IAssemblySymbol> referencedAssemblies)
        {
            if (compilation is null)
            {
                throw new ArgumentNullException(nameof(compilation));
            }

            // Include the project's own assembly so local:/using: types (e.g. the app's own controls)
            // resolve alongside the referenced framework assemblies.
            var builder = ImmutableArray.CreateBuilder<IAssemblySymbol>();
            builder.Add(compilation.Assembly);
            if (!referencedAssemblies.IsDefault)
            {
                builder.AddRange(referencedAssemblies);
            }

            var assemblies = builder.ToImmutable();

            var xmlnsMap = BuildXmlnsMap(assemblies);
            AddConventionNamespaces(xmlnsMap, assemblies);
            return new XamlTypeSystem(compilation, assemblies, xmlnsMap);
        }

        /// <summary>
        /// Resolves an element or attached-property owner name (e.g. <c>Button</c> in the presentation
        /// namespace, or <c>SmokePage</c> in <c>using:SmokeFixture</c>) to its type symbol, or null.
        /// </summary>
        public INamedTypeSymbol? ResolveType(string xmlnsUri, string localName)
        {
            if (string.IsNullOrEmpty(localName))
            {
                return null;
            }

            // XAML intrinsic types (x: language namespace) resolve to their CLR counterparts.
            if (string.Equals(xmlnsUri, XamlLanguageNamespace, StringComparison.Ordinal) &&
                XamlIntrinsicTypes.TryGetValue(localName, out var intrinsicMetadataName))
            {
                return _compilation.GetTypeByMetadataName(intrinsicMetadataName);
            }

            foreach (var binding in NamespacesFor(xmlnsUri))
            {
                var type = FindType(binding, localName);
                if (type is not null)
                {
                    return type;
                }
            }

            return null;
        }

        /// <summary>
        /// Resolves a type by its fully-qualified metadata name (e.g.
        /// <c>Microsoft.UI.Xaml.Data.BindingMode</c>) across the compilation and its references, or null.
        /// Used for well-known framework types (binding modes, etc.) that aren't reached through xmlns.
        /// </summary>
        public INamedTypeSymbol? ResolveMetadataType(string metadataName) =>
            string.IsNullOrEmpty(metadataName) ? null : _compilation.GetTypeByMetadataName(metadataName);

        /// <summary>
        /// The distinct CLR namespaces of SOURCE types declared with the given simple (unqualified) name in
        /// the current compilation — the candidate <c>using:</c> targets when an undeclared custom XAML
        /// prefix names one of a project's own types (e.g. <c>&lt;local:MyControl&gt;</c> ⇒
        /// <c>using:MyApp.Controls</c>). Searches the compilation's declaration table (its own source) via
        /// <see cref="Compilation.GetSymbolsWithName(string, SymbolFilter, System.Threading.CancellationToken)"/>,
        /// NOT referenced metadata: framework/library types are reached through their registered xmlns, so
        /// suggesting a <c>using:</c> for them would be wrong. Only instantiable classes count (a XAML element
        /// is an object), the global namespace is skipped (a XAML element always needs a prefixed namespace),
        /// and results are ordered so the offered quick fixes are deterministic.
        /// </summary>
        public IReadOnlyList<string> FindNamespacesForTypeName(string simpleName)
        {
            if (string.IsNullOrEmpty(simpleName))
            {
                return System.Array.Empty<string>();
            }

            return _compilation
                .GetSymbolsWithName(simpleName, SymbolFilter.Type)
                .OfType<INamedTypeSymbol>()
                .Where(t => t.TypeKind == TypeKind.Class && !t.IsStatic &&
                    t.ContainingNamespace is { IsGlobalNamespace: false })
                .Select(t => t.ContainingNamespace.ToDisplayString())
                .Where(ns => !string.IsNullOrEmpty(ns))
                .Distinct(StringComparer.Ordinal)
                .OrderBy(ns => ns, StringComparer.Ordinal)
                .ToList();
        }

        /// <summary>
        /// The distinct CLR namespaces of the project's own SOURCE types that are usable as XAML elements —
        /// the candidate targets when completing a <c>using:</c> xmlns value (e.g. typing
        /// <c>xmlns:local="using:|"</c> offers <c>MyApp.Controls</c>). This is the enumeration companion to
        /// <see cref="FindNamespacesForTypeName"/>: same source-only, instantiable-class rule, but across ALL
        /// such types rather than a single name. Walks the source assembly's global namespace
        /// (<see cref="Compilation.Assembly"/>) — NOT referenced metadata; the project's OWN namespaces are
        /// the most relevant and are ranked first in completion. Referenced-assembly namespaces (framework and
        /// library types, including control libraries that register no xmlns and so are reachable ONLY through
        /// <c>using:</c>) are offered separately by <see cref="GetReferencedUsingNamespaces"/>, matching Visual
        /// Studio, which lists every CLR namespace with a public type. A namespace qualifies when it directly
        /// declares at least one public, non-static class (a XAML element is a public object); the global
        /// namespace is skipped (a XAML element always needs a prefixed namespace). Results are distinct and
        /// Ordinal-sorted so completion is deterministic.
        /// </summary>
        public IReadOnlyList<string> GetUsingNamespaces()
        {
            var result = new SortedSet<string>(StringComparer.Ordinal);
            CollectUsableNamespaces(_compilation.Assembly.GlobalNamespace, result);
            return result.ToList();
        }

        /// <summary>
        /// The distinct CLR namespaces from REFERENCED assemblies (framework + libraries) usable as XAML
        /// elements via a <c>using:</c> xmlns — the companion to <see cref="GetUsingNamespaces"/> (which
        /// covers the project's own source namespaces). Together they form the full <c>using:</c> completion
        /// candidate set, matching Visual Studio: a control library referenced as an assembly that registers
        /// no <c>XmlnsDefinitionAttribute</c> is reachable ONLY through <c>xmlns:x="using:Lib.Controls"</c>, so
        /// it must be offered here. Walks the MERGED compilation namespace (source + all references) with the
        /// same instantiable-class rule as the source walk, then removes the source-only namespaces so the two
        /// sets are disjoint (source namespaces rank first in completion). Computed once and cached because the
        /// reference closure (BCL + Windows App SDK projections) is large. Results are distinct and
        /// Ordinal-sorted.
        /// </summary>
        public IReadOnlyList<string> GetReferencedUsingNamespaces()
        {
            if (_referencedUsingNamespaces is not null)
            {
                return _referencedUsingNamespaces;
            }

            var all = new SortedSet<string>(StringComparer.Ordinal);
            CollectUsableNamespaces(_compilation.GlobalNamespace, all);
            all.ExceptWith(GetUsingNamespaces());

            return _referencedUsingNamespaces = all.ToList();
        }

        /// <summary>
        /// The third-party element types available for completion — public classes assignable to
        /// <c>Microsoft.UI.Xaml.DependencyObject</c> from REFERENCED assemblies (NuGet packages, control
        /// libraries) that are NOT declared in the project's own source. These are the controls a developer
        /// adds by referencing a package (e.g. the Windows Community Toolkit's <c>SettingsCard</c>), which
        /// register no <c>XmlnsDefinitionAttribute</c> and so are reachable ONLY through a
        /// <c>using:CLR.Namespace</c> xmlns. Element-name completion offers them alongside the reachable
        /// types and auto-injects the xmlns, matching Visual Studio.
        /// <para>The <c>DependencyObject</c>-assignability filter is the precision gate: it surfaces genuine
        /// framework elements while excluding BCL noise (<c>System.String</c>, collections),
        /// service/helper types (e.g. <c>Microsoft.Extensions.*</c>), and a control library's own enums,
        /// static helpers, and generated <c>XamlTypeInfo</c> plumbing. Candidate namespaces are drawn from
        /// <see cref="GetReferencedUsingNamespaces"/> (referenced, non-source, with ≥1 public class). Returns
        /// an empty list when <c>DependencyObject</c> can't be resolved (a non-WinUI project), so the feature
        /// degrades to no suggestions. Computed once and cached — the reference closure is large.</para>
        /// </summary>
        public IReadOnlyList<INamedTypeSymbol> GetReferencedElementTypes()
        {
            if (_referencedElementTypes is not null)
            {
                return _referencedElementTypes;
            }

            var dependencyObject = _compilation.GetTypeByMetadataName("Microsoft.UI.Xaml.DependencyObject");
            if (dependencyObject is null)
            {
                return _referencedElementTypes = System.Array.Empty<INamedTypeSymbol>();
            }

            var result = new List<INamedTypeSymbol>();
            var seen = new HashSet<INamedTypeSymbol>(SymbolEqualityComparer.Default);
            foreach (var namespaceName in GetReferencedUsingNamespaces())
            {
                var ns = ResolveNamespace(_compilation.GlobalNamespace, namespaceName);
                if (ns is null)
                {
                    continue;
                }

                foreach (var type in ns.GetTypeMembers())
                {
                    if (IsPublicClass(type) &&
                        !SymbolEqualityComparer.Default.Equals(type.ContainingAssembly, _compilation.Assembly) &&
                        IsAssignableTo(type, dependencyObject) &&
                        seen.Add(type))
                    {
                        result.Add(type);
                    }
                }
            }

            return _referencedElementTypes = result;
        }

        /// <summary>
        /// The distinct CLR namespaces reachable through an xmlns URI (<c>using:</c>, <c>clr-namespace:</c>,
        /// or a registered <c>XmlnsDefinitionAttribute</c>). Element-name completion uses this to compute a
        /// scope's already-reachable namespaces so a third-party type in an undeclared namespace can be told
        /// apart from a framework type reachable via the default xmlns.
        /// </summary>
        public IEnumerable<string> ClrNamespacesForUri(string xmlnsUri)
        {
            foreach (var binding in NamespacesFor(xmlnsUri))
            {
                yield return binding.ClrNamespace;
            }
        }

        /// <summary>
        /// The WinUI named colors — the static public property names of <c>Microsoft.UI.Colors</c>
        /// (AliceBlue, CornflowerBlue, …, Transparent — 141 in the current SDK) — that a
        /// <c>Brush</c>/<c>Color</c>-typed attribute value may be set to (e.g. <c>Foreground="Red"</c>).
        /// Resolved at RUNTIME from the referenced Windows App SDK so the list always tracks the SDK in use
        /// (zero drift), in declaration order. Returns an empty list when <c>Microsoft.UI.Colors</c> can't be
        /// resolved (e.g. a project without a WinUI reference), so the feature degrades to no suggestions
        /// rather than failing. Computed once and cached — the result is derived purely from this instance's
        /// immutable compilation, so it can never be stale (same contract as <see cref="GetReferencedUsingNamespaces"/>).
        /// </summary>
        public IReadOnlyList<string> GetNamedColors()
        {
            if (_namedColors is not null)
            {
                return _namedColors;
            }

            var colors = _compilation.GetTypeByMetadataName("Microsoft.UI.Colors");
            if (colors is null)
            {
                return _namedColors = System.Array.Empty<string>();
            }

            var names = colors.GetMembers()
                .OfType<IPropertySymbol>()
                .Where(p => p.IsStatic && p.DeclaredAccessibility == Accessibility.Public)
                .Select(p => p.Name)
                .ToList();

            return _namedColors = names;
        }

        /// <summary>
        /// The WinUI named font weights — the static public property names of
        /// <c>Microsoft.UI.Text.FontWeights</c> (Thin, ExtraLight, Light, SemiLight, Normal, Medium, SemiBold,
        /// Bold, ExtraBold, Black, ExtraBlack — 11 in the current SDK) — that a <c>FontWeight</c>-typed
        /// attribute value may be set to (e.g. <c>FontWeight="SemiBold"</c>). Resolved at RUNTIME from the
        /// referenced Windows App SDK so the list always tracks the SDK in use (zero drift), in declaration
        /// order. Returns an empty list when <c>Microsoft.UI.Text.FontWeights</c> can't be resolved (e.g. a
        /// project without a WinUI reference), so the feature degrades to no suggestions rather than failing.
        /// Computed once and cached — derived purely from this instance's immutable compilation, so it can
        /// never be stale (same contract as <see cref="GetNamedColors"/>).
        /// </summary>
        public IReadOnlyList<string> GetFontWeights()
        {
            if (_fontWeights is not null)
            {
                return _fontWeights;
            }

            var weights = _compilation.GetTypeByMetadataName("Microsoft.UI.Text.FontWeights");
            if (weights is null)
            {
                return _fontWeights = System.Array.Empty<string>();
            }

            var names = weights.GetMembers()
                .OfType<IPropertySymbol>()
                .Where(p => p.IsStatic && p.DeclaredAccessibility == Accessibility.Public)
                .Select(p => p.Name)
                .ToList();

            return _fontWeights = names;
        }

        private static void CollectUsableNamespaces(INamespaceSymbol ns, SortedSet<string> into)
        {
            if (!ns.IsGlobalNamespace &&
                ns.GetTypeMembers().Any(t =>
                    t.TypeKind == TypeKind.Class && !t.IsStatic &&
                    t.DeclaredAccessibility == Accessibility.Public))
            {
                into.Add(ns.ToDisplayString());
            }

            foreach (var child in ns.GetNamespaceMembers())
            {
                CollectUsableNamespaces(child, into);
            }
        }

        /// <summary>
        /// Enumerates the public, instantiable types available under an xmlns URI. This is the raw
        /// candidate set for element-name completion.
        /// </summary>
        public IEnumerable<INamedTypeSymbol> GetTypes(string xmlnsUri)
        {
            var seen = new HashSet<INamedTypeSymbol>(SymbolEqualityComparer.Default);
            foreach (var binding in NamespacesFor(xmlnsUri))
            {
                var ns = ResolveNamespace(binding.Assembly.GlobalNamespace, binding.ClrNamespace);
                if (ns is null)
                {
                    continue;
                }

                foreach (var type in ns.GetTypeMembers())
                {
                    if (IsPublicClass(type) && seen.Add(type))
                    {
                        yield return type;
                    }
                }
            }
        }

        /// <summary>
        /// Enumerates every public type available under an xmlns URI — classes (including static
        /// classes), structs, enums, interfaces, and delegates. Unlike <see cref="GetTypes"/> (which
        /// yields only instantiable classes for element-name completion), this is the candidate set for
        /// type <em>references</em> such as <c>{x:Type}</c> and the owner of <c>{x:Static}</c>, where
        /// enums (e.g. <c>Visibility</c>) and static classes (e.g. <c>Colors</c>) are the usual targets.
        /// </summary>
        public IEnumerable<INamedTypeSymbol> GetAllTypes(string xmlnsUri)
        {
            var seen = new HashSet<INamedTypeSymbol>(SymbolEqualityComparer.Default);
            foreach (var binding in NamespacesFor(xmlnsUri))
            {
                var ns = ResolveNamespace(binding.Assembly.GlobalNamespace, binding.ClrNamespace);
                if (ns is null)
                {
                    continue;
                }

                foreach (var type in ns.GetTypeMembers())
                {
                    if (IsPublicType(type) && seen.Add(type))
                    {
                        yield return type;
                    }
                }
            }
        }

        /// <summary>
        /// The XAML language intrinsic type aliases (e.g. <c>x:String</c> → <c>System.String</c>) paired
        /// with their resolved CLR symbols. These are deliberately NOT enumerated by <see cref="GetTypes"/>
        /// or <see cref="GetAllTypes"/> because the XAML language namespace has no CLR-namespace binding —
        /// the intrinsics are a resolve-on-demand map (see <see cref="ResolveType"/>). Type-reference
        /// completion offers them when the reference's prefix resolves to <see cref="XamlLanguageNamespace"/>
        /// (e.g. <c>x:DataType="x:|"</c>, <c>{x:Type x:|}</c>), matching Visual Studio.
        /// <para><paramref name="allTypeKinds"/> mirrors the <see cref="GetTypes"/> (false) vs
        /// <see cref="GetAllTypes"/> (true) split so intrinsics are kind-filtered IDENTICALLY to CLR types
        /// in the same completion list: a class-only site (e.g. <c>TargetType="x:|"</c>) sees only the
        /// reference-type intrinsics (Object/String/Uri/Type), never value-type aliases (x:Int32, …).</para>
        /// </summary>
        public IEnumerable<KeyValuePair<string, INamedTypeSymbol>> GetXamlIntrinsicTypes(bool allTypeKinds)
        {
            foreach (var pair in XamlIntrinsicTypes)
            {
                if (_compilation.GetTypeByMetadataName(pair.Value) is { } symbol &&
                    (allTypeKinds ? IsPublicType(symbol) : IsPublicClass(symbol)))
                {
                    yield return new KeyValuePair<string, INamedTypeSymbol>(pair.Key, symbol);
                }
            }
        }

        /// <summary>
        /// True when the xmlns URI is understood by this type system — it maps to at least one CLR
        /// namespace that actually contains usable types. Validation uses this to stay silent on
        /// namespaces it cannot model (design-time <c>d:</c>, markup-compat, or third-party namespaces
        /// with no <c>XmlnsDefinitionAttribute</c>), so unknown-type diagnostics fire only where trusted.
        /// </summary>
        public bool IsKnownNamespace(string xmlnsUri) => GetTypes(xmlnsUri).Any();

        /// <summary>
        /// Enumerates the members usable as XAML attributes on <paramref name="type"/>: public settable
        /// properties and public events, walking base types (most-derived wins on name collisions).
        /// </summary>
        public IEnumerable<XamlMemberInfo> GetMembers(INamedTypeSymbol type)
        {
            if (type is null)
            {
                yield break;
            }

            var seen = new HashSet<string>(StringComparer.Ordinal);
            for (INamedTypeSymbol? t = type; t is not null; t = t.BaseType)
            {
                foreach (var member in t.GetMembers())
                {
                    if (member.DeclaredAccessibility != Accessibility.Public || member.IsStatic)
                    {
                        continue;
                    }

                    switch (member)
                    {
                        case IPropertySymbol { SetMethod: { DeclaredAccessibility: Accessibility.Public } } p
                            when !p.IsIndexer && seen.Add(p.Name):
                            yield return new XamlMemberInfo(p.Name, XamlMemberKind.Property, p, p.Type, t);
                            break;

                        case IEventSymbol e when seen.Add(e.Name):
                            yield return new XamlMemberInfo(e.Name, XamlMemberKind.Event, e, e.Type, t);
                            break;
                    }
                }
            }
        }

        /// <summary>Finds a single attribute member by name on a type (settable property or event).</summary>
        public XamlMemberInfo? FindMember(INamedTypeSymbol type, string memberName) =>
            GetMembers(type).FirstOrDefault(m => string.Equals(m.Name, memberName, StringComparison.Ordinal));

        /// <summary>
        /// True when the type or a base type declares any public instance property or event with the
        /// given name. Deliberately more lenient than <see cref="GetMembers"/> (which requires a public
        /// setter) so validation does not flag XAML-settable get-only properties that rely on a type
        /// converter (e.g. <c>Grid.ColumnDefinitions="Auto,*"</c>). Used to detect misspelled attributes.
        /// </summary>
        public bool HasMember(INamedTypeSymbol type, string memberName)
        {
            if (type is null || string.IsNullOrEmpty(memberName))
            {
                return false;
            }

            for (INamedTypeSymbol? t = type; t is not null; t = t.BaseType)
            {
                foreach (var member in t.GetMembers(memberName))
                {
                    if (member.DeclaredAccessibility == Accessibility.Public && !member.IsStatic &&
                        member is IPropertySymbol or IEventSymbol)
                    {
                        return true;
                    }
                }
            }

            return false;
        }

        /// <summary>
        /// Property-element validation: does <paramref name="type"/> (or a base type) expose a public,
        /// non-static instance PROPERTY named <paramref name="memberName"/>? Unlike <see cref="HasMember"/>
        /// this excludes events, which cannot be set with property-element syntax (<c>&lt;Button.Click&gt;</c>).
        /// </summary>
        public bool HasProperty(INamedTypeSymbol type, string memberName)
        {
            if (type is null || string.IsNullOrEmpty(memberName))
            {
                return false;
            }

            for (INamedTypeSymbol? t = type; t is not null; t = t.BaseType)
            {
                foreach (var member in t.GetMembers(memberName))
                {
                    if (member.DeclaredAccessibility == Accessibility.Public && !member.IsStatic &&
                        member is IPropertySymbol)
                    {
                        return true;
                    }
                }
            }

            return false;
        }

        /// <summary>
        /// Candidate member NAMES for a misspelled ATTRIBUTE on <paramref name="type"/>, mirroring
        /// <see cref="HasMember"/>: every public, non-static instance property (INCLUDING get-only ones that
        /// are XAML-settable through a type converter, e.g. <c>ColumnDefinitions</c>) plus every public
        /// instance event. Deliberately broader than <see cref="GetMembers"/> (which requires a public
        /// setter) so a "did you mean …?" quick fix can suggest exactly the names validation accepts.
        /// </summary>
        public IEnumerable<string> GetAttributeCandidateNames(INamedTypeSymbol type)
        {
            if (type is null)
            {
                yield break;
            }

            var seen = new HashSet<string>(StringComparer.Ordinal);
            for (INamedTypeSymbol? t = type; t is not null; t = t.BaseType)
            {
                foreach (var member in t.GetMembers())
                {
                    if (member.DeclaredAccessibility != Accessibility.Public || member.IsStatic)
                    {
                        continue;
                    }

                    if (member is IPropertySymbol { IsIndexer: false } p && seen.Add(p.Name))
                    {
                        yield return p.Name;
                    }
                    else if (member is IEventSymbol e && seen.Add(e.Name))
                    {
                        yield return e.Name;
                    }
                }
            }
        }

        /// <summary>
        /// Candidate member NAMES for a misspelled PROPERTY ELEMENT on <paramref name="owner"/>, mirroring
        /// <see cref="HasProperty"/> + <see cref="HasAttachedMember"/>: every public, non-static instance
        /// property (get-only INCLUDED, e.g. the collection property <c>Grid.RowDefinitions</c>) plus this
        /// owner's attached properties. Excludes events (not settable in element form). Deliberately broader
        /// than <see cref="GetMembers"/> so a "did you mean …?" quick fix can suggest exactly the names
        /// property-element validation accepts.
        /// </summary>
        public IEnumerable<string> GetPropertyElementCandidateNames(INamedTypeSymbol owner)
        {
            if (owner is null)
            {
                yield break;
            }

            var seen = new HashSet<string>(StringComparer.Ordinal);
            for (INamedTypeSymbol? t = owner; t is not null; t = t.BaseType)
            {
                foreach (var member in t.GetMembers())
                {
                    if (member is IPropertySymbol { IsIndexer: false } p && !p.IsStatic &&
                        p.DeclaredAccessibility == Accessibility.Public && seen.Add(p.Name))
                    {
                        yield return p.Name;
                    }
                }
            }

            foreach (var attached in GetAttachedProperties(owner))
            {
                if (seen.Add(attached.Name))
                {
                    yield return attached.Name;
                }
            }
        }

        /// <summary>
        /// Enumerates the attached properties declared by <paramref name="owner"/> — the WinUI pattern of
        /// a static <c>GetXxx(DependencyObject)</c> / <c>SetXxx(DependencyObject, T)</c> pair (e.g.
        /// <c>Grid.Row</c>, <c>Canvas.Left</c>). Feeds attached-property attribute completion.
        /// </summary>
        public IEnumerable<XamlMemberInfo> GetAttachedProperties(INamedTypeSymbol owner)
        {
            if (owner is null)
            {
                yield break;
            }

            var setters = new Dictionary<string, IMethodSymbol>(StringComparer.Ordinal);
            var getters = new Dictionary<string, IMethodSymbol>(StringComparer.Ordinal);

            for (INamedTypeSymbol? t = owner; t is not null; t = t.BaseType)
            {
                foreach (var method in t.GetMembers().OfType<IMethodSymbol>())
                {
                    if (!method.IsStatic || method.DeclaredAccessibility != Accessibility.Public)
                    {
                        continue;
                    }

                    if (method.Name.StartsWith("Get", StringComparison.Ordinal) &&
                        method.Parameters.Length == 1 &&
                        !method.ReturnsVoid)
                    {
                        var name = method.Name.Substring(3);
                        if (!getters.ContainsKey(name))
                        {
                            getters[name] = method;
                        }
                    }
                    else if (method.Name.StartsWith("Set", StringComparison.Ordinal) &&
                             method.Parameters.Length == 2 &&
                             method.ReturnsVoid)
                    {
                        var name = method.Name.Substring(3);
                        if (!setters.ContainsKey(name))
                        {
                            setters[name] = method;
                        }
                    }
                }
            }

            foreach (var pair in getters)
            {
                if (setters.ContainsKey(pair.Key))
                {
                    yield return new XamlMemberInfo(
                        pair.Key, XamlMemberKind.AttachedProperty, pair.Value, pair.Value.ReturnType, owner);
                }
            }
        }

        /// <summary>
        /// Lenient check for attached-property attribute validation: does <paramref name="owner"/> (or a
        /// base type) expose a public static <c>Get{member}</c> (1 arg, non-void) or <c>Set{member}</c>
        /// (2 args, void) accessor? Accepting EITHER half — rather than requiring a matched pair as
        /// <see cref="GetAttachedProperties"/> does — keeps the validator from flagging real attached
        /// members that happen to declare only one public accessor.
        /// </summary>
        public bool HasAttachedMember(INamedTypeSymbol owner, string member)
            => GetAttachedMemberType(owner, member) is not null;

        /// <summary>
        /// Enumerates the members bindable via <c>{x:Bind}</c> on <paramref name="type"/>: public
        /// instance properties (with a getter), fields, and ordinary methods. Walks base classes and,
        /// for an interface type, its inherited interfaces (most-derived wins on name collisions).
        /// Members declared on <see cref="object"/> are excluded to keep the list focused.
        /// </summary>
        /// <summary>
        /// Enumerates the members bindable via <c>{x:Bind}</c> on <paramref name="type"/> — public
        /// instance properties/fields and ordinary methods (methods enable event- and function-binding),
        /// walking base types. When <paramref name="includeRootNonPublic"/> is set, non-public members
        /// declared on <paramref name="type"/> itself are also returned: an <c>x:Bind</c> whose root is the
        /// page's <c>x:Class</c> (or a template's <c>x:DataType</c>) can reach that type's private members
        /// because the generated binding code lives inside it. Inherited members stay public-only.
        /// </summary>
        public IEnumerable<ISymbol> GetBindableMembers(ITypeSymbol? type, bool includeRootNonPublic = false)
        {
            if (type is null)
            {
                yield break;
            }

            var seen = new HashSet<string>(StringComparer.Ordinal);
            bool isRoot = true;
            foreach (var t in SelfAndBases(type))
            {
                bool allowNonPublic = includeRootNonPublic && isRoot;
                foreach (var member in t.GetMembers())
                {
                    if ((member.DeclaredAccessibility != Accessibility.Public && !allowNonPublic) ||
                        member.IsStatic || member.IsImplicitlyDeclared)
                    {
                        continue;
                    }

                    switch (member)
                    {
                        case IPropertySymbol { IsIndexer: false, GetMethod: not null } p when seen.Add(p.Name):
                            yield return p;
                            break;

                        case IFieldSymbol f when seen.Add(f.Name):
                            yield return f;
                            break;

                        case IMethodSymbol { MethodKind: MethodKind.Ordinary } m when seen.Add(m.Name):
                            yield return m;
                            break;
                    }
                }

                isRoot = false;
            }
        }

        /// <summary>
        /// Enumerates every callable method available to an <c>x:Bind</c> root, preserving overloads so
        /// function-binding validation can check argument counts. Non-public methods are allowed only on
        /// the root type, matching <see cref="GetBindableMembers"/>.
        /// </summary>
        public IEnumerable<IMethodSymbol> GetBindableMethods(ITypeSymbol? type, bool includeRootNonPublic = false)
        {
            if (type is null)
            {
                yield break;
            }

            var seenNames = new HashSet<string>(StringComparer.Ordinal);
            bool isRoot = true;
            foreach (var t in SelfAndBases(type))
            {
                bool allowNonPublic = includeRootNonPublic && isRoot;
                var methods = t.GetMembers().OfType<IMethodSymbol>()
                    .Where(method =>
                        method.MethodKind == MethodKind.Ordinary &&
                        !method.IsStatic &&
                        !method.IsImplicitlyDeclared &&
                        (method.DeclaredAccessibility == Accessibility.Public || allowNonPublic))
                    .ToArray();
                foreach (var method in methods)
                {
                    if (!seenNames.Contains(method.Name))
                    {
                        yield return method;
                    }
                }

                foreach (var name in methods.Select(method => method.Name))
                {
                    seenNames.Add(name);
                }

                isRoot = false;
            }
        }

        /// <summary>Returns the value type of an attached-property accessor, accepting either accessor half.</summary>
        public ITypeSymbol? GetAttachedMemberType(INamedTypeSymbol owner, string member)
        {
            if (owner is null || string.IsNullOrEmpty(member))
            {
                return null;
            }

            for (INamedTypeSymbol? t = owner; t is not null; t = t.BaseType)
            {
                foreach (var method in t.GetMembers())
                {
                    if (method is not IMethodSymbol { IsStatic: true, DeclaredAccessibility: Accessibility.Public } m)
                    {
                        continue;
                    }

                    if (string.Equals(m.Name, "Get" + member, StringComparison.Ordinal) &&
                        m.Parameters.Length == 1 && !m.ReturnsVoid)
                    {
                        return m.ReturnType;
                    }

                    if (string.Equals(m.Name, "Set" + member, StringComparison.Ordinal) &&
                        m.Parameters.Length == 2 && m.ReturnsVoid)
                    {
                        return m.Parameters[1].Type;
                    }
                }
            }

            return null;
        }

        /// <summary>The value type produced by a bindable member (property/field type, or method return).</summary>
        public static ITypeSymbol? GetMemberType(ISymbol member) => member switch
        {
            IPropertySymbol p => p.Type,
            IFieldSymbol f => f.Type,
            IMethodSymbol m => m.ReturnType,
            _ => null,
        };

        /// <summary>
        /// Resolves the declared type of a public instance property by name, walking base types. Unlike
        /// <see cref="GetMembers"/> this includes get-only properties (e.g. the collection property
        /// <c>Grid.RowDefinitions</c>), so the content of a property element can be typed.
        /// </summary>
        public ITypeSymbol? GetPropertyType(INamedTypeSymbol type, string propertyName)
        {
            if (type is null || string.IsNullOrEmpty(propertyName))
            {
                return null;
            }

            for (INamedTypeSymbol? t = type; t is not null; t = t.BaseType)
            {
                foreach (var member in t.GetMembers(propertyName))
                {
                    if (member is IPropertySymbol { IsStatic: false, IsIndexer: false, DeclaredAccessibility: Accessibility.Public } p)
                    {
                        return p.Type;
                    }
                }
            }

            return null;
        }

        /// <summary>
        /// The type of the elements accepted as XAML child content of <paramref name="type"/>: resolves the
        /// <c>[ContentProperty]</c> (walking the base chain for the most-derived declaration, since XAML
        /// inherits it), then that property's type — unwrapped to its collection element type when it is a
        /// collection (so a panel's <c>UIElementCollection</c> yields <c>UIElement</c>). Returns null when the
        /// type declares no content property or it cannot be resolved. An <c>object</c> content property
        /// (e.g. <c>ContentControl.Content</c>) returns <see cref="SpecialType.System_Object"/>, which callers
        /// treat as "no narrowing" (any child is valid).
        /// </summary>
        public ITypeSymbol? GetContentPropertyType(INamedTypeSymbol type)
        {
            if (type is null)
            {
                return null;
            }

            for (INamedTypeSymbol? t = type; t is not null; t = t.BaseType)
            {
                foreach (var attr in t.GetAttributes())
                {
                    if (attr.AttributeClass?.Name != "ContentPropertyAttribute")
                    {
                        continue;
                    }

                    string? propertyName = null;
                    foreach (var na in attr.NamedArguments)
                    {
                        if (na.Key == "Name" && na.Value.Value is string s)
                        {
                            propertyName = s;
                            break;
                        }
                    }

                    if (propertyName is null && attr.ConstructorArguments.Length == 1 &&
                        attr.ConstructorArguments[0].Value is string cs)
                    {
                        propertyName = cs;
                    }

                    if (string.IsNullOrEmpty(propertyName))
                    {
                        return null;
                    }

                    var propertyType = GetPropertyType(type, propertyName!);
                    if (propertyType is null)
                    {
                        return null;
                    }

                    return GetCollectionElementType(propertyType) ?? propertyType;
                }
            }

            return null;
        }

        /// <summary>
        /// If <paramref name="type"/> is an array or a generic collection (implements
        /// <see cref="IEnumerable{T}"/>), returns the element type <c>T</c>; otherwise null. Used to type
        /// the child elements accepted inside a collection property element.
        /// </summary>
        public static ITypeSymbol? GetCollectionElementType(ITypeSymbol? type)
        {
            if (type is null)
            {
                return null;
            }

            if (type is IArrayTypeSymbol array)
            {
                return array.ElementType;
            }

            IEnumerable<INamedTypeSymbol> interfaces = type.AllInterfaces;
            if (type is INamedTypeSymbol { TypeKind: TypeKind.Interface } iface)
            {
                interfaces = new[] { iface }.Concat(interfaces);
            }

            foreach (var i in interfaces)
            {
                if (i is { IsGenericType: true, TypeArguments.Length: 1 } &&
                    i.ConstructedFrom.SpecialType == SpecialType.System_Collections_Generic_IEnumerable_T)
                {
                    return i.TypeArguments[0];
                }
            }

            return null;
        }

        /// <summary>
        /// True when <paramref name="candidate"/> is <paramref name="target"/> or derives from it
        /// (class base chain). Used to scope property-element child completion to assignable types.
        /// </summary>
        public static bool IsAssignableTo(ITypeSymbol candidate, ITypeSymbol target)
        {
            foreach (var t in SelfAndBases(candidate))
            {
                if (SymbolEqualityComparer.Default.Equals(t, target))
                {
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// The type and its inheritance chain to draw members from: for a class, the base-type chain up
        /// to (but excluding) <see cref="object"/>; for an interface, the interface plus all it inherits.
        /// </summary>
        private static IEnumerable<ITypeSymbol> SelfAndBases(ITypeSymbol type)
        {
            if (type.TypeKind == TypeKind.Interface)
            {
                yield return type;
                foreach (var inherited in type.AllInterfaces)
                {
                    yield return inherited;
                }

                yield break;
            }

            for (ITypeSymbol? t = type; t is not null && t.SpecialType != SpecialType.System_Object; t = t.BaseType)
            {
                yield return t;
            }
        }

        // --- namespace resolution ----------------------------------------------------------------

        private IEnumerable<NamespaceBinding> NamespacesFor(string? xmlnsUri)
        {
            if (string.IsNullOrEmpty(xmlnsUri))
            {
                yield break;
            }

            if (xmlnsUri!.StartsWith(UsingScheme, StringComparison.Ordinal))
            {
                var clrNamespace = xmlnsUri.Substring(UsingScheme.Length).Trim();
                foreach (var asm in _assemblies)
                {
                    yield return new NamespaceBinding(asm, clrNamespace);
                }

                yield break;
            }

            if (xmlnsUri.StartsWith(ClrNamespaceScheme, StringComparison.Ordinal))
            {
                foreach (var binding in ParseClrNamespace(xmlnsUri))
                {
                    yield return binding;
                }

                yield break;
            }

            if (_xmlnsMap.TryGetValue(xmlnsUri, out var bindings))
            {
                foreach (var binding in bindings)
                {
                    yield return binding;
                }
            }
        }

        private IEnumerable<NamespaceBinding> ParseClrNamespace(string uri)
        {
            // clr-namespace:Some.Ns[;assembly=AsmName]
            var body = uri.Substring(ClrNamespaceScheme.Length);
            string clrNamespace = body;
            string? assemblyName = null;

            int semi = body.IndexOf(';');
            if (semi >= 0)
            {
                clrNamespace = body.Substring(0, semi).Trim();
                var rest = body.Substring(semi + 1);
                const string assemblyKey = "assembly=";
                int idx = rest.IndexOf(assemblyKey, StringComparison.OrdinalIgnoreCase);
                if (idx >= 0)
                {
                    assemblyName = rest.Substring(idx + assemblyKey.Length).Trim();
                }
            }

            IEnumerable<IAssemblySymbol> candidates = assemblyName is { Length: > 0 }
                ? _assemblies.Where(a => string.Equals(a.Name, assemblyName, StringComparison.OrdinalIgnoreCase))
                : _assemblies;

            foreach (var asm in candidates)
            {
                yield return new NamespaceBinding(asm, clrNamespace);
            }
        }

        private static INamedTypeSymbol? FindType(NamespaceBinding binding, string localName)
        {
            var ns = ResolveNamespace(binding.Assembly.GlobalNamespace, binding.ClrNamespace);
            return ns?.GetTypeMembers(localName).FirstOrDefault();
        }

        private static INamespaceSymbol? ResolveNamespace(INamespaceSymbol root, string dotted)
        {
            var current = root;
            if (string.IsNullOrEmpty(dotted))
            {
                return current;
            }

            foreach (var part in dotted.Split('.'))
            {
                current = current.GetNamespaceMembers()
                    .FirstOrDefault(n => string.Equals(n.Name, part, StringComparison.Ordinal));
                if (current is null)
                {
                    return null;
                }
            }

            return current;
        }

        private static bool IsPublicClass(INamedTypeSymbol type) =>
            type.DeclaredAccessibility == Accessibility.Public &&
            type.TypeKind == TypeKind.Class &&
            !type.IsStatic;

        private static bool IsPublicType(INamedTypeSymbol type) =>
            type.DeclaredAccessibility == Accessibility.Public &&
            type.TypeKind is TypeKind.Class or TypeKind.Struct or TypeKind.Enum
                or TypeKind.Interface or TypeKind.Delegate;

        private static Dictionary<string, List<NamespaceBinding>> BuildXmlnsMap(
            ImmutableArray<IAssemblySymbol> assemblies)
        {
            var map = new Dictionary<string, List<NamespaceBinding>>(StringComparer.Ordinal);

            foreach (var asm in assemblies)
            {
                foreach (var attr in asm.GetAttributes())
                {
                    if (attr.AttributeClass?.Name != "XmlnsDefinitionAttribute" ||
                        attr.ConstructorArguments.Length < 2)
                    {
                        continue;
                    }

                    if (attr.ConstructorArguments[0].Value is not string xmlNamespace ||
                        attr.ConstructorArguments[1].Value is not string clrNamespace)
                    {
                        continue;
                    }

                    // An optional AssemblyName named-argument can retarget the CLR namespace to another
                    // assembly; default to the declaring assembly.
                    var target = asm;
                    foreach (var named in attr.NamedArguments)
                    {
                        if (string.Equals(named.Key, "AssemblyName", StringComparison.Ordinal) &&
                            named.Value.Value is string retarget)
                        {
                            target = assemblies.FirstOrDefault(
                                a => string.Equals(a.Name, retarget, StringComparison.OrdinalIgnoreCase)) ?? asm;
                        }
                    }

                    if (!map.TryGetValue(xmlNamespace, out var list))
                    {
                        list = new List<NamespaceBinding>();
                        map[xmlNamespace] = list;
                    }

                    list.Add(new NamespaceBinding(target, clrNamespace));
                }
            }

            return map;
        }

        /// <summary>
        /// Adds the WinUI presentation-namespace convention mapping when the referenced assemblies carry
        /// no <c>XmlnsDefinitionAttribute</c> for it (the common case). Each known root CLR namespace is
        /// expanded to every descendant namespace present in the assemblies, so the mapping follows the
        /// actual SDK. A real attribute-declared mapping always wins and short-circuits this.
        /// </summary>
        private static void AddConventionNamespaces(
            Dictionary<string, List<NamespaceBinding>> map, ImmutableArray<IAssemblySymbol> assemblies)
        {
            if (map.ContainsKey(PresentationNamespace))
            {
                return;
            }

            var bindings = new List<NamespaceBinding>();
            foreach (var asm in assemblies)
            {
                foreach (var root in PresentationRoots)
                {
                    var rootNs = ResolveNamespace(asm.GlobalNamespace, root);
                    if (rootNs is null)
                    {
                        continue;
                    }

                    foreach (var ns in EnumerateSelfAndDescendants(rootNs))
                    {
                        bindings.Add(new NamespaceBinding(asm, ns.ToDisplayString()));
                    }
                }
            }

            if (bindings.Count > 0)
            {
                map[PresentationNamespace] = bindings;
            }
        }

        private static IEnumerable<INamespaceSymbol> EnumerateSelfAndDescendants(INamespaceSymbol ns)
        {
            yield return ns;
            foreach (var child in ns.GetNamespaceMembers())
            {
                foreach (var descendant in EnumerateSelfAndDescendants(child))
                {
                    yield return descendant;
                }
            }
        }

        private readonly record struct NamespaceBinding(IAssemblySymbol Assembly, string ClrNamespace);
    }

    /// <summary>The kind of XAML member a <see cref="XamlMemberInfo"/> describes.</summary>
    public enum XamlMemberKind
    {
        /// <summary>A settable instance property (usable as an attribute or property element).</summary>
        Property,

        /// <summary>An event (usable as an attribute mapping to a handler).</summary>
        Event,

        /// <summary>An attached property (a static Get/Set pair, e.g. <c>Grid.Row</c>).</summary>
        AttachedProperty,
    }

    /// <summary>
    /// A resolved XAML-relevant member: its name, kind, the underlying Roslyn symbol, its value type,
    /// and the type that declared it. Deliberately lightweight so completion/hover can render it.
    /// </summary>
    public sealed class XamlMemberInfo
    {
        internal XamlMemberInfo(
            string name,
            XamlMemberKind kind,
            ISymbol symbol,
            ITypeSymbol? type,
            INamedTypeSymbol declaringType)
        {
            Name = name;
            Kind = kind;
            Symbol = symbol;
            Type = type;
            DeclaringType = declaringType;
        }

        /// <summary>The XAML-facing member name (e.g. <c>Content</c>, <c>Click</c>, <c>Row</c>).</summary>
        public string Name { get; }

        /// <summary>Whether this is a property, event, or attached property.</summary>
        public XamlMemberKind Kind { get; }

        /// <summary>The underlying Roslyn symbol (property, event, or the attached-property getter).</summary>
        public ISymbol Symbol { get; }

        /// <summary>The member's value type (property type, event handler type, attached-property type).</summary>
        public ITypeSymbol? Type { get; }

        /// <summary>The type that declares this member (may be a base type of the queried type).</summary>
        public INamedTypeSymbol DeclaringType { get; }
    }
}
