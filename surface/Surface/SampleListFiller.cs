using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text.Json;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Surface;

/// <summary>
/// WS2-F6 sample rows. <see cref="XamlCleaner"/> (with sample data on) drops a list's
/// <c>ItemsSource="{x:Bind ...}"</c> and marks the element with <c>Tag="__wxp-sample:{payload}"</c> (see
/// <see cref="SamplePlanner"/>). After the page is mounted, this fills each marked list with generated rows so its
/// item template repeats, then clears the marker. Rows are real instances of the item type when the app's assembly
/// provides it (<see cref="SampleObjects"/>), else dictionaries or strings. Lists inside item templates are only
/// realized once their parent's rows exist, so marked elements are picked up on later layout passes; nesting is
/// capped (3, then 2, then 1 row). The app's template selector stays, wrapped so a selector that throws on a sample row
/// falls back to a text template (<see cref="SafeTemplateSelector"/>). Never throws.
/// </summary>
internal static class SampleListFiller
{
    internal const string TagPrefix = "__wxp-sample:";

    /// <summary>The properties a marked control takes its rows through (a TabView's tabs, a NavigationView's menu).</summary>
    internal static readonly string[] SourceProperties = { "ItemsSource", "TabItemsSource", "MenuItemsSource" };

    private static readonly int[] RowsByDepth = { 3, 2, 1 };
    private const int MaxLayoutPasses = 60;
    private const int MaxIdlePassesAfterFill = 10;

    // Lists this filler populated; used to compute the nesting depth of a list found inside their rows.
    private static readonly ConditionalWeakTable<FrameworkElement, object> Filled = new();

    /// <summary>Fill marked lists under <paramref name="root"/> as layout realizes them.</summary>
    public static void Attach(FrameworkElement root)
    {
        int passes = 0, idle = 0;
        bool anyFilled = false;
        EventHandler<object>? handler = null;
        handler = (_, _) =>
        {
            int filled = 0;
            try
            {
                filled = FillMarked(root, 0);
            }
            catch (Exception ex)
            {
                App.Log($"SAMPLE: list fill failed: {ex.GetType().Name}: {ex.Message}");
                passes = MaxLayoutPasses;
            }

            anyFilled |= filled > 0;
            idle = filled > 0 ? 0 : idle + 1;
            if (++passes >= MaxLayoutPasses || (anyFilled && idle >= MaxIdlePassesAfterFill))
            {
                root.LayoutUpdated -= handler;
            }
        };
        root.LayoutUpdated += handler;
    }

    private static int FillMarked(DependencyObject node, int depth)
    {
        int count = 0;
        if (node is FrameworkElement fe && fe.Tag is string tag && tag.StartsWith(TagPrefix, StringComparison.Ordinal))
        {
            fe.ClearValue(FrameworkElement.TagProperty);
            if (depth < RowsByDepth.Length && TryFill(fe, tag.Substring(TagPrefix.Length), RowsByDepth[depth]))
            {
                Filled.AddOrUpdate(fe, null!);
                count++;
            }
        }

        int childDepth = node is FrameworkElement f && Filled.TryGetValue(f, out _) ? depth + 1 : depth;
        int n = VisualTreeHelper.GetChildrenCount(node);
        for (int i = 0; i < n; i++)
        {
            count += FillMarked(VisualTreeHelper.GetChild(node, i), childDepth);
        }

        return count;
    }

    private static bool TryFill(FrameworkElement list, string label, int rows)
    {
        try
        {
            if (label.Contains("\"grouped\":true", StringComparison.Ordinal) && list is ItemsControl grouped)
            {
                return TryFillGrouped(grouped, label);
            }

            var prop = SourceProperties.Select(n => list.GetType().GetProperty(n)).FirstOrDefault(p => p is { CanWrite: true });
            if (prop is null)
            {
                return false;
            }
            if (prop.GetValue(list) is System.Collections.IEnumerable bound and not string && bound.GetEnumerator().MoveNext())
            {
                return false; // its {Binding} already reached real rows (a list inside a typed row)
            }

            var items = BuildRows(label, rows, out label, out var typeName);
            int typed = 0;
            if (typeName is not null && SampleObjects.ResolveType(typeName) is { } itemType)
            {
                for (int i = 0; i < items.Count; i++)
                {
                    if (SampleObjects.Create(itemType, items[i] as IReadOnlyDictionary<string, object>, i) is { } obj)
                    {
                        items[i] = obj;
                        typed++;
                    }
                }
            }

            if (list is ItemsControl ic && ic.ItemTemplateSelector is { } selector and not SafeTemplateSelector)
            {
                ic.ItemTemplateSelector = new SafeTemplateSelector(selector, items.Count > 0 ? items[0] : null);
            }
            prop.SetValue(list, items);
            App.Log($"SAMPLE: filled {list.GetType().Name} with {rows} placeholder row(s) for {label}" +
                (typed > 0 ? $" ({typed} typed {typeName})." : "."));
            return true;
        }
        catch (Exception ex)
        {
            App.Log($"SAMPLE: skipped {list.GetType().Name}: {ex.GetType().Name}: {ex.Message}");
            return false;
        }
    }

