using System;

namespace TestUserApp;

/// <summary>
/// Reference implementation of the WinUI-preview DESIGN-MODE CONTRACT that an app copies into its own
/// code (§51 M2). <see cref="IsDesignMode"/> is true when running inside the VS/Blend XAML designer OR the
/// WinUI preview surface. An app checks it in a page/control constructor to seed sample <c>{x:Bind}</c>
/// data and the app statics the constructor needs — the honest fix for x:Bind pages the preview cannot
/// otherwise populate (§50g construction gate).
/// </summary>
public static class DesignModeContract
{
    /// <summary>The process environment variable the WinUI preview surface sets to "1" (see the surface's
    /// <c>DesignModeSignal</c>). The app does not reference the surface — it only reads this documented env var.</summary>
    private const string SurfaceSignalEnvVar = "WINUI_XAML_DESIGN_MODE";

    /// <summary>
    /// True in a design/preview host. Evaluated once — the signal is fixed for the life of the process.
    /// Combines the built-in WinRT designer flag (true in VS/Blend) with the surface's env-var signal
    /// (true in the WinUI preview surface, where the WinRT flag is not set).
    /// </summary>
    public static bool IsDesignMode { get; } =
        SafeDesignModeEnabled() ||
        string.Equals(Environment.GetEnvironmentVariable(SurfaceSignalEnvVar), "1", StringComparison.Ordinal);

    private static bool SafeDesignModeEnabled()
    {
        try
        {
            return Windows.ApplicationModel.DesignMode.DesignModeEnabled;
        }
        catch
        {
            return false;
        }
    }
}
