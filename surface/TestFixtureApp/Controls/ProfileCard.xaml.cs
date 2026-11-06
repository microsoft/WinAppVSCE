using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace TestFixtureApp.Controls;

/// <summary>Custom UserControl (compiled XAML + a dependency property).</summary>
public sealed partial class ProfileCard : UserControl
{
    public static readonly DependencyProperty TitleProperty = DependencyProperty.Register(
        nameof(Title), typeof(string), typeof(ProfileCard),
        new PropertyMetadata(string.Empty, (d, e) => ((ProfileCard)d).TitleText.Text = e.NewValue as string ?? string.Empty));

    public ProfileCard()
    {
        InitializeComponent();
    }

    public string Title
    {
        get => (string)GetValue(TitleProperty);
        set => SetValue(TitleProperty, value);
    }
}
