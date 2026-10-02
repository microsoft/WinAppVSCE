#nullable enable

using System;
using EnvDTE;
using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using Microsoft.VisualStudio.Threading;
using WinUIXamlPreview.Logging;

namespace WinUIXamlPreview.UI
{
    /// <summary>
    /// Tracks which document is active in the editor so the preview can follow it. Combines two
    /// standard VSSDK signals: Running Document Table events (document show / save) and DTE window
    /// activation. Raises <see cref="ActiveDocumentChanged"/> when the active document path changes,
    /// and <see cref="ActiveDocumentSaved"/> when the active document is saved. This is standard
    /// shell boilerplate — no proprietary designer logic.
    /// </summary>
    internal sealed class EditorTracker : IVsRunningDocTableEvents, IDisposable
    {
        private readonly IVsRunningDocumentTable _rdt;
        private readonly DTE _dte;
        private readonly JoinableTaskFactory _jtf;
        private readonly WindowEvents _windowEvents;
        private readonly DocumentEvents _documentEvents;
        private readonly uint _cookie;
        private string? _lastPath;
        private bool _disposed;

        public EditorTracker(IVsRunningDocumentTable rdt, DTE dte, JoinableTaskFactory jtf)
        {
            _rdt = rdt ?? throw new ArgumentNullException(nameof(rdt));
            _dte = dte ?? throw new ArgumentNullException(nameof(dte));
            _jtf = jtf ?? throw new ArgumentNullException(nameof(jtf));

            ThreadHelper.ThrowIfNotOnUIThread();
            ErrorHandler.ThrowOnFailure(_rdt.AdviseRunningDocTableEvents(this, out _cookie));

            // Hold references so the COM event sinks are not collected.
            _windowEvents = _dte.Events.WindowEvents;
            _windowEvents.WindowActivated += OnWindowActivated;
            _documentEvents = _dte.Events.DocumentEvents;
            _documentEvents.DocumentSaved += OnDocumentSaved;
        }

        public event EventHandler<string?>? ActiveDocumentChanged;

        public event EventHandler<string?>? ActiveDocumentSaved;

        public string? GetActiveDocumentPath()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            try
            {
                return _dte.ActiveDocument?.FullName;
            }
            catch
            {
                return null;
            }
        }

        // ---- IVsRunningDocTableEvents --------------------------------------

        public int OnBeforeDocumentWindowShow(uint docCookie, int fFirstShow, IVsWindowFrame pFrame)
        {
            RaiseChanged();
            return VSConstants.S_OK;
        }

        public int OnAfterSave(uint docCookie)
        {
            RaiseSaved();
            return VSConstants.S_OK;
        }

        public int OnAfterFirstDocumentLock(uint docCookie, uint dwRDTLockType, uint dwReadLocksRemaining, uint dwEditLocksRemaining) => VSConstants.S_OK;
        public int OnBeforeLastDocumentUnlock(uint docCookie, uint dwRDTLockType, uint dwReadLocksRemaining, uint dwEditLocksRemaining) => VSConstants.S_OK;
        public int OnAfterAttributeChange(uint docCookie, uint grfAttribs) => VSConstants.S_OK;
        public int OnAfterDocumentWindowHide(uint docCookie, IVsWindowFrame pFrame) => VSConstants.S_OK;

        // ---- DTE events -----------------------------------------------------

        private void OnWindowActivated(Window gotFocus, Window lostFocus) => RaiseChanged();

        private void OnDocumentSaved(Document document) => RaiseSaved();

        // ---- dispatch -------------------------------------------------------

        private void RaiseChanged()
        {
            if (_disposed)
            {
                return;
            }

            _ = _jtf.RunAsync(async () =>
            {
                await _jtf.SwitchToMainThreadAsync();
                if (_disposed)
                {
                    return;
                }

                var path = GetActiveDocumentPath();
                if (string.Equals(_lastPath, path, StringComparison.OrdinalIgnoreCase))
                {
                    return;
                }

                _lastPath = path;
                ActiveDocumentChanged?.Invoke(this, path);
            });
        }

        private void RaiseSaved()
        {
            if (_disposed)
            {
                return;
            }

            _ = _jtf.RunAsync(async () =>
            {
                await _jtf.SwitchToMainThreadAsync();
                if (_disposed)
                {
                    return;
                }

                ActiveDocumentSaved?.Invoke(this, GetActiveDocumentPath());
            });
        }

        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;

            // When already on the UI thread (the normal package-shutdown path) unsubscribe directly: calling
            // _jtf.Run here would needlessly re-enter the message pump and can deadlock during shell teardown.
            // Only marshal when we are genuinely off the UI thread. Each step is guarded on its own so a
            // throwing DTE-event detach can never skip the RDT unadvise — the COM sink that must come off (T8).
            if (_jtf.Context.IsOnMainThread)
            {
                Unsubscribe();
            }
            else
            {
                try
                {
                    _jtf.Run(async () =>
                    {
                        await _jtf.SwitchToMainThreadAsync();
                        Unsubscribe();
                    });
                }
                catch (Exception ex)
                {
                    Log.Write("EditorTracker teardown failed to marshal to the UI thread: " + ex);
                }
            }
        }

        private void Unsubscribe()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            try { _windowEvents.WindowActivated -= OnWindowActivated; }
            catch (Exception ex) { Log.Write("EditorTracker: WindowActivated detach failed: " + ex); }

            try { _documentEvents.DocumentSaved -= OnDocumentSaved; }
            catch (Exception ex) { Log.Write("EditorTracker: DocumentSaved detach failed: " + ex); }

            try { if (_cookie != 0) _rdt.UnadviseRunningDocTableEvents(_cookie); }
            catch (Exception ex) { Log.Write("EditorTracker: RDT unadvise failed: " + ex); }
        }
    }
}
