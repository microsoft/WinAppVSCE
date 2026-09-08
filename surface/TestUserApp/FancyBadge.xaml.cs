using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace TestUserApp;

/// <summary>
/// A simple custom control used to prove that the Surface host can activate a
/// user-defined XAML type referenced from runtime-parsed markup.
/// </summary>
public sealed partial class FancyBadge : UserControl
{
    /// <summary>
    /// Backing <see cref="DependencyProperty"/> for <see cref="Label"/>.
    /// Default value is "Badge".
    /// </summary>
    public static readonly DependencyProperty LabelProperty =
        DependencyProperty.Register(
            nameof(Label),
            typeof(string),
            typeof(FancyBadge),
            new PropertyMetadata("Badge", OnLabelChanged));

    public FancyBadge()
    {
        InitializeComponent();

        // Set the initial text directly (no binding) so the control is
        // bulletproof regardless of how it is activated.
        LabelText.Text = Label;
    }

    /// <summary>
    /// The text displayed inside the badge.
    /// </summary>
    public string Label
    {
        get => (string)GetValue(LabelProperty);
        set => SetValue(LabelProperty, value);
    }

    private static void OnLabelChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
    {
        var badge = (FancyBadge)d;
        badge.LabelText.Text = (string)e.NewValue;
    }
}
