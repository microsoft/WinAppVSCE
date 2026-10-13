using System;
using System.Collections.Generic;
using WinUIXamlPreview.UI;

namespace WinUIXamlPreview.UnitTests;

internal static partial class Program
{
    // DesignerSelection is process-wide static state (and _autoShown never resets), so this group runs its
    // checks in a fixed order and leaves handlers detached when it finishes.
    private static void DesignerSelectionTests()
    {
        var seen = new List<SelectionSnapshot?>();
        Action<SelectionSnapshot?> record = s => seen.Add(s);
        Action<SelectionSnapshot?> boom = _ => throw new InvalidOperationException("panel bug");
        int shows = 0;

        try
        {
            DesignerSelection.Changed += record;
            var a = new SelectionSnapshot { Id = 1, ElementType = "Button", Name = "Ok" };
            DesignerSelection.Set(a);
            Check("Set publishes Current and raises Changed", ReferenceEquals(DesignerSelection.Current, a) && seen.Count == 1 && ReferenceEquals(seen[0], a));

            var b = new SelectionSnapshot { Id = 2, ElementType = "TextBlock" };
            DesignerSelection.Set(b);
            Check("last writer wins", ReferenceEquals(DesignerSelection.Current, b) && seen.Count == 2);

            DesignerSelection.Set(null);
            Check("Set(null) clears selection and notifies", DesignerSelection.Current == null && seen.Count == 3 && seen[2] == null);

            DesignerSelection.Changed += boom;
            bool threw = false;
            try { DesignerSelection.Set(a); } catch { threw = true; }
            Check("a throwing panel handler never escapes Set", !threw && ReferenceEquals(DesignerSelection.Current, a));
            DesignerSelection.Changed -= boom;

            DesignerSelection.Changed -= record;
            DesignerSelection.Set(b);
            Check("Set with no subscribers is safe", ReferenceEquals(DesignerSelection.Current, b) && seen.Count == 4);

            // Fresh process: _autoShown starts false, so the first auto-open fires exactly once.
            DesignerSelection.RequestShowPropertiesWindow = () => shows++;
            DesignerSelection.ShowPropertiesWindowOnce();
            DesignerSelection.ShowPropertiesWindowOnce();
            Check("ShowPropertiesWindowOnce opens only the first time", shows == 1, "shows=" + shows);

            DesignerSelection.ShowPropertiesWindow();
            DesignerSelection.ShowPropertiesWindow();
            Check("ShowPropertiesWindow always opens", shows == 3, "shows=" + shows);

            DesignerSelection.RequestShowPropertiesWindow = null;
            threw = false;
            try { DesignerSelection.ShowPropertiesWindow(); } catch { threw = true; }
            Check("ShowPropertiesWindow with no opener is a no-op", !threw);

            DesignerSelection.RequestShowPropertiesWindow = () => throw new InvalidOperationException("tool window bug");
            threw = false;
            try { DesignerSelection.ShowPropertiesWindow(); } catch { threw = true; }
            Check("a throwing opener never escapes ShowPropertiesWindow", !threw);
        }
        finally
        {
            DesignerSelection.Changed -= record;
            DesignerSelection.Changed -= boom;
            DesignerSelection.RequestShowPropertiesWindow = null;
            DesignerSelection.Set(null);
        }
    }
}
