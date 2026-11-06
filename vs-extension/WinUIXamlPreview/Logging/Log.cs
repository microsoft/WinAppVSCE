#nullable enable

using System;
using System.IO;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using Task = System.Threading.Tasks.Task;

namespace WinUIXamlPreview.Logging
{
    /// <summary>
    /// Lightweight logger that writes to a dedicated Output pane ("WinUI XAML Preview"), to the
    /// debugger, AND to a rolling log file on disk. The file sink is critical for debugging in
    /// constrained environments (VMs / RDP) where reading the Output pane in the live VS UI is
    /// impractical — the file can be read out-of-band while VS keeps running. All VS-thread work is
    /// marshaled through the shared JoinableTaskFactory. Safe to call from any thread.
    /// </summary>
    internal static class Log
    {
        private static IVsOutputWindowPane? _pane;
        private static readonly object Gate = new object();

        /// <summary>
        /// Absolute path of the on-disk log. Exposed so the package can echo it at startup, making
        /// the file trivial to locate: <c>%LOCALAPPDATA%\WinUIXamlPreview\preview.log</c>.
        /// </summary>
        public static readonly string LogFilePath = BuildLogFilePath();

        private static string BuildLogFilePath()
        {
            try
            {
                var dir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "WinUIXamlPreview");
                Directory.CreateDirectory(dir);
                return Path.Combine(dir, "preview.log");
            }
            catch
            {
                return Path.Combine(Path.GetTempPath(), "WinUIXamlPreview.preview.log");
            }
        }

        public static async Task InitializeAsync(IAsyncServiceProvider services)
        {
            // Start every VS session with a clear marker so stale content is never confusing.
            WriteToFile($"===== WinUI XAML Preview session start (pid {System.Diagnostics.Process.GetCurrentProcess().Id}) =====");
            WriteToFile($"log file: {LogFilePath}");

            try
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                if (await services.GetServiceAsync(typeof(SVsOutputWindow)) is IVsOutputWindow outputWindow)
                {
                    var guid = PackageGuids.OutputPaneGuid;
                    outputWindow.CreatePane(ref guid, "WinUI XAML Preview", 1, 1);
                    outputWindow.GetPane(ref guid, out _pane);
                }
            }
            catch (Exception ex)
            {
                WriteToFile("Log init (output pane) failed: " + ex);
                System.Diagnostics.Debug.WriteLine("[WinUIXamlPreview] Log init failed: " + ex);
            }
        }

        public static void Write(string message)
        {
            var line = $"[{DateTime.Now:HH:mm:ss.fff}] {message}";
            System.Diagnostics.Debug.WriteLine("[WinUIXamlPreview] " + line);
            WriteToFile(line);

            var pane = _pane;
            if (pane == null)
            {
                return;
            }

            _ = ThreadHelper.JoinableTaskFactory.RunAsync(async () =>
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                lock (Gate)
                {
                    pane.OutputStringThreadSafe(line + Environment.NewLine);
                }
            });
        }

        private static void WriteToFile(string line)
        {
            try
            {
                lock (Gate)
                {
                    File.AppendAllText(LogFilePath, line + Environment.NewLine);
                }
            }
            catch
            {
                // Never let logging throw into caller paths.
            }
        }
    }
}
