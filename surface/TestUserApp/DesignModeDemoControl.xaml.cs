using System.Collections.ObjectModel;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace TestUserApp;

/// <summary>
/// M2 demo (§51): a <see cref="UserControl"/> that binds via <c>{x:Bind}</c> AND dereferences a stand-in
/// app singleton (<see cref="AppServices.Current"/>) in its constructor — the exact shape of the §50g
/// pages the preview could not populate (they don't fail on DATA, they fail on CONSTRUCTION). Under the
/// design-mode contract it seeds the singleton (dissolving the CONSTRUCTION gate) and fills the x:Bind
/// collection (dissolving the DATA gap), then forces the loaded visual state.
/// </summary>
public sealed partial class DesignModeDemoControl : UserControl
{
    /// <summary>x:Bind source: derived from the (seeded) app singleton — proves the construction gate crossed.</summary>
    public string Title { get; private set; } = string.Empty;

    /// <summary>x:Bind source: a summary of the sample collection — proves the data gap crossed.</summary>
    public string ItemsSummary { get; private set; } = string.Empty;

    /// <summary>x:Bind-backed sample collection, filled only under the design-mode contract.</summary>
    public ObservableCollection<DemoItem> Items { get; } = new();

    public DesignModeDemoControl()
    {
        // CONSTRUCTION GATE: a real app seeds AppServices at App startup; the preview surface does not run
        // the app's App class, so under design mode seed it here — else the dereference below NREs (§50g).
        if (DesignModeContract.IsDesignMode && AppServices.Current is null)
        {
            AppServices.SeedDesignTime();
        }

        // Real constructor work that depends on the app singleton (mirrors an App.ModelDownloadQueue deref).
        var queue = AppServices.Current!.ModelQueue;
        Title = queue.Count > 0 ? $"{queue.Count} models queued" : "No models queued";

        // DATA GAP: fill the x:Bind-backed collection with sample data under the design-mode contract.
        if (DesignModeContract.IsDesignMode)
        {
            Items.Add(new DemoItem("Contoso Vision", "image"));
            Items.Add(new DemoItem("Fabrikam Speech", "audio"));
            Items.Add(new DemoItem("Northwind Chat", "text"));
        }
        ItemsSummary = $"{Items.Count} sample items";

        // {x:Bind} is OneTime by default and is captured during InitializeComponent's Connect(), so the
        // sample values above MUST be set first. (This ordering is the contract's clean form; a page that
        // must set its data later can instead call this.Bindings.Update() — the mechanism M3 uses.)
        this.InitializeComponent();

        // Force the populated visual state so the "Populated" setters apply instead of the empty default.
        // GoToState needs the control's content root in the live visual tree, which is not guaranteed from a
        // constructor, so apply it on Loaded (authoritative) and also attempt it now (best-effort no-op if
        // the tree is not ready yet).
        if (DesignModeContract.IsDesignMode)
        {
            this.Loaded += (_, _) => VisualStateManager.GoToState(this, "Populated", useTransitions: false);
            VisualStateManager.GoToState(this, "Populated", useTransitions: false);
        }
    }
}
