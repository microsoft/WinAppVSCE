using Microsoft.UI.Xaml.Controls;

namespace SmokeFixture;

/// <summary>
/// The page the DevTools E2E specs inspect, shown instead of <see cref="SmokePage"/>
/// when the app is launched with <c>--devtools-page</c>.
/// </summary>
public sealed partial class DevToolsPage : Page
{
    public string Title { get; } = "Bound fixture";

    public DevToolsPage()
    {
        InitializeComponent();
        DataContext = this;
    }
}
