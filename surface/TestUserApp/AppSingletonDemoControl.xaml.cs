using Microsoft.UI.Xaml.Controls;

namespace TestUserApp;

/// <summary>
/// P2 (coverage hardening) demo control. Its constructor dereferences the static <see cref="DesignTimeApp"/>
/// app-service singleton — which is null in a headless preview host — exactly like the real gallery
/// constructors that NRE on <c>App.ModelDownloadQueue</c> (idx3 DownloadProgressList, idx23
/// FoundryLocalPickerView). The first activation attempt throws; the Surface host's App-init recovery then
/// reflectively seeds the singleton and retries this constructor, which now succeeds and surfaces values
/// read from the seeded instance.
/// </summary>
public sealed partial class AppSingletonDemoControl : UserControl
{
    public AppSingletonDemoControl()
    {
        // Deref the app singleton BEFORE InitializeComponent — mirrors the gallery ctors' construction gate.
        // Throws NullReferenceException in a headless host until the host's App-init recovery seeds it.
        DemoAppService service = DesignTimeApp.AppService;
        string status = service.Status;
        int count = service.Items.Count;

        InitializeComponent();

        // Surface values sourced from the seeded singleton so the smoke read-back proves it was really used.
        StatusText.Text = status;
        CountText.Text = $"{count} items";
    }
}
