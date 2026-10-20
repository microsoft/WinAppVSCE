using System.Text.Json.Nodes;

namespace WinUIXamlPreview.IntegrationTests
{
    internal static partial class Program
    {
        private static JsonObject Opt(JsonObject snap) => snap["options"]!.AsObject();

        private static string? Label(JsonObject snap, string path, string field) => (string?)Margin(snap, path)?[field];

        /// <summary>Margin toolbar: theme/size menus, sample-data + select toggles, persistence, Window, Reload, overflow.</summary>
        private static void Group_Toolbar()
        {
            Run("Toolbar: theme menu switches the preview theme on a fresh surface", () =>
            {
                Fresh();
                var s = OpenRendered(_fx.MainPage);
                var pid = (int?)Preview(s, _fx.MainPage)!["clientPid"];
                Call("menu", new { path = _fx.MainPage, button = "PreviewThemeButton", item = "PreviewThemeDark" });
                s = WaitFor("Dark applied", x => Label(x, _fx.MainPage, "themeLabel") == "Dark"
                                               && (string?)Opt(x)["theme"] == "Dark"
                                               && (string?)Preview(x, _fx.MainPage)!["activeTheme"] == "Dark"
                                               && (int?)Preview(x, _fx.MainPage)!["clientPid"] != pid
                                               && Rendered(Preview(x, _fx.MainPage)), 60_000);
                Call("menu", new { path = _fx.MainPage, button = "PreviewThemeButton", item = "PreviewThemeLight" });
                WaitFor("Light restored", x => Label(x, _fx.MainPage, "themeLabel") == "Light"
                                             && (string?)Preview(x, _fx.MainPage)!["activeTheme"] == "Light"
                                             && Rendered(Preview(x, _fx.MainPage)), 60_000);
            });

            Run("Toolbar: size menu sets the canvas size; Auto clears it", () =>
            {
                Fresh();
                OpenRendered(_fx.MainPage);
                var mark = LogMark();
                Call("menu", new { path = _fx.MainPage, button = "PreviewSizeButton", item = "PreviewSizePhone" });
                var s = WaitFor("Phone", x => Label(x, _fx.MainPage, "sizeLabel") == "Phone");
                Eq(360.0, Num(Opt(s)["canvasWidth"]), "canvasWidth");
                Eq(640.0, Num(Opt(s)["canvasHeight"]), "canvasHeight");
                WaitForLog(mark, "canvas size set to 360x640");
                Call("menu", new { path = _fx.MainPage, button = "PreviewSizeButton", item = "PreviewSizeAuto" });
                s = WaitFor("Auto", x => Label(x, _fx.MainPage, "sizeLabel") == "Auto");
                Eq(0.0, Num(Opt(s)["canvasWidth"]), "canvasWidth after Auto");
            });

            Run("Toolbar: sample-data toggle flips the option and re-renders", () =>
            {
                Fresh();
                OpenRendered(_fx.MainPage);
                var mark = LogMark();
                Call("click", new { path = _fx.MainPage, automationId = "PreviewDtdToggle" });
                var s = WaitFor("off", x => Label(x, _fx.MainPage, "dtdLabel") == "Sample data: Off");
                Eq(false, Opt(s)["designTimeData"]!.GetValue<bool>(), "designTimeData");
                WaitForLog(mark, "Sample data toggled off");
                WaitFor("rendered", x => Rendered(Preview(x, _fx.MainPage)), 60_000);
                Call("click", new { path = _fx.MainPage, automationId = "PreviewDtdToggle" });
                WaitFor("on", x => Label(x, _fx.MainPage, "dtdLabel") == "Sample data: On" && Opt(x)["designTimeData"]!.GetValue<bool>());
            });

            Run("Toolbar: select toggle switches Select <-> Interact", () =>
            {
                Fresh();
                OpenRendered(_fx.MainPage);
                Call("click", new { path = _fx.MainPage, automationId = "PreviewSelectToggle" });
                var s = WaitFor("Interact", x => Label(x, _fx.MainPage, "selectLabel") == "Interact");
                Eq(false, Opt(s)["designMode"]!.GetValue<bool>(), "designMode");
                Call("click", new { path = _fx.MainPage, automationId = "PreviewSelectToggle" });
                WaitFor("Select", x => Label(x, _fx.MainPage, "selectLabel") == "Select" && Opt(x)["designMode"]!.GetValue<bool>());
            });

            Run("Toolbar: choices persist into a newly opened tab", () =>
            {
                Fresh();
                OpenRendered(_fx.MainPage);
                Call("menu", new { path = _fx.MainPage, button = "PreviewThemeButton", item = "PreviewThemeDark" });
                Call("menu", new { path = _fx.MainPage, button = "PreviewSizeButton", item = "PreviewSizeTablet" });
                Call("click", new { path = _fx.MainPage, automationId = "PreviewDtdToggle" });
                WaitFor("MainPage settled", x => Label(x, _fx.MainPage, "themeLabel") == "Dark" && Rendered(Preview(x, _fx.MainPage)), 60_000);
                var s = OpenRendered(_fx.SecondPage);
                Eq("Dark", Label(s, _fx.SecondPage, "themeLabel"), "theme label");
                Eq("Tablet", Label(s, _fx.SecondPage, "sizeLabel"), "size label");
                Eq("Sample data: Off", Label(s, _fx.SecondPage, "dtdLabel"), "sample-data label");
                Eq("Dark", (string?)Preview(s, _fx.SecondPage)!["activeTheme"], "surface theme");
            });

            Run("Toolbar: a change in one tab updates the other open tab's labels and surface", () =>
            {
                Fresh();
                OpenRendered(_fx.MainPage);
                OpenRendered(_fx.SecondPage);
                Call("menu", new { path = _fx.SecondPage, button = "PreviewThemeButton", item = "PreviewThemeDark" });
                Call("menu", new { path = _fx.SecondPage, button = "PreviewSizeButton", item = "PreviewSizePhone" });
                Call("click", new { path = _fx.SecondPage, automationId = "PreviewDtdToggle" });
                Call("click", new { path = _fx.SecondPage, automationId = "PreviewSelectToggle" });
                WaitFor("MainPage labels follow", x => Label(x, _fx.MainPage, "themeLabel") == "Dark"
                                                     && Label(x, _fx.MainPage, "sizeLabel") == "Phone"
                                                     && Label(x, _fx.MainPage, "dtdLabel") == "Sample data: Off"
                                                     && Label(x, _fx.MainPage, "selectLabel") == "Interact", 15_000);
                Call("activate", new { path = _fx.MainPage });
                WaitFor("MainPage surface re-themed", x => (string?)Preview(x, _fx.MainPage)!["activeTheme"] == "Dark"
                                                         && Rendered(Preview(x, _fx.MainPage)), 60_000);
            });

            Run("Toolbar: Window button shows the preview tool window", () =>
            {
                Fresh();
                OpenRendered(_fx.MainPage);
                Call("click", new { path = _fx.MainPage, automationId = "PreviewWindowButton" });
                WaitFor("tool window visible", _ => ToolWindowVisible(), 15_000);
                WaitFor("margin is a strip", x => IsStrip(Margin(x, _fx.MainPage)), 15_000);
            });

            Run("Toolbar: Reload re-renders the current buffer", () =>
            {
                Fresh();
                OpenRendered(_fx.MainPage);
                var mark = LogMark();
                Call("click", new { path = _fx.MainPage, automationId = "PreviewReloadButton" });
                WaitFor("reload render", _ => EditRenders(mark) >= 1, 30_000);
                WaitFor("rendered", x => Rendered(Preview(x, _fx.MainPage)), 30_000);
            });

            Run("Toolbar: a narrow margin moves buttons into the overflow menu", () =>
            {
                Fresh();
                Call("setOption", new { name = "RightWidth", value = 220 });
                Call("open", new { path = _fx.MainPage });
                var s = WaitFor("overflow shown", x => Margin(x, _fx.MainPage)?["overflowVisible"]?.GetValue<bool>() == true, 30_000);
                var narrow = Num(Margin(s, _fx.MainPage)!["toolbarLevel"]);
                Fresh();
                s = OpenRendered(_fx.MainPage);
                Eq(false, Margin(s, _fx.MainPage)!["overflowVisible"]!.GetValue<bool>(), "overflow at default width");
                Assert(Num(Margin(s, _fx.MainPage)!["toolbarLevel"]) < narrow, $"toolbar collapse level wide={Margin(s, _fx.MainPage)!["toolbarLevel"]} narrow={narrow}");
            });
        }
    }
}
