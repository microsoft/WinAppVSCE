using Microsoft.UI.Xaml.Markup;

namespace SmokeFixture;

public enum BadgeTone
{
    Primary,
    Secondary,
}

public sealed class BadgeExtension : MarkupExtension
{
    public BadgeTone Tone { get; set; }

    protected override object ProvideValue() => Tone.ToString();
}

public sealed class BadgeLookalike
{
    public BadgeTone Tone { get; set; }
}

public sealed class Binding : MarkupExtension
{
    protected override object ProvideValue() => "custom";
}

public sealed class StaticResourceExtension : MarkupExtension
{
    protected override object ProvideValue() => "custom";
}
