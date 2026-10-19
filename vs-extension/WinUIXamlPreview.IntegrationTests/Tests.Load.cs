using System.Linq;

namespace WinUIXamlPreview.IntegrationTests
{
    internal static partial class Program
    {
        /// <summary>Package load, the View command, the tool window, and the first margin render.</summary>
        private static void Group_Load()
        {
            Run("Load: product package loads and reports default options", () =>
            {
                var s = Snap();
                var o = s["options"]!;
                Eq("Right", (string?)o["location"], "location");
                Eq(true, o["designTimeData"]!.GetValue<bool>(), "designTimeData");
                Eq(false, o["collapsed"]!.GetValue<bool>(), "collapsed");
                Eq(false, o["fullFidelityAutoBuild"]!.GetValue<bool>(), "fullFidelityAutoBuild");
                Assert(((string?)s["logFile"])?.EndsWith("preview.log") == true, "log file path: " + s["logFile"]);
                Log("      snapshot: " + s.ToJsonString());
            });

            Run("Load: View > Other Windows command shows the tool window", () =>
            {
                ShowWindow();
            });

            Run("Load: with the preview window open, a WinUI page's margin is a strip and the window renders it", () =>
            {
                OpenInWindow(_fx.MainPage);
                var m = Margin(Snap(), _fx.MainPage)!;
                Eq("The preview is open in the WinUI XAML Preview window.", (string?)m["preview"]!["statusText"], "margin status");
            });

            Run("Load: closing the preview window brings the margin back and it renders", () =>
            {
                HideWindow();
                var s = WaitFor("MainPage margin rendered", x => Rendered(Preview(x, _fx.MainPage)), 120_000);
                var m = Margin(s, _fx.MainPage)!;
                Eq("Right", (string?)m["location"], "margin location");
                Eq(true, m["contentVisible"]!.GetValue<bool>(), "content visible");
                Assert(m["preview"]!["clientPid"] != null, "surface pid reported");
            });

            Run("Load: opening a WinUI page attaches a margin that renders", () =>
            {
                Call("closeAll");
                Call("open", new { path = _fx.MainPage });
                Eq("XAML", (string?)Call("viewInfo", new { path = _fx.MainPage })?["contentType"], "content type");
                WaitFor("MainPage margin attached", x => Margin(x, _fx.MainPage) != null, 30_000);
                var s = WaitFor("MainPage margin rendered", x => Rendered(Preview(x, _fx.MainPage)), 120_000);
                var m = Margin(s, _fx.MainPage)!;
                Eq("Right", (string?)m["location"], "margin location");
                Eq(true, m["contentVisible"]!.GetValue<bool>(), "content visible");
                Assert(m["preview"]!["clientPid"] != null, "surface pid reported");
            });

            Run("Load: closing every document disposes the margin", () =>
            {
                Call("closeAll");
                WaitFor("no live MainPage margin", x => Margin(x, _fx.MainPage) == null, 15_000);
                var s = Snap();
                Assert(s["margins"]!.AsArray().Count == 0, "margins left: " + s["margins"]!.ToJsonString());
            });
        }
    }
}
