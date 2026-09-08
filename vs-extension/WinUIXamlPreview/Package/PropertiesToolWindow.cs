#nullable enable

using System;
using System.Runtime.InteropServices;
using Microsoft.VisualStudio.Shell;
using WinUIXamlPreview.UI;

namespace WinUIXamlPreview
{
    /// <summary>
    /// The dockable tool window that hosts the design-time property panel (plan §41). Registered via
    /// <c>[ProvideToolWindow]</c> on the package; opened automatically the first time an element is selected
    /// in the preview, or on demand from the margin toolbar's "Properties" button.
    /// </summary>
    [Guid(PackageGuids.PropertiesToolWindowGuidString)]
    public sealed class PropertiesToolWindow : ToolWindowPane
    {
        public PropertiesToolWindow()
            : base(null)
        {
            Caption = "WinUI Designer — Properties";
            Content = new PropertyPanelControl();
        }
    }
}
