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

// Five more distinct throwing types: the safety net retires one type per retry and is bounded at 5 retries, so a
// page using all six exhausts it. Each throws from its OWN constructor so the offender is the declared type.
public sealed class ThrowingControlB : Control
{
    public ThrowingControlB() => throw new InvalidOperationException("ThrowingControlB");
}

public sealed class ThrowingControlC : Control
{
    public ThrowingControlC() => throw new InvalidOperationException("ThrowingControlC");
}

public sealed class ThrowingControlD : Control
{
    public ThrowingControlD() => throw new InvalidOperationException("ThrowingControlD");
}

public sealed class ThrowingControlE : Control
{
    public ThrowingControlE() => throw new InvalidOperationException("ThrowingControlE");
}

public sealed class ThrowingControlF : Control
{
    public ThrowingControlF() => throw new InvalidOperationException("ThrowingControlF");
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

/// <summary>Like WinUI Gallery's ControlExample: an <c>async void</c> Loaded handler reads a content file shipped
/// next to the app (CopyToOutputDirectory). The host must stage that file, or the read throws on the UI thread.</summary>
public sealed class ContentFileReader : ContentControl
{
    public ContentFileReader()
    {
        Content = "(not loaded)";
        Loaded += OnLoaded;
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        Content = (await System.IO.File.ReadAllTextAsync(
            System.IO.Path.Combine(AppContext.BaseDirectory, "FixtureContent", "greeting.txt"))).Trim();
    }
}

/// <summary>An <c>async void</c> Loaded handler that faults after the page has rendered; nothing in the host's call
/// stack can catch it, so only the host's Application.UnhandledException net keeps the preview alive.</summary>
public sealed class AsyncThrowingControl : Control
{
    public AsyncThrowingControl() => Loaded += OnLoaded;

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        await System.Threading.Tasks.Task.Yield();
        throw new InvalidOperationException("AsyncThrowingControl: background work failed after load.");
    }
}