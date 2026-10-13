using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace TestFixtureApp.Controls;

// Deliberately hostile user code for the --behaviors lane: the preview must degrade (placeholder / no
// DataContext) and keep rendering the rest of the page, never crash the surface.

/// <summary>A control whose constructor throws, like one that touches app services at design time.</summary>
public sealed class ThrowingControl : Control
{
    public ThrowingControl()
    {
        throw new InvalidOperationException("ThrowingControl: app services are unavailable at design time.");
    }
}

/// <summary>A view model whose constructor throws.</summary>
public sealed class ThrowingViewModel
{
    public ThrowingViewModel()
    {
        throw new InvalidOperationException("ThrowingViewModel: no backend at design time.");
    }

    public string Title => "never";
}

public sealed class SamplePerson
{
    public string Name { get; set; } = "Grace Hopper";
}

/// <summary>A self-populating view model with a nested object and a collection.</summary>
public sealed class SampleViewModel
{
    public string Title { get; set; } = "Sample title";
    public SamplePerson Owner { get; set; } = new SamplePerson();
    public List<SamplePerson> People { get; set; } = new()
    {
        new SamplePerson { Name = "Ada" },
        new SamplePerson { Name = "Alan" },
    };
}

/// <summary>A design-instance type with no public parameterless constructor.</summary>
public sealed class NoDefaultCtorViewModel
{
    public NoDefaultCtorViewModel(string title) => Title = title;

    public string Title { get; }
}

/// <summary>A control that keeps the UI thread busy forever (an auto-advancing carousel, a clock); the preview must
/// still render pages that contain it.</summary>
public sealed class TickerControl : Control
{
    private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromMilliseconds(16) };

    public TickerControl()
    {
        _timer.Tick += (_, _) => Ticks++;
        _timer.Start();
    }

    public int Ticks { get; private set; }
}