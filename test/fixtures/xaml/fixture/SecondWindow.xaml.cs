using Microsoft.UI.Xaml;

namespace SmokeFixture;

/// <summary>
/// A second top-level window activated alongside <see cref="MainWindow"/> in
/// <see cref="App.OnLaunched"/>. It owns its own XamlRoot, enabling multi-window
/// smoke tests (e.g. verifying per-window visual-tree isolation during hot reload).
/// </summary>
public sealed partial class SecondWindow : Window
{
    public SecondWindow()
    {
        InitializeComponent();
    }
}
