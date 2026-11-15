#nullable enable

using System;
using System.Collections.Generic;
using System.Windows.Threading;
using WinUIXamlPreview.Logging;
using WinUIXamlPreview.Protocol;

namespace WinUIXamlPreview.UI
{
    /// <summary>
    /// A live, already-rendered surface whose preview went away (dock switch reopens the document, the preview
    /// moved to or from the tool window, the tool window was redocked). Its window is detached and parked off-screen,
    /// so the next preview of the same document can re-host it instead of cold-starting a new process.
    /// </summary>
    internal sealed class ParkedSurface : IDisposable
    {
        public string Path { get; set; } = "";
        public SurfaceClient Client { get; set; } = null!;
        public IntPtr Hwnd { get; set; }
        public int PixelWidth { get; set; }
        public int PixelHeight { get; set; }

        // Launch config the process was started with.
        public string? SurfaceExe { get; set; }
        public string? UserDll { get; set; }
        public string? UserAppXaml { get; set; }
        public string? Project { get; set; }
        public string? Theme { get; set; }
        public string? UserPri { get; set; }
        public DateTime UserDllWriteTime { get; set; } // a rebuild while parked makes the process stale

        internal static DateTime DllStamp(string? dll)
        {
            try { return string.IsNullOrEmpty(dll) ? default : System.IO.File.GetLastWriteTimeUtc(dll); }
            catch { return default; }
        }

        // Settings the rendered content reflects; an adopter whose settings differ starts fresh instead.
        public bool? SampleData { get; set; }
        public bool DesignMode { get; set; }
        public double CanvasWidth { get; set; }
        public double CanvasHeight { get; set; }
        public double DpiScale { get; set; }

        // Render state to restore on the adopting preview.
        public string? Xaml { get; set; }
        public ViewMsg? View { get; set; }
        public IReadOnlyDictionary<string, string>? ContentPropMap { get; set; }
        public HwndMsg? LastHosted { get; set; }

        internal DispatcherTimer? Expiry;
        internal Action<string>? ClosedHandler;
        private bool _disposed;

        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            try { Client.Dispose(); } catch { }
        }
    }

    /// <summary>
    /// Process-wide parking for <see cref="ParkedSurface"/>s, keyed by document path. Entries expire after
    /// <see cref="Lifetime"/> (the process is then disposed as before) and are registered as preview sessions so a
    /// VS shutdown still kills them. UI thread only.
    /// </summary>
    internal static class SurfaceParking
    {
        internal static readonly TimeSpan Lifetime = TimeSpan.FromSeconds(10);
        private static readonly ParkingLot<ParkedSurface> _lot = new ParkingLot<ParkedSurface>(capacity: 4);

        public static void Park(ParkedSurface p)
        {
            foreach (var dropped in _lot.Park(p.Path, p))
            {
                Log.Write($"Parked surface for '{dropped.Path}' replaced; disposing it.");
                Release(dropped);
                dropped.Dispose();
            }

            PreviewPackageState.RegisterSession(p);
            var dispatcher = Dispatcher.CurrentDispatcher;
            p.ClosedHandler = reason => dispatcher.BeginInvoke(new Action(() => Expire(p, "closed: " + reason)));
            p.Client.Closed += p.ClosedHandler;
            p.Expiry = new DispatcherTimer(DispatcherPriority.Background, dispatcher) { Interval = Lifetime };
            p.Expiry.Tick += (_, __) => Expire(p, "not reused");
            p.Expiry.Start();
            Log.Write($"Parked the live surface for '{p.Path}' for {Lifetime.TotalSeconds:0} s.");
        }

        /// <summary>Take the parked surface for <paramref name="path"/> if <paramref name="usable"/> accepts it.</summary>
        public static ParkedSurface? TryTake(string path, Func<ParkedSurface, bool> usable)
        {
            var p = _lot.TryTake(path, usable);
            if (p != null)
            {
                Release(p);
            }

            return p;
        }

        private static void Expire(ParkedSurface p, string why)
        {
            if (!_lot.Remove(p))
            {
                return; // already adopted or replaced
            }

            Log.Write($"Parked surface for '{p.Path}' released ({why}).");
            Release(p);
            p.Dispose();
        }

        private static void Release(ParkedSurface p)
        {
            p.Expiry?.Stop();
            p.Expiry = null;
            if (p.ClosedHandler != null)
            {
                p.Client.Closed -= p.ClosedHandler;
                p.ClosedHandler = null;
            }

            PreviewPackageState.UnregisterSession(p);
        }
    }
}
