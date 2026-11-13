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

        /// <param name="pixelW">Initial child width in device pixels — the PANE's size, not the preview canvas.
        /// WPF re-sizes the child to the host's arranged rect on every layout pass; starting at the pane size
        /// avoids a visible jump (and an overdraw into neighboring VS panes) before that first pass.</param>
        /// <param name="pixelH">Initial child height in device pixels (see <paramref name="pixelW"/>).</param>
        public SurfaceHwndHost(IntPtr surfaceHwnd, int pixelW, int pixelH)
        {
            _surfaceHwnd = surfaceHwnd;
            _pixelW = Math.Max(1, pixelW);
            _pixelH = Math.Max(1, pixelH);
            LayoutUpdated += OnLayoutUpdated;
        }

        // ---- airspace clip --------------------------------------------------
        //
        // A native child ignores WPF clipping, so if any ancestor is laid out smaller than this host (e.g. an
        // editor margin wider than its tab) the WinUI window would paint over neighboring VS panes. Clip the
        // child with a window region to the part of the host that lies inside every ancestor's bounds.

        private (int l, int t, int r, int b)? _appliedClip; // null = no region (fully visible)
        private bool _clipKnown;

        private void OnLayoutUpdated(object? sender, EventArgs e) => UpdateClip();

        protected override void OnWindowPositionChanged(System.Windows.Rect rcBoundingBox)
        {
            base.OnWindowPositionChanged(rcBoundingBox);
            UpdateClip();
        }

        private void UpdateClip()
        {
            if (!_surfaceAlive || _surfaceHwnd == IntPtr.Zero || ActualWidth <= 0 || ActualHeight <= 0)
            {
                return;
            }

            try
            {
                var source = System.Windows.PresentationSource.FromVisual(this);
                if (source?.RootVisual == null || source.CompositionTarget == null)
                {
                    return;
                }

                var full = new System.Windows.Rect(0, 0, ActualWidth, ActualHeight);
                var visible = full;
                for (var node = System.Windows.Media.VisualTreeHelper.GetParent(this); node != null;
                     node = System.Windows.Media.VisualTreeHelper.GetParent(node))
                {
                    if (node is System.Windows.UIElement ancestor)
                    {
                        var bounds = ancestor.TransformToDescendant(this)
                            .TransformBounds(new System.Windows.Rect(ancestor.RenderSize));
                        visible.Intersect(bounds);
                        if (visible.IsEmpty)
                        {
                            break;
                        }
                    }

                    if (node == source.RootVisual)
                    {
                        break;
                    }
                }

                (int l, int t, int r, int b)? clip = null;
                if (visible.IsEmpty)
                {
                    clip = (0, 0, 0, 0);
                }
                else if (!ClipCovers(visible, full))
                {
                    var m = source.CompositionTarget.TransformToDevice;
                    clip = ((int)Math.Floor(visible.Left * m.M11), (int)Math.Floor(visible.Top * m.M22),
                            (int)Math.Ceiling(visible.Right * m.M11), (int)Math.Ceiling(visible.Bottom * m.M22));
                }

                if (_clipKnown && Nullable.Equals(clip, _appliedClip))
                {
                    return;
                }

                // The system owns the region after a successful SetWindowRgn; only free it on failure.
                var rgn = clip is { } c ? NativeMethods.CreateRectRgn(c.l, c.t, c.r, c.b) : IntPtr.Zero;
                if (NativeMethods.SetWindowRgn(_surfaceHwnd, rgn, true) == 0 && rgn != IntPtr.Zero)
                {
                    NativeMethods.DeleteObject(rgn);
                    return;
                }

                _appliedClip = clip;
                _clipKnown = true;
            }
            catch
            {
                // best-effort: a clip failure must never break hosting
            }
        }

        // Half-DIP tolerance so layout rounding doesn't toggle a region on an unclipped host.
        internal static bool ClipCovers(System.Windows.Rect visible, System.Windows.Rect full) =>
            visible.Left <= full.Left + 0.5 && visible.Top <= full.Top + 0.5 &&
            visible.Right >= full.Right - 0.5 && visible.Bottom >= full.Bottom - 0.5;

        public IntPtr SurfaceHwnd => _surfaceHwnd;

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
            // Place the child where the holder actually is BEFORE showing it. hwndParent is the VS (main or
            // floating) window's HwndSource, so (0,0) is VS's top-left corner: the child would flash there until
            // WPF's first layout pass moved it into the pane (visible on every new HWND, e.g. a theme swap).
            var (x, y) = GetInitialChildOrigin();
            NativeMethods.MoveWindow(_surfaceHwnd, x, y, _pixelW, _pixelH, true);
            NativeMethods.ShowWindow(_surfaceHwnd, NativeMethods.SW_SHOWNA);
            return new HandleRef(this, _surfaceHwnd);
        }

        /// <summary>The holder's top-left in parent-HWND device pixels; far off-screen if not yet resolvable (WPF's
        /// layout then positions the child — off-screen it's clipped by the parent, so nothing flashes).</summary>
        private (int x, int y) GetInitialChildOrigin()
        {
            try
            {
                var anchor = System.Windows.Media.VisualTreeHelper.GetParent(this) as System.Windows.Media.Visual ?? this;
                var source = System.Windows.PresentationSource.FromVisual(anchor);
                if (source?.RootVisual != null && source.CompositionTarget != null)
                {
                    var dip = anchor.TransformToAncestor(source.RootVisual).Transform(new System.Windows.Point(0, 0));
                    var px = source.CompositionTarget.TransformToDevice.Transform(dip);
                    return ((int)Math.Round(px.X), (int)Math.Round(px.Y));
                }
            }
            catch
            {
                // fall through to off-screen
            }
            return (-32000, -32000);
        }

        protected override void DestroyWindowCore(HandleRef hwnd)
        {
            LayoutUpdated -= OnLayoutUpdated;
            // Detach only when the surface is still alive (mode switch / control unload); the surface
            // owns the window and re-cloaks it on ExitNative. If the process is dead, do nothing.
            if (_surfaceAlive && _surfaceHwnd != IntPtr.Zero)
            {
                // Park the child far off-screen BEFORE detaching: SetParent(null) keeps the child's
                // parent-relative coordinates as screen coordinates, so a child at (0,0) would flash at the
                // desktop's top-left (e.g. the old window during a theme swap) until the surface re-cloaks it.
                NativeMethods.MoveWindow(_surfaceHwnd, -32000, -32000, _pixelW, _pixelH, false);
                if (_clipKnown && _appliedClip != null)
                {
                    // The surface reuses this window (warm re-host / spare): don't leave it clipped.
                    NativeMethods.SetWindowRgn(_surfaceHwnd, IntPtr.Zero, false);
                }
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
        public const int SW_SHOWNA = 8; // show without activating: the editor keeps focus

        public enum DPI_HOSTING_BEHAVIOR { INVALID = -1, DEFAULT = 0, MIXED = 1 }

        [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);
        [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr GetParent(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll", SetLastError = true)] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
        [DllImport("user32.dll", SetLastError = true, EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
        [DllImport("user32.dll", SetLastError = true, EntryPoint = "SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
        [DllImport("user32.dll")] public static extern int SetWindowRgn(IntPtr hWnd, IntPtr hRgn, bool bRedraw);
        [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
        [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr hObject);
        [DllImport("user32.dll")] public static extern DPI_HOSTING_BEHAVIOR SetThreadDpiHostingBehavior(DPI_HOSTING_BEHAVIOR value);
    }
}
