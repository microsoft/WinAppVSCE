using System;
using System.Threading;

namespace WinUIXamlPreview.IntegrationTests
{
    internal static partial class Program
    {
        private static int OffsetOf(string path, string needle)
        {
            var text = (string)Call("text", new { path })!;
            var at = text.IndexOf(needle, StringComparison.Ordinal);
            Assert(at >= 0, $"'{needle}' not in buffer");
            return at;
        }

        /// <summary>Two-way editor caret &lt;-&gt; designer selection sync (paths: 0=Page, 0.0=StackPanel,
        /// 0.0.0=TextBlock, 0.0.1=Button, 0.0.2=TextBox).</summary>
        private static void Group_Caret()
        {
            Run("Caret: moving the caret selects the element in the designer", () =>
            {
                Fresh();
                OpenRendered(_fx.MainPage);
                Call("caret", new { path = _fx.MainPage, offset = OffsetOf(_fx.MainPage, "<Button") + 3 });
                var s = WaitFor("designer selected Button", x => (string?)Preview(x, _fx.MainPage)!["lastSelectedPath"] == "0.0.1", 15_000);
                Assert(((string?)Preview(s, _fx.MainPage)!["lastSelectedType"] ?? "").Contains("Button"),
                    $"selected type {Preview(s, _fx.MainPage)!["lastSelectedType"]}");

                Call("caret", new { path = _fx.MainPage, offset = OffsetOf(_fx.MainPage, "PlaceholderText") });
                WaitFor("designer selected TextBox (caret on an attribute)", x => (string?)Preview(x, _fx.MainPage)!["lastSelectedPath"] == "0.0.2", 15_000);
            });

            Run("Caret: no designer selection when design mode is off", () =>
            {
                Fresh();
                Call("setOption", new { name = "DesignMode", value = false });
                OpenRendered(_fx.MainPage);
                Call("caret", new { path = _fx.MainPage, offset = OffsetOf(_fx.MainPage, "<Button") + 3 });
                Holds("no designer selection", x => Preview(x, _fx.MainPage)!["lastSelectedPath"] == null, 2_500);
            });

            Run("Caret: designer selection moves the caret and highlights the start tag", () =>
            {
                Fresh();
                OpenRendered(_fx.MainPage);
                Call("designerSelect", new { path = _fx.MainPage, elementPath = "0.0.1" });
                var s = WaitFor("caret on Button", x => Num(Margin(x, _fx.MainPage)!["caret"]) == OffsetOf(_fx.MainPage, "<Button"), 5_000);
                Eq("<Button x:Name=\"Go\" Content=\"Go\" />", (string?)Margin(s, _fx.MainPage)!["selection"], "selected text");
            });

            Run("Caret: designer selection inside the caret's element leaves the caret alone", () =>
            {
                Fresh();
                OpenRendered(_fx.MainPage);
                var inside = OffsetOf(_fx.MainPage, "Content=\"Go\"");
                Call("caret", new { path = _fx.MainPage, offset = inside });
                Call("designerSelect", new { path = _fx.MainPage, elementPath = "0.0.1" });
                Thread.Sleep(300);
                Eq((double)inside, Num(Margin(Snap(), _fx.MainPage)!["caret"]), "caret");
            });

            Run("Caret: designer selection uses the edited buffer's layout", () =>
            {
                Fresh();
                OpenRendered(_fx.MainPage);
                Edit(_fx.MainPage, "<Button", "<CheckBox x:Name=\"Inserted\" />\r\n        <Button");
                Call("designerSelect", new { path = _fx.MainPage, elementPath = "0.0.1" });
                var s = WaitFor("caret on the inserted CheckBox", x => Num(Margin(x, _fx.MainPage)!["caret"]) == OffsetOf(_fx.MainPage, "<CheckBox"), 5_000);
                Call("designerSelect", new { path = _fx.MainPage, elementPath = "0.0.2" });
                WaitFor("caret on Button (shifted)", x => Num(Margin(x, _fx.MainPage)!["caret"]) == OffsetOf(_fx.MainPage, "<Button"), 5_000);
            });

            Run("Caret: unknown designer path is ignored", () =>
            {
                Fresh();
                OpenRendered(_fx.MainPage);
                Call("caret", new { path = _fx.MainPage, offset = 0 });
                Call("designerSelect", new { path = _fx.MainPage, elementPath = "0.9.9" });
                Thread.Sleep(300);
                Eq(0.0, Num(Margin(Snap(), _fx.MainPage)!["caret"]), "caret");
            });
        }
    }
}
