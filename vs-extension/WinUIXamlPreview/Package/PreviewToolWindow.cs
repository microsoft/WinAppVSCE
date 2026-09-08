#nullable enable

using System;
using System.Runtime.InteropServices;
using Microsoft.VisualStudio.Shell;
using WinUIXamlPreview.UI;

namespace WinUIXamlPreview
{
    /// <summary>
    /// The dockable tool window that hosts the live XAML preview. Registered via
    /// <c>[ProvideToolWindow]</c> on the package, so it appears under
    /// <b>View → Other Windows → WinUI XAML Preview</b> with no command/menu (.vsct) plumbing.
    /// </summary>
    [Guid(PackageGuids.ToolWindowGuidString)]
    public sealed class PreviewToolWindow : ToolWindowPane
    {
        public PreviewToolWindow()
            : base(null)
        {
            Caption = "WinUI XAML Preview";
            Content = new PreviewControl();
        }

        protected override void OnClose()
        {
            (Content as IDisposable)?.Dispose();
            base.OnClose();
        }
    }
}
