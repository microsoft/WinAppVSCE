using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Surface;

/// <summary>
/// A chart property the cleaner removed and <see cref="SampleChartFiller"/> restores after load. WinAppSDK charts are
/// wired with <c>{x:Bind}</c> to other named elements (<c>XValues="{x:Bind Month}"</c>, <c>XAxis="{x:Bind MonthX}"</c>)
/// and to page data (<c>Samples ItemsSource="{x:Bind Months}"</c>); neither survives the cleaner as markup.
/// </summary>
/// <param name="Element">x:Name of the element to update (generated when the markup had none).</param>
/// <param name="Property">The property to set.</param>
/// <param name="RefName">The named element to assign, or null when <paramref name="Values"/> is set.</param>
/// <param name="Values">Sample values for the property (a list), or null.</param>
/// <param name="Numeric">True when <paramref name="Values"/> are numbers.</param>
internal sealed record ChartFixup(string Element, string Property, string? RefName, IReadOnlyList<string>? Values, bool Numeric);

internal static partial class SamplePlanner
{
    internal const string ChartsNamespace = "Microsoft.UI.Xaml.Controls.Charts";

    /// <summary>Points generated for a chart series.</summary>
    internal const int ChartPoints = 12;

    /// <summary>Points in a sample line the preview builds itself (no labelled X axis), matching the overlay line.</summary>
    internal const int ChartLinePoints = 24;

    private const int MaxLiteralItems = 64;
    private const string GeneratedNamePrefix = "__wxpChart";

    /// <summary>Custom control type names that read as charts.</summary>
    internal static readonly Regex ChartTypeName = new("(Chart|Graph|Plot|Sparkline)$", RegexOptions.CultureInvariant);

    /// <summary>x:Names that read as charts.</summary>
    internal static readonly Regex ChartElementName = new(@"(chart|graph|plot|spark|sparkline|trend)\d*$",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);

    private static readonly Regex SimpleName = new(@"^[A-Za-z_]\w*$", RegexOptions.CultureInvariant);

    private static readonly string[] MonthNames = { "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" };

    /// <summary>A gentle deterministic wave in [0.1, 0.9] that reads as real-ish data.</summary>
    internal static double ChartWave(double i) =>
        0.5 + 0.22 * Math.Sin(i * 0.45) + 0.1 * Math.Sin(i * 1.3 + 0.7) + 0.08 * Math.Cos(i * 0.21);

    /// <summary>Stable across runs and processes (unlike <see cref="string.GetHashCode()"/>), so a chart keeps its shape.</summary>
    internal static int StableHash(string? text)
    {
        unchecked
        {
            uint h = 2166136261;
            foreach (var ch in text ?? "")
            {
                h = (h ^ ch) * 16777619;
            }
            return (int)(h & 0x7FFFFFFF);
        }
    }

    /// <summary>Numbers for a sample series named <paramref name="name"/>: a wave between 20 and 80.</summary>
    internal static double[] ChartSeriesValues(string? name, int count = ChartPoints) =>
        ChartSeriesValues(name, count, 20, 80);

    /// <summary>Numbers for a sample series, scaled into [<paramref name="min"/>, <paramref name="max"/>]. Any count
    /// spans the same stretch of the wave, so 12 and 24 points draw the same shape.</summary>
    internal static double[] ChartSeriesValues(string? name, int count, double min, double max)
    {
        int phase = StableHash(name) % 16;
        double step = count > 1 ? (ChartLinePoints - 1.0) / (count - 1) : 1;
        return Enumerable.Range(0, count)
            .Select(i => Math.Round(min + (max - min) * ChartWave(i * step + phase), 2))
            .ToArray();
    }

    /// <summary>Category labels for a sample series: month abbreviations.</summary>
    internal static string[] ChartCategories(int count = ChartPoints) =>
        Enumerable.Range(0, count).Select(i => MonthNames[i % MonthNames.Length]).ToArray();

