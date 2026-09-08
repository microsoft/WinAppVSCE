using System;

namespace Surface;

/// <summary>
/// The surface's DESIGN-MODE CONTRACT (§51 M2) — the honest fix for <c>{x:Bind}</c> pages whose
/// constructors dereference app statics that only exist once the full app boots (the §50g construction
/// gate).
///
/// <para>
/// <see cref="XamlReader.Load"/> cannot honor <c>{x:Bind}</c> (it is compiled, not runtime-parsed), and
/// the surface never runs the user app's own <c>App</c> class, so two things a real page relies on are
/// missing at preview time:
/// <list type="bullet">
///   <item>sample DATA for the x:Bind-backed fields, and</item>
///   <item>the app SINGLETONS the page constructor dereferences.</item>
/// </list>
/// Only the APP can supply these, in a design-mode branch of its own code. This contract defines the
/// signal the app checks to take that branch.
/// </para>
///
/// <para>
/// SIGNAL (what the app checks):
/// <code>
/// bool designMode =
///     Windows.ApplicationModel.DesignMode.DesignModeEnabled                     // true in the VS/Blend XAML designer
///     || Environment.GetEnvironmentVariable("WINUI_XAML_DESIGN_MODE") == "1";   // true in THIS preview surface
/// </code>
/// The built-in <c>DesignModeEnabled</c> flag is NOT true in this unpackaged host (see the probe logged by
/// <see cref="Establish"/>), so the surface additionally sets the process environment variable
/// <see cref="EnvVarName"/>=1. Because the user assembly is loaded and activated IN-PROCESS (live mode,
/// §39), the app's code reads the same process environment and sees the signal.
/// </para>
///
/// <para>
/// POPULATION PATTERN (what the app does under design mode — see <c>DesignModeDemoControl</c>):
/// <code>
/// public MyPage() {
///     if (DesignModeContract.IsDesignMode &amp;&amp; App.Services is null)
///         App.SeedDesignTimeServices();   // seed the statics the ctor needs (dissolve the construction gate)
///     var q = App.Services!.Queue;        // real ctor work — no NRE now
///     if (DesignModeContract.IsDesignMode)
///         FillSampleData();               // seed the x:Bind-backed collections (dissolve the data gap)
///     InitializeComponent();              // x:Bind (OneTime) captures the sample values here
///     if (DesignModeContract.IsDesignMode)
///         VisualStateManager.GoToState(this, "Loaded", false);  // force the populated visual state
/// }
/// </code>
/// </para>
/// </summary>
internal static class DesignModeSignal
{
    /// <summary>Process environment variable the surface sets to "1" so an app can detect the preview host.</summary>
    internal const string EnvVarName = "WINUI_XAML_DESIGN_MODE";

    /// <summary>
    /// Establish the design-mode signal for this process and log an investigation probe of the built-in
    /// WinRT DesignMode flags. Call once at startup, after ComWrappers init so the WinRT probe is valid.
    /// Never throws.
    /// </summary>
    internal static void Establish()
    {
        try
        {
            Environment.SetEnvironmentVariable(EnvVarName, "1");
        }
        catch (Exception ex)
        {
            App.Log($"DesignMode signal: could not set {EnvVarName}: {ex.GetType().Name}: {ex.Message}");
        }

        // Investigation (§51 M2): does the built-in WinRT DesignMode flag read true in our unpackaged host?
        // Empirically it does not — which is exactly why the env-var signal above exists.
        try
        {
            bool native = Windows.ApplicationModel.DesignMode.DesignModeEnabled;
            bool native2 = Windows.ApplicationModel.DesignMode.DesignMode2Enabled;
            App.Log($"DesignMode probe: DesignModeEnabled={native}, DesignMode2Enabled={native2}; " +
                    $"surface signal {EnvVarName}=1 established (apps OR the WinRT flag with this env var).");
        }
        catch (Exception ex)
        {
            App.Log($"DesignMode probe threw ({ex.GetType().Name}: {ex.Message}); {EnvVarName}=1 established regardless.");
        }
    }
}
