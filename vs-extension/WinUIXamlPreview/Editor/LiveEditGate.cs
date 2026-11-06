#nullable enable

namespace WinUIXamlPreview.Editor
{
    /// <summary>
    /// When typing in the margin's document re-renders the preview. A burst of keystrokes restarts one debounce
    /// timer so only the last text renders; a collapsed preview spends no renders and instead refreshes once when
    /// it is expanded again. The timer itself lives in the margin; this holds the rules.
    /// </summary>
    internal sealed class LiveEditGate
    {
        private bool _dirtyWhileCollapsed;

        /// <summary>The buffer changed. True means (re)start the debounce timer.</summary>
        public bool OnTextChanged(bool collapsed)
        {
            if (collapsed)
            {
                _dirtyWhileCollapsed = true;
                return false;
            }

            return true;
        }

        /// <summary>The debounce timer fired. True means re-render now.</summary>
        public bool OnDebounceElapsed(bool collapsed, bool disposed) => !disposed && !collapsed;

        /// <summary>The preview was expanded. True means edits arrived while hidden, so re-render once.</summary>
        public bool OnExpanded()
        {
            if (!_dirtyWhileCollapsed)
            {
                return false;
            }

            _dirtyWhileCollapsed = false;
            return true;
        }
    }
}
