using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading;

namespace WinUIXamlPreview.IntegrationTests
{
    internal static partial class Program
    {
        private static string? _productLog;

        /// <summary>Current end of the product's preview.log; pair with <see cref="LogSince"/>.</summary>
        internal static long LogMark()
        {
            _productLog ??= (string?)Snap()["logFile"];
            try { return new FileInfo(_productLog!).Length; } catch { return 0; }
        }

        internal static string LogSince(long mark)
        {
            using var fs = new FileStream(_productLog!, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            if (mark > fs.Length)
            {
                mark = 0; // rotated
            }
            fs.Seek(mark, SeekOrigin.Begin);
            using var r = new StreamReader(fs, Encoding.UTF8);
            return r.ReadToEnd();
        }

        internal static void WaitForLog(long mark, string needle, int timeoutMs = 30_000)
        {
            var end = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            while (DateTime.UtcNow < end)
            {
                if (LogSince(mark).IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    return;
                }
                Thread.Sleep(150);
            }
            var tail = LogSince(mark);
            throw new TestFailure($"log never contained '{needle}' within {timeoutMs}ms. Log since mark:\n{(tail.Length > 2500 ? tail.Substring(tail.Length - 2500) : tail)}");
        }

        /// <summary>The tool-window session (the one that follows the active document, i.e. not pinned).</summary>
        internal static bool SamePath(string? a, string? b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);

        internal static JsonObject? ToolSession(JsonObject snap) =>
            snap["sessions"]!.AsArray().OfType<JsonObject>()
                .FirstOrDefault(s => s["pinnedPath"] == null && s["disposed"]?.GetValue<bool>() != true);

        /// <summary>Document following, save-reload, rename, and close.</summary>
        private static void Group_Render()
        {
            Run("Render: tool window follows the active XAML document", () =>
            {
                Fresh();
                Call("raise", new { guid = CommandSetGuid, id = ShowPreviewCommandId });
                OpenRendered(_fx.MainPage);
                WaitFor("tool window on MainPage", x => SamePath((string?)ToolSession(x)?["currentPath"], _fx.MainPage));
                OpenRendered(_fx.SecondPage);
                WaitFor("tool window on SecondPage", x => SamePath((string?)ToolSession(x)?["currentPath"], _fx.SecondPage));
                Call("activate", new { path = _fx.MainPage });
                WaitFor("tool window back on MainPage", x => SamePath((string?)ToolSession(x)?["currentPath"], _fx.MainPage));
            });

            Run("Render: tool window shows the empty state for a non-XAML document", () =>
            {
                Call("open", new { path = _fx.Readme });
                var s = WaitFor("empty state", x => ToolSession(x)?["currentPath"] == null
                                                   && (string?)ToolSession(x)?["statusText"] == "Open a .xaml file to preview it.");
                Eq(true, ToolSession(s)!["statusVisible"]!.GetValue<bool>(), "status overlay visible");
            });

            Run("Render: pinned margin ignores active-document changes", () =>
            {
                Fresh();
                OpenRendered(_fx.MainPage);
                OpenRendered(_fx.SecondPage);
                var s = Snap();
                Eq(_fx.MainPage, (string?)Preview(s, _fx.MainPage)!["currentPath"], "MainPage margin still on MainPage");
                Eq(_fx.SecondPage, (string?)Preview(s, _fx.SecondPage)!["currentPath"], "SecondPage margin on SecondPage");
            });

            Run("Render: saving the document reloads its preview", () =>
            {
                Fresh();
                OpenRendered(_fx.MainPage);
                var editMark = LogMark();
                Call("replace", new { path = _fx.MainPage, start = Fixture.MainPageXaml.IndexOf("Hello preview", StringComparison.Ordinal), length = 5, text = "Saved" });
                WaitForLog(editMark, "PERF edit."); // live-edit render settles first
                var mark = LogMark();
                Call("save", new { path = _fx.MainPage });
                Assert(File.ReadAllText(_fx.MainPage).Contains("Saved preview"), "file on disk has the edit");
                WaitForLog(mark, "PERF edit.");
                WaitFor("rendered after save", x => Rendered(Preview(x, _fx.MainPage)), 60_000);
            });

            Run("Render: Save As follows the renamed document", () =>
            {
                Fresh();
                OpenRendered(_fx.SecondPage);
                var renamed = Path.Combine(_fx.WinUiDir, "RenamedPage.xaml");
                if (File.Exists(renamed)) File.Delete(renamed);
                var mark = LogMark();
                Call("save", new { path = _fx.SecondPage, newPath = renamed });
                WaitForLog(mark, "renamed");
                var s = WaitFor("margin re-pinned to the new path", x => Margin(x, renamed) != null
                                                                        && SamePath((string?)Preview(x, renamed)!["pinnedPath"], renamed), 30_000);
                Assert(Margin(s, _fx.SecondPage) == null, "old-path margin still live");
                WaitFor("renamed page rendered", x => Rendered(Preview(x, renamed)) && SamePath((string?)Preview(x, renamed)!["currentPath"], renamed), 60_000);
                Call("closeAll");
                File.Delete(renamed);
            });

            Run("Render: closing a tab disposes its margin and ends its surface", () =>
            {
                Fresh();
                var s = OpenRendered(_fx.MainPage);
                var pid = Preview(s, _fx.MainPage)!["clientPid"]!.GetValue<int>();
                var spare = (int?)Preview(s, _fx.MainPage)!["sparePid"];
                Assert(IsAlive(pid), "surface alive before close");
                Call("close", new { path = _fx.MainPage });
                WaitFor("margin gone", x => Margin(x, _fx.MainPage) == null, 15_000);
                var end = DateTime.UtcNow.AddSeconds(15);
                while (DateTime.UtcNow < end && (IsAlive(pid) || (spare != null && IsAlive(spare.Value))))
                {
                    Thread.Sleep(200);
                }
                Assert(!IsAlive(pid), $"surface {pid} still running 15s after the tab closed");
                Assert(spare == null || !IsAlive(spare.Value), $"spare surface {spare} still running 15s after the tab closed");
            });
        }
    }
}
