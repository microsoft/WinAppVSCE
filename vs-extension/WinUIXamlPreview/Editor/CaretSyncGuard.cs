#nullable enable

using System;

namespace WinUIXamlPreview.Editor
{
    /// <summary>
    /// Echo suppression for two-way selection sync between the editor caret and the designer. Two loops exist:
    /// moving the caret for a designer selection fires the caret-changed handler synchronously (broken by
    /// <see cref="BeginCaretMove"/>), and a caret-driven selection comes back from the surface as a designer
    /// selection (broken because the caret is already inside that element). Remembering the last path also
    /// stops caret moves within one element from re-selecting it.
    /// </summary>
    internal sealed class CaretSyncGuard
    {
        private bool _movingCaret;

        public string? LastPath { get; private set; }

        /// <summary>Designer → editor: whether to act on a designer selection at all.</summary>
        public bool AcceptsDesignerSelection(string? path) => !_movingCaret && !string.IsNullOrEmpty(path);

        /// <summary>
        /// Designer → editor: true when the caret already sits inside the selected element's span (inclusive
        /// end), i.e. the selection is the echo of a caret move — leave the caret alone.
        /// </summary>
        public bool IsEchoOfCaret(string path, int caret, int start, int end)
        {
            if (caret < start || caret > end)
            {
                return false;
            }

            LastPath = path;
            return true;
        }

        /// <summary>Designer → editor: bracket the programmatic caret move. Dispose when done.</summary>
        public IDisposable BeginCaretMove()
        {
            _movingCaret = true;
            return new Scope(this);
        }

        /// <summary>Designer → editor: the caret now sits in <paramref name="path"/>'s element.</summary>
        public void CaretMovedTo(string path) => LastPath = path;

        /// <summary>Editor → designer: cheap early-out before any source-map work for a caret move.</summary>
        public bool TracksCaret(bool designMode) => !_movingCaret && designMode;

        /// <summary>Editor → designer: the path to select for a caret move, or null to do nothing.</summary>
        public string? OnCaretMoved(string? pathAtCaret, bool designMode)
        {
            if (!TracksCaret(designMode) || pathAtCaret == null || pathAtCaret == LastPath)
            {
                return null;
            }

            LastPath = pathAtCaret;
            return pathAtCaret;
        }

        /// <summary>Clamp a source-map span to the current snapshot length (the map can lag an edit).</summary>
        public static (int Start, int End) Clamp(int start, int end, int length)
        {
            if (start > length) start = length;
            if (end > length) end = length;
            if (end < start) end = start;
            return (start, end);
        }

        private sealed class Scope : IDisposable
        {
            private CaretSyncGuard? _owner;

            public Scope(CaretSyncGuard owner) => _owner = owner;

            public void Dispose()
            {
                if (_owner != null)
                {
                    _owner._movingCaret = false;
                    _owner = null;
                }
            }
        }
    }
}
