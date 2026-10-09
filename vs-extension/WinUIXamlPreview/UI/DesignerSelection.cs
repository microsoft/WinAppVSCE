#nullable enable

using System;
using System.Collections.Generic;

namespace WinUIXamlPreview.UI
{
    /// <summary>A single reflected property row shown in the read-only design-time property panel (plan §41).</summary>
    internal sealed class PropRow
    {
        public string Name { get; set; } = "";
        public string Category { get; set; } = "";
        public string TypeName { get; set; } = "";
        public string Value { get; set; } = "";
    }

    /// <summary>An immutable snapshot of the currently-selected element and its properties.</summary>
    internal sealed class SelectionSnapshot
    {
        public int Id { get; set; }
        public string ElementType { get; set; } = "";
        public string? Name { get; set; }
        public IReadOnlyList<PropRow> Props { get; set; } = Array.Empty<PropRow>();
    }

    /// <summary>
    /// Process-wide handoff between whichever <see cref="PreviewControl"/> owns the surface that raised a
    /// selection and the shared design-time property panel. Last-writer-wins: the most recent selection (from
    /// any open preview) drives the panel. Mirrors <see cref="PreviewPackageState"/>'s tiny-static pattern.
    /// </summary>
    internal static class DesignerSelection
    {
        /// <summary>The most recent selection, or null when nothing is selected.</summary>
        public static SelectionSnapshot? Current { get; private set; }

        /// <summary>Raised (on the UI thread) whenever the selection changes.</summary>
        public static event Action<SelectionSnapshot?>? Changed;

        /// <summary>Set by the package: opens (or focuses) the properties tool window. UI thread only.</summary>
        public static Action? RequestShowPropertiesWindow { get; set; }

        private static bool _autoShown;

        /// <summary>
        /// Publish a new selection. Last-writer-wins: the most recent selection from any open preview drives
        /// the panel.
        /// </summary>
        public static void Set(SelectionSnapshot? snapshot)
        {
            Current = snapshot;
            try { Changed?.Invoke(snapshot); }
            catch { /* a panel handler must never break the preview */ }
        }

        /// <summary>Open the properties window the first time an element is selected in a session.</summary>
        public static void ShowPropertiesWindowOnce()
        {
            if (_autoShown)
            {
                return;
            }

            _autoShown = true;
            try { RequestShowPropertiesWindow?.Invoke(); }
            catch { /* best effort */ }
        }

        /// <summary>Open (or focus) the properties window on demand (e.g. a toolbar button).</summary>
        public static void ShowPropertiesWindow()
        {
            _autoShown = true;
            try { RequestShowPropertiesWindow?.Invoke(); }
            catch { /* best effort */ }
        }
    }
}
