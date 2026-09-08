#nullable enable

using System;
using System.ComponentModel.Design;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using EnvDTE;
using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using Microsoft.VisualStudio.Threading;
using WinUIXamlPreview.Logging;
using WinUIXamlPreview.UI;

namespace WinUIXamlPreview
{
    /// <summary>
    /// Async in-proc package for the WinUI XAML live preview. Registers a single tool window (no
    /// menu/command plumbing) and starts an <see cref="EditorTracker"/> so the preview follows the
    /// active <c>.xaml</c> document. Hosts the reused headless surface via <c>SurfaceClient</c>.
    /// </summary>
    [PackageRegistration(UseManagedResourcesOnly = true, AllowsBackgroundLoading = true)]
    [Guid(PackageGuids.PackageGuidString)]
    [ProvideMenuResource("Menus.ctmenu", 1)]
    [ProvideAutoLoad(VSConstants.UICONTEXT.ShellInitialized_string, PackageAutoLoadFlags.BackgroundLoad)]
    [ProvideToolWindow(typeof(PreviewToolWindow), Style = VsDockStyle.Tabbed, Orientation = ToolWindowOrientation.Right)]
    [ProvideToolWindow(typeof(PropertiesToolWindow), Style = VsDockStyle.Tabbed, Orientation = ToolWindowOrientation.Right)]
    public sealed class PreviewPackage : AsyncPackage
    {
        protected override async Task InitializeAsync(CancellationToken cancellationToken, IProgress<ServiceProgressData> progress)
        {
            await base.InitializeAsync(cancellationToken, progress);
            await Log.InitializeAsync(this);
            Log.Write("WinUI XAML Preview package initializing…");

            await JoinableTaskFactory.SwitchToMainThreadAsync(cancellationToken);

            var rdt = await GetServiceAsync(typeof(SVsRunningDocumentTable)) as IVsRunningDocumentTable;
            var dte = await GetServiceAsync(typeof(SDTE)) as DTE;

            if (rdt != null && dte != null)
            {
                PreviewPackageState.EditorTracker = new EditorTracker(rdt, dte, JoinableTaskFactory);
                Log.Write("EditorTracker started (following the active document).");
            }
            else
            {
                Log.Write("WARNING: RDT/DTE unavailable; active-document tracking disabled.");
            }

            // Register the "View -> Other Windows -> WinUI XAML Preview" command so users have a
            // discoverable, on-demand way to (re)open the pane. The .vsct places the button; this
            // wires the click to ShowToolWindow.
            if (await GetServiceAsync(typeof(IMenuCommandService)) is OleMenuCommandService mcs)
            {
                var id = new CommandID(PackageGuids.CommandSet, PackageGuids.ShowPreviewCommandId);
                mcs.AddCommand(new MenuCommand(OnShowPreviewCommand, id));
                Log.Write("Show-preview command registered.");
            }
            else
            {
                Log.Write("WARNING: IMenuCommandService unavailable; menu command not registered.");
            }

            // Let the in-editor margin's "Window" button reopen the separate tool window on demand.
            PreviewPackageState.RequestShowToolWindow = () => OnShowPreviewCommand(this, EventArgs.Empty);

            // Let a selection in the design surface open (once) / the toolbar reopen the properties panel.
            DesignerSelection.RequestShowPropertiesWindow = ShowPropertiesWindow;

            // No .vsct command yet, so surface the pane automatically once the shell is up. This
            // makes the preview visible without a menu entry (a proper View menu command is a
            // follow-up). Showing it here also drives the first render of the active .xaml.
            //
            // IMPORTANT: do NOT await ShowToolWindowAsync inside InitializeAsync — the tool-window
            // infrastructure waits for the package to finish loading, so awaiting it here (while we
            // are still inside the package load) deadlocks. Schedule it to run AFTER init returns.
            // SPIKE (v0.2.0): the live preview now rides INSIDE the XAML code tab as an editor margin
            // (see Editor\XamlPreviewMargin.cs), so we no longer auto-pop the separate tool window — that
            // would run a second preview for the same file. The tool window is still registered and can be
            // reopened any time via View -> Other Windows -> WinUI XAML Preview (OnShowPreviewCommand).
            // ShowPreviewPaneDeferred();

            Log.Write("WinUI XAML Preview package ready.");
        }

        private void OnShowPreviewCommand(object sender, EventArgs e)
        {
            // Fire-and-forget onto the UI thread; showing the tool window is safe here (we are long
            // past package load, unlike the auto-show during InitializeAsync).
            JoinableTaskFactory.RunAsync(async () =>
            {
                await JoinableTaskFactory.SwitchToMainThreadAsync(DisposalToken);
                try
                {
                    await ShowToolWindowAsync(typeof(PreviewToolWindow), 0, create: true, DisposalToken);
                }
                catch (Exception ex)
                {
                    Log.Write("Show-preview command failed: " + ex);
                }
            }).FileAndForget("winuixamlpreview/show-command");
        }

        private void ShowPreviewPaneDeferred()
        {
            JoinableTaskFactory.RunAsync(async () =>
            {
                // Let InitializeAsync return (package finishes loading) before we ask to show the
                // pane, otherwise ShowToolWindowAsync re-enters the still-loading package.
                await Task.Yield();
                await JoinableTaskFactory.SwitchToMainThreadAsync(DisposalToken);
                try
                {
                    await ShowToolWindowAsync(typeof(PreviewToolWindow), 0, create: true, DisposalToken);
                    Log.Write("Preview tool window auto-shown.");
                }
                catch (Exception ex)
                {
                    Log.Write("Auto-show tool window failed: " + ex);
                }
            }).FileAndForget("winuixamlpreview/auto-show");
        }

        private void ShowPropertiesWindow()
        {
            JoinableTaskFactory.RunAsync(async () =>
            {
                await JoinableTaskFactory.SwitchToMainThreadAsync(DisposalToken);
                try
                {
                    await ShowToolWindowAsync(typeof(PropertiesToolWindow), 0, create: true, DisposalToken);
                }
                catch (Exception ex)
                {
                    Log.Write("Show-properties failed: " + ex);
                }
            }).FileAndForget("winuixamlpreview/show-properties");
        }

        // ---- async tool window factory (recommended AsyncPackage pattern) ----

        public override IVsAsyncToolWindowFactory? GetAsyncToolWindowFactory(Guid toolWindowType)
        {
            return toolWindowType == typeof(PreviewToolWindow).GUID
                || toolWindowType == typeof(PropertiesToolWindow).GUID
                ? this
                : base.GetAsyncToolWindowFactory(toolWindowType);
        }

        protected override string GetToolWindowTitle(Type toolWindowType, int id)
            => toolWindowType == typeof(PropertiesToolWindow)
                ? "WinUI Designer — Properties"
                : "WinUI XAML Preview";

        protected override Task<object?> InitializeToolWindowAsync(Type toolWindowType, int id, CancellationToken cancellationToken)
        {
            // The pane builds its own WPF content; nothing to prepare off the UI thread.
            return Task.FromResult<object?>(null);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                PreviewPackageState.EditorTracker?.Dispose();
                PreviewPackageState.EditorTracker = null;
            }

            base.Dispose(disposing);
        }
    }
}
