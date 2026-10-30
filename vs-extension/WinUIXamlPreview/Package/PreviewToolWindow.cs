#nullable enable

using System;
using System.Runtime.InteropServices;
using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using WinUIXamlPreview.Logging;
using WinUIXamlPreview.UI;

namespace WinUIXamlPreview
{
    /// <summary>
    /// The dockable tool window that hosts the live XAML preview. Registered via
    /// <c>[ProvideToolWindow]</c> on the package, so it appears under
    /// <b>View → Other Windows → WinUI XAML Preview</b> with no command/menu (.vsct) plumbing.
    /// While it is open the in-editor margins step aside (<see cref="PreviewPackageState.PoppedOut"/>).
    /// </summary>
    [Guid(PackageGuids.ToolWindowGuidString)]
    public sealed class PreviewToolWindow : ToolWindowPane, IVsWindowFrameNotify3
    {
        private PreviewControl _preview = null!;

        public PreviewToolWindow()
            : base(null)
        {
            Caption = "WinUI XAML Preview";
            Content = BuildContent();
        }

        // Shared preview toolbar (no Dock/Window/Hide — those are margin-only) above the preview.
        private object BuildContent()
        {
            _preview = new PreviewControl();
            var root = new System.Windows.Controls.DockPanel { LastChildFill = true };
            root.SetResourceReference(System.Windows.Controls.Panel.BackgroundProperty, Microsoft.VisualStudio.PlatformUI.EnvironmentColors.ToolWindowBackgroundBrushKey);
            var toolbar = new Editor.PreviewToolbar(_preview).Element;
            System.Windows.Controls.DockPanel.SetDock(toolbar, System.Windows.Controls.Dock.Top);
            root.Children.Add(toolbar);
            root.Children.Add(_preview);
            return root;
        }

        public override void OnToolWindowCreated()
        {
            base.OnToolWindowCreated();
            ThreadHelper.ThrowIfNotOnUIThread();
            try
            {
                if (Frame is IVsWindowFrame frame)
                {
                    frame.SetProperty((int)__VSFPROPID.VSFPROPID_ViewHelper, this);
                    PreviewPackageState.SetPoppedOut(frame.IsVisible() == VSConstants.S_OK);
                }
            }
            catch (Exception ex)
            {
                Log.Write("Preview tool window: frame notify hookup failed: " + ex.Message);
            }
        }

        protected override void OnClose()
        {
            PreviewPackageState.SetPoppedOut(false);
            _preview.Dispose();

            // The shell keeps this pane and reshows it on the next "Window" click; give it a live control
            // (the disposed one can never render again).
            Content = BuildContent();
            base.OnClose();
        }

        // ---- IVsWindowFrameNotify3 -------------------------------------------

        public int OnShow(int fShow)
        {
            switch ((__FRAMESHOW)fShow)
            {
                case __FRAMESHOW.FRAMESHOW_WinShown:
                case __FRAMESHOW.FRAMESHOW_WinRestored:
                    PreviewPackageState.SetPoppedOut(true);
                    break;
                case __FRAMESHOW.FRAMESHOW_WinHidden:
                case __FRAMESHOW.FRAMESHOW_WinClosed:
                    PreviewPackageState.SetPoppedOut(false);
                    break;
            }

            return VSConstants.S_OK;
        }

        public int OnMove(int x, int y, int w, int h) => VSConstants.S_OK;

        public int OnSize(int x, int y, int w, int h) => VSConstants.S_OK;

        public int OnDockableChange(int fDockable, int x, int y, int w, int h) => VSConstants.S_OK;

        public int OnClose(ref uint pgrfSaveOptions) => VSConstants.S_OK;
    }
}
