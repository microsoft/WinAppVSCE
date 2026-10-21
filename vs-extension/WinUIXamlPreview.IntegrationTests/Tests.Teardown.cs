using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Nodes;

namespace WinUIXamlPreview.IntegrationTests
{
    internal static partial class Program
    {
        private static IEnumerable<int> Pids(JsonObject? preview) =>
            preview == null ? Enumerable.Empty<int>()
                            : new[] { Pid(preview, "clientPid"), Pid(preview, "sparePid") }.Where(p => p != 0);

        private static void AssertAllExited(IEnumerable<int> pids, string what)
        {
            var all = pids.ToList();
            Assert(all.Count > 0, $"no surfaces to check for {what}");
            var left = SurvivingSurfaces(all);
            Assert(left.Count == 0, $"{what}: {left.Count} of {all.Count} surfaces still running ({string.Join(", ", left)})");
        }

        /// <summary>Surface lifetime when documents, the tool window, and the solution go away. The post-exit check lives in Main.</summary>
        private static void Group_Teardown()
        {
            Run("Teardown: closing every document ends all margin surfaces", () =>
            {
                Fresh();
                OpenRendered(_fx.MainPage);
                OpenRendered(_fx.SecondPage);
                // A background tab's margin may be unloaded by VS (seen on VS 2026 x64), which releases its surfaces;
                // otherwise it keeps its warm spare. Either is fine — every surface still running must end on close.
                var s = WaitFor("spares warm", x => new[] { _fx.MainPage, _fx.SecondPage }
                    .All(p => Preview(x, p) is JsonObject pv
                              && (pv["spareReady"]?.GetValue<bool>() == true || pv["isLoaded"]?.GetValue<bool>() == false)), 60_000);
                var pids = Pids(Preview(s, _fx.MainPage)).Concat(Pids(Preview(s, _fx.SecondPage))).ToList();
                Call("closeAll");
                WaitFor("no margins left", x => x["margins"]!.AsArray().Count(m => m?["disposed"]?.GetValue<bool>() != true) == 0, 15_000);
                AssertAllExited(pids, "after closing all documents");
            });

            Run("Teardown: closing the tool window ends its surfaces", () =>
            {
                Fresh();
                ShowWindow();
                var s = OpenInWindow(_fx.MainPage);
                var pids = Pids(ToolSession(s)).ToList();
                HideWindow();
                AssertAllExited(pids, "after closing the tool window");
                WaitFor("margin renders again", x => Rendered(Preview(x, _fx.MainPage)), 120_000);
            });

            Run("Teardown: opening the tool window collapses the margin and ends its surfaces", () =>
            {
                Fresh();
                var s = OpenRendered(_fx.MainPage);
                var margin = Pids(Preview(s, _fx.MainPage)).ToList();
                ShowWindow();
                WaitFor("tool window rendered", x => ToolSession(x) is JsonObject t
                                                    && SamePath((string?)t["currentPath"], _fx.MainPage) && Rendered(t), 60_000);
                WaitFor("margin is a strip", x => IsStrip(Margin(x, _fx.MainPage)), 15_000);
                AssertAllExited(margin, "margin after opening the tool window");
            });

            Run("Teardown: closing the last XAML tab releases the tool window's surfaces", () =>
            {
                Fresh();
                ShowWindow();
                var s = OpenInWindow(_fx.MainPage);
                var tool = Pids(ToolSession(s)).ToList();
                Call("close", new { path = _fx.MainPage });
                s = WaitFor("tool window empty", x => ToolSession(x) is JsonObject t && t["currentPath"] == null, 15_000);
                Eq("Open a .xaml file to preview it.", (string?)ToolSession(s)!["statusText"], "empty state");
                AssertAllExited(tool, "tool window after closing its document");
            });

            Run("Teardown: closing one of two XAML tabs moves the tool window without a cold start", () =>
            {
                Fresh();
                ShowWindow();
                OpenInWindow(_fx.MainPage);
                OpenInWindow(_fx.SecondPage);
                var mark = LogMark();
                Call("close", new { path = _fx.SecondPage });
                WaitFor("tool window on MainPage", x => ToolSession(x) is JsonObject t
                                                        && SamePath((string?)t["currentPath"], _fx.MainPage) && Rendered(t), 60_000);
                Assert(LogSince(mark).IndexOf("ShowDocument: path='(null)'", System.StringComparison.Ordinal) < 0,
                       "tool window passed through the empty state while switching tabs");
            });

            // Must stay last: everything above needs the solution open.
            Run("Teardown: closing the solution ends every surface", () =>
            {
                Fresh();
                ShowWindow();
                var s = OpenInWindow(_fx.MainPage);
                var tool = Pids(ToolSession(s)).ToList();
                Call("closeSolution");
                WaitFor("margin disposed", x => Margin(x, _fx.MainPage) == null, 30_000);
                WaitFor("tool window empty", x => ToolSession(x) is JsonObject t && t["currentPath"] == null, 15_000);
                AssertAllExited(tool, "tool window after closing the solution");
            });
        }
    }
}
