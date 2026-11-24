using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Markup;

namespace TestFixtureApp.Controls;

/// <summary>Templated control whose default style lives in Themes/Generic.xaml.</summary>
public sealed class TagChip : Control
{
    public static readonly DependencyProperty TextProperty = DependencyProperty.Register(
        nameof(Text), typeof(string), typeof(TagChip), new PropertyMetadata(string.Empty));

    public TagChip()
    {
        DefaultStyleKey = typeof(TagChip);
    }

    public string Text
    {
        get => (string)GetValue(TextProperty);
        set => SetValue(TextProperty, value);
    }
}

/// <summary>Templated control with a NON-standard content property, so authored children go to Body.</summary>
[ContentProperty(Name = nameof(Body))]
public sealed class Section : Control
{
    public static readonly DependencyProperty HeaderProperty = DependencyProperty.Register(
        nameof(Header), typeof(string), typeof(Section), new PropertyMetadata(string.Empty));

    public static readonly DependencyProperty BodyProperty = DependencyProperty.Register(
        nameof(Body), typeof(UIElement), typeof(Section), new PropertyMetadata(null));

    public Section()
    {
        DefaultStyleKey = typeof(Section);
    }

    public string Header
    {
        get => (string)GetValue(HeaderProperty);
        set => SetValue(HeaderProperty, value);
    }

    public UIElement? Body
    {
        get => (UIElement?)GetValue(BodyProperty);
        set => SetValue(BodyProperty, value);
    }
}
