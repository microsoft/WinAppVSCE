using Microsoft.UI.Xaml.Controls;

namespace TestFixtureLib;

/// <summary>A code-only panel from a referenced library; its authored children must stay selectable.</summary>
public class LibStack : StackPanel
{
    public LibStack()
    {
        Spacing = 6;
    }
}
