using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Surface;

/// <summary>What the cleaner does with one <c>{x:Bind}</c> attribute when sample data is on.</summary>
/// <param name="Value">Replacement attribute value; null drops the attribute.</param>
/// <param name="Tag">Sample-rows marker for <see cref="SampleListFiller"/> to add as <c>Tag</c>; null for none.</param>
internal sealed record BindSample(string? Value, string? Tag);

/// <summary>Generated sample data for one document, consumed by <see cref="XamlCleaner"/>.</summary>
internal sealed class SamplePlan
{
    public Dictionary<XAttribute, BindSample> Binds { get; } = new();

    /// <summary>Attributes to add for values the code-behind assigns to named elements.</summary>
    public List<(XElement element, XName name, string value)> Adds { get; } = new();
}

/// <summary>
/// Generates sample values for a page from types alone — nothing in the app is executed or read at runtime.
/// For each <c>{x:Bind}</c> it resolves the binding path against the page class or the template's
/// <c>x:DataType</c> through <see cref="SampleTypeModel"/> (when available), then produces a value from the
/// type, falling back to name conventions and finally to the humanized member name. Bound lists get
/// generated rows (dictionaries keyed by the template's binding paths), and the template's <c>{x:Bind}</c>s
/// become <c>{Binding}</c>s so each row shows its own values. Assignments to named elements in the page's
/// code-behind (outside event handlers) are typed the same way. Deterministic; never throws.
/// </summary>
internal static class SamplePlanner
{
    private static readonly XNamespace Xaml = "http://schemas.microsoft.com/winfx/2006/xaml";
    private static readonly XNamespace Design = "http://schemas.microsoft.com/expression/blend/2008";

    internal const int Rows = 3;

    /// <summary>Object-typed properties that display text (string-typed properties always qualify).</summary>
    private static readonly HashSet<string> TextObjectProperties = new(StringComparer.Ordinal)
    {
        "Content", "Header", "Title", "Subtitle", "Description", "Label", "OnContent", "OffContent", "Message",
        "Footer", "PlaceholderText", "Text",
    };

    /// <summary>Boolean properties worth turning on in a preview; others keep their defaults.</summary>
    private static readonly HashSet<string> PreviewBoolProperties = new(StringComparer.Ordinal)
    {
        "IsChecked", "IsOn", "IsEnabled", "IsActive", "IsExpanded", "IsSelected",
    };

