using System.Collections.ObjectModel;

namespace TestUserApp;

/// <summary>
/// A plain (POCO) view-model used to demonstrate classic <c>{Binding}</c> design-time data. It is
/// referenced only from a page's <c>d:DataContext="{d:DesignInstance Type=vm:DemoViewModel, …}"</c>, so it
/// exercises the Surface host's design-time-data support (§51 M1): the host reflectively constructs this
/// type and assigns it as the parsed root's DataContext so every <c>{Binding}</c> resolves to the sample
/// values seeded in the constructor. It has a public parameterless constructor and self-populates, which is
/// the common, robust design-time pattern.
/// </summary>
public sealed class DemoViewModel
{
    public string Title { get; set; } = "Design-time Title";

    public string Subtitle { get; set; } = "Sample subtitle from DemoViewModel";

    public ObservableCollection<DemoItem> Items { get; } = new();

    public DemoViewModel()
    {
        Items.Add(new DemoItem("First sample", "alpha"));
        Items.Add(new DemoItem("Second sample", "beta"));
        Items.Add(new DemoItem("Third sample", "gamma"));
    }
}
