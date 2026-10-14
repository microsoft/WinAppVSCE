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
                var s = WaitFor("spares warm", x => new[] { _fx.MainPage, _fx.SecondPage }
                    .All(p => Preview(x, p)?["spareReady"]?.GetValue<bool>() == true), 60_000);
                var pids = Pids(Preview(s, _fx.MainPage)).Concat(Pids(Preview(s, _fx.SecondPage))).ToList();
                Call("closeAll");
                WaitFor("no margins left", x => x["margins"]!.AsArray().Count(m => m?["disposed"]?.GetValue<bool>() != true) == 0, 15_000);
                AssertAllExited(pids, "after closing all documents");
            });

            Run("Teardown: closing the tool window ends its surfaces", () =>
            {
                Fresh();
                Call("raise", new { guid = CommandSetGuid, id = ShowPreviewCommandId });
                OpenRendered(_fx.MainPage);
                var s = WaitFor("tool window rendered", x => ToolSession(x) is JsonObject t
                                                            && SamePath((string?)t["currentPath"], _fx.MainPage) && Rendered(t), 60_000);
                var pids = Pids(ToolSession(s)).ToList();
                Call("hideToolWindow", new { guid = ToolWindowGuid });
                WaitFor("tool window hidden", _ => !Call("toolWindowVisible", new { guid = ToolWindowGuid })!.GetValue<bool>(), 10_000);
                AssertAllExited(pids, "after closing the tool window");
                Assert(SurfaceAlive(Pid(Preview(s, _fx.MainPage)!, "clientPid")), "the margin's surface should be untouched");
            });

            Run("Teardown: reopening the tool window renders again", () =>
            {
                Fresh();
                OpenRendered(_fx.MainPage);
                Call("raise", new { guid = CommandSetGuid, id = ShowPreviewCommandId });
                WaitFor("tool window rendered again", x => ToolSession(x) is JsonObject t
                                                          && SamePath((string?)t["currentPath"], _fx.MainPage) && Rendered(t), 60_000);
            });

            Run("Teardown: closing the last XAML tab releases the tool window's surfaces", () =>
            {
                Fresh();
                Call("raise", new { guid = CommandSetGuid, id = ShowPreviewCommandId });
                OpenRendered(_fx.MainPage);
                var s = WaitFor("tool window rendered", x => ToolSession(x) is JsonObject t
                                                            && SamePath((string?)t["currentPath"], _fx.MainPage) && Rendered(t), 60_000);
                var tool = Pids(ToolSession(s)).ToList();
                Call("close", new { path = _fx.MainPage });
                s = WaitFor("tool window empty", x => ToolSession(x) is JsonObject t && t["currentPath"] == null, 15_000);
                Eq("Open a .xaml file to preview it.", (string?)ToolSession(s)!["statusText"], "empty state");
                AssertAllExited(tool, "tool window after closing its document");
            });

            Run("Teardown: closing one of two XAML tabs moves the tool window without a cold start", () =>
            {
                Fresh();
                Call("raise", new { guid = CommandSetGuid, id = ShowPreviewCommandId });
                OpenRendered(_fx.MainPage);
                OpenRendered(_fx.SecondPage);
                WaitFor("tool window on SecondPage", x => ToolSession(x) is JsonObject t
                                                          && SamePath((string?)t["currentPath"], _fx.SecondPage) && Rendered(t), 60_000);
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
                Call("raise", new { guid = CommandSetGuid, id = ShowPreviewCommandId });
                OpenRendered(_fx.MainPage);
                var s = WaitFor("tool window rendered", x => ToolSession(x) is JsonObject t && Rendered(t), 60_000);
                var tool = Pids(ToolSession(s)).ToList();
                Call("closeSolution");
                WaitFor("margin disposed", x => Margin(x, _fx.MainPage) == null, 30_000);
                AssertAllExited(Pids(Preview(s, _fx.MainPage)), "margin after closing the solution");
                WaitFor("tool window empty", x => ToolSession(x) is JsonObject t && t["currentPath"] == null, 15_000);
                AssertAllExited(tool, "tool window after closing the solution");
            });
        }
    }
}
