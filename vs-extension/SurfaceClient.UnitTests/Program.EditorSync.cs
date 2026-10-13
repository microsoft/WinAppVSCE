#nullable enable

using WinUIXamlPreview.Editor;

namespace WinUIXamlPreview.UnitTests;

// LiveEditGate / CaretSyncGuard: the in-editor margin's typing debounce and two-way selection echo suppression.
internal static partial class Program
{
    private static void EditorSyncTests()
    {
        // ---- live edit while collapsed ----
        {
            var g = new LiveEditGate();
            Check("edit: expanded → debounce", g.OnTextChanged(collapsed: false));
            Check("edit: debounce fires → render", g.OnDebounceElapsed(collapsed: false, disposed: false));
            Check("edit: expand with nothing pending → no render", !g.OnExpanded());
            Check("edit: collapsed → no debounce", !g.OnTextChanged(collapsed: true));
            Check("edit: collapsed again → still none", !g.OnTextChanged(collapsed: true));
            Check("edit: expand → render once", g.OnExpanded());
            Check("edit: expand again → no render", !g.OnExpanded());
            Check("edit: collapsed before the debounce fired → skip", !g.OnDebounceElapsed(collapsed: true, disposed: false));
            Check("edit: disposed → skip", !g.OnDebounceElapsed(collapsed: false, disposed: true));
        }

        // ---- caret → designer ----
        {
            var c = new CaretSyncGuard();
            Eq("caret: interact mode → nothing", null, c.OnCaretMoved("0/1", designMode: false));
            Eq("caret: outside any element → nothing", null, c.OnCaretMoved(null, true));
            Eq("caret: new element → select", "0/1", c.OnCaretMoved("0/1", true));
            Eq("caret: same element → nothing", null, c.OnCaretMoved("0/1", true));
            Eq("caret: another element → select", "0/2", c.OnCaretMoved("0/2", true));
        }

        // ---- designer → caret ----
        {
            var c = new CaretSyncGuard();
            Check("designer: empty path ignored", !c.AcceptsDesignerSelection(""));
            Check("designer: null path ignored", !c.AcceptsDesignerSelection(null));
            Check("designer: accepted", c.AcceptsDesignerSelection("0/3"));
            Check("designer: caret at start is an echo", c.IsEchoOfCaret("0/3", caret: 10, start: 10, end: 20));
            Eq("designer: echo records the path", "0/3", c.LastPath);
            Eq("designer: so the caret doesn't re-select it", null, c.OnCaretMoved("0/3", true));
            Check("designer: caret at end is an echo (inclusive)", c.IsEchoOfCaret("0/3", 20, 10, 20));
            Check("designer: caret past end is not", !c.IsEchoOfCaret("0/4", 21, 10, 20));
            Check("designer: caret before start is not", !c.IsEchoOfCaret("0/4", 9, 10, 20));
            Eq("designer: non-echo leaves the path alone", "0/3", c.LastPath);

            using (c.BeginCaretMove())
            {
                Check("moving: designer selections ignored", !c.AcceptsDesignerSelection("0/5"));
                Check("moving: caret not tracked", !c.TracksCaret(true));
                Eq("moving: caret event swallowed", null, c.OnCaretMoved("0/4", true));
                c.CaretMovedTo("0/4");
            }

            Check("after move: tracked again", c.TracksCaret(true) && c.AcceptsDesignerSelection("0/5"));
            Eq("after move: caret in the moved-to element → nothing", null, c.OnCaretMoved("0/4", true));

            var scope = c.BeginCaretMove();
            scope.Dispose();
            scope.Dispose();
            Check("scope: double dispose is harmless", c.TracksCaret(true));
        }

        // ---- clamp a lagging source map ----
        Eq("clamp: in range", (5, 9), CaretSyncGuard.Clamp(5, 9, 100));
        Eq("clamp: end past length", (5, 10), CaretSyncGuard.Clamp(5, 50, 10));
        Eq("clamp: both past length", (10, 10), CaretSyncGuard.Clamp(40, 50, 10));
        Eq("clamp: inverted", (7, 7), CaretSyncGuard.Clamp(7, 3, 10));
    }
}
