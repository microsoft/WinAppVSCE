namespace TestUserApp;

/// <summary>A simple item type for the design-time-data demo's sample collection (<see cref="DemoViewModel"/>).</summary>
public sealed class DemoItem
{
    public string Name { get; set; } = string.Empty;

    public string Detail { get; set; } = string.Empty;

    public DemoItem()
    {
    }

    public DemoItem(string name, string detail)
    {
        Name = name;
        Detail = detail;
    }
}
