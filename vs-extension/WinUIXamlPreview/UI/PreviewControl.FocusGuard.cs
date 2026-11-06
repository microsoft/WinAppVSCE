#nullable enable

using System;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Threading;
using WinUIXamlPreview.Logging;

namespace WinUIXamlPreview.UI
{
    /// <summary>
    /// The reparented surface window shares VS's input queue, so WinUI can pull keyboard focus into its input site when
    /// the preview is shown again (e.g. Ctrl+Tab back to a previewed page) or a new surface window attaches, leaving the
    /// editor without focus. For a short window after either event, focus that lands in the surface without the user
    /// pressing a mouse button is handed back to <see cref="ReclaimFocus"/>. A deliberate click into the preview keeps it.
    /// </summary>
    public partial class PreviewControl
    {
        private static readonly TimeSpan FocusGuardWindow = TimeSpan.FromSeconds(2);
        private DispatcherTimer? _focusGuard;
        private DateTime _focusGuardUntil;

        /// <summary>Returns keyboard focus to the owner (the editor for a margin). Null disables the guard.</summary>
        internal Action? ReclaimFocus { get; set; }

        private void ArmFocusGuard()
        {
            if (ReclaimFocus == null || _disposed)
            {
                return;
            }

            _focusGuardUntil = DateTime.UtcNow + FocusGuardWindow;
            if (_focusGuard == null)
            {
                _focusGuard = new DispatcherTimer(DispatcherPriority.Input, Dispatcher) { Interval = TimeSpan.FromMilliseconds(50) };
                _focusGuard.Tick += OnFocusGuardTick;
            }
            // Clear the "pressed since last call" bits so only presses from now on count as user intent.
            GetAsyncKeyState(VK_LBUTTON);
            GetAsyncKeyState(VK_RBUTTON);
            _focusGuard.Start();
        }

        private void StopFocusGuard() => _focusGuard?.Stop();

        private void OnFocusGuardTick(object? sender, EventArgs e)
        {
            if (_disposed || DateTime.UtcNow > _focusGuardUntil || !IsVisible)
            {
                StopFocusGuard();
                return;
            }

            if (MouseButtonPressed())
            {
                StopFocusGuard(); // the user is interacting; whatever gets focus now is theirs
                return;
            }

            var surface = _nativeHost?.SurfaceHwnd ?? IntPtr.Zero;
            var focus = GetFocus();
            if (surface == IntPtr.Zero || focus == IntPtr.Zero || (focus != surface && !IsChild(surface, focus)))
            {
                return;
            }

            Log.Write("Surface took keyboard focus without a click; returning it to the editor.");
            try { ReclaimFocus?.Invoke(); } catch (Exception ex) { Log.Write("ReclaimFocus failed: " + ex.Message); }
        }

        private static bool MouseButtonPressed() =>
            (GetAsyncKeyState(VK_LBUTTON) & 0x8001) != 0 || (GetAsyncKeyState(VK_RBUTTON) & 0x8001) != 0;

        private const int VK_LBUTTON = 0x01;
        private const int VK_RBUTTON = 0x02;

        [DllImport("user32.dll")] private static extern IntPtr GetFocus();
        [DllImport("user32.dll")] private static extern bool IsChild(IntPtr hWndParent, IntPtr hWnd);
        [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int vKey);
    }
}
