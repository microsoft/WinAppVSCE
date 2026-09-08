#nullable enable

using System;
using System.Runtime.InteropServices;
using System.Windows.Interop;

namespace WinUIXamlPreview.UI
{
    /// <summary>
    /// Hosts the surface's live WinUI window as a WPF child via <c>SetParent</c> — the "native"
    /// preview path (a real, interactive WinUI surface reparented into the tool window, not a
    /// streamed image). Proven cross-process by <c>vs-extension\tools\ReparentHarness</c>.
    /// </summary>
    internal sealed class SurfaceHwndHost : HwndHost
    {
        private IntPtr _surfaceHwnd;
        private int _pixelW;
        private int _pixelH;
        private bool _surfaceAlive = true;

        public SurfaceHwndHost(IntPtr surfaceHwnd, int pixelW, int pixelH)
        {
            _surfaceHwnd = surfaceHwnd;
            _pixelW = Math.Max(1, pixelW);
            _pixelH = Math.Max(1, pixelH);
        }

        public IntPtr SurfaceHwnd => _surfaceHwnd;

        /// <summary>Resize the reparented child in place (same HWND, new canvas pixel size). No-op when
        /// the size is unchanged — the surface re-mounts new content in the same window, so a same-size
        /// edit needs no client action (and skipping MoveWindow avoids any reposition flicker).</summary>
        public void ResizeChild(int pixelW, int pixelH)
        {
            pixelW = Math.Max(1, pixelW);
            pixelH = Math.Max(1, pixelH);
            if (pixelW == _pixelW && pixelH == _pixelH)
            {
                return;
            }
            _pixelW = pixelW;
            _pixelH = pixelH;
            if (_surfaceAlive && _surfaceHwnd != IntPtr.Zero)
            {
                NativeMethods.MoveWindow(_surfaceHwnd, 0, 0, _pixelW, _pixelH, true);
            }
        }

        /// <summary>
        /// Mark the surface window as gone (process killed). Prevents <see cref="DestroyWindowCore"/>
        /// from reparenting a dead/soon-dead handle back to the desktop (which would flash on screen).
        /// </summary>
        public void MarkSurfaceDead()
        {
            _surfaceAlive = false;
            _surfaceHwnd = IntPtr.Zero;
        }

        protected override HandleRef BuildWindowCore(HandleRef hwndParent)
        {
            // Mixed-mode DPI hosting so a PerMonitorV2 WinUI child composes crisply inside VS's host.
            NativeMethods.SetThreadDpiHostingBehavior(NativeMethods.DPI_HOSTING_BEHAVIOR.MIXED);

            // Turn the surface's top-level window into a borderless child of the tool window.
            long style = NativeMethods.GetWindowLongPtr(_surfaceHwnd, NativeMethods.GWL_STYLE).ToInt64();
            style &= ~(NativeMethods.WS_POPUP | NativeMethods.WS_CAPTION | NativeMethods.WS_THICKFRAME |
                       NativeMethods.WS_MINIMIZEBOX | NativeMethods.WS_MAXIMIZEBOX | NativeMethods.WS_SYSMENU);
            style |= NativeMethods.WS_CHILD | NativeMethods.WS_VISIBLE;
            NativeMethods.SetWindowLongPtr(_surfaceHwnd, NativeMethods.GWL_STYLE, new IntPtr(style));

            NativeMethods.SetParent(_surfaceHwnd, hwndParent.Handle);
            NativeMethods.MoveWindow(_surfaceHwnd, 0, 0, _pixelW, _pixelH, true);
            NativeMethods.ShowWindow(_surfaceHwnd, NativeMethods.SW_SHOW);
            return new HandleRef(this, _surfaceHwnd);
        }

        protected override void DestroyWindowCore(HandleRef hwnd)
        {
            // Detach only when the surface is still alive (mode switch / control unload); the surface
            // owns the window and re-cloaks it on ExitNative. If the process is dead, do nothing.
            if (_surfaceAlive && _surfaceHwnd != IntPtr.Zero)
            {
                NativeMethods.SetParent(_surfaceHwnd, IntPtr.Zero);
            }
        }
    }

    internal static class NativeMethods
    {
        public const int GWL_STYLE = -16;
        public const long WS_CHILD = 0x40000000L;
        public const long WS_POPUP = 0x80000000L;
        public const long WS_VISIBLE = 0x10000000L;
        public const long WS_CAPTION = 0x00C00000L;
        public const long WS_THICKFRAME = 0x00040000L;
        public const long WS_MINIMIZEBOX = 0x00020000L;
        public const long WS_MAXIMIZEBOX = 0x00010000L;
        public const long WS_SYSMENU = 0x00080000L;
        public const int SW_SHOW = 5;

        public enum DPI_HOSTING_BEHAVIOR { INVALID = -1, DEFAULT = 0, MIXED = 1 }

        [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);
        [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr GetParent(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll", SetLastError = true)] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
        [DllImport("user32.dll", SetLastError = true, EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
        [DllImport("user32.dll", SetLastError = true, EntryPoint = "SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
        [DllImport("user32.dll")] public static extern DPI_HOSTING_BEHAVIOR SetThreadDpiHostingBehavior(DPI_HOSTING_BEHAVIOR value);
    }
}