    /// <summary>
    /// A grouped list over a <c>CollectionViewSource</c>: generated groups (typed as the app's group type when it's
    /// loaded) go into the page's own view source, so its <c>IsSourceGrouped</c>/<c>ItemsPath</c> still apply.
    /// </summary>
    private static bool TryFillGrouped(ItemsControl list, string payload)
    {
        var groups = BuildGroups(payload, out var label, out var typedGroups, out var itemsPath);
        if (groups.Count == 0)
        {
            return false;
        }

        var cvs = list.GetBindingExpression(ItemsControl.ItemsSourceProperty)?.ParentBinding?.Source as Microsoft.UI.Xaml.Data.CollectionViewSource;
        if (cvs is not null && (typedGroups || string.IsNullOrEmpty(itemsPath)))
        {
            cvs.Source = groups;
        }
        else
        {
            // Plain groups are the item lists themselves, so no ItemsPath.
            var own = new Microsoft.UI.Xaml.Data.CollectionViewSource { IsSourceGrouped = true, Source = groups };
            if (typedGroups && !string.IsNullOrEmpty(itemsPath))
            {
                own.ItemsPath = new PropertyPath(itemsPath);
            }
            list.ItemsSource = own.View;
        }
        App.Log($"SAMPLE: filled grouped {list.GetType().Name} with {groups.Count} group(s) for {label}{(typedGroups ? " (typed)" : "")}.");
        return true;
    }

    internal static List<object> BuildGroups(string payload, out string label, out bool typedGroups, out string? itemsPath)
    {
        int bar = payload.IndexOf('|');
        label = bar < 0 ? payload : payload[..bar];
        typedGroups = false;
        itemsPath = null;
        var groups = new List<object>();
        if (bar < 0)
        {
            return groups;
        }

        using var doc = JsonDocument.Parse(payload[(bar + 1)..]);
        var root = doc.RootElement;
        string? Str(string name) => root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        itemsPath = Str("itemsPath");
        var groupType = Str("groupType") is { } gt ? SampleObjects.ResolveType(gt) : null;
        var itemType = Str("type") is { } it ? SampleObjects.ResolveType(it) : null;
        if (!root.TryGetProperty("rows", out var rows) || rows.ValueKind != JsonValueKind.Array)
        {
            return groups;
        }

        int gi = 0;
        bool allTyped = groupType is not null;
        var plain = new List<object>();
        foreach (var g in rows.EnumerateArray())
        {
            var key = g.TryGetProperty("Key", out var k) ? k.GetString() ?? "" : "";
            var items = new List<object>();
            if (g.TryGetProperty("Items", out var rowsOfGroup) && rowsOfGroup.ValueKind == JsonValueKind.Array)
            {
                int ii = 0;
                foreach (var row in rowsOfGroup.EnumerateArray())
                {
                    if (Convert(row) is not { } v) continue;
                    if (itemType is not null && SampleObjects.Create(itemType, v as IReadOnlyDictionary<string, object>, ii) is { } obj) v = obj;
                    items.Add(v);
                    ii++;
                }
            }

            object? group = null;
            if (groupType is not null &&
                SampleObjects.Create(groupType, new Dictionary<string, object> { ["Key"] = key }, gi) is { } typed)
            {
                // A group that is its own item list (class Grouping : List<Person>): add the rows to it. Otherwise
                // SampleObjects already filled its ItemsPath collection.
                if (string.IsNullOrEmpty(itemsPath) && typed is System.Collections.IList l && !l.IsReadOnly && !l.IsFixedSize)
                {
                    try
                    {
                        l.Clear();
                        foreach (var item in items) l.Add(item);
                        group = typed;
                    }
                    catch (ArgumentException)
                    {
                        // untyped rows don't fit the app's group list
                    }
                }
                else if (!string.IsNullOrEmpty(itemsPath))
                {
                    group = typed;
                }
            }
            allTyped &= group is not null;
            groups.Add(group ?? items);
            plain.Add(items);
            gi++;
        }

        // Mixed typed and plain groups would need different ItemsPaths; use plain item lists throughout.
        typedGroups = allTyped;
        return allTyped ? groups : plain;
    }

