using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace TestUserApp;

/// <summary>
/// P3 (coverage hardening) render-settle demo. Mirrors the gallery's auto-advance carousel (idx18
/// HeaderCarousel, also embedded in idx29 HomePage): a private <see cref="DispatcherTimer"/> field started on
/// Loaded that would otherwise churn the UI thread indefinitely. In a one-shot design-time capture that churn
/// prevents the render from ever settling, so the harness times the page out. The host's render-settle sweep
/// (<c>RenderSettle.Quiesce</c>) must locate this code-behind timer in the mounted tree and Stop() it —
/// logged as <c>SETTLE: stopped 1 timer(s)</c> — so the page settles to a representative frame instead.
/// The 2s interval guarantees the timer is enabled-but-un-ticked when the sweep runs, so the proof is
/// deterministic.
/// </summary>
public sealed partial class SettleDemoControl : UserControl
{
    private readonly DispatcherTimer _churnTimer = new() { Interval = TimeSpan.FromMilliseconds(2000) };
    private int _ticks;

    public SettleDemoControl()
    {
        InitializeComponent();
        Loaded += OnLoaded;
    }

    private void OnLoaded(object sender, RoutedEventArgs e)
    {
        _churnTimer.Tick += (_, _) =>
        {
            _ticks++;
            TickText.Text = $"{_ticks} ticks";
        };
        _churnTimer.Start();
    }
}
