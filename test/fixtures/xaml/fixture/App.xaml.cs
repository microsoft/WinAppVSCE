using Microsoft.Extensions.DependencyInjection;
using Microsoft.UI.Xaml;

// To learn more about WinUI, the WinUI project structure,
// and more about our project templates, see: http://aka.ms/winui-project-info.

namespace SmokeFixture;

/// <summary>
/// Provides application-specific behavior to supplement the default Application class.
/// Builds the DI container exposed via <see cref="Services"/> and launches two windows
/// (Main + Second) on their own XamlRoots for multi-window smoke tests.
/// </summary>
public partial class App : Application
{
    private Window? _mainWindow;
    private Window? _secondWindow;

    /// <summary>The application-wide service provider used to resolve DI-constructed types.</summary>
    public static IServiceProvider Services { get; private set; } = null!;

    /// <summary>
    /// Initializes the singleton application object. This is the first line of authored code
    /// executed, and as such is the logical equivalent of main() or WinMain().
    /// </summary>
    public App()
    {
        InitializeComponent();
        Services = ConfigureServices();
    }

    private static IServiceProvider ConfigureServices()
    {
        var services = new ServiceCollection();

        // Singleton service shared across the app.
        services.AddSingleton<IGreetingService, GreetingService>();

        // Transient view-model + transient constructor-injected page.
        services.AddTransient<DiPageViewModel>();
        services.AddTransient<DiPage>();

        return services.BuildServiceProvider();
    }

    /// <summary>
    /// Invoked when the application is launched. Creates and activates two windows,
    /// each hosting its own XamlRoot.
    /// </summary>
    /// <param name="args">Details about the launch request and process.</param>
    protected override void OnLaunched(Microsoft.UI.Xaml.LaunchActivatedEventArgs args)
    {
        _mainWindow = new MainWindow();
        _mainWindow.Activate();

        _secondWindow = new SecondWindow();
        _secondWindow.Activate();
    }
}
