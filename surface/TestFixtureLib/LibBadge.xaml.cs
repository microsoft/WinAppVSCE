using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace TestFixtureLib;

public sealed partial class LibBadge : UserControl
{
    public static readonly DependencyProperty LabelProperty = DependencyProperty.Register(
        nameof(Label), typeof(string), typeof(LibBadge),
        new PropertyMetadata(string.Empty, (d, e) => ((LibBadge)d).LabelText.Text = e.NewValue as string ?? string.Empty));

    public LibBadge()
    {
        InitializeComponent();
    }

    public string Label
    {
        get => (string)GetValue(LabelProperty);
        set => SetValue(LabelProperty, value);
    }
}