    /// <summary>True for an element whose XML namespace maps to the WinAppSDK charts namespace.</summary>
    internal static bool IsChartsElement(XElement el)
    {
        var ns = ClrNamespace(el.Name.NamespaceName);
        if (ns == ChartsNamespace)
        {
            return true;
        }
        try
        {
            return XamlCleaner.ResolveElementType(el)?.Namespace == ChartsNamespace;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>A WinAppSDK <c>Chart</c>, a custom control named like a chart, or an element whose x:Name reads as a chart.</summary>
    internal static bool IsChartLike(XElement el)
    {
        if (IsChartsElement(el))
        {
            return el.Name.LocalName == "Chart";
        }
        if (ClrNamespace(el.Name.NamespaceName) is not null && ChartTypeName.IsMatch(el.Name.LocalName))
        {
            return true;
        }
        var name = (string?)el.Attribute(Xaml + "Name") ?? (string?)el.Attribute("Name");
        return !string.IsNullOrEmpty(name) && ChartElementName.IsMatch(name);
    }

    /// <summary>
    /// Chart-specific handling for one <c>{x:Bind}</c>, or null to fall through to the general planner:
    /// <list type="bullet">
    /// <item>a bound <c>Visibility</c> on a chart takes the source's initial value when the code-behind makes it plain
    /// (a hidden chart should stay hidden, not be shown with sample data);</item>
    /// <item>on a charts element, a reference to another named element is restored after load
    /// (<c>XValues="{x:Bind Month}"</c>), and <c>Samples.ItemsSource</c> gets sample values: the code-behind's literal
    /// array when it has one, otherwise values typed from the source.</item>
    /// </list>
    /// </summary>
    private static BindSample? PlanChartBind(Context ctx, XElement el, XAttribute a, SamplePlan plan)
    {
        if (a.Name.Namespace != XNamespace.None || a.Name.LocalName.Contains('.') ||
            el.Attribute(Design + a.Name.LocalName) is not null ||
            !XamlCleaner.TryParseBind(a.Value, out var path, out var named))
        {
            return null;
        }

        var prop = a.Name.LocalName;
        var p = path?.Trim() ?? "";
        bool inTemplate = NearestTemplate(el) is not null;

        if (prop == "Visibility")
        {
            if (inTemplate || !IsChartLike(el) || named.ContainsKey("Converter") || !SimpleName.IsMatch(p))
            {
                return null;
            }
            return InitialVisibility(ctx, p) is { } visibility ? new BindSample(visibility, null) : null;
        }

        if (inTemplate || !IsChartsElement(el) || !SimpleName.IsMatch(p))
        {
            return null;
        }

        var drop = new BindSample(null, null);
        if (ctx.Named.TryGetValue(p, out var target) && target != el && NearestTemplate(target) is null)
        {
            plan.ChartFixups.Add(new ChartFixup(EnsureName(el, plan), prop, p, null, false));
            return drop;
        }

        if (el.Name.LocalName == "Samples" && prop == "ItemsSource")
        {
            var (values, numeric) = ChartSampleValues(ctx, el, p);
            plan.ChartFixups.Add(new ChartFixup(EnsureName(el, plan), prop, null, values, numeric));
            return drop;
        }

        return null;
    }

    /// <summary>The element's x:Name, or a generated one added to the plan (so the host can find it after load).</summary>
    private static string EnsureName(XElement el, SamplePlan plan)
    {
        var name = (string?)el.Attribute(Xaml + "Name") ?? (string?)el.Attribute("Name");
        if (!string.IsNullOrEmpty(name))
        {
            return name;
        }
        foreach (var (e, n, v) in plan.Adds)
        {
            if (e == el && n == Xaml + "Name")
            {
                return v;
            }
        }
        var generated = GeneratedNamePrefix + plan.Adds.Count(x => x.name == Xaml + "Name");
        plan.Adds.Add((el, Xaml + "Name", generated));
        return generated;
    }

    /// <summary>
    /// Values for a <c>Samples</c> bound to page member <paramref name="member"/>: the member's literal initializer
    /// when it has one, else generated values. Numbers unless the source is typed as text or the samples feed a
    /// category X axis.
    /// </summary>
    private static (IReadOnlyList<string> values, bool numeric) ChartSampleValues(Context ctx, XElement samples, string member)
    {
        var declared = ctx.RootType is null ? null : MemberInitializer(ctx.RootType, member);
        if (declared is not null && LiteralItems(declared) is { } literal)
        {
            return literal;
        }

        var type = ctx.RootType is null ? null : SampleTypeModel.MemberType(ctx.RootType, member);
        var element = type is null ? null : SampleTypeModel.ElementType(type);
        bool numeric = element is not null
            ? IsNumeric(element)
            : !FeedsCategoryAxis(ctx, (string?)samples.Attribute(Xaml + "Name") ?? (string?)samples.Attribute("Name"));

        if (numeric)
        {
            return (ChartSeriesValues(member).Select(v => v.ToString(CultureInfo.InvariantCulture)).ToList(), true);
        }

        // Category labels: months read naturally on any category axis; member-derived labels ("Code filled x 2") don't.
        return (ChartCategories(), false);
    }

    /// <summary>True when a series uses the named samples as XValues on a CategoryAxis.</summary>
    private static bool FeedsCategoryAxis(Context ctx, string? samplesName)
    {
        if (string.IsNullOrEmpty(samplesName))
        {
            return false;
        }
        foreach (var el in ctx.Root.Descendants())
        {
            if (BoundName(el, "XValues") != samplesName)
            {
                continue;
            }
            var axis = BoundName(el, "XAxis");
            if (axis is not null && ctx.Named.TryGetValue(axis, out var axisEl) && axisEl.Name.LocalName == "CategoryAxis")
            {
                return true;
            }
        }
        return false;
    }

    private static string? BoundName(XElement el, string property)
    {
        var a = el.Attribute(property);
        return a is not null && IsXBind(el, a.Value) && XamlCleaner.TryParseBind(a.Value, out var path, out _) ? path?.Trim() : null;
    }

    /// <summary>
    /// The initial <c>Visibility</c> literal for a chart bound to page member <paramref name="member"/>, when the code
    /// makes it plain: a literal initializer, or an auto-property/field the class never assigns (its default). Null
    /// when it can't tell (computed, assigned in code, or no source model).
    /// </summary>
    private static string? InitialVisibility(Context ctx, string member)
    {
        if (ctx.RootType is null)
        {
            return null;
        }
        var symbol = FindMember(ctx.RootType, member);
        var type = symbol switch
        {
            IPropertySymbol p => p.Type,
            IFieldSymbol f => f.Type,
            _ => null,
        };
        if (type is null)
        {
            return null;
        }
        bool isBool = type.SpecialType == SpecialType.System_Boolean;
        if (!isBool && type.Name != "Visibility")
        {
            return null;
        }

        var initializer = MemberInitializer(ctx.RootType, member);
        if (initializer is not null)
        {
            return initializer switch
            {
                LiteralExpressionSyntax l when l.IsKind(SyntaxKind.TrueLiteralExpression) && isBool => "Visible",
                LiteralExpressionSyntax l when l.IsKind(SyntaxKind.FalseLiteralExpression) && isBool => "Collapsed",
                MemberAccessExpressionSyntax { Name.Identifier.Text: "Collapsed" } when !isBool => "Collapsed",
                MemberAccessExpressionSyntax { Name.Identifier.Text: "Visible" } when !isBool => "Visible",
                _ => null,
            };
        }

        if (!IsPlainStorage(symbol!) || IsAssigned(ctx.RootType, member))
        {
            return null;
        }
        return isBool ? "Collapsed" : "Visible";
    }

    private static ISymbol? FindMember(ITypeSymbol type, string name)
    {
        for (var cur = type; cur is not null; cur = cur.BaseType)
        {
            var m = cur.GetMembers(name).FirstOrDefault(s => s is IPropertySymbol or IFieldSymbol);
            if (m is not null)
            {
                return m;
            }
        }
        return null;
    }

    /// <summary>A field, or an auto-property (accessors without bodies).</summary>
    private static bool IsPlainStorage(ISymbol symbol)
    {
        if (symbol is IFieldSymbol)
        {
            return true;
        }
        foreach (var r in symbol.DeclaringSyntaxReferences)
        {
            if (r.GetSyntax() is PropertyDeclarationSyntax prop)
            {
                return prop.ExpressionBody is null && prop.AccessorList is { } list &&
                       list.Accessors.All(acc => acc.Body is null && acc.ExpressionBody is null);
            }
        }
        return false;
    }

    /// <summary>True when the class's code assigns <paramref name="member"/> anywhere (<c>X = …</c>, <c>this.X = …</c>, <c>X += …</c>).</summary>
    private static bool IsAssigned(INamedTypeSymbol type, string member)
    {
        foreach (var tree in type.DeclaringSyntaxReferences.Select(r => r.SyntaxTree).Distinct())
        {
            foreach (var asg in tree.GetRoot().DescendantNodes().OfType<AssignmentExpressionSyntax>())
            {
                var name = asg.Left switch
                {
                    IdentifierNameSyntax id => id.Identifier.Text,
                    MemberAccessExpressionSyntax { Expression: ThisExpressionSyntax, Name: var n } => n.Identifier.Text,
                    _ => null,
                };
                if (name == member)
                {
                    return true;
                }
            }
        }
        return false;
    }

    /// <summary>The initializer expression of property or field <paramref name="member"/> on the type or a base type.</summary>
    private static ExpressionSyntax? MemberInitializer(ITypeSymbol type, string member)
    {
        var symbol = FindMember(type, member);
        if (symbol is null)
        {
            return null;
        }
        foreach (var r in symbol.DeclaringSyntaxReferences)
        {
            switch (r.GetSyntax())
            {
                case PropertyDeclarationSyntax prop when prop.Initializer is not null:
                    return prop.Initializer.Value;
                case VariableDeclaratorSyntax v when v.Initializer is not null:
                    return v.Initializer.Value;
            }
        }
        return null;
    }

    /// <summary>
    /// The items of a literal collection (<c>["a", "b"]</c>, <c>new[] { 1, 2 }</c>, <c>new List&lt;double&gt; { 1, 2 }</c>)
    /// when every item is a string or number literal of one kind; null otherwise (including empty).
    /// </summary>
    internal static (IReadOnlyList<string> values, bool numeric)? LiteralItems(ExpressionSyntax expr)
    {
        IEnumerable<ExpressionSyntax>? items = expr switch
        {
            CollectionExpressionSyntax c when c.Elements.All(e => e is ExpressionElementSyntax) =>
                c.Elements.Cast<ExpressionElementSyntax>().Select(e => e.Expression),
            ArrayCreationExpressionSyntax ac => ac.Initializer?.Expressions,
            ImplicitArrayCreationExpressionSyntax ia => ia.Initializer.Expressions,
            BaseObjectCreationExpressionSyntax oc when oc.Initializer is { } init &&
                init.IsKind(SyntaxKind.CollectionInitializerExpression) => init.Expressions,
            _ => null,
        };
        if (items is null)
        {
            return null;
        }

        var values = new List<string>();
        bool? numeric = null;
        foreach (var item in items)
        {
            if (values.Count >= MaxLiteralItems)
            {
                break;
            }
            var (text, isNumber) = item switch
            {
                LiteralExpressionSyntax l when l.IsKind(SyntaxKind.StringLiteralExpression) => (l.Token.ValueText, false),
                LiteralExpressionSyntax l when l.IsKind(SyntaxKind.NumericLiteralExpression) => (NumberText(l.Token.Value), true),
                PrefixUnaryExpressionSyntax { OperatorToken.Text: "-", Operand: LiteralExpressionSyntax l }
                    when l.IsKind(SyntaxKind.NumericLiteralExpression) => ("-" + NumberText(l.Token.Value), true),
                _ => ((string?)null, false),
            };
            if (text is null || (numeric is { } n && n != isNumber))
            {
                return null;
            }
            numeric = isNumber;
            values.Add(text);
        }
        return values.Count == 0 ? null : (values, numeric!.Value);
    }

    private static string NumberText(object? value) =>
        Convert.ToDouble(value, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture);
}
