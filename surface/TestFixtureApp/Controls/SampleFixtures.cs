using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace TestFixtureApp.Controls;

// Third-party-style chart controls and template selectors for the --behaviors "sample charts and selectors" group.

/// <summary>An empty round chart: the preview should draw a placeholder donut over it.</summary>
public sealed partial class FixturePieChart : Control
{
    public IList<double> ItemsSource { get; set; } = new List<double>();
}

/// <summary>An empty line chart: the preview should draw a placeholder series over it.</summary>
public sealed partial class FixtureLineChart : Control
{
    public IList<double>? Series { get; set; }
}

/// <summary>A chart whose constructor fills Series while ItemsSource stays empty: it has data, so no placeholder.</summary>
public sealed partial class FixtureSeriesChart : Control
{
    public IList<double> Series { get; } = new List<double> { 1, 3, 2 };
    public IList<double> ItemsSource { get; set; } = new List<double>();
}

/// <summary>A selector that only understands the app's real row type and throws on anything else.</summary>
public sealed partial class ThrowingSelector : DataTemplateSelector
{
    protected override DataTemplate SelectTemplateCore(object item) =>
        throw new InvalidCastException("ThrowingSelector: unexpected row " + item?.GetType().Name);

    protected override DataTemplate SelectTemplateCore(object item, DependencyObject container) => SelectTemplateCore(item);
}

/// <summary>A well-behaved selector: always returns its Template.</summary>
public sealed partial class FixedSelector : DataTemplateSelector
{
    public DataTemplate? Template { get; set; }

    protected override DataTemplate? SelectTemplateCore(object item) => Template;

    protected override DataTemplate? SelectTemplateCore(object item, DependencyObject container) => Template;
}