    /// <summary>Function names that just format their argument; the argument names the value instead.</summary>
    private static readonly HashSet<string> FormatterNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "Format", "ToString", "Convert", "Display", "Show", "Hide", "Text", "Str", "ToText", "Visible", "Collapsed",
    };

    /// <summary><c>Object</c>: a property typed as one of the app's own classes (a control's <c>Aircraft</c>, <c>Order</c>).</summary>
    internal enum TargetKind { None, Text, Bool, Number, Visibility, Items, Object }

    /// <summary>A resolved binding path: its type (null when unknown) and the member name that labels it.</summary>
    private readonly record struct Resolved(ITypeSymbol? Type, string Name, bool IsFunction, bool IsSimple, bool IsElementRef);

    private sealed class Context
    {
        public required XElement Root { get; init; }
        public SampleTypeModel? Model { get; init; }
        public INamedTypeSymbol? RootType { get; init; }
        public required Dictionary<string, XElement> Named { get; init; }
    }

    public static SamplePlan Plan(XElement root, SampleTypeModel? model)
    {
        var plan = new SamplePlan();
        try
        {
            var rootClass = (string?)root.Attribute(Xaml + "Class");
            var named = new Dictionary<string, XElement>(StringComparer.Ordinal);
            foreach (var el in root.DescendantsAndSelf())
            {
                var name = (string?)el.Attribute(Xaml + "Name") ?? (string?)el.Attribute("Name");
                if (!string.IsNullOrEmpty(name))
                {
                    named.TryAdd(name, el);
                }
            }

            var ctx = new Context
            {
                Root = root,
                Model = model,
                RootType = rootClass is null ? null : model?.FindType(rootClass),
                Named = named,
            };

            foreach (var el in root.DescendantsAndSelf().ToList())
            {
                foreach (var a in el.Attributes().ToList())
                {
                    if (!a.IsNamespaceDeclaration && IsXBind(el, a.Value))
                    {
                        try
                        {
                            plan.Binds[a] = PlanBind(ctx, el, a);
                        }
                        catch (Exception ex)
                        {
                            App.Log($"SAMPLE: {el.Name.LocalName}.{a.Name.LocalName}: {ex.GetType().Name}: {ex.Message}");
                        }
                    }
                }
            }

            if (model is not null && rootClass is not null)
            {
                PlanCodeBehind(ctx, rootClass, plan);
            }
        }
        catch (Exception ex)
        {
            App.Log($"SAMPLE: planning failed: {ex.GetType().Name}: {ex.Message}");
        }
        return plan;
    }

    // ---- {x:Bind} ---------------------------------------------------------------------------------------

    private static BindSample PlanBind(Context ctx, XElement el, XAttribute a)
    {
        var drop = new BindSample(null, null);
        if (a.Name.Namespace != XNamespace.None || a.Name.LocalName.Contains('.') ||
            el.Attribute(Design + a.Name.LocalName) is not null ||
            !XamlCleaner.TryParseBind(a.Value, out var path, out var named))
        {
            return drop; // attached property, d: value wins, or unparsable
        }

        var (kind, propName) = (TargetKindOf(ctx, el, a.Name.LocalName), a.Name.LocalName);
        if (kind == TargetKind.None)
        {
            return drop;
        }

        var template = NearestTemplate(el);
        var scope = template is null ? ctx.RootType : TemplateType(ctx, template);
        var r = Resolve(ctx, el, scope, template is null, path);
        if (r.IsElementRef)
        {
            return drop;
        }

        if (kind == TargetKind.Items)
        {
            if (el.Attribute("Tag") is not null)
            {
                return drop;
            }
            var itemType = r.Type is null ? null : SampleTypeModel.ElementType(r.Type);
            return new BindSample(null, ListMarker(ctx, el, itemType, r.Name));
        }

        if (kind == TargetKind.Object)
        {
            // Inside an item template the row is a real instance of the item type (see SampleObjects) when the
            // app is built, so hand the row (or a simple member path into it) to the control.
            if (template is null || r.IsFunction)
            {
                return drop;
            }
            var p = path?.Trim() ?? "";
            if (p.Length == 0 || p == ".")
            {
                return new BindSample("{Binding}", null);
            }
            return Regex.IsMatch(p, @"^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$") ? new BindSample($"{{Binding {p}}}", null) : drop;
        }

        if (kind == TargetKind.Text)
        {
            foreach (var key in new[] { "FallbackValue", "TargetNullValue" })
            {
                if (named.TryGetValue(key, out var literal) && literal.Length > 0 && literal[0] != '{')
                {
                    return new BindSample(literal, null);
                }
            }

            var text = TextValue(r.Type, r.Name, 0);
            if (template is not null && RowBindingPath(path, r) is { } rowPath)
            {
                return new BindSample($"{{Binding {rowPath}, FallbackValue='{QuoteSafe(text)}'}}", null);
            }
            return new BindSample(EscapeLiteral(text), null);
        }

        var literalValue = ScalarValue(kind, propName, r.Type, r.Name);
        return new BindSample(literalValue, null);
    }

    /// <summary>The <c>{Binding}</c> path for a template text binding that reads its value from the row, or null.</summary>
    private static string? RowBindingPath(string? path, Resolved r)
    {
        if (r.IsFunction || !r.IsSimple || string.IsNullOrWhiteSpace(path))
        {
            return null;
        }
        var p = path.Trim();
        return Regex.IsMatch(p, @"^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$") ? p : null;
    }

    private static XElement? NearestTemplate(XElement el) =>
        el.AncestorsAndSelf().FirstOrDefault(x => x.Name.LocalName == "DataTemplate");

    private static ITypeSymbol? TemplateType(Context ctx, XElement template)
    {
        var dataType = (string?)template.Attribute(Xaml + "DataType");
        return dataType is null ? null : ResolveXamlType(ctx, template, dataType);
    }

    /// <summary>Resolves a XAML type reference (<c>local:Order</c>, <c>x:String</c>) to a source type.</summary>
    private static ITypeSymbol? ResolveXamlType(Context ctx, XElement scope, string reference)
    {
        if (ctx.Model is null)
        {
            return null;
        }

        var (prefix, local) = reference.Contains(':') ? (reference[..reference.IndexOf(':')], reference[(reference.IndexOf(':') + 1)..]) : ("", reference);
        var ns = scope.GetNamespaceOfPrefix(prefix.Length == 0 ? "xmlns" : prefix)?.NamespaceName ?? (prefix.Length == 0 ? scope.GetDefaultNamespace().NamespaceName : "");
        if (ns == Xaml.NamespaceName)
        {
            var special = local switch
            {
                "String" => SpecialType.System_String,
                "Int32" => SpecialType.System_Int32,
                "Double" => SpecialType.System_Double,
                "Boolean" => SpecialType.System_Boolean,
                _ => SpecialType.None,
            };
            return special == SpecialType.None ? null : ctx.Model.Compilation.GetSpecialType(special);
        }

        var clr = ClrNamespace(ns);
        return clr is null ? null : ctx.Model.FindType(clr + "." + local);
    }

    private static string? ClrNamespace(string xmlns)
    {
        if (xmlns.StartsWith("using:", StringComparison.Ordinal))
        {
            return xmlns[6..];
        }
        if (xmlns.StartsWith("clr-namespace:", StringComparison.Ordinal))
        {
            var rest = xmlns[14..];
            int semi = rest.IndexOf(';');
            return semi < 0 ? rest : rest[..semi];
        }
        return null;
    }

    private static Resolved Resolve(Context ctx, XElement el, ITypeSymbol? scope, bool atPage, string? path)
    {
        var p = path?.Trim() ?? "";
        // Leading casts: (local:Order)Selected.Name
        while (p.StartsWith('('))
        {
            int close = MatchingParen(p, 0);
            if (close < 0 || close == p.Length - 1)
            {
                return new Resolved(null, "Value", false, false, false);
            }
            p = p[(close + 1)..].TrimStart('.', ' ');
        }

        if (p.Length == 0)
        {
            return new Resolved(scope, scope?.Name ?? "Item", false, true, false);
        }

        int call = XamlCleaner.IndexOfTopLevel(p, '(');
        if (call > 0)
        {
            return ResolveFunction(ctx, el, scope, p, call);
        }

        var segments = XamlCleaner.SplitTopLevel(p, '.') ?? new List<string> { p };
        var first = StripIndexer(segments[0].Trim());
        // {x:Bind SomeElement.Prop} at page scope reads another named element, not data: leave it alone.
        if (atPage && ctx.Named.ContainsKey(first) && (scope is null || SampleTypeModel.MemberType(scope, first) is null))
        {
            return new Resolved(null, first, false, false, true);
        }

        ITypeSymbol? cur = scope;
        string last = first;
        bool simple = true;
        foreach (var raw in segments)
        {
            var seg = raw.Trim();
            bool indexed = seg.EndsWith(']');
            simple &= !indexed && !seg.Contains('(');
            last = StripIndexer(seg);
            if (cur is null)
            {
                continue;
            }

            var next = SampleTypeModel.MemberType(cur, last);
            if (next is not null && indexed)
            {
                next = SampleTypeModel.ElementType(next) ?? next;
            }
            cur = next;
        }

        return new Resolved(cur is { TypeKind: TypeKind.Error } ? null : cur, last, false, simple, false);
    }

    private static Resolved ResolveFunction(Context ctx, XElement el, ITypeSymbol? scope, string p, int call)
    {
        var head = p[..call].Trim();
        int close = MatchingParen(p, call);
        var args = p[(call + 1)..(close > 0 ? close : p.Length)];
        var firstArg = (XamlCleaner.SplitTopLevel(args, ',') ?? new List<string>()).FirstOrDefault()?.Trim() ?? "";
        string argName = LastIdentifier(firstArg) ?? "Value";

        ITypeSymbol? owner = scope;
        string method;
        int colon = head.IndexOf(':');
        if (colon > 0)
        {
            // helpers:Format.Hours(...) — a static method on a class in an xmlns-mapped namespace.
            var prefix = head[..colon];
            var rest = head[(colon + 1)..];
            int dot = rest.LastIndexOf('.');
            method = dot < 0 ? rest : rest[(dot + 1)..];
            var ns = ClrNamespace(el.GetNamespaceOfPrefix(prefix)?.NamespaceName ?? "");
            owner = dot < 0 || ns is null ? null : ctx.Model?.FindType(ns + "." + rest[..dot]);
        }
        else
        {
            var parts = head.Split('.');
            method = parts[^1];
            foreach (var part in parts[..^1])
            {
                owner = owner is null ? null : SampleTypeModel.MemberType(owner, part.Trim());
            }
        }

        var type = owner is null ? null : SampleTypeModel.MemberType(owner, method);
        var name = FormatterNames.Contains(method) ? argName : method;
        return new Resolved(type is { TypeKind: TypeKind.Error } ? null : type, name, true, false, false);
    }

    private static string? LastIdentifier(string expr)
    {
        var m = Regex.Match(expr, @"([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*$");
        return m.Success ? m.Groups[1].Value : null;
    }

    private static string StripIndexer(string seg)
    {
        int b = seg.IndexOf('[');
        return (b >= 0 ? seg[..b] : seg).Trim();
    }

    private static int MatchingParen(string s, int open)
    {
        int depth = 0;
        for (int i = open; i < s.Length; i++)
        {
            if (s[i] == '(') depth++;
            else if (s[i] == ')' && --depth == 0) return i;
        }
        return -1;
    }

    // ---- target property ----------------------------------------------------------------------------------

    internal static TargetKind TargetKindOf(XElement el, string property) => TargetKindOf(null, el, property);

    private static TargetKind TargetKindOf(Context? ctx, XElement el, string property)
    {
        if (property == "ItemsSource")
        {
            var t = XamlCleaner.ResolveElementType(el);
            if (t is not null)
            {
                return typeof(Microsoft.UI.Xaml.FrameworkElement).IsAssignableFrom(t) &&
                       t.GetProperty("ItemsSource", BindingFlags.Public | BindingFlags.Instance) is not null
                    ? TargetKind.Items
                    : TargetKind.None;
            }
            return ctx?.Model is not null && SourcePropertyType(ctx, el, property) is not null ? TargetKind.Items : TargetKind.None;
        }

        var type = XamlCleaner.ResolveElementType(el);
        if (type is not null)
        {
            PropertyInfo? prop;
            try
            {
                prop = type.GetProperty(property, BindingFlags.Public | BindingFlags.Instance);
            }
            catch (AmbiguousMatchException)
            {
                return TargetKind.None;
            }

            if (prop is null || !prop.CanWrite)
            {
                return TargetKind.None;
            }
            return KindOf(prop.PropertyType, property);
        }

        if (ctx?.Model is null)
        {
            return TargetKind.None;
        }

        var sym = SourcePropertyType(ctx, el, property);
        return sym is null ? TargetKind.None : KindOf(sym, property);
    }

    private static ITypeSymbol? SourcePropertyType(Context ctx, XElement el, string property)
    {
        var clr = ClrNamespace(el.Name.NamespaceName);
        var owner = clr is null ? null : ctx.Model!.FindType(clr + "." + el.Name.LocalName);
        return owner is null ? null : SampleTypeModel.MemberType(owner, property);
    }

    private static TargetKind KindOf(Type t, string property)
    {
        t = Nullable.GetUnderlyingType(t) ?? t;
        if (t == typeof(string)) return TargetKind.Text;
        if (t == typeof(object)) return TextObjectProperties.Contains(property) ? TargetKind.Text : TargetKind.None;
        if (t == typeof(bool)) return TargetKind.Bool;
        if (t == typeof(double) || t == typeof(float) || t == typeof(int) || t == typeof(long)) return TargetKind.Number;
        if (t.FullName == "Microsoft.UI.Xaml.Visibility") return TargetKind.Visibility;
        if ((t.IsClass || t.IsInterface) && !IsPlatformNamespace(t.Namespace)) return TargetKind.Object;
        return TargetKind.None;
    }

    private static bool IsPlatformNamespace(string? ns) =>
        ns is null || ns == "System" || ns.StartsWith("System.", StringComparison.Ordinal) ||
        ns.StartsWith("Microsoft.", StringComparison.Ordinal) || ns.StartsWith("Windows.", StringComparison.Ordinal) ||
        ns.StartsWith("WinRT", StringComparison.Ordinal);

    private static TargetKind KindOf(ITypeSymbol t, string property)
    {
        if (t is INamedTypeSymbol { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T } n) t = n.TypeArguments[0];
        if (property == "ItemsSource") return TargetKind.Items;
        switch (t.SpecialType)
        {
            case SpecialType.System_String: return TargetKind.Text;
            case SpecialType.System_Object: return TextObjectProperties.Contains(property) ? TargetKind.Text : TargetKind.None;
            case SpecialType.System_Boolean: return TargetKind.Bool;
            case SpecialType.System_Double: case SpecialType.System_Single: case SpecialType.System_Int32: case SpecialType.System_Int64:
            case SpecialType.System_Decimal:
                return TargetKind.Number;
        }
        if (t.Name == "Visibility") return TargetKind.Visibility;
        return t.TypeKind is TypeKind.Class or TypeKind.Interface && t.Locations.Any(l => l.IsInSource)
            ? TargetKind.Object
            : TargetKind.None;
    }

    // ---- lists --------------------------------------------------------------------------------------------

    /// <summary><c>__wxp-sample:{label}|{rows JSON}</c> for a list of <paramref name="itemType"/>.</summary>
    private static string ListMarker(Context ctx, XElement list, ITypeSymbol? itemType, string label)
    {
        var paths = new Dictionary<string, (ITypeSymbol? type, string name)>(StringComparer.Ordinal);
        foreach (var template in TemplatesFor(ctx, list, itemType))
        {
            var scope = TemplateType(ctx, template) ?? itemType;
            foreach (var el in template.Descendants())
            {
                if (NearestTemplate(el) != template)
                {
                    continue;
                }
                foreach (var a in el.Attributes())
                {
                    if (a.IsNamespaceDeclaration || a.Name.Namespace != XNamespace.None || !IsXBind(el, a.Value) ||
                        !XamlCleaner.TryParseBind(a.Value, out var path, out _) ||
                        TargetKindOf(ctx, el, a.Name.LocalName) != TargetKind.Text)
                    {
                        continue;
                    }
                    var r = Resolve(ctx, el, scope, false, path);
                    if (RowBindingPath(path, r) is { } rowPath)
                    {
                        paths.TryAdd(rowPath, (r.Type, r.Name));
                    }
                }
            }
        }

        var rows = new List<object>(Rows);
        for (int i = 0; i < Rows; i++)
        {
            if (paths.Count == 0)
            {
                rows.Add(TextValue(itemType, itemType?.Name ?? Singular(label), i));
                continue;
            }

            var row = new Dictionary<string, object>(StringComparer.Ordinal);
            foreach (var (path, (type, name)) in paths)
            {
                var segs = path.Split('.');
                var node = row;
                bool ok = true;
                for (int s = 0; s < segs.Length - 1 && ok; s++)
                {
                    if (!node.TryGetValue(segs[s], out var child))
                    {
                        child = new Dictionary<string, object>(StringComparer.Ordinal);
                        node[segs[s]] = child;
                    }
                    if (child is Dictionary<string, object> d) node = d; else ok = false;
                }
                if (ok && !node.ContainsKey(segs[^1]))
                {
                    node[segs[^1]] = TextValue(type, name, i);
                }
            }
            rows.Add(row);
        }

        var json = JsonSerializer.Serialize(rows);
        if (itemType is not null && ReflectionName(itemType) is { } typeName)
        {
            json = JsonSerializer.Serialize(new Dictionary<string, object> { ["type"] = typeName, ["rows"] = rows });
        }
        return SampleListFiller.TagPrefix + label + "|" + json;
    }

    /// <summary>
    /// <c>Ns.Outer+Inner</c> for an app-defined class or struct (what <see cref="Type.GetType(string)"/> expects),
    /// or null for framework, generic, enum and special types, which rows never need to construct.
    /// </summary>
    internal static string? ReflectionName(ITypeSymbol type)
    {
        if (type is not INamedTypeSymbol named || named.IsGenericType || type.SpecialType != SpecialType.None ||
            type.TypeKind is not (TypeKind.Class or TypeKind.Struct) || !type.Locations.Any(l => l.IsInSource))
        {
            return null;
        }
        var name = named.MetadataName;
        for (var outer = named.ContainingType; outer is not null; outer = outer.ContainingType)
        {
            if (outer.IsGenericType) return null;
            name = outer.MetadataName + "+" + name;
        }
        var ns = named.ContainingNamespace is { IsGlobalNamespace: false } n ? n.ToDisplayString() + "." : "";
        return ns + name;
    }

    /// <summary>The item templates that render <paramref name="list"/>'s rows.</summary>
    private static IEnumerable<XElement> TemplatesFor(Context ctx, XElement list, ITypeSymbol? itemType)
    {
        var found = new List<XElement>();
        foreach (var t in list.Descendants().Where(d => d.Name.LocalName == "DataTemplate"))
        {
            var owner = t.Ancestors().FirstOrDefault(x => x.Attribute("ItemsSource") is not null || x == list);
            if (owner == list)
            {
                found.Add(t);
            }
        }

        foreach (var attr in new[] { "ItemTemplate", "ContentTemplate" })
        {
            var v = (string?)list.Attribute(attr);
            var m = v is null ? null : Regex.Match(v, @"^\{\s*(?:Static|Theme)Resource\s+([^}\s]+)\s*\}$");
            if (m is { Success: true })
            {
                var key = m.Groups[1].Value;
                found.AddRange(ctx.Root.DescendantsAndSelf().Where(e =>
                    e.Name.LocalName == "DataTemplate" && (string?)e.Attribute(Xaml + "Key") == key));
            }
        }

        if (itemType is not null)
        {
            found.AddRange(ctx.Root.Descendants().Where(e =>
                e.Name.LocalName == "DataTemplate" &&
                SymbolEqualityComparer.Default.Equals(TemplateType(ctx, e), itemType)));
        }
        return found.Distinct();
    }

    private static string Singular(string label)
    {
        var l = label.Trim('{', '}');
        if (l.EndsWith("ies", StringComparison.Ordinal)) return l[..^3] + "y";
        if (l.EndsWith("s", StringComparison.Ordinal) && !l.EndsWith("ss", StringComparison.Ordinal)) return l[..^1];
        return l;
    }

    // ---- code-behind --------------------------------------------------------------------------------------

    private static void PlanCodeBehind(Context ctx, string rootClass, SamplePlan plan)
    {
        var done = new HashSet<(XElement, string)>();
        foreach (var (target, prop, value, model, method) in ctx.Model!.Assignments(rootClass))
        {
            try
            {
                if (!ctx.Named.TryGetValue(target, out var el) || IsEventHandlerCode(value, method) ||
                    el.Attribute(prop) is not null || el.Attribute(Design + prop) is not null || !done.Add((el, prop)))
                {
                    continue;
                }

                var kind = TargetKindOf(ctx, el, prop);
                string? literal = kind switch
                {
                    TargetKind.Text => EscapeLiteral(TextOf(value, model, target)),
                    TargetKind.Number => ScalarValue(kind, prop, model.GetTypeInfo(value).Type, LastName(value) ?? prop),
                    TargetKind.Bool => ScalarValue(kind, prop, null, prop),
                    _ => null,
                };

                if (kind == TargetKind.Items && el.Attribute("Tag") is null)
                {
                    var t = model.GetTypeInfo(value).Type;
                    var itemType = t is null or { TypeKind: TypeKind.Error } ? null : SampleTypeModel.ElementType(t);
                    if (itemType is not null)
                    {
                        plan.Adds.Add((el, "Tag", ListMarker(ctx, el, itemType, LastName(value) ?? target)));
                    }
                    continue;
                }

                if (literal is not null)
                {
                    plan.Adds.Add((el, prop, literal));
                }
            }
            catch (Exception ex)
            {
                App.Log($"SAMPLE: code-behind {target}.{prop}: {ex.GetType().Name}: {ex.Message}");
            }
        }
    }

    /// <summary>
    /// True for code that runs in response to user input (a handler with an <c>…EventArgs</c> parameter, or a lambda
    /// subscribed to an event) — such values describe an interaction, not the page's initial state. Load and
    /// navigation handlers are kept.
    /// </summary>
    private static bool IsEventHandlerCode(SyntaxNode node, BaseMethodDeclarationSyntax? method)
    {
        static bool InitialState(string name) =>
            Regex.IsMatch(name, "Load|Navigat|Activat|Init|Construct|Refresh|Populate|Render|Update|Bind", RegexOptions.IgnoreCase);

        foreach (var lambda in node.Ancestors().OfType<AnonymousFunctionExpressionSyntax>())
        {
            if (lambda.Parent is AssignmentExpressionSyntax { RawKind: (int)SyntaxKind.AddAssignmentExpression } sub)
            {
                var ev = sub.Left is MemberAccessExpressionSyntax ma ? ma.Name.Identifier.Text : sub.Left.ToString();
                if (!InitialState(ev)) return true;
            }
        }

        if (method is MethodDeclarationSyntax m &&
            m.ParameterList.Parameters.Any(p => p.Type?.ToString().EndsWith("EventArgs", StringComparison.Ordinal) == true))
        {
            return !InitialState(m.Identifier.Text);
        }
        return false;
    }

    /// <summary>Display text for a code-behind string expression, generating every non-literal part.</summary>
    private static string TextOf(ExpressionSyntax expr, SemanticModel model, string target)
    {
        switch (expr)
        {
            case LiteralExpressionSyntax lit when lit.IsKind(SyntaxKind.StringLiteralExpression):
                return lit.Token.ValueText;
            case InterpolatedStringExpressionSyntax interp:
            {
                var sb = new StringBuilder();
                foreach (var part in interp.Contents)
                {
                    sb.Append(part switch
                    {
                        InterpolatedStringTextSyntax t => t.TextToken.ValueText,
                        InterpolationSyntax h => Hole(h.Expression, model),
                        _ => "",
                    });
                }
                return sb.ToString();
            }
            case ParenthesizedExpressionSyntax p:
                return TextOf(p.Expression, model, target);
            case ConditionalExpressionSyntax c:
                return TextOf(c.WhenTrue, model, target);
            case BinaryExpressionSyntax b when b.IsKind(SyntaxKind.AddExpression):
                return TextOf(b.Left, model, target) + TextOf(b.Right, model, target);
            case BinaryExpressionSyntax b when b.IsKind(SyntaxKind.CoalesceExpression):
                return b.Right is LiteralExpressionSyntax ? TextOf(b.Right, model, target) : TextOf(b.Left, model, target);
            case SwitchExpressionSyntax s when s.Arms.Count > 0:
                return TextOf(s.Arms[0].Expression, model, target);
            case InvocationExpressionSyntax inv when IsStringFormat(inv, out var format, out var args):
                return Regex.Replace(format, @"\{(\d+)(?:[,:][^}]*)?\}", m =>
                {
                    int n = int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
                    return n < args.Count ? Hole(args[n], model) : m.Value;
                });
            default:
                return Hole(expr, model);
        }
    }

    private static bool IsStringFormat(InvocationExpressionSyntax inv, out string format, out List<ExpressionSyntax> args)
    {
        format = "";
        args = new List<ExpressionSyntax>();
        if (inv.Expression is not MemberAccessExpressionSyntax { Name.Identifier.Text: "Format" } ma ||
            ma.Expression.ToString() is not ("string" or "String" or "System.String") ||
            inv.ArgumentList.Arguments.Count == 0)
        {
            return false;
        }

        var all = inv.ArgumentList.Arguments.Select(a => a.Expression).ToList();
        if (all[0] is not LiteralExpressionSyntax lit || !lit.IsKind(SyntaxKind.StringLiteralExpression))
        {
            all.RemoveAt(0); // IFormatProvider overload
            if (all.Count == 0 || all[0] is not LiteralExpressionSyntax lit2 || !lit2.IsKind(SyntaxKind.StringLiteralExpression))
            {
                return false;
            }
            lit = lit2;
        }
        format = lit.Token.ValueText;
        args = all.Skip(1).ToList();
        return true;
    }

    /// <summary>A generated value for one non-literal piece of a code-behind string.</summary>
    private static string Hole(ExpressionSyntax expr, SemanticModel model)
    {
        if (expr is LiteralExpressionSyntax lit)
        {
            return lit.Token.ValueText;
        }
        if (expr is InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax { Name.Identifier.Text: "ToString" } ts })
        {
            expr = ts.Expression;
        }

        ITypeSymbol? type = null;
        try
        {
            type = model.GetTypeInfo(expr).Type;
        }
        catch
        {
            // unresolvable: name-based
        }
        return TextValue(type is { TypeKind: TypeKind.Error } ? null : type, LastName(expr) ?? "Value", 0);
    }

    private static string? LastName(ExpressionSyntax expr) => expr switch
    {
        IdentifierNameSyntax id => id.Identifier.Text,
        MemberAccessExpressionSyntax ma => ma.Name.Identifier.Text,
        InvocationExpressionSyntax inv => LastName(inv.Expression),
        ElementAccessExpressionSyntax ea => LastName(ea.Expression),
        ConditionalAccessExpressionSyntax ca => ca.WhenNotNull is MemberBindingExpressionSyntax mb ? mb.Name.Identifier.Text : LastName(ca.Expression),
        CastExpressionSyntax c => LastName(c.Expression),
        ParenthesizedExpressionSyntax p => LastName(p.Expression),
        PostfixUnaryExpressionSyntax pu => LastName(pu.Operand),
        _ => null,
    };

    // ---- value generation ---------------------------------------------------------------------------------

    /// <summary>
    /// Display text for a value of <paramref name="type"/> named <paramref name="name"/> in row <paramref name="index"/>:
    /// from the type when known, else from the name.
    /// </summary>
    internal static string TextValue(ITypeSymbol? type, string name, int index)
    {
        if (type is INamedTypeSymbol { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T } n)
        {
            type = n.TypeArguments[0];
        }

        if (type is null || type.TypeKind == TypeKind.Error)
        {
            return TextByName(name, index);
        }

        switch (type.SpecialType)
        {
            case SpecialType.System_String:
            case SpecialType.System_Object:
                return TextByName(name, index);
            case SpecialType.System_Boolean:
                return index % 2 == 0 ? "True" : "False";
            case SpecialType.System_Byte: case SpecialType.System_Int16: case SpecialType.System_Int32: case SpecialType.System_Int64:
            case SpecialType.System_UInt16: case SpecialType.System_UInt32: case SpecialType.System_UInt64:
                return IntByName(name, index).ToString("N0", CultureInfo.CurrentCulture);
            case SpecialType.System_Single: case SpecialType.System_Double: case SpecialType.System_Decimal:
                return DoubleByName(name, index).ToString("0.##", CultureInfo.CurrentCulture);
            case SpecialType.System_DateTime:
                return SampleDate(index).ToString("d MMM yyyy", CultureInfo.CurrentCulture);
            case SpecialType.System_Char:
                return ((char)('A' + index % 26)).ToString();
        }

        switch (type.Name)
        {
            case "DateTimeOffset": case "DateOnly":
                return SampleDate(index).ToString("d MMM yyyy", CultureInfo.CurrentCulture);
            case "TimeSpan": case "TimeOnly":
                return $"{2 + index}:{(15 * index) % 60:00}";
            case "Guid":
                return $"00000000-0000-0000-0000-{1001 + index:000000000000}";
            case "Uri":
                return "https://example.com";
        }

        if (type.TypeKind == TypeKind.Enum)
        {
            var members = type.GetMembers().OfType<IFieldSymbol>().Where(f => f.HasConstantValue).ToList();
            return members.Count == 0 ? TextByName(name, index) : Humanize(members[index % members.Count].Name);
        }

        if (SampleTypeModel.ElementType(type) is not null)
        {
            return $"{Rows} {Humanize(name).ToLowerInvariant()}";
        }

        // An object shown as text: its display-name property, else its type name.
        foreach (var display in new[] { "Name", "DisplayName", "Title", "Label", "Text" })
        {
            if (SampleTypeModel.MemberType(type, display) is { SpecialType: SpecialType.System_String })
            {
                return TextByName(display == "Name" || display == "DisplayName" ? type.Name + "Name" : display, index);
            }
        }
        return Humanize(type.Name) + (index > 0 ? $" {index + 1}" : "");
    }

    /// <summary>Text for a string (or unknown) value from its name alone.</summary>
    internal static string TextByName(string name, int index)
    {
        var n = name.ToLowerInvariant();
        if (Regex.IsMatch(n, "(url|uri|link|website|href)$")) return "https://example.com";
        if (n.Contains("email")) return index == 0 ? "name@example.com" : $"name{index + 1}@example.com";
        if (n.Contains("phone")) return $"(555) 010-{100 + index:0000}";
        if (Regex.IsMatch(n, "(date|time|timestamp)$") || Regex.IsMatch(name, "[a-z](At|On)$"))
            return SampleDate(index).ToString("d MMM yyyy", CultureInfo.CurrentCulture);
        if (Regex.IsMatch(n, "(count|total|qty|quantity|amount|number of)")) return IntByName(name, index).ToString("N0", CultureInfo.CurrentCulture);
        if (Regex.IsMatch(n, "(percent|pct)")) return $"{40 + 15 * index}%";
        if (Regex.IsMatch(n, "(^|[^a-z])id$") || name.EndsWith("Id", StringComparison.Ordinal) || name.EndsWith("ID", StringComparison.Ordinal))
            return (1001 + index).ToString(CultureInfo.InvariantCulture);
        var label = Humanize(name);
        return index > 0 ? $"{label} {index + 1}" : label;
    }

    internal static long IntByName(string name, int index)
    {
        var n = name.ToLowerInvariant();
        if (n.EndsWith("id")) return 1001 + index;
        if (n.Contains("year")) return 2026 - index;
        if (n.Contains("percent") || n.Contains("pct")) return Math.Min(100, 40 + 15 * index);
        return 12 + 7 * index;
    }

    internal static double DoubleByName(string name, int index)
    {
        var n = name.ToLowerInvariant();
        if (Regex.IsMatch(n, "percent|pct|rate|availability|progress|utilization|utilisation|score"))
            return 72.5 + 4 * index;
        if (Regex.IsMatch(n, "ratio|fraction|opacity"))
            return 0.72;
        if (Regex.IsMatch(n, "price|cost|amount|total|balance"))
            return 249.99 + 50 * index;
        return 1.5 * (index + 1);
    }

    internal static DateTime SampleDate(int index) => new DateTime(2026, 11, 18).AddDays(index);

    /// <summary>A literal for a non-text target property; null keeps the property's default.</summary>
    private static string? ScalarValue(TargetKind kind, string property, ITypeSymbol? sourceType, string name)
    {
        switch (kind)
        {
            case TargetKind.Visibility:
                return "Visible";
            case TargetKind.Bool:
                return PreviewBoolProperties.Contains(property) ? "True" : null;
            case TargetKind.Number:
            {
                double? v = property switch
                {
                    "Width" => 120,
                    "Height" => 32,
                    "Value" => Regex.IsMatch(name, "percent|pct|rate|availability|progress|utilization", RegexOptions.IgnoreCase) ? 72.5 : 60,
                    "Maximum" => 100,
                    "Minimum" => 0,
                    "Opacity" => 1,
                    _ => null,
                };
                if (v is null && sourceType is { } st && IsNumeric(st))
                {
                    v = DoubleByName(name, 0);
                }
                return v?.ToString(CultureInfo.InvariantCulture);
            }
        }
        return null;
    }

    private static bool IsNumeric(ITypeSymbol t)
    {
        if (t is INamedTypeSymbol { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T } n) t = n.TypeArguments[0];
        return t.SpecialType is SpecialType.System_Int32 or SpecialType.System_Int64 or SpecialType.System_Double or
            SpecialType.System_Single or SpecialType.System_Decimal or SpecialType.System_Int16;
    }

    /// <summary><c>TailNumber</c> → <c>Tail number</c>; <c>_count</c> → <c>Count</c>.</summary>
    internal static string Humanize(string name)
    {
        var n = name.TrimStart('_');
        if (n.StartsWith("m_", StringComparison.Ordinal)) n = n[2..];
        if (n.Length == 0) return "Value";
        var spaced = Regex.Replace(n, @"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|_+", " ").Trim();
        var words = spaced.Split(' ', StringSplitOptions.RemoveEmptyEntries)
            .Select((w, i) => i == 0 ? char.ToUpperInvariant(w[0]) + w[1..] : (w.All(char.IsUpper) && w.Length > 1 ? w : w.ToLowerInvariant()));
        return string.Join(" ", words);
    }

    private static string EscapeLiteral(string text) => text.Length > 0 && text[0] == '{' ? "{}" + text : text;

    private static string QuoteSafe(string text) => text.Replace('\'', '\u2019').Replace('\\', '/').Replace("{", "(").Replace("}", ")");

    private static bool IsXBind(XElement el, string value)
    {
        var v = value.TrimStart();
        if (!v.StartsWith('{')) return false;
        var m = Regex.Match(v, @"^\{\s*(?:(?<p>[\w]+):)?Bind\b");
        if (!m.Success || !m.Groups["p"].Success) return false;
        return el.GetNamespaceOfPrefix(m.Groups["p"].Value) == Xaml;
    }
}
