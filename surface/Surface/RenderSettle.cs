using System;
using System.Collections.Generic;
using System.Reflection;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;

namespace Surface;

/// <summary>
/// P3 (coverage hardening): design-time RENDER-SETTLE. A few pages never settle to a frame because their
/// code-behind starts self-perpetuating UI-thread churn on load — an auto-advancing carousel driven by a
/// <see cref="DispatcherTimer"/> (idx18 HeaderCarousel, also embedded in idx29 HomePage), an infinitely
/// repeating storyboard, etc. In a live app that churn is intended; in a one-shot design-time capture it only
/// prevents the render from ever completing, so the harness times the page out. <see cref="Quiesce"/> walks
/// the mounted tree and stops exactly that churn — ticking timers and <c>RepeatBehavior=Forever</c>
/// storyboards — so the page settles to a representative frame instead of timing out.
///
/// Deliberately narrow so it is a genuine no-op on already-OK pages: it only STOPS things that would
/// otherwise run forever (running timers, forever-storyboards). A page with none is untouched. It never
/// starts anything, never mutates layout or properties, and never touches one-shot/entrance animations or
/// composition (implicit/connected) animations — those complete on their own before capture. Every step is
/// individually try/caught; failing to quiesce one element never aborts the sweep or the render.
/// </summary>
internal static class RenderSettle
{
    private const int MaxNodes = 5000;

    /// <summary>
    /// Stop self-perpetuating churn under <paramref name="root"/> (the mounted user element). Bounded and
    /// fully defensive. Logs a single line only when something was actually stopped (so the default path,
    /// which stops nothing, stays quiet).
    /// </summary>
    internal static void Quiesce(FrameworkElement root, Action<string>? log)
    {
        int timers = 0, storyboards = 0, nodes = 0;
        try
        {
            foreach (var el in EnumerateTree(root))
            {
                if (++nodes > MaxNodes) break;
                try
                {
                    QuiesceFields(el, ref timers, ref storyboards);
                    if (el is FrameworkElement fe)
                    {
                        QuiesceResources(fe, ref storyboards);
                    }
                }
                catch
                {
                    // per-element failure must never abort the whole sweep
                }
            }
        }
        catch
        {
            // fully defensive — settle is best-effort and must never fail a render
        }

        if ((timers > 0 || storyboards > 0) && log != null)
        {
            log($"SETTLE: stopped {timers} timer(s), {storyboards} forever-storyboard(s) across {nodes} node(s)");
        }
    }

    private static IEnumerable<DependencyObject> EnumerateTree(DependencyObject root)
    {
        var stack = new Stack<DependencyObject>();
        stack.Push(root);
        while (stack.Count > 0)
        {
            var d = stack.Pop();
            yield return d;

            int n;
            try { n = VisualTreeHelper.GetChildrenCount(d); }
            catch { continue; }

            for (int i = 0; i < n; i++)
            {
                DependencyObject? c = null;
                try { c = VisualTreeHelper.GetChild(d, i); }
                catch { }
                if (c != null) stack.Push(c);
            }
        }
    }

    /// <summary>
    /// Inspect only fields DECLARED on user code-behind types (skipping framework base types) so the sweep
    /// stays bounded and targets app-authored timers/storyboards rather than framework internals.
    /// </summary>
    private static void QuiesceFields(DependencyObject el, ref int timers, ref int storyboards)
    {
        for (Type? t = el.GetType(); t != null && IsUserType(t); t = t.BaseType)
        {
            FieldInfo[] fields;
            try
            {
                fields = t.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly);
            }
            catch { continue; }

            foreach (var f in fields)
            {
                object? v;
                try { v = f.GetValue(el); }
                catch { continue; }
                if (v is null) continue;

                if (v is DispatcherTimer dt)
                {
                    if (TryStop(() => dt.IsEnabled, dt.Stop)) timers++;
                }
                else if (v is DispatcherQueueTimer qt)
                {
                    if (TryStop(() => qt.IsRunning, qt.Stop)) timers++;
                }
                else if (v is Storyboard sb)
                {
                    if (TryStopForever(sb)) storyboards++;
                }
            }
        }
    }

    private static void QuiesceResources(FrameworkElement fe, ref int storyboards)
    {
        ResourceDictionary? res;
        try { res = fe.Resources; }
        catch { return; }
        if (res is null) return;

        // Snapshot the values first — enumerating a live ResourceDictionary while stopping is safest copied.
        var values = new List<object?>();
        try
        {
            foreach (var kv in res) values.Add(kv.Value);
        }
        catch { return; }

        foreach (var val in values)
        {
            if (val is Storyboard sb && TryStopForever(sb)) storyboards++;
        }
    }

    private static bool TryStop(Func<bool> isActive, Action stop)
    {
        try
        {
            if (isActive())
            {
                stop();
                return true;
            }
        }
        catch { }
        return false;
    }

    private static bool TryStopForever(Storyboard sb)
    {
        try
        {
            // Only infinitely-repeating storyboards are churn. One-shot/entrance storyboards complete on
            // their own before capture, so leaving them alone keeps already-OK pages byte-identical.
            if (sb.RepeatBehavior.Type == RepeatBehaviorType.Forever)
            {
                sb.Stop();
                return true;
            }
        }
        catch { }
        return false;
    }

    private static bool IsUserType(Type t)
    {
        var ns = t.Namespace ?? string.Empty;
        if (ns.StartsWith("Microsoft.UI", StringComparison.Ordinal)) return false;
        if (ns.StartsWith("Microsoft.Xaml", StringComparison.Ordinal)) return false;
        if (ns.StartsWith("Windows.", StringComparison.Ordinal)) return false;
        if (ns.StartsWith("System", StringComparison.Ordinal)) return false;
        return true;
    }
}
