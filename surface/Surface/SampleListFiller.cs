using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Surface;

/// <summary>
/// WS2-F6 dummy rows. <see cref="XamlCleaner"/> (with sample data on) drops a list's
/// <c>ItemsSource="{x:Bind ...}"</c> and marks the element with <c>Tag="__wxp-sample:{Path}"</c>. After the page
/// is mounted, this fills each marked list with a few placeholder strings so its item template repeats (its own
/// <c>{x:Bind}</c>s already became placeholders), then clears the marker. Lists inside item templates are only
/// realized once their parent's rows exist, so marked elements are picked up on later layout passes; nesting is
/// capped (3, then 2, then 1 row). No user code runs: the items are plain strings, and a template selector is
/// cleared so it is never asked about an item it doesn't understand. Never throws.
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

            var items = new List<object>(rows);
            for (int i = 0; i < rows; i++)
            {
                items.Add(label);
            }

            prop.SetValue(list, items);
            App.Log($"SAMPLE: filled {list.GetType().Name} with {rows} placeholder row(s) for {label}.");
            return true;
        }
        catch (Exception ex)
        {
            App.Log($"SAMPLE: skipped {list.GetType().Name}: {ex.GetType().Name}: {ex.Message}");
            return false;
        }
    }
}
