#nullable enable
using System;

namespace WinUIXamlPreview.Protocol;

/// <summary>
/// BB-060/061: a failure of the previewed page's own code that ends the surface process. A restart re-runs the same
/// code and fails the same way, so the preview names the cause and waits for Reload instead of auto-restarting.
/// </summary>
internal enum AppFatalCause
{
    None,

    /// <summary>The page's layout never settled (WinUI E_LAYOUTCYCLE).</summary>
    LayoutCycle,

    /// <summary>A MeasureOverride/ArrangeOverride in the app threw.</summary>
    LayoutCodeThrew,

    /// <summary>The page's code kept the surface busy before the first paint (constructor or Loaded loop).</summary>
    Unresponsive,
}

internal static class AppFatal
{
    /// <summary>Stderr text the surface logs for a layout cycle (surface\Surface\XamlErrorText.cs LayoutCycleMarker; keep in sync).</summary>
    public const string LayoutCycleMarker = "page layout never settled (layout cycle)";

    /// <summary>Stderr text the surface logs when app layout code threw; WinUI terminates the host for these.</summary>
    public const string LayoutFaultMarker = "app layout code threw during measure/arrange";

    /// <summary>The fatal cause a surface stderr line reports, or <see cref="AppFatalCause.None"/>.</summary>
    public static AppFatalCause FromStderr(string? line)
    {
        if (string.IsNullOrEmpty(line))
        {
            return AppFatalCause.None;
        }
        if (line!.IndexOf(LayoutCycleMarker, StringComparison.Ordinal) >= 0)
        {
            return AppFatalCause.LayoutCycle;
        }
        return line.IndexOf(LayoutFaultMarker, StringComparison.Ordinal) >= 0 ? AppFatalCause.LayoutCodeThrew : AppFatalCause.None;
    }
}
