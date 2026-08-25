using System.Collections.Generic;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace SmokeFixture;

/// <summary>
/// The landing page navigated to on startup. Exposes the x:Bind targets
/// <see cref="GreetingText"/> and <see cref="Items"/>, and wires <see cref="GoButton"/>
/// to navigate the hosting Frame to <see cref="Page2"/>.
/// </summary>
public sealed partial class SmokePage : Page
{
    /// <summary>Greeting sourced from the DI singleton <see cref="IGreetingService"/>.</summary>
    public string GreetingText { get; }

    /// <summary>Backing collection for the <c>Repeater</c> compiled binding.</summary>
    public IReadOnlyList<string> Items { get; } = new[] { "Alpha", "Bravo", "Charlie", "Delta" };

    public SmokePage()
    {
        InitializeComponent();
        GreetingText = App.Services.GetRequiredService<IGreetingService>().GetGreeting();
    }

    private void OnGo_Click(object sender, RoutedEventArgs e)
    {
        Frame.Navigate(typeof(Page2));
    }
}

internal sealed class InternalCard : Control
{
}

internal sealed class InternalViewModel
{
    public string Title { get; } = "Internal";
}
