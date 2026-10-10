using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;

namespace Surface;

/// <summary>
/// F4: logs where a native render knowingly differs from the running app (see "Rendering fidelity" in
/// surface/README.md). Read-only and best-effort; it never changes the tree and never fails a render.
/// <list type="bullet">
/// <item>Window backdrop: a page with no opaque background shows the window's Mica/Acrylic at run time,
/// but the preview has no app window, so the design canvas paints the theme page brush behind it.</item>
/// <item>Code-started storyboards: keyed storyboards in element resources are begun by code-behind, which
/// the preview never runs, so they show their initial frame.</item>
/// </list>
/// </summary>
internal static class FidelityNotes
{
    private const int MaxNodes = 5000;
    private const int MaxNamedKeys = 5;

    internal static void Log(FrameworkElement root, Action<string> log)
    {
        try
        {
            if (!HasOpaqueBackground(root))
            {
                log("FIDELITY: page background is transparent; a window backdrop (Mica/Acrylic) is approximated with the theme page background.");
            }
        }
        catch
        {
        }

        try
        {
            var keys = new List<string>();
            int count = 0, nodes = 0;
            var stack = new Stack<DependencyObject>();
            stack.Push(root);
            while (stack.Count > 0 && ++nodes <= MaxNodes)
            {
                var d = stack.Pop();
                if (d is FrameworkElement fe)
                {
                    CollectStoppedStoryboards(fe, keys, ref count);
                }

                int n;
                try { n = VisualTreeHelper.GetChildrenCount(d); }
                catch { continue; }
                for (int i = 0; i < n; i++)
                {
                    try { stack.Push(VisualTreeHelper.GetChild(d, i)); }
                    catch { }
                }
            }

            if (count > 0)
            {
                string named = keys.Count > 0 ? " (" + string.Join(", ", keys) + (count > keys.Count ? ", …" : "") + ")" : "";
                log($"FIDELITY: {count} resource storyboard(s) not started{named}; code-behind that would begin them does not run in the preview.");
            }
        }
        catch
        {
        }
    }

    // A page shows the window backdrop only if neither it nor its content paints an opaque background.
    private static bool HasOpaqueBackground(FrameworkElement root)
    {
        if (IsOpaque(BackgroundOf(root))) return true;
        if (root is UserControl uc && uc.Content is FrameworkElement content)
        {
            return IsOpaque(BackgroundOf(content));
        }
        return false;
    }

    private static Brush? BackgroundOf(FrameworkElement fe) => fe switch
    {
        Control c => c.Background,
        Panel p => p.Background,
        Border b => b.Background,
        _ => null,
    };

    private static bool IsOpaque(Brush? brush) => brush switch
    {
        null => false,
        SolidColorBrush s => s.Color.A > 0 && s.Opacity > 0,
        _ => brush.Opacity > 0,
    };

    private static void CollectStoppedStoryboards(FrameworkElement fe, List<string> keys, ref int count)
    {
        ResourceDictionary res;
        try
        {
            res = fe.Resources;
            if (res is null || res.Count == 0) return;
        }
        catch { return; }

        var entries = new List<KeyValuePair<object, object>>();
        try
        {
            foreach (var kv in res) entries.Add(kv);
        }
        catch { return; }

        foreach (var kv in entries)
        {
            if (kv.Value is not Storyboard sb) continue;
            try
            {
                if (sb.GetCurrentState() != ClockState.Stopped) continue;
            }
            catch { continue; }

            count++;
            if (keys.Count < MaxNamedKeys && kv.Key is string key) keys.Add(key);
        }
    }
}
