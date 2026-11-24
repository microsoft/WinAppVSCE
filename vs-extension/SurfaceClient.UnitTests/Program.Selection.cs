using System;
using System.Collections.Generic;
using WinUIXamlPreview.UI;

namespace WinUIXamlPreview.UnitTests;

internal static partial class Program
{
    // PreviewerSelection is process-wide static state (and _autoShown never resets), so this group runs its
    // checks in a fixed order and leaves handlers detached when it finishes.
    private static void PreviewerSelectionTests()
    {
        var seen = new List<SelectionSnapshot?>();
        Action<SelectionSnapshot?> record = s => seen.Add(s);
        Action<SelectionSnapshot?> boom = _ => throw new InvalidOperationException("panel bug");
        int shows = 0;

        try
        {
            PreviewerSelection.Changed += record;
            var a = new SelectionSnapshot { Id = 1, ElementType = "Button", Name = "Ok" };
            PreviewerSelection.Set(a);
            Check("Set publishes Current and raises Changed", ReferenceEquals(PreviewerSelection.Current, a) && seen.Count == 1 && ReferenceEquals(seen[0], a));

            var b = new SelectionSnapshot { Id = 2, ElementType = "TextBlock" };
            PreviewerSelection.Set(b);
            Check("last writer wins", ReferenceEquals(PreviewerSelection.Current, b) && seen.Count == 2);

            PreviewerSelection.Set(null);
            Check("Set(null) clears selection and notifies", PreviewerSelection.Current == null && seen.Count == 3 && seen[2] == null);

            PreviewerSelection.Changed += boom;
            bool threw = false;
            try { PreviewerSelection.Set(a); } catch { threw = true; }
            Check("a throwing panel handler never escapes Set", !threw && ReferenceEquals(PreviewerSelection.Current, a));
            PreviewerSelection.Changed -= boom;

            PreviewerSelection.Changed -= record;
            PreviewerSelection.Set(b);
            Check("Set with no subscribers is safe", ReferenceEquals(PreviewerSelection.Current, b) && seen.Count == 4);

            // Per-document: the panel follows the active tab instead of keeping the last file's selection.
            PreviewerSelection.Changed += record;
            seen.Clear();
            const string DocA = @"C:\p\A.xaml", DocB = @"C:\p\B.xaml";
            PreviewerSelection.SetActiveDocument(DocA);
            PreviewerSelection.Set(a, DocA);
            Check("active document's selection is shown", ReferenceEquals(PreviewerSelection.Current, a));

            PreviewerSelection.SetActiveDocument(DocB);
            Check("switching to a file with no selection clears the panel", PreviewerSelection.Current == null && seen[seen.Count - 1] == null);

            int before = seen.Count;
            PreviewerSelection.Set(b, @"c:\P\a.XAML");
            Check("a background document's selection doesn't replace the active one", PreviewerSelection.Current == null && seen.Count == before);

            PreviewerSelection.SetActiveDocument(DocA);
            Check("switching back restores that file's latest selection (case-insensitive path)", ReferenceEquals(PreviewerSelection.Current, b));

            PreviewerSelection.Forget(DocA);
            Check("Forget clears the shown selection", PreviewerSelection.Current == null);
            PreviewerSelection.SetActiveDocument(DocB);
            PreviewerSelection.SetActiveDocument(DocA);
            Check("forgotten selection is not restored", PreviewerSelection.Current == null);

            PreviewerSelection.Set(a, DocA);
            PreviewerSelection.Set(null, DocA);
            Check("Set(null, doc) clears the active document's selection", PreviewerSelection.Current == null);
            PreviewerSelection.Changed -= record;
            PreviewerSelection.SetActiveDocument(null);

            // Fresh process: _autoShown starts false, so the first auto-open fires exactly once.
            PreviewerSelection.RequestShowPropertiesWindow = () => shows++;
            PreviewerSelection.ShowPropertiesWindowOnce();
            PreviewerSelection.ShowPropertiesWindowOnce();
            Check("ShowPropertiesWindowOnce opens only the first time", shows == 1, "shows=" + shows);

            PreviewerSelection.ShowPropertiesWindow();
            PreviewerSelection.ShowPropertiesWindow();
            Check("ShowPropertiesWindow always opens", shows == 3, "shows=" + shows);

            PreviewerSelection.RequestShowPropertiesWindow = null;
            threw = false;
            try { PreviewerSelection.ShowPropertiesWindow(); } catch { threw = true; }
            Check("ShowPropertiesWindow with no opener is a no-op", !threw);

            PreviewerSelection.RequestShowPropertiesWindow = () => throw new InvalidOperationException("tool window bug");
            threw = false;
            try { PreviewerSelection.ShowPropertiesWindow(); } catch { threw = true; }
            Check("a throwing opener never escapes ShowPropertiesWindow", !threw);
        }
        finally
        {
            PreviewerSelection.Changed -= record;
            PreviewerSelection.Changed -= boom;
            PreviewerSelection.RequestShowPropertiesWindow = null;
            PreviewerSelection.Set(null);
        }
    }
}
