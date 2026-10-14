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
                ["selectLabel"] = _selectButton != null ? AutomationProperties.GetName(_selectButton) : null,
                ["themeLabel"] = _themeButton != null ? AutomationProperties.GetName(_themeButton) : null,
                ["sizeLabel"] = _sizeButton != null ? AutomationProperties.GetName(_sizeButton) : null,
                ["dtdLabel"] = _dtdButton != null ? AutomationProperties.GetName(_dtdButton) : null,
                ["toolbarLevel"] = _toolbarLevel,
                ["overflowVisible"] = _overflowButton?.Visibility == Visibility.Visible,
                ["caret"] = caret,
                ["selection"] = selection,
                ["preview"] = _preview.TestSnapshot(),
            };
        }

        /// <summary>Feeds a designer selection through the real designer -> editor path (no surface click needed).</summary>
        internal void TestSimulateDesignerSelection(string elementPath)
            => OnDesignerElementSelected(new SelectedMsg { Type = "selected", Path = elementPath });
    }
}
