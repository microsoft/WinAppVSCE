using System.Text.Json.Nodes;

namespace WinUIXamlPreview.IntegrationTests
{
    internal static partial class Program
    {
        private static JsonObject OpenUntilStatus(string path, string statusText, int timeoutMs = 120_000)
        {
            Call("open", new { path });
            return WaitFor($"'{statusText}' on {System.IO.Path.GetFileName(path)}",
                x => Preview(x, path) is JsonObject p && (string?)p["statusText"] == statusText && p["statusVisible"]!.GetValue<bool>(),
                timeoutMs);
        }

        /// <summary>Error presentation: cold parse/type errors, non-designable roots, live recovery, banner dismiss.</summary>
        private static void Group_Errors()
        {
            Run("Errors: an unknown type on first render shows the XAML error card with its location", () =>
            {
                Fresh();
                var p = Preview(OpenUntilStatus(_fx.BrokenPage, "XAML error"), _fx.BrokenPage)!;
                var detail = (string?)p["statusDetail"] ?? "";
                Assert(detail.Contains("NoSuchControl"), "detail names the type: " + detail);
                Assert(detail.StartsWith("Line "), "detail has a line/col prefix: " + detail);
                Eq(false, p["messageBarShown"]!.GetValue<bool>(), "banner (no previous render to keep)");
                Eq(false, p["hasFrame"]!.GetValue<bool>() || p["hasNative"]!.GetValue<bool>(), "has a render");
                Eq(false, p["reconnectShown"]!.GetValue<bool>(), "reconnect banner");
            });

            Run("Errors: fixing a broken page live replaces the error card with a render", () =>
            {
                Fresh();
                OpenUntilStatus(_fx.BrokenPage, "XAML error");
                Edit(_fx.BrokenPage, "<NoSuchControl />", "<TextBlock Text=\"fixed\" />");
                WaitFor("rendered", x => Rendered(Preview(x, _fx.BrokenPage)), 60_000);
            });

            Run("Errors: malformed XML while editing shows the XAML error banner", () =>
            {
                Fresh();
                OpenRendered(_fx.SecondPage);
                Edit(_fx.SecondPage, "</Page>", "<Grid></Page>");
                var s = WaitFor("error banner", x => Preview(x, _fx.SecondPage)!["messageBarShown"]!.GetValue<bool>(), 30_000);
                Assert(((string?)Preview(s, _fx.SecondPage)!["messageBarText"] ?? "").Contains("XAML error"), "banner text");
            });

            Run("Errors: a ResourceDictionary shows the calm 'Not a designable page' state", () =>
            {
                Fresh();
                var p = Preview(OpenUntilStatus(_fx.Dictionary, "Not a designable page"), _fx.Dictionary)!;
                Assert(!string.IsNullOrWhiteSpace((string?)p["statusDetail"]), "has a human reason");
                Eq(false, p["messageBarShown"]!.GetValue<bool>(), "error banner");
                Eq(false, p["reconnectShown"]!.GetValue<bool>(), "reconnect banner");
                Eq(false, p["statusSpinner"]!.GetValue<bool>(), "spinner");
            });

            Run("Errors: the error banner can be dismissed and the last render stays", () =>
            {
                Fresh();
                OpenRendered(_fx.MainPage);
                Edit(_fx.MainPage, "<TextBlock x:Name", "<NoSuchControlX x:Name");
                WaitFor("error banner", x => Preview(x, _fx.MainPage)!["messageBarShown"]!.GetValue<bool>(), 30_000);
                Call("click", new { path = _fx.MainPage, automationId = "PreviewMessageBar.Close" });
                var s = WaitFor("banner dismissed", x => !Preview(x, _fx.MainPage)!["messageBarShown"]!.GetValue<bool>(), 5_000);
                var p = Preview(s, _fx.MainPage)!;
                Assert(p["hasFrame"]!.GetValue<bool>() || p["hasNative"]!.GetValue<bool>(), "last render kept");
                Eq(false, p["statusVisible"]!.GetValue<bool>(), "status card");
            });

            Run("Errors: the tool window recovers when moving from a broken page to a good one", () =>
            {
                Fresh();
                Call("raise", new { guid = CommandSetGuid, id = ShowPreviewCommandId });
                OpenUntilStatus(_fx.BrokenPage, "XAML error");
                WaitFor("tool window shows the error", x => (string?)ToolSession(x)?["statusText"] == "XAML error", 60_000);
                OpenRendered(_fx.MainPage);
                WaitFor("tool window rendered MainPage", x => SamePath((string?)ToolSession(x)?["currentPath"], _fx.MainPage)
                                                              && Rendered(ToolSession(x)), 60_000);
            });
        }
    }
}
