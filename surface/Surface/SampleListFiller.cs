using System;
using System.Collections.Generic;
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
/// capped (3, then 2, then 1 row). A template selector is cleared so it is never asked about an item it doesn't
/// understand. Never throws.
/// </summary>
internal static class SampleListFiller
{
    internal const string TagPrefix = "__wxp-sample:";

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
            if (list is ItemsControl ic && ic.ItemTemplateSelector is not null)
            {
                ic.ItemTemplateSelector = null;
            }

            var prop = list.GetType().GetProperty("ItemsSource");
            if (prop is null || !prop.CanWrite)
            {
                return false;
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
