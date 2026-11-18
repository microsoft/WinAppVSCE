using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Data;

namespace Surface;

/// <summary>
/// Converters the sample-data rewrite references from generated <c>{Binding}</c>s. Registered in the host's
/// application resources (<see cref="App"/>) so the rewritten markup resolves them like any app resource.
/// </summary>
internal static class SampleConverters
{
    /// <summary>Key of the converter a template <c>Visibility="{x:Bind …}"</c> is rewritten to use.</summary>
    internal const string VisibilityKey = "__wxpSampleVisibility";

    internal static void Register(ResourceDictionary resources)
    {
        try
        {
            resources[VisibilityKey] = new SampleVisibilityConverter();
        }
        catch (Exception ex)
        {
            App.Log($"SAMPLE: registering converters failed: {ex.GetType().Name}: {ex.Message}");
        }
    }
}

/// <summary>
/// A sample row's value to <see cref="Visibility"/>, as <c>x:Bind</c> converts a <c>bool</c>: false, null, empty
/// and zero collapse; a <see cref="Visibility"/> (or its name) passes through; anything else shows.
/// </summary>
internal sealed partial class SampleVisibilityConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, string language) => value switch
    {
        null => Visibility.Collapsed,
        Visibility v => v,
        bool b => b ? Visibility.Visible : Visibility.Collapsed,
        string s when s.Equals("Collapsed", StringComparison.OrdinalIgnoreCase) || s.Equals("False", StringComparison.OrdinalIgnoreCase) || s.Length == 0
            => Visibility.Collapsed,
        double d => d == 0 ? Visibility.Collapsed : Visibility.Visible,
        int i => i == 0 ? Visibility.Collapsed : Visibility.Visible,
        _ => Visibility.Visible,
    };

    public object ConvertBack(object value, Type targetType, object parameter, string language) =>
        value is Visibility v && v == Visibility.Visible;
}
