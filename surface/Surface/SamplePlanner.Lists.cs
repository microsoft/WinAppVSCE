using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Surface;

/// <summary>
/// Lists fed through a classic <c>{Binding}</c>: grouped lists over a page <c>CollectionViewSource</c> (its
/// <c>Source</c> was an <c>{x:Bind}</c> or set in code), and <c>ItemsSource="{Binding X}"</c> with no design-time
/// data context, which would otherwise bind to nothing.
/// </summary>
internal static partial class SamplePlanner
{
    internal const int Groups = 2;

    /// <summary>Most rows a list gets from its source's initializer (<c>Enumerable.Range(0, 500)</c> shows 50).</summary>
    internal const int MaxListRows = 50;

    /// <summary>What a list's source initializer says about its rows: their literal values, or just how many.</summary>
    internal readonly record struct SourceRows(IReadOnlyList<object>? Values, int Count);

    /// <summary>The initializer of the property or field a list binds to, when it's declared on <paramref name="owner"/>.</summary>
    private static ExpressionSyntax? SourceInitializer(ITypeSymbol? owner, string member) =>
        owner is null ? null : MemberInitializer(owner, member);

    /// <summary>
    /// The rows a source initializer declares: literal items (<c>new() { "a", "b" }</c>, <c>{ 7, 8 }</c>),
    /// <c>Enumerable.Range(a, n)</c> (wrapped in a collection constructor or <c>.ToList()</c>), or the count of
    /// object items (<c>{ new Person(), new Person() }</c>). Null when the initializer says nothing (empty
    /// <c>new()</c>, filled later in code) — those lists keep generated rows.
    /// </summary>
    internal static SourceRows? SourceRowsOf(ExpressionSyntax? expr)
    {
        for (int guard = 0; expr is not null && guard < 8; guard++)
        {
            switch (expr)
            {
                case ParenthesizedExpressionSyntax p:
                    expr = p.Expression;
                    continue;
                case CastExpressionSyntax c:
                    expr = c.Expression;
                    continue;
                case InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax ma } inv:
                    if (ma.Name.Identifier.Text == "Range" && ma.Expression.ToString() is "Enumerable" or "System.Linq.Enumerable" &&
                        inv.ArgumentList.Arguments.Count == 2 &&
                        IntLiteral(inv.ArgumentList.Arguments[0].Expression) is { } start &&
                        IntLiteral(inv.ArgumentList.Arguments[1].Expression) is { } n and > 0)
                    {
                        int take = Math.Min(n, MaxListRows);
                        return new SourceRows(Enumerable.Range(0, take).Select(i => (object)(double)(start + i)).ToList(), take);
                    }
                    if (inv.ArgumentList.Arguments.Count == 0 && ma.Name.Identifier.Text is "ToList" or "ToArray" or "ToObservableCollection" or "AsReadOnly")
                    {
                        expr = ma.Expression;
                        continue;
                    }
                    return null;
                case BaseObjectCreationExpressionSyntax oc when oc.Initializer is null &&
                                                                 oc.ArgumentList is { Arguments.Count: 1 } args:
                    expr = args.Arguments[0].Expression; // new ObservableCollection<int>(source)
                    continue;
            }

            if (LiteralItems(expr) is { } lit)
            {
                var values = lit.values.Take(MaxListRows)
                    .Select(v => lit.numeric ? (object)double.Parse(v, System.Globalization.CultureInfo.InvariantCulture) : v).ToList();
                return new SourceRows(values, values.Count);
            }

            IEnumerable<SyntaxNode>? items = expr switch
            {
                CollectionExpressionSyntax c => c.Elements,
                ArrayCreationExpressionSyntax ac => ac.Initializer?.Expressions,
                ImplicitArrayCreationExpressionSyntax ia => ia.Initializer.Expressions,
                InitializerExpressionSyntax ai when ai.IsKind(SyntaxKind.ArrayInitializerExpression) => ai.Expressions,
                BaseObjectCreationExpressionSyntax oc when oc.Initializer is { } init &&
                    init.IsKind(SyntaxKind.CollectionInitializerExpression) => init.Expressions,
                _ => null,
            };
            int count = items?.Count() ?? 0;
            return count > 0 && items!.All(i => i is not SpreadElementSyntax)
                ? new SourceRows(null, Math.Min(count, MaxListRows))
                : null;
        }
        return null;
    }

    private static int? IntLiteral(ExpressionSyntax e) => e switch
    {
        LiteralExpressionSyntax l when l.Token.Value is int i => i,
        PrefixUnaryExpressionSyntax { OperatorToken.Text: "-", Operand: LiteralExpressionSyntax l } when l.Token.Value is int i => -i,
        _ => null,
    };

    private static void PlanBindingLists(Context ctx, SamplePlan plan)
    {
        var tagged = new HashSet<XElement>(plan.Adds.Where(a => a.name == "Tag").Select(a => a.element));
        foreach (var el in ctx.Root.Descendants().ToList())
        {
            try
            {
                var source = (string?)el.Attribute("ItemsSource");
                if (source is null || el.Attribute("Tag") is not null || tagged.Contains(el) || NearestTemplate(el) is not null ||
                    el.Attribute(Design + "ItemsSource") is not null)
                {
                    continue;
                }

                var cvsRef = Regex.Match(source, @"^\{\s*Binding\s+Source\s*=\s*\{\s*(?:Static|Theme)Resource\s+([^}\s]+)\s*\}\s*\}$");
                if (cvsRef.Success)
                {
                    if (FindCollectionViewSource(ctx, cvsRef.Groups[1].Value) is { } cvs && GroupedMarker(ctx, el, cvs) is { } marker)
                    {
                        plan.Adds.Add((el, "Tag", marker));
                        tagged.Add(el);
                    }
                    continue;
                }

                var bound = Regex.Match(source, @"^\{\s*Binding\s+(?:Path\s*=\s*)?([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\}$");
                if (bound.Success && !el.AncestorsAndSelf().Any(a => a.Attribute(Design + "DataContext") is not null || a.Attribute("DataContext") is not null) &&
                    TargetKindOf(ctx, el, "ItemsSource") == TargetKind.Items)
                {
                    var path = bound.Groups[1].Value;
                    var itemType = TemplateItemType(ctx, el);
                    plan.Adds.Add((el, "Tag", ListMarker(ctx, el, itemType, path.Split('.')[^1])));
                    tagged.Add(el);
                }
            }
            catch (Exception ex)
            {
                App.Log($"SAMPLE: binding list {el.Name.LocalName}: {ex.GetType().Name}: {ex.Message}");
            }
        }
    }

    private static XElement? FindCollectionViewSource(Context ctx, string key) =>
        ctx.Root.DescendantsAndSelf().FirstOrDefault(e => e.Name.LocalName == "CollectionViewSource" &&
            ((string?)e.Attribute(Xaml + "Key") == key || (string?)e.Attribute(Xaml + "Name") == key));

    /// <summary>
    /// <c>label|{"grouped":true,"groupType":…,"type":…,"rows":[{"Key":"Group 1","Items":[…]},…]}</c>, or null when
    /// the view source already has data the preview can show (a d: or literal Source).
    /// </summary>
    private static string? GroupedMarker(Context ctx, XElement list, XElement cvs)
    {
        if (cvs.Attribute(Design + "Source") is not null ||
            (cvs.Attribute("Source") is { } src && !IsXBind(cvs, src.Value)) ||
            cvs.Elements().Any(e => e.Name.LocalName == "CollectionViewSource.Source"))
        {
            return null;
        }

        // The groups' type: from the x:Bind path, else from code that assigns the view source's Source.
        ITypeSymbol? groupsType = null;
        string label = (string?)cvs.Attribute(Xaml + "Name") ?? (string?)cvs.Attribute(Xaml + "Key") ?? "Groups";
        if (cvs.Attribute("Source") is { } bind && XamlCleaner.TryParseBind(bind.Value, out var path, out _))
        {
            var r = Resolve(ctx, cvs, ctx.RootType, true, path);
            groupsType = r.Type;
            label = r.Name;
        }
        else if (ctx.Model is not null && (string?)ctx.Root.Attribute(Xaml + "Class") is { } rootClass &&
                 (string?)cvs.Attribute(Xaml + "Name") is { } cvsName)
        {
            foreach (var (target, prop, value, model, _) in ctx.Model.Assignments(rootClass))
            {
                if (target == cvsName && prop == "Source")
                {
                    groupsType = model.GetTypeInfo(value).Type;
                    label = LastName(value) ?? label;
                    break;
                }
            }
        }

        var groupType = groupsType is null or { TypeKind: TypeKind.Error } ? null : SampleTypeModel.ElementType(groupsType);
        var itemsPath = (string?)cvs.Attribute("ItemsPath");
        ITypeSymbol? itemType = null;
        if (groupType is not null)
        {
            var holder = string.IsNullOrWhiteSpace(itemsPath) ? groupType : SampleTypeModel.MemberType(groupType, itemsPath.Trim());
            itemType = holder is null ? null : SampleTypeModel.ElementType(holder);
        }
        itemType ??= TemplateItemType(ctx, list);

        var rows = ListRows(ctx, list, itemType, itemType?.Name ?? "Items", out var itemTypeName);
        var groups = new List<object>();
        var groupLabel = Humanize(Singular(label));
        for (int g = 0; g < Groups; g++)
        {
            groups.Add(new Dictionary<string, object> { ["Key"] = $"{groupLabel} {g + 1}", ["Items"] = rows });
        }

        var payload = new Dictionary<string, object> { ["grouped"] = true, ["rows"] = groups };
        if (groupType is not null && ReflectionName(groupType) is { } gt) payload["groupType"] = gt;
        if (itemTypeName is not null) payload["type"] = itemTypeName;
        if (!string.IsNullOrWhiteSpace(itemsPath)) payload["itemsPath"] = itemsPath.Trim();
        return SampleListFiller.TagPrefix + label + "|" + JsonSerializer.Serialize(payload);
    }
}
