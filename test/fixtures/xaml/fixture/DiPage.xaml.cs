using Microsoft.UI.Xaml.Controls;

namespace SmokeFixture;

/// <summary>
/// A page whose constructor is satisfied by DI (it requires a <see cref="DiPageViewModel"/>).
/// Registered transient in <see cref="App.ConfigureServices"/> and resolved via
/// <see cref="App.Services"/>, so a test can reload a DI-constructed page graph.
/// </summary>
public sealed partial class DiPage : Page
{
    /// <summary>The injected view-model bound by <c>DiMessage</c>.</summary>
    public DiPageViewModel ViewModel { get; }

    public DiPage(DiPageViewModel viewModel)
    {
        ViewModel = viewModel;
        InitializeComponent();
    }
}
