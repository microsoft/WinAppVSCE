using Microsoft.Extensions.DependencyInjection;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace SmokeFixture;

/// <summary>
/// A second navigable page reachable from <see cref="SmokePage.GoButton"/>, used for
/// navigation-state capture/restore tests. Also provides a path to the
/// constructor-injected <see cref="DiPage"/> resolved through <see cref="App.Services"/>.
/// </summary>
public sealed partial class Page2 : Page
{
    public Page2()
    {
        InitializeComponent();
    }

    private void OnOpenDiPage_Click(object sender, RoutedEventArgs e)
    {
        // DiPage is constructor-injected, so it cannot be instantiated via Frame.Navigate's
        // default activator. Resolve it from DI and set it as the Frame content directly.
        Frame.Content = App.Services.GetRequiredService<DiPage>();
    }

    public void OnBack_Click(object sender, RoutedEventArgs e)
    {
        if (Frame.CanGoBack)
        {
            Frame.GoBack();
        }
    }
}
