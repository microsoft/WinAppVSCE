#nullable enable
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

namespace WinUIXamlPreview.Protocol;

/// <summary>
/// Kills the preview when the hosted Surface window stops pumping messages. Once reparented into Visual Studio,
/// the Surface's UI thread shares VS's input queue, so a stuck Surface freezes VS input ("Not Responding")
/// even though VS's own UI thread is idle. Probes the window from a thread-pool thread (never the VS UI
/// thread) and calls <c>onHung</c> once after it has been unresponsive for <c>hungAfter</c>.
/// </summary>
internal sealed class SurfaceHangWatchdog : IDisposable
{
    public static readonly TimeSpan DefaultInterval = TimeSpan.FromSeconds(1);

    // Long enough that a slow-but-alive render (a heavy page load runs on the Surface UI thread) is never
    // killed; short enough that VS recovers on its own instead of staying frozen.
    public static readonly TimeSpan DefaultHungAfter = TimeSpan.FromSeconds(10);

    private readonly Func<bool?> _probe;
    private readonly Action<TimeSpan> _onHung;
    private readonly TimeSpan _hungAfter;
    private readonly Timer _timer;
    private Stopwatch? _hungSince;
    private int _busy;
    private int _done;

    /// <summary>Watches <paramref name="hwnd"/>; <paramref name="onHung"/> runs on a thread-pool thread.</summary>
    public static SurfaceHangWatchdog Start(IntPtr hwnd, Action<TimeSpan> onHung) =>
        Start(hwnd, onHung, DefaultInterval, DefaultHungAfter);

    internal static SurfaceHangWatchdog Start(IntPtr hwnd, Action<TimeSpan> onHung, TimeSpan interval, TimeSpan hungAfter) =>
        new(() => Probe(hwnd), onHung, interval, hungAfter);

    /// <summary>
    /// BB-060: watches a surface before its window is hosted (the first load), by probing the process's WinUI
    /// windows. No WinUI window yet counts as responsive: the process is still starting.
    /// </summary>
    public static SurfaceHangWatchdog StartForProcess(int pid, Action<TimeSpan> onHung, TimeSpan hungAfter) =>
        new(() => ProbeProcess(pid), onHung, DefaultInterval, hungAfter);

    private const string WinUIWindowClass = "WinUIDesktopWin32WindowClass";

    private static bool? ProbeProcess(int pid)
    {
        var windows = new System.Collections.Generic.List<IntPtr>();
        var cls = new System.Text.StringBuilder(64);
        EnumWindows((h, _) =>
        {
            GetWindowThreadProcessId(h, out var owner);
            if (owner == (uint)pid)
            {
                cls.Clear();
                if (GetClassName(h, cls, cls.Capacity) > 0 && cls.ToString() == WinUIWindowClass)
                {
                    windows.Add(h);
                }
            }
            return true;
        }, IntPtr.Zero);

        // Responsive if any WinUI window answers; a hung UI thread leaves all of them unanswered.
        bool sawLive = false;
        foreach (var h in windows)
        {
            var r = Probe(h);
            if (r == true)
            {
                return true;
            }
            sawLive |= r == false;
        }
        return !sawLive;
    }

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder className, int maxCount);

    /// <param name="probe">True = responsive, false = not responding, null = window gone (stops watching).</param>
    internal SurfaceHangWatchdog(Func<bool?> probe, Action<TimeSpan> onHung, TimeSpan interval, TimeSpan hungAfter)
    {
        _probe = probe;
        _onHung = onHung;
        _hungAfter = hungAfter;
        _timer = new Timer(_ => Tick(), null, interval, interval);
    }

    private void Tick()
    {
        if (Volatile.Read(ref _done) != 0 || Interlocked.Exchange(ref _busy, 1) != 0)
        {
            return; // stopped, or the previous probe is still waiting on the window
        }

        try
        {
            var responsive = _probe();
            if (responsive is null)
            {
                Dispose();
            }
            else if (responsive.Value)
            {
                _hungSince = null;
            }
            else
            {
                _hungSince ??= Stopwatch.StartNew();
                if (_hungSince.Elapsed >= _hungAfter && Interlocked.Exchange(ref _done, 1) == 0)
                {
                    _timer.Dispose();
                    _onHung(_hungSince.Elapsed);
                }
            }
        }
        catch
        {
            // A probe or callback failure must never take down VS; the next tick tries again.
        }
        finally
        {
            Volatile.Write(ref _busy, 0);
        }
    }

    public void Dispose()
    {
        Interlocked.Exchange(ref _done, 1);
        _timer.Dispose();
    }

    private static bool? Probe(IntPtr hwnd)
    {
        if (!IsWindow(hwnd))
        {
            return null;
        }

        // SMTO_ABORTIFHUNG returns at once if Windows already considers the thread hung; otherwise wait up to 1 s.
        if (SendMessageTimeout(hwnd, WM_NULL, IntPtr.Zero, IntPtr.Zero, SMTO_BLOCK | SMTO_ABORTIFHUNG, 1000, out _) != IntPtr.Zero)
        {
            return true;
        }

        return IsWindow(hwnd) ? false : null;
    }

    private const uint WM_NULL = 0x0000;
    private const uint SMTO_BLOCK = 0x0001;
    private const uint SMTO_ABORTIFHUNG = 0x0002;

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SendMessageTimeout(
        IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeoutMs, out IntPtr result);
}
