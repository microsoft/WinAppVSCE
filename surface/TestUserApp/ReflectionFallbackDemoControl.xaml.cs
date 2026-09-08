using System.Collections.ObjectModel;
using Microsoft.UI.Xaml.Controls;

namespace TestUserApp;

/// <summary>
/// M3 demo (§51): a ZERO-CONFIG UserControl that binds via <c>{x:Bind}</c> to an EMPTY collection and does
/// NOTHING in its constructor to fill it — mirroring an app that opts into neither the M1 d:DesignData path
/// nor the M2 DesignMode contract. It exists to prove the OPPORTUNISTIC REFLECTION FALLBACK: when the
/// surface runs with the fallback opt-in (env <c>SURFACE_DTD_REFLECT=1</c>) and live-activates this control,
/// the host reflects <see cref="Models"/> (found empty), fabricates a bounded sample dataset, and re-runs
/// the generated <c>Bindings.Update()</c> so <see cref="ItemCountText"/> re-reads the now-filled count.
/// Without the opt-in the control renders "0 items" (the fallback stays off the default path).
/// </summary>
public sealed partial class ReflectionFallbackDemoControl : UserControl
{
    /// <summary>x:Bind-backed sample collection — intentionally left EMPTY by the app.</summary>
    public ObservableCollection<DemoItem> Models { get; } = new();

    /// <summary>x:Bind (OneTime) source; re-read by Bindings.Update() after the fallback fills the collection.</summary>
    public string ItemCountText => $"{Models.Count} items";

    public ReflectionFallbackDemoControl()
    {
        // Deliberately zero-config: no seeding, no design-mode branch. Any sample content that appears is
        // entirely the work of the opportunistic reflection fallback (when opted in) — nothing else.
        this.InitializeComponent();
    }
}
