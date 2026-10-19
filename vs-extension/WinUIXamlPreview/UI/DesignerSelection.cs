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
    /// selection and the shared design-time property panel. Selections are remembered per document and the
    /// panel shows the active document's: switching tabs swaps to that file's selection (or clears) instead of
    /// leaving the previous file's element on display. Mirrors <see cref="PreviewPackageState"/>'s tiny-static pattern.
    /// </summary>
    internal static class DesignerSelection
    {
        private static readonly Dictionary<string, SelectionSnapshot> ByDocument =
            new Dictionary<string, SelectionSnapshot>(StringComparer.OrdinalIgnoreCase);

        private static string? _activeDocument;
        private static bool _activeKnown;

        /// <summary>The selection shown in the panel, or null when nothing is selected.</summary>
        public static SelectionSnapshot? Current { get; private set; }

        /// <summary>Raised (on the UI thread) whenever the selection changes.</summary>
        public static event Action<SelectionSnapshot?>? Changed;

        /// <summary>Set by the package: opens (or focuses) the properties tool window. UI thread only.</summary>
        public static Action? RequestShowPropertiesWindow { get; set; }

        private static bool _autoShown;

        /// <summary>
        /// Publish a new selection. With a <paramref name="documentPath"/> it is remembered for that document
        /// and shown only while that document is active; without one it is shown unconditionally.
        /// </summary>
        public static void Set(SelectionSnapshot? snapshot, string? documentPath = null)
        {
            if (!string.IsNullOrEmpty(documentPath))
            {
                if (snapshot == null)
                {
                    ByDocument.Remove(documentPath!);
                }
                else
                {
                    ByDocument[documentPath!] = snapshot;
                }

                if (_activeKnown && !string.Equals(_activeDocument, documentPath, StringComparison.OrdinalIgnoreCase))
                {
                    return; // a background preview (another tab's margin); keep showing the active one
                }
            }

            Publish(snapshot);
        }

        /// <summary>The active editor document changed: show its remembered selection, or clear the panel.</summary>
        public static void SetActiveDocument(string? documentPath)
        {
            _activeKnown = true;
            _activeDocument = documentPath;
            SelectionSnapshot? snapshot = null;
            if (!string.IsNullOrEmpty(documentPath))
            {
                ByDocument.TryGetValue(documentPath!, out snapshot);
            }

            if (!ReferenceEquals(snapshot, Current))
            {
                Publish(snapshot);
            }
        }

        /// <summary>Forget a document's selection (its preview went away); clears the panel if it was showing.</summary>
        public static void Forget(string? documentPath)
        {
            if (string.IsNullOrEmpty(documentPath) || !ByDocument.TryGetValue(documentPath!, out var snapshot))
            {
                return;
            }

            ByDocument.Remove(documentPath!);
            if (ReferenceEquals(snapshot, Current))
            {
                Publish(null);
            }
        }

        private static void Publish(SelectionSnapshot? snapshot)
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
