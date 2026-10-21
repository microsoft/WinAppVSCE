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

        /// <summary>Feeds a previewer selection through the real previewer -> editor path (no surface click needed).</summary>
        internal void TestSimulatePreviewerSelection(string elementPath)
            => OnPreviewerElementSelected(new SelectedMsg { Type = "selected", Path = elementPath });
    }
}
