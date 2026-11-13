using System;
using System.Text.RegularExpressions;
using System.Threading;

namespace WinUIXamlPreview.IntegrationTests
{
    internal static partial class Program
    {
        /// <summary>Replaces the first occurrence of <paramref name="find"/> in the live buffer (unsaved).</summary>
        internal static void Edit(string path, string find, string replacement)
        {
            var text = (string)Call("text", new { path })!;
            var at = text.IndexOf(find, StringComparison.Ordinal);
            Assert(at >= 0, $"'{find}' not in buffer");
            Call("replace", new { path, start = at, length = find.Length, text = replacement });
        }

        /// <summary>Live-edit render starts (each one logs "PERF edit.&lt;kind&gt;.paint ...").</summary>
        internal static int EditRenders(long mark) =>
            Regex.Matches(LogSince(mark), @"PERF edit\.[a-z.]+\.paint").Count;

        /// <summary>Unsaved-buffer live edit: debounce, coalescing, collapse gating, error banner, recovery.</summary>
        private static void Group_Edit()
        {
            Run("Edit: typing re-renders from the unsaved buffer after the debounce", () =>
            {
                Fresh();
                OpenRendered(_fx.MainPage);
                // The debounce clock starts when VS applies the edit, but the replace round-trip can stall on a
                // loaded runner (seen on ARM) so "250ms after it returned" may already be past 500ms. Time from
                // before the call and only judge an attempt whose check really landed inside the window.
                long mark = 0;
                for (var attempt = 0; ; attempt++)
                {
                    var find = attempt == 0 ? "Hello preview" : "Live preview" + new string('!', attempt - 1);
                    var replacement = "Live preview" + new string('!', attempt);
                    mark = LogMark();
                    var sw = System.Diagnostics.Stopwatch.StartNew();
                    Edit(_fx.MainPage, find, replacement);
                    var callMs = sw.ElapsedMilliseconds;
                    Thread.Sleep((int)Math.Max(0, 250 - callMs));
                    var renders = EditRenders(mark);
                    var checkedAt = sw.ElapsedMilliseconds;
                    if (checkedAt < 400 || attempt == 2)
                    {
                        Eq(0, renders, $"renders inside the 500ms debounce window (checked at {checkedAt}ms, replace took {callMs}ms, attempt {attempt + 1})");
                        break;
                    }
                    WaitFor("edit render", _ => EditRenders(mark) >= 1, 30_000);
                    WaitFor("rendered", x => Rendered(Preview(x, _fx.MainPage)), 30_000);
                }
                WaitFor("edit render", _ => EditRenders(mark) >= 1, 30_000);
                WaitFor("rendered", x => Rendered(Preview(x, _fx.MainPage)), 30_000);
                Assert(!System.IO.File.ReadAllText(_fx.MainPage).Contains("Live preview"), "edit was written to disk");
            });

            Run("Edit: a burst of edits coalesces into one render", () =>
            {
                Fresh();
                OpenRendered(_fx.MainPage);
                // Each replace is a pipe round-trip into VS; under load one can stall past the 500ms debounce,
                // and then the "burst" really was two bursts. Only judge a burst whose gaps stayed well inside it.
                for (var attempt = 1; ; attempt++)
                {
                    var mark = LogMark();
                    var text = (string)Call("text", new { path = _fx.MainPage })!;
                    var g = Regex.Match(text, "Text=\"([^\"]*)\" />").Groups[1];
                    int start = g.Index, length = g.Length;
                    var maxGap = 0L;
                    var sw = System.Diagnostics.Stopwatch.StartNew();
                    foreach (var word in new[] { "One", "Two", "Three", "Four", "Five" })
                    {
                        Call("replace", new { path = _fx.MainPage, start, length, text = word });
                        length = word.Length;
                        maxGap = Math.Max(maxGap, sw.ElapsedMilliseconds);
                        sw.Restart();
                        Thread.Sleep(50);
                    }
                    WaitFor("edit render", _ => EditRenders(mark) >= 1, 30_000);
                    Thread.Sleep(1500);
                    var renders = EditRenders(mark);
                    if (renders == 1)
                    {
                        return;
                    }
                    if (maxGap < 350 || attempt == 3)
                    {
                        Eq(1, renders, $"renders for a 5-edit burst (largest gap {maxGap}ms, attempt {attempt})");
                    }
                    Log($"      burst gap {maxGap}ms exceeded the debounce margin ({renders} renders); retrying");
                    WaitFor("rendered", x => Rendered(Preview(x, _fx.MainPage)), 30_000);
                }
            });

            Run("Edit: no renders while collapsed; one reload on expand", () =>
            {
                Fresh();
                OpenRendered(_fx.MainPage);
                Call("click", new { path = _fx.MainPage, automationId = "PreviewHideButton" });
                WaitFor("collapsed", x => Margin(x, _fx.MainPage)!["collapsedBarVisible"]!.GetValue<bool>());
                var mark = LogMark();
                Edit(_fx.MainPage, "Hello preview", "Hidden edit");
                Thread.Sleep(1500);
                Eq(0, EditRenders(mark), "renders while collapsed");
                Call("click", new { path = _fx.MainPage, automationId = "PreviewShowButton" });
                WaitFor("render on expand", _ => EditRenders(mark) >= 1, 30_000);
                WaitFor("rendered", x => Rendered(Preview(x, _fx.MainPage)), 30_000);
            });

            Run("Edit: expanding with no pending edits does not re-render", () =>
            {
                Fresh();
                OpenRendered(_fx.MainPage);
                Call("click", new { path = _fx.MainPage, automationId = "PreviewHideButton" });
                WaitFor("collapsed", x => Margin(x, _fx.MainPage)!["collapsedBarVisible"]!.GetValue<bool>());
                var mark = LogMark();
                Call("click", new { path = _fx.MainPage, automationId = "PreviewShowButton" });
                WaitFor("expanded", x => !Margin(x, _fx.MainPage)!["collapsedBarVisible"]!.GetValue<bool>());
                Thread.Sleep(1500);
                Eq(0, EditRenders(mark), "renders on a no-op expand");
            });

            Run("Edit: an invalid edit shows the XAML error banner over the last render", () =>
            {
                Fresh();
                OpenRendered(_fx.MainPage);
                Edit(_fx.MainPage, "<TextBlock x:Name", "<NoSuchControlX x:Name");
                var s = WaitFor("error banner", x => Preview(x, _fx.MainPage)!["messageBarShown"]!.GetValue<bool>(), 30_000);
                var p = Preview(s, _fx.MainPage)!;
                Assert(((string?)p["messageBarText"] ?? "").Contains("XAML error"), $"banner text: {p["messageBarText"]}");
                Eq(false, p["statusVisible"]!.GetValue<bool>(), "status card (last render should stay visible)");
                Assert(p["hasFrame"]!.GetValue<bool>() || p["hasNative"]!.GetValue<bool>(), "last render kept");
            });

            Run("Edit: fixing the error clears the banner and re-renders", () =>
            {
                Fresh();
                OpenRendered(_fx.MainPage);
                Edit(_fx.MainPage, "<TextBlock x:Name", "<NoSuchControlX x:Name");
                WaitFor("error banner", x => Preview(x, _fx.MainPage)!["messageBarShown"]!.GetValue<bool>(), 30_000);
                Edit(_fx.MainPage, "<NoSuchControlX x:Name", "<TextBlock x:Name");
                WaitFor("banner cleared + rendered", x => !Preview(x, _fx.MainPage)!["messageBarShown"]!.GetValue<bool>()
                                                         && Rendered(Preview(x, _fx.MainPage)), 30_000);
            });
        }
    }
}
