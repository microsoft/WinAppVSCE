using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;

namespace Surface;

/// <summary>
/// Lists fed through a classic <c>{Binding}</c>: grouped lists over a page <c>CollectionViewSource</c> (its
/// <c>Source</c> was an <c>{x:Bind}</c> or set in code), and <c>ItemsSource="{Binding X}"</c> with no design-time
/// data context, which would otherwise bind to nothing.
/// </summary>
internal static partial class SamplePlanner
{
    internal const int Groups = 2;

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
