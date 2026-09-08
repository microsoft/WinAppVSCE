#nullable enable

using System;
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
