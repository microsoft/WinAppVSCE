using Microsoft.UI.Xaml;

// To learn more about WinUI, the WinUI project structure,
// and more about our project templates, see: http://aka.ms/winui-project-info.

namespace SmokeFixture;

/// <summary>
/// The primary application window. Hosts a <see cref="Microsoft.UI.Xaml.Controls.Frame"/>
/// named <c>RootFrame</c> that navigates to <see cref="SmokePage"/> on startup.
/// </summary>
public sealed partial class MainWindow : Window
{
    public MainWindow()
    {
        InitializeComponent();

        ExtendsContentIntoTitleBar = true;
        SetTitleBar(AppTitleBar);

        AppWindow.SetIcon("Assets/AppIcon.ico");

        // Navigate the root frame to the landing page on startup.
        RootFrame.Navigate(typeof(SmokePage));
    }
}
