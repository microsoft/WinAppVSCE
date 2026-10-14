using System;
using System.Text.Json.Nodes;

namespace WinUIXamlPreview.IntegrationTests
{
    internal static partial class Program
    {
        private static JsonObject OpenRendered(string path, int timeoutMs = 120_000)
        {
            Call("open", new { path });
            WaitFor("margin attached: " + path, x => Margin(x, path) != null, 30_000);
            return WaitFor("margin rendered: " + path, x => Rendered(Preview(x, path)), timeoutMs);
        }

        private static double Num(JsonNode? n) => n?.GetValue<double>() ?? double.NaN;

        /// <summary>No open documents, default options (optionally pre-collapsed).</summary>
        internal static void Fresh(bool collapsed = false)
        {
            Call("closeAll");
            Call("resetOptions");
            if (collapsed)
            {
                Call("setOption", new { name = "Collapsed", value = true });
            }
        }

        /// <summary>WinUI-only gating, collapse/expand, persistence across tabs, Right/Bottom dock toggle.</summary>
        private static void Group_Margin()
        {
            Run("Margin: WPF XAML gets no margin", () =>
            {
                Fresh();
                Call("open", new { path = _fx.WpfWindow });
                Holds("no margin on WPF window", x => Margin(x, _fx.WpfWindow) == null, 4_000);
            });

            Run("Margin: a loose .xaml outside any project gets a margin and renders", () =>
            {
                Fresh();
                Assert(Rendered(Preview(OpenRendered(_fx.LoosePage), _fx.LoosePage)), "loose page rendered");
            });

            Run("Margin: a plain .xml file gets no margin", () =>
            {
                Fresh();
                Call("open", new { path = _fx.LooseXml });
                Holds("no margin on .xml", x => Margin(x, _fx.LooseXml) == null, 4_000);
            });

            Run("Margin: each WinUI tab gets its own margin and surface", () =>
            {
                Fresh();
                var a = Preview(OpenRendered(_fx.MainPage), _fx.MainPage)!;
                var s = OpenRendered(_fx.SecondPage);
                var b = Preview(s, _fx.SecondPage)!;
                Assert(Margin(s, _fx.MainPage) != null, "MainPage margin survived opening a second tab");
                var pa = (int?)a["clientPid"];
                var pb = (int?)b["clientPid"];
                Assert(pa != null && pb != null && pa != pb, $"distinct surfaces expected, got {pa} / {pb}");
                Eq(_fx.MainPage, (string?)a["pinnedPath"], "MainPage pinned path");
                Eq(_fx.SecondPage, (string?)b["pinnedPath"], "SecondPage pinned path");
            });

            Run("Margin: hide collapses to a strip and persists the choice", () =>
            {
                Fresh();
                OpenRendered(_fx.MainPage);
                Call("click", new { path = _fx.MainPage, automationId = "PreviewHideButton" });
                var s = WaitFor("collapsed", x => Margin(x, _fx.MainPage)!["collapsedBarVisible"]!.GetValue<bool>()
                                                 && Num(Margin(x, _fx.MainPage)!["width"]) < 40);
                var m = Margin(s, _fx.MainPage)!;
                Eq(false, m["contentVisible"]!.GetValue<bool>(), "content visible while collapsed");
                Eq(true, s["options"]!["collapsed"]!.GetValue<bool>(), "persisted collapsed");
            });

            Run("Margin: a newly opened tab honours the collapsed preference", () =>
            {
                Fresh(collapsed: true);
                Call("open", new { path = _fx.SecondPage });
                var s = WaitFor("SecondPage margin collapsed", x => Margin(x, _fx.SecondPage)?["collapsedBarVisible"]?.GetValue<bool>() == true);
                Eq(false, Margin(s, _fx.SecondPage)!["contentVisible"]!.GetValue<bool>(), "content visible");
            });

            Run("Margin: show expands back to the persisted width and renders", () =>
            {
                Fresh(collapsed: true);
                Call("open", new { path = _fx.MainPage });
                WaitFor("collapsed margin", x => Margin(x, _fx.MainPage)?["collapsedBarVisible"]?.GetValue<bool>() == true, 30_000);
                Call("click", new { path = _fx.MainPage, automationId = "PreviewShowButton" });
                var s = WaitFor("expanded", x => Margin(x, _fx.MainPage)!["contentVisible"]!.GetValue<bool>()
                                                && Num(Margin(x, _fx.MainPage)!["width"]) > 100);
                var expected = Num(s["options"]!["rightWidth"]);
                var width = Num(Margin(s, _fx.MainPage)!["width"]);
                Assert(Math.Abs(width - expected) < 2, $"width {width} vs persisted {expected}");
                Eq(false, s["options"]!["collapsed"]!.GetValue<bool>(), "persisted collapsed");
                WaitFor("rendered after expand", x => Rendered(Preview(x, _fx.MainPage)), 120_000);
            });

            Run("Margin: dock toggle moves the preview to the bottom and back", () =>
            {
                Fresh();
                OpenRendered(_fx.MainPage);
                Call("click", new { path = _fx.MainPage, automationId = "PreviewDockToggle" });
                var s = WaitFor("bottom margin", x => (string?)Margin(x, _fx.MainPage)?["location"] == "Bottom", 30_000);
                Eq("Bottom", (string?)s["options"]!["location"], "persisted location");
                s = WaitFor("bottom margin rendered at persisted height", x =>
                    Rendered(Preview(x, _fx.MainPage)) && Math.Abs(Num(Margin(x, _fx.MainPage)!["height"]) - Num(x["options"]!["bottomHeight"])) < 2);

                Call("click", new { path = _fx.MainPage, automationId = "PreviewDockToggle" });
                WaitFor("right margin again", x => (string?)Margin(x, _fx.MainPage)?["location"] == "Right"
                                                  && (string?)x["options"]!["location"] == "Right", 30_000);
                WaitFor("right margin rendered", x => Rendered(Preview(x, _fx.MainPage)));
            });
        }
    }
}
