#nullable enable

using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using EnvDTE;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using WinUIXamlPreview.UI;

namespace WinUIXamlPreview
{
    /// <summary>
    /// Process-wide handoff between the package (which owns the <see cref="UI.EditorTracker"/>) and
    /// the tool window's <see cref="PreviewControl"/> (created lazily by the shell). Kept tiny and
    /// resilient: the control can find the active document even if the tracker isn't up yet.
    /// </summary>
    internal static class PreviewPackageState
    {
        public static EditorTracker? EditorTracker { get; set; }

        // Package-level ownership of every live preview session (each PreviewControl owns a SurfaceClient
        // and therefore a surface process). The package disposes the whole set on shutdown so no surface
        // process can outlive Visual Studio even if an individual margin/tool-window teardown is skipped (T7).
        private static readonly object _sessionGate = new object();
        private static readonly HashSet<IDisposable> _sessions = new HashSet<IDisposable>();
        private static readonly CancellationTokenSource _shutdownCts = new CancellationTokenSource();
        private static bool _shutdownComplete;

        /// <summary>Cancelled once the package begins shutting down; lets sessions abort in-flight work.</summary>
        public static CancellationToken ShutdownToken => _shutdownCts.Token;

        /// <summary>Track a live preview session. If shutdown already ran, the session is disposed immediately.</summary>
        public static void RegisterSession(IDisposable session)
        {
            if (session == null)
            {
                return;
            }

            bool disposeNow = false;
            lock (_sessionGate)
            {
                if (_shutdownComplete)
                {
                    disposeNow = true;
                }
                else
                {
                    _sessions.Add(session);
                }
            }

            if (disposeNow)
            {
                try { session.Dispose(); } catch { }
            }
        }

        /// <summary>Stop tracking a session that disposed itself normally (e.g. its tab/margin closed).</summary>
        public static void UnregisterSession(IDisposable session)
        {
            if (session == null)
            {
                return;
            }

            lock (_sessionGate)
            {
                _sessions.Remove(session);
            }
        }

        /// <summary>
        /// Dispose every live session and cancel the shutdown token. Idempotent; called from the package's
        /// Dispose so a VS exit can never orphan a surface process.
        /// </summary>
        public static void ShutdownAll()
        {
            IDisposable[] snapshot;
            lock (_sessionGate)
            {
                if (_shutdownComplete)
                {
                    return;
                }

                _shutdownComplete = true;
                snapshot = _sessions.ToArray();
                _sessions.Clear();
            }

            try { _shutdownCts.Cancel(); } catch { }

            foreach (var session in snapshot)
            {
                try { session.Dispose(); } catch { }
            }
        }

        /// <summary>
        /// Set by the package: opens (or focuses) the separate preview tool window. Invoked by the in-editor
        /// margin's "Window" toolbar button. Must be called on the UI thread.
        /// </summary>
        public static Action? RequestShowToolWindow { get; set; }

        /// <summary>Full path of the active editor document, or null. Must be called on the UI thread.</summary>
        public static string? GetActiveXamlPath()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            try
            {
                if (Microsoft.VisualStudio.Shell.Package.GetGlobalService(typeof(SDTE)) is DTE dte)
                {
                    return dte.ActiveDocument?.FullName;
                }
            }
            catch
            {
                // no active document / DTE unavailable
            }

            return null;
        }
    }
}