    /// <summary>
    /// Rows for a marker payload: <c>label|[json rows]</c> or <c>label|{"type":…,"rows":[…]}</c> from
    /// <see cref="SamplePlanner"/> (objects become dictionaries, so the template's <c>{Binding Name}</c>s read them),
    /// or a bare label repeated. <paramref name="typeName"/> is the item type to build real instances of, if any.
    /// </summary>
    internal static List<object> BuildRows(string payload, int max, out string label) =>
        BuildRows(payload, max, out label, out _);

    internal static List<object> BuildRows(string payload, int max, out string label, out string? typeName)
    {
        int bar = payload.IndexOf('|');
        label = bar < 0 ? payload : payload[..bar];
        typeName = null;
        var items = new List<object>(max);
        if (bar >= 0)
        {
            try
            {
                using var doc = JsonDocument.Parse(payload[(bar + 1)..]);
                var rows = doc.RootElement;
                if (rows.ValueKind == JsonValueKind.Object)
                {
                    if (rows.TryGetProperty("type", out var t) && t.ValueKind == JsonValueKind.String)
                    {
                        typeName = t.GetString();
                    }
                    rows = rows.TryGetProperty("rows", out var r) ? r : default;
                }
                if (rows.ValueKind == JsonValueKind.Array)
                {
                    foreach (var row in rows.EnumerateArray())
                    {
                        if (items.Count >= max)
                        {
                            break;
                        }
                        if (Convert(row) is { } v)
                        {
                            items.Add(v);
                        }
                    }
                }
            }
            catch (JsonException)
            {
                items.Clear();
            }
        }

        while (items.Count < max)
        {
            items.Add(label);
        }
        return items;
    }

    private static object? Convert(JsonElement e) => e.ValueKind switch
    {
        JsonValueKind.Object => ToDictionary(e),
        JsonValueKind.Array => ToList(e),
        JsonValueKind.String => e.GetString(),
        JsonValueKind.Number => e.GetDouble(),
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        _ => null,
    };

    private static Dictionary<string, object> ToDictionary(JsonElement e)
    {
        var d = new Dictionary<string, object>(StringComparer.Ordinal);
        foreach (var p in e.EnumerateObject())
        {
            if (Convert(p.Value) is { } v)
            {
                d[p.Name] = v;
            }
        }
        return d;
    }

    private static List<object> ToList(JsonElement e)
    {
        var l = new List<object>();
        foreach (var x in e.EnumerateArray())
        {
            if (Convert(x) is { } v)
            {
                l.Add(v);
            }
        }
        return l;
    }
}

/// <summary>
/// The app's own template selector, asked about sample rows (they're real instances of the item type when the app
/// is built, so most selectors work). If it throws on a row it doesn't understand, the row gets a plain text
/// template instead of failing the list.
/// </summary>
internal sealed partial class SafeTemplateSelector : DataTemplateSelector
{
    private readonly DataTemplateSelector _inner;
    private readonly object? _sample;
    private DataTemplate? _fallback;

    public SafeTemplateSelector(DataTemplateSelector inner, object? sample)
    {
        _inner = inner;
        _sample = sample;
    }

    protected override DataTemplate? SelectTemplateCore(object item) => Select(item, null);

    protected override DataTemplate? SelectTemplateCore(object item, DependencyObject container) => Select(item, container);

    private DataTemplate? Select(object item, DependencyObject? container)
    {
        try
        {
            return container is null ? _inner.SelectTemplate(item) : _inner.SelectTemplate(item, container);
        }
        catch (Exception ex)
        {
            App.Log($"SAMPLE: template selector {_inner.GetType().Name} threw {ex.GetType().Name}; using a text template.");
            return _fallback ??= Fallback(_sample);
        }
    }

    /// <summary>A text row: the first text member of a dictionary row, else the row itself.</summary>
    internal static DataTemplate? Fallback(object? sample)
    {
        var path = sample is IReadOnlyDictionary<string, object> d ? d.FirstOrDefault(kv => kv.Value is string).Key : null;
        var binding = path is null ? "{Binding}" : "{Binding " + path + "}";
        try
        {
            return (DataTemplate)Microsoft.UI.Xaml.Markup.XamlReader.Load(
                "<DataTemplate xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\">" +
                $"<TextBlock Text=\"{binding}\" /></DataTemplate>");
        }
        catch
        {
            return null;
        }
    }
}
