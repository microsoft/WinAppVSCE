#nullable enable

using System.Collections.Generic;
using System.Windows;
using System.Windows.Automation;
using WinUIXamlPreview.Protocol;

namespace WinUIXamlPreview.Editor
{
    // Read-only state probe + one input shim for the in-VS integration tests. Reached only through
    // Testing.TestHooks; UI thread only.
    internal sealed partial class XamlPreviewMargin
    {
        internal string? TestPath => _path;

        internal FrameworkElement TestRoot => _root;

        internal Dictionary<string, object?> TestSnapshot()
        {
            int caret = -1;
            string? selection = null;
            try
            {
                caret = _textView.Caret.Position.BufferPosition.Position;
                var spans = _textView.Selection.SelectedSpans;
                selection = spans.Count > 0 ? spans[0].GetText() : null;
            }
            catch { }

            return new Dictionary<string, object?>
            {
                ["path"] = _path,
                ["location"] = _location.ToString(),
                ["disposed"] = _disposed,
                ["isVisible"] = _root.IsVisible,
                ["width"] = _root.ActualWidth,
                ["height"] = _root.ActualHeight,
                ["hostWidth"] = _hostControl?.ActualWidth,
                ["hostHeight"] = _hostControl?.ActualHeight,
                ["surfaceOverflowPx"] = SurfaceOverflowPx(),
                ["contentVisible"] = _content.Visibility == Visibility.Visible,
                ["collapsedBarVisible"] = _collapsedBar.Visibility == Visibility.Visible,
                ["selectLabel"] = _toolbar.SelectLabelState,
                ["themeLabel"] = _toolbar.ThemeLabelState,
                ["sizeLabel"] = _toolbar.SizeLabelState,
                ["dtdLabel"] = _toolbar.DtdLabelState,
                ["fidelityLabel"] = _toolbar.FidelityLabelState,
                ["toolbarLevel"] = _toolbar.Level,
                ["overflowVisible"] = _toolbar.OverflowVisible,
                ["caret"] = caret,
                ["selection"] = selection,
                ["preview"] = _preview.TestSnapshot(),
            };
        }

        /// <summary>Device pixels by which the hosted surface's VISIBLE area (window rect clipped by its window
        /// region) extends past the editor host on any side; 0 when contained, null when no native surface.</summary>
        private int? SurfaceOverflowPx()
        {
            var hwnd = _preview.TestNativeHwnd;
            if (hwnd == System.IntPtr.Zero || _hostControl == null || !_hostControl.IsVisible)
            {
                return null;
            }

            if (!GetWindowRect(hwnd, out var w))
            {
                return null;
            }

            var visible = w;
            var kind = GetWindowRgnBox(hwnd, out var box);
            if (kind == 1 /* NULLREGION */)
            {
                return 0;
            }
            if (kind > 1 /* SIMPLEREGION / COMPLEXREGION */)
            {
                visible = new RECT { Left = w.Left + box.Left, Top = w.Top + box.Top, Right = w.Left + box.Right, Bottom = w.Top + box.Bottom };
            }

            var tl = _hostControl.PointToScreen(new Point(0, 0));
            var br = _hostControl.PointToScreen(new Point(_hostControl.ActualWidth, _hostControl.ActualHeight));
            var over = System.Math.Max(System.Math.Max(visible.Right - (int)System.Math.Ceiling(br.X), (int)System.Math.Floor(tl.X) - visible.Left),
                                       System.Math.Max(visible.Bottom - (int)System.Math.Ceiling(br.Y), (int)System.Math.Floor(tl.Y) - visible.Top));
            return System.Math.Max(0, over);
        }

        [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
        private struct RECT { public int Left, Top, Right, Bottom; }

        [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern bool GetWindowRect(System.IntPtr hWnd, out RECT rect);
        [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern int GetWindowRgnBox(System.IntPtr hWnd, out RECT rect);

        /// <summary>Feeds a previewer selection through the real previewer -> editor path (no surface click needed).</summary>
        internal void TestSimulatePreviewerSelection(string elementPath)
            => OnPreviewerElementSelected(new SelectedMsg { Type = "selected", Path = elementPath });
    }
}
