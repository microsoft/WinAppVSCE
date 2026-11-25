using Microsoft.UI.Xaml.Data;

namespace SmokeFixture.Helpers;

/// <summary>Static x:Bind targets used by the XAML smoke tests.</summary>
public static class Fmt
{
    public static string Title { get; } = "Smoke";

    public static string Join(string first, string second) => first + second;
}

/// <summary>A plain CLR resource used by resource-dictionary completion tests.</summary>
public sealed class UpperConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, string language) =>
        value?.ToString()?.ToUpperInvariant() ?? string.Empty;

    public object ConvertBack(object value, Type targetType, object parameter, string language) => value;
}
