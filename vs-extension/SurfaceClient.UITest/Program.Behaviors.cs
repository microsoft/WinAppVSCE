#nullable enable

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using WinUIXamlPreview.Protocol;

namespace WinUIXamlPreview.UITest
{
    // Renderer behaviours against the real surface and TestFixtureApp.dll: frame sizing, canvas presets,
    // live property edits (conversions + rejected edits), parse-error positions, the safety net for user
    // controls that throw, design-time-data failure paths, sample rows for every list kind, and native-mode
    // transitions. Every hostile input must degrade (placeholder / reverted cell / Error) without killing
    // the surface, so each section ends with a liveness probe.
    internal static partial class Program
    {
        private const string BehNs =
            "xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" " +
            "xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\" " +
            "xmlns:d=\"http://schemas.microsoft.com/expression/blend/2008\" " +
            "xmlns:mc=\"http://schemas.openxmlformats.org/markup-compatibility/2006\" mc:Ignorable=\"d\" " +
            "xmlns:fx=\"using:TestFixtureApp.Controls\"";

        private static string PageXaml(string body, string rootAttrs = "Width=\"400\" Height=\"300\"") =>
            "<Page " + BehNs + " " + rootAttrs + ">\n" + body + "\n</Page>";

        private sealed class Session : IDisposable
        {
            public SurfaceClient Client = null!;
            public FrameBox Box = null!;
            public readonly ConcurrentQueue<string> Logs = new ConcurrentQueue<string>();
            public readonly List<FrameMsg> Frames = new List<FrameMsg>();
            public int NativeExits;

            public void Dispose() => Client.Dispose();

            public async Task<FrameMsg?> NextFrame(Action send, TimeSpan timeout)
            {
                int before;
                lock (Frames) before = Frames.Count;
                send();
                var deadline = DateTime.UtcNow + timeout;
                while (DateTime.UtcNow < deadline)
                {
                    lock (Frames)
                    {
                        if (Frames.Count > before) return Frames[before];
                    }

                    await Task.Delay(50);
                }

                return null;
            }

            public async Task<bool> WaitLog(Func<string, bool> match, TimeSpan timeout)
            {
                var deadline = DateTime.UtcNow + timeout;
                while (DateTime.UtcNow < deadline)
                {
                    if (Logs.Any(match)) return true;
                    await Task.Delay(100);
                }

                return false;
            }

            public string[] TakeErrors()
            {
                lock (Box.Errors)
                {
                    var e = Box.Errors.ToArray();
                    Box.Errors.Clear();
                    return e;
                }
            }

            public async Task<SelectedMsg?> Select(string path, TimeSpan? timeout = null)
            {
                var t = Box.NextSelected(timeout ?? TimeSpan.FromSeconds(10));
                Box.ClearProps();
                Client.SelectByPath(path);
                var sel = await t;
                // Selected and ElementProps arrive back to back; consume this selection's props so a later
                // edit never mistakes them for its echo.
                if (sel != null) await PropsFor(sel);
                return sel;
            }

            public async Task<ElementPropsMsg?> PropsFor(SelectedMsg sel) =>
                await Box.WaitProps(p => p.Id == sel.Id, TimeSpan.FromSeconds(10));

            public async Task<string?> Read(string path, string prop)
            {
                var sel = await Select(path);
                return sel == null ? null : FindProp(await PropsFor(sel), prop)?.Value;
            }

            /// <summary>Send a property edit and return the echoed props (null when the surface sends none).</summary>
            public async Task<ElementPropsMsg?> Set(int id, string name, string value, TimeSpan? timeout = null)
            {
                Box.ClearProps();
                Client.SetProperty(id, name, value);
                return await Box.WaitProps(p => p.Id == id, timeout ?? TimeSpan.FromSeconds(10));
            }

            public async Task<HwndMsg?> Host(string xaml, double w = 400, double h = 300)
            {
                var t = Box.NextHwnd(TimeSpan.FromSeconds(40));
                Client.EnterNative(xaml, w, h, 1.0);
                var hwnd = await t;
                Client.SetMode(true);
                await Task.Delay(300);
                return hwnd;
            }

            public async Task<HwndMsg?> Rehost(string xaml)
            {
                var t = Box.NextHwnd(TimeSpan.FromSeconds(40));
                Client.UpdateXaml(xaml);
                var hwnd = await t;
                await Task.Delay(300);
                return hwnd;
            }
        }

        private static async Task<Session> Open(string surfaceExe, string? userDll, string? appXaml)
        {
            var s = new Session();
            s.Client = new SurfaceClient(surfaceExe, userDll, line => { s.Logs.Enqueue(line); Console.Error.WriteLine("  " + line); }, appXaml, "Light")
            {
                SampleData = true,
            };
            s.Box = new FrameBox(s.Client);
            s.Client.Frame += f => { lock (s.Frames) s.Frames.Add(f); };
            s.Client.NativeExited += () => System.Threading.Interlocked.Increment(ref s.NativeExits);
            await s.Client.StartAsync(TimeSpan.FromSeconds(30));
            return s;
        }

        private static async Task<int> RunBehaviors(string[] args)
        {
            string outDir = GetArg(args, "--out") ?? Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "qa-results");
            Directory.CreateDirectory(outDir);
            string surfaceExe = GetArg(args, "--surface") ?? Environment.GetEnvironmentVariable("WINUI_SURFACE_EXE") ?? DefaultSurfaceExe;
            string? userDll = FullPathOrNull(GetArg(args, "--user-dll"));
            string? fixturesDir = FullPathOrNull(GetArg(args, "--fixtures-dir"));
            string? appXaml = fixturesDir == null ? null : Path.Combine(fixturesDir, "App.xaml");

            Console.WriteLine("Renderer behaviours: sizing, property edits, errors, safety net, design-time data, sample lists");
            Console.WriteLine("Surface.exe: " + surfaceExe);
            Console.WriteLine("User DLL:    " + (userDll ?? "(none)"));
            Console.WriteLine();

            s_behSurface = surfaceExe;
            s_behUserDll = userDll;
            s_behMatchedHost = FullPathOrNull(GetArg(args, "--matched-host"));
            string? only = GetArg(args, "--group");
            bool ok = CheckInput("BEH-0 Surface.exe exists", surfaceExe) & CheckInput("BEH-0 user DLL exists", userDll) &
                CheckInput("BEH-0 App.xaml exists", appXaml);
            if (ok)
            {
                foreach (var (name, body) in new (string, Func<Session, Task>)[]
                {
                    ("frame sizing", FrameSizing),
                    ("parse errors", ParseErrors),
                    ("canvas presets", CanvasPresets),
                    ("property edits", PropertyEdits),
                    ("native transitions", NativeTransitions),
                    ("safety net", SafetyNet),
                    ("safety net: several throwers", SafetyNetMany),
                    ("design-time data", DesignTimeDataNegatives),
                    ("design-time data grammar", DesignTimeDataGrammar),
                    ("sample lists", SampleLists),
                    ("root types", RootTypes),
                    ("resources", Resources),
                    ("app.xaml failures", AppXamlFailures),
                    ("app.xaml merged sources", AppXamlMergedSources),
                    ("never-settling page", NeverSettlingPage),
                    ("malformed payloads", MalformedPayloads),
                    ("huge canvas", HugeCanvas),
                    ("matched-host PRI", MatchedHostPri),
                })
                {
                    if (only != null && name.IndexOf(only, StringComparison.OrdinalIgnoreCase) < 0) continue;
                    Console.WriteLine("== " + name);
                    try
                    {
                        using var s = await Open(surfaceExe, userDll, appXaml);
                        await body(s);
                        Check(name + ": surface still alive", !s.Client.IsFaulted && await Alive(s));
                    }
                    catch (Exception ex)
                    {
                        Check(name + ": ran without exception", false, ex.GetType().Name + ": " + ex.Message);
                    }
                }
            }

            WriteResults(outDir, "behaviors-results.json");
            int failed = Results.Count(r => !r.Pass);
            Console.WriteLine();
            Console.WriteLine($"===== BEHAVIORS: {Results.Count - failed} passed, {failed} failed =====");
            return failed == 0 ? 0 : 1;
        }

        // A surface that still answers a render is alive; works in either frame or native mode.
        private static async Task<bool> Alive(Session s)
        {
            const string probe = "<Page xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" Width=\"100\" Height=\"100\"><TextBlock Text=\"alive\"/></Page>";
            var hwndTask = s.Box.NextHwnd(TimeSpan.FromSeconds(20));
            var frame = await s.NextFrame(() => s.Client.UpdateXaml(probe), TimeSpan.FromSeconds(20));
            if (frame != null) return true;
            return await hwndTask != null;
        }

        // ---------------------------------------------------------------- frame mode sizing

        private static async Task FrameSizing(Session s)
        {
            // The canvas comes from the page's own Width/Height (or the 1024x720 default); the client viewport
            // is ignored and only the scale (clamped 1..2) supersamples the pixels.
            var page = PageXaml("<Border Background=\"Teal\"/>", "Width=\"320\" Height=\"200\"");
            // Pixel size = canvas DIP x clamped output scale x the window's rasterization scale (1.5 on a 150%
            // display), so assert the DIP exactly and the pixel density relative to the 1x frame.
            var f = await s.NextFrame(() => s.Client.LoadXaml(page, 900, 700, 1.0), TimeSpan.FromSeconds(30));
            Check("BEH-F1 page size wins over viewport", f != null && f.DipWidth == 320 && f.DipHeight == 200 && f.Width >= 320 && f.Width * 200 == f.Height * 320, Dims(f));
            double baseDensity = f == null ? 0 : f.Width / 320.0;
            bool Density(FrameMsg? x, double scale) =>
                x != null && baseDensity > 0 && x.DipWidth == 320 && x.DipHeight == 200 &&
                Math.Abs(x.Width - 320 * baseDensity * scale) <= 2 &&
                Math.Abs(x.Height - 200 * baseDensity * scale) <= 2;
            string D(FrameMsg? x) => Dims(x) + $", base density {baseDensity:0.##}";

            f = await s.NextFrame(() => s.Client.Resize(1200, 900, 1.5), TimeSpan.FromSeconds(30));
            Check("BEH-F2 Resize re-renders at 1.5x the base density", Density(f, 1.5), D(f));

            f = await s.NextFrame(() => s.Client.Resize(1200, 900, 4.0), TimeSpan.FromSeconds(30));
            Check("BEH-F3 scale clamps to 2x", Density(f, 2.0), D(f));

            f = await s.NextFrame(() => s.Client.Resize(1200, 900, 0.25), TimeSpan.FromSeconds(30));
            Check("BEH-F4 scale clamps to 1x", Density(f, 1.0), D(f));

            var unsized = PageXaml("<Border Background=\"Teal\"/>", "");
            f = await s.NextFrame(() => s.Client.UpdateXaml(unsized), TimeSpan.FromSeconds(30));
            Check("BEH-F5 unsized page uses the 1024x720 default canvas", f != null && f.DipWidth == 1024 && f.DipHeight == 720, Dims(f));

            var designSized = PageXaml("<Border Background=\"Teal\"/>", "d:DesignWidth=\"360\" d:DesignHeight=\"640\"");
            f = await s.NextFrame(() => s.Client.UpdateXaml(designSized), TimeSpan.FromSeconds(30));
            Check("BEH-F6 d:DesignWidth/Height size the canvas", f != null && f.DipWidth == 360 && f.DipHeight == 640, Dims(f));

            // Frame-mode canvas preset applies to the next render and restores to the page size on auto.
            s.Client.SetCanvasSize(375, 667);
            f = await s.NextFrame(() => s.Client.UpdateXaml(page), TimeSpan.FromSeconds(30));
            Check("BEH-F7 canvas preset applies in frame mode", f != null && f.DipWidth == 375 && f.DipHeight == 667, Dims(f));
            s.Client.SetCanvasSize(0, 0);
            f = await s.NextFrame(() => s.Client.UpdateXaml(page), TimeSpan.FromSeconds(30));
            Check("BEH-F8 auto canvas restores page size", f != null && f.DipWidth == 320 && f.DipHeight == 200, Dims(f));
            Check("BEH-F9 no surface errors while sizing", s.TakeErrors().Length == 0);
        }

        private static string Dims(FrameMsg? f) =>
            f == null ? "no Frame" : $"dip {f.DipWidth}x{f.DipHeight}, px {f.Width}x{f.Height}";

        // ---------------------------------------------------------------- parse errors

        private static async Task<ErrorMsg?> NextError(Session s, Action send)
        {
            var tcs = new TaskCompletionSource<ErrorMsg>(TaskCreationOptions.RunContinuationsAsynchronously);
            Action<ErrorMsg> h = e => tcs.TrySetResult(e);
            s.Client.Error += h;
            try
            {
                send();
                var done = await Task.WhenAny(tcs.Task, Task.Delay(TimeSpan.FromSeconds(30)));
                return done == tcs.Task ? tcs.Task.Result : null;
            }
            finally
            {
                s.Client.Error -= h;
            }
        }

        private static string Pos(ErrorMsg? e) =>
            e == null ? "no Error" : $"phase={e.Phase} line={e.Line?.ToString() ?? "null"} col={e.Column?.ToString() ?? "null"} msg={e.Message}";

        private static async Task ParseErrors(Session s)
        {
            var good = PageXaml("<TextBlock Text=\"ok\"/>");
            var f = await s.NextFrame(() => s.Client.LoadXaml(good, 400, 300, 1.0), TimeSpan.FromSeconds(30));
            Check("BEH-E0 baseline renders", f != null);

            // Malformed XML: the element on line 4 is never closed. Lines are 1-based in the authored text.
            var unclosed = "<Page " + BehNs + ">\n  <StackPanel>\n    <TextBlock Text=\"a\"/>\n    <Border>\n  </StackPanel>\n</Page>";
            var e = await NextError(s, () => s.Client.UpdateXaml(unclosed));
            Check("BEH-E1 malformed XML -> Error (not a crash)", e != null, Pos(e));
            Check("BEH-E2 malformed XML reports a line", e?.Line != null, Pos(e));
            Check("BEH-E3 malformed XML line points at the mismatch (line 5)", e?.Line == 5, Pos(e));
            Check("BEH-E3b malformed XML has readable text (no WinUI placeholder)",
                e?.Message != null && e.Message.StartsWith("XML error:") && e.Message.Contains("Border") && !e.Message.Contains("could not be found"), Pos(e));

            // Bad attribute value on line 3, column 15 (the Width attribute).
            var badValue = "<Page " + BehNs + ">\n  <StackPanel>\n    <Button Width=\"wide\" Content=\"x\"/>\n  </StackPanel>\n</Page>";
            e = await NextError(s, () => s.Client.UpdateXaml(badValue));
            Check("BEH-E4 bad attribute value -> Error", e != null, Pos(e));
            Check("BEH-E5 bad attribute value reports line 3", e?.Line == 3, Pos(e));
            Check("BEH-E5b bad attribute value names the attribute and element",
                e?.Message != null && e.Message.Contains("Width=\"wide\"") && e.Message.Contains("<Button>"), Pos(e));

            // An unknown property on a framework element (line 3).
            var badProp = "<Page " + BehNs + ">\n  <StackPanel>\n    <Button NotAProperty=\"1\"/>\n  </StackPanel>\n</Page>";
            e = await NextError(s, () => s.Client.UpdateXaml(badProp));
            Check("BEH-E6 unknown property -> Error", e != null, Pos(e));
            Check("BEH-E7 unknown property reports line 3", e?.Line == 3, Pos(e));
            Check("BEH-E7b unknown property keeps WinUI's real text, minus the placeholder",
                e?.Message != null && e.Message.Contains("NotAProperty") && !e.Message.Contains("could not be found") && !e.Message.Contains("Exception:"), Pos(e));

            f = await s.NextFrame(() => s.Client.UpdateXaml(good), TimeSpan.FromSeconds(30));
            Check("BEH-E8 recovers after parse errors", f != null);
            s.TakeErrors();
        }

        // ---------------------------------------------------------------- native canvas presets

        private static async Task CanvasPresets(Session s)
        {
            // An unsized root stretches to the board, so its aspect ratio tracks the canvas. Selected bounds are in
            // zoomed view coordinates (the board is fit into the pane), so compare aspect ratios, not sizes. A root
            // with its own Width/Height keeps that size and is centred on the board instead.
            var page = PageXaml("<Grid Background=\"Teal\"/>", "");
            var hwnd = await s.Host(page);
            Check("BEH-C1 EnterNative -> Hwnd", hwnd != null && hwnd.Hwnd != 0);
            var root = await s.Select("0");
            Check("BEH-C2 unsized root fills the 1024x720 default board", Aspect(root, 1024, 720), Bounds(root));

            var t = s.Box.NextHwnd(TimeSpan.FromSeconds(30));
            s.Client.SetCanvasSize(375, 667);
            var re = await t;
            Check("BEH-C3 SetCanvasSize re-hosts (fresh Hwnd)", re != null && re.Hwnd != 0);
            await Task.Delay(300);
            root = await s.Select("0");
            Check("BEH-C4 root laid out at the 375x667 preset", Aspect(root, 375, 667), Bounds(root));

            // The preset survives a document edit.
            await s.Rehost(PageXaml("<Grid Background=\"Orange\"/>", ""));
            root = await s.Select("0");
            Check("BEH-C5 preset survives a re-host", Aspect(root, 375, 667), Bounds(root));

            t = s.Box.NextHwnd(TimeSpan.FromSeconds(30));
            s.Client.SetCanvasSize(0, 0);
            await t;
            await Task.Delay(300);
            root = await s.Select("0");
            Check("BEH-C6 auto restores the default board", Aspect(root, 1024, 720), Bounds(root));

            // Native Resize is a no-op on the surface (client owns child placement): no re-host, no Frame.
            t = s.Box.NextHwnd(TimeSpan.FromSeconds(2));
            var frame = await s.NextFrame(() => s.Client.Resize(1000, 800, 1.0), TimeSpan.FromSeconds(2));
            Check("BEH-C7 native Resize sends no Frame/Hwnd", frame == null && await t == null);
            Check("BEH-C8 no surface errors", s.TakeErrors().Length == 0);
        }

        private static bool Aspect(SelectedMsg? sel, double w, double h) =>
            sel != null && sel.W > 0 && sel.H > 0 && Math.Abs(sel.W / sel.H - w / h) <= 0.02 * (w / h);

        private static string Bounds(SelectedMsg? s) => s == null ? "no Selected" : $"{s.ElementType} {s.W}x{s.H} @ {s.X},{s.Y}";

        // ---------------------------------------------------------------- property edits

        private const string EditPage =
            "<StackPanel>\n" +
            "  <Button x:Name=\"B\" Content=\"Hi\" Width=\"100\"/>\n" +   // 0.0.0
            "  <TextBlock Text=\"T\"/>\n" +                                // 0.0.1
            "  <CheckBox Content=\"C\" IsChecked=\"True\"/>\n" +           // 0.0.2
            "  <Grid><Border Grid.Row=\"0\" Width=\"10\" Height=\"10\"/></Grid>\n" + // 0.0.3, 0.0.3.0
            "</StackPanel>";

        private static async Task PropertyEdits(Session s)
        {
            await s.Host(PageXaml(EditPage));
            var btn = await s.Select("0.0.0");
            Check("BEH-P0 Button selectable", btn?.ElementType == "Button", Bounds(btn));
            if (btn == null) return;
            int id = btn.Id;

            async Task Applies(string code, string prop, string input, Func<string?, bool> expect, int? target = null)
            {
                var echo = await s.Set(target ?? id, prop, input);
                var v = FindProp(echo, prop)?.Value;
                Check($"{code} {prop}='{input}' applies", echo != null && expect(v), "now " + (v ?? (echo == null ? "(no echo)" : "(no row)")));
            }

            async Task Rejected(string code, string prop, string input, string expectedUnchanged, int? target = null)
            {
                var echo = await s.Set(target ?? id, prop, input);
                var v = FindProp(echo, prop)?.Value;
                Check($"{code} {prop}='{input}' rejected, cell reverts", echo != null && v == expectedUnchanged, "now " + (v ?? (echo == null ? "(no echo)" : "(no row)")));
            }

            await Applies("BEH-P1", "Width", "120", v => v == "120");
            await Applies("BEH-P2", "Opacity", "0.5", v => v == "0.5");
            await Applies("BEH-P3", "IsEnabled", "False", v => v == "False");
            await Applies("BEH-P4", "HorizontalAlignment", "Right", v => v == "Right");
            await Applies("BEH-P5", "Margin", "1,2,3,4", v => v == "1,2,3,4");
            await Applies("BEH-P6", "Background", "#FF112233", v => v == "#FF112233");
            await Applies("BEH-P7", "Background", "Red", v => v == "#FFFF0000");
            await Applies("BEH-P8", "Background", "#80FF00", v => v == "#FF80FF00");
            await Applies("BEH-P9", "Background", "(none)", v => string.IsNullOrEmpty(v) || v == "(none)" || v == "null");
            await Applies("BEH-P10", "FontFamily", "Consolas", v => v == "Consolas");
            await Applies("BEH-P11", "CornerRadius", "4", v => v != null && v.StartsWith("4"));
            await Applies("BEH-P12", "Content", "Edited", v => v == "Edited");

            // Width back to a known value, then hostile edits must leave it unchanged.
            await Applies("BEH-P13", "Width", "120", v => v == "120");
            await Rejected("BEH-P14", "Width", "wide", "120");
            await Rejected("BEH-P15", "Width", "", "120");
            await Rejected("BEH-P16", "HorizontalAlignment", "Sideways", "Right");
            await Rejected("BEH-P17", "Background", "#GG0000", "(none)");

            var echo = await s.Set(id, "ActualWidth", "5");
            Check("BEH-P18 read-only ActualWidth: no crash, unchanged", echo != null && FindProp(echo, "ActualWidth")?.Value != "5",
                echo == null ? "no echo" : "ActualWidth=" + FindProp(echo, "ActualWidth")?.Value);
            echo = await s.Set(id, "NoSuchProperty", "1");
            Check("BEH-P19 unknown property: echo, no crash", echo != null);
            echo = await s.Set(987654, "Width", "50", TimeSpan.FromSeconds(2));
            Check("BEH-P20 unknown element id: silently ignored", echo == null);

            // Nullable bool.
            var cb = await s.Select("0.0.2");
            if (cb != null)
            {
                await Applies("BEH-P21", "IsChecked", "False", v => v == "False", cb.Id);
                await Applies("BEH-P22", "IsChecked", "", v => string.IsNullOrEmpty(v) || v == "null" || v == "(null)", cb.Id);
            }

            // Attached property: either editable (applies) or shown read-only — never offered and then dropped.
            var border = await s.Select("0.0.3.0");
            var bprops = border == null ? null : await s.PropsFor(border);
            var row = FindProp(bprops, "Grid.Row") ?? FindProp(bprops, "Row");
            if (row == null)
            {
                Check("BEH-P23 attached Grid.Row not offered as an editable row", true, "not listed");
            }
            else
            {
                var e = await s.Set(border!.Id, row.Name!, "1");
                var v = FindProp(e, row.Name!)?.Value;
                Check("BEH-P23 attached Grid.Row: editable row applies (or is read-only)", row.ReadOnly || v == "1",
                    $"listed as '{row.Name}' readOnly={row.ReadOnly}, after edit {v ?? "(no echo)"}");
            }

            // Interact mode: edits are refused (no echo), and the value is untouched.
            s.Client.SetMode(false);
            await Task.Delay(300);
            echo = await s.Set(id, "Width", "77", TimeSpan.FromSeconds(2));
            Check("BEH-P24 interact mode refuses edits (no echo)", echo == null);
            s.Client.SetMode(true);
            await Task.Delay(300);
            Check("BEH-P25 value unchanged after refused edit", await s.Read("0.0.0", "Width") == "120");
            Check("BEH-P26 no surface errors from edits", s.TakeErrors().Length == 0);
        }

        // ---------------------------------------------------------------- native mode transitions

        private static async Task NativeTransitions(Session s)
        {
            var page = PageXaml("<StackPanel><TextBlock Text=\"one\"/></StackPanel>");
            await s.Host(page);

            var bad = await s.Select("0.9.9", TimeSpan.FromSeconds(2));
            Check("BEH-N1 SelectByPath out of range: no Selected", bad == null);
            bad = await s.Select("not.a.path", TimeSpan.FromSeconds(2));
            Check("BEH-N2 SelectByPath garbage: no Selected", bad == null);
            var good = await s.Select("0.0.0");
            Check("BEH-N3 valid path still selects after bad ones", good?.ElementType == "TextBlock", Bounds(good));

            // Interact mode: SelectByPath is ignored.
            s.Client.SetMode(false);
            await Task.Delay(300);
            Check("BEH-N4 interact mode: SelectByPath ignored", await s.Select("0.0.0", TimeSpan.FromSeconds(2)) == null);
            s.Client.SetMode(true);
            await Task.Delay(300);
            Check("BEH-N5 design mode again: SelectByPath works", (await s.Select("0.0.0"))?.ElementType == "TextBlock");

            // Exit native, render a frame, re-enter native.
            int exits = s.NativeExits;
            s.Client.ExitNative();
            for (int i = 0; i < 50 && s.NativeExits == exits; i++) await Task.Delay(100);
            Check("BEH-N6 ExitNative -> NativeExited", s.NativeExits == exits + 1);
            var f = await s.NextFrame(() => s.Client.LoadXaml(page, 400, 300, 1.0), TimeSpan.FromSeconds(30));
            Check("BEH-N7 frame mode works after ExitNative", f != null, Dims(f));
            var h = await s.Host(PageXaml("<StackPanel><TextBlock Text=\"two\"/></StackPanel>"));
            Check("BEH-N8 re-enter native -> Hwnd", h != null && h.Hwnd != 0);
            Check("BEH-N9 re-entered document is live", await s.Read("0.0.0", "Text") == "two");

            // Repeated enter/exit cycles don't wedge the surface.
            for (int i = 0; i < 3; i++)
            {
                s.Client.ExitNative();
                await Task.Delay(200);
                h = await s.Host(page);
            }

            Check("BEH-N10 3 exit/enter cycles end hosted", h != null && h.Hwnd != 0);
            Check("BEH-N11 no surface errors", s.TakeErrors().Length == 0);
        }

        // ---------------------------------------------------------------- safety net (user code throws)

        private static async Task SafetyNet(Session s)
        {
            var page = PageXaml(
                "<StackPanel>\n" +
                "  <TextBlock Text=\"before\"/>\n" +
                "  <fx:ThrowingControl/>\n" +
                "  <TextBlock Text=\"after\"/>\n" +
                "</StackPanel>");
            var f = await s.NextFrame(() => s.Client.LoadXaml(page, 400, 300, 1.0), TimeSpan.FromSeconds(30));
            Check("BEH-S1 page with a throwing control still renders a frame", f != null, string.Join("; ", s.TakeErrors()));
            Check("BEH-S2 safety net logged the throwing type",
                await s.WaitLog(l => l.Contains("SAFETY-NET") && l.Contains("ThrowingControl"), TimeSpan.FromSeconds(5)));

            await s.Host(page);
            var before = await s.Select("0.0.0");
            var bad = await s.Select("0.0.1");
            var after = await s.Select("0.0.2");
            Check("BEH-S3 sibling before is real", before?.ElementType == "TextBlock", Bounds(before));
            Check("BEH-S4 throwing control replaced by a placeholder", bad != null && bad.ElementType != "ThrowingControl", Bounds(bad));
            Check("BEH-S5 sibling after is real", after?.ElementType == "TextBlock", Bounds(after));
            // Re-selecting the current element emits nothing, so read the props that came with S5's selection.
            var afterText = after == null ? null : FindProp(await s.PropsFor(after), "Text")?.Value;
            Check("BEH-S6 after reads its text", afterText == "after", afterText ?? "(null)");

            // A throwing control as the root content of a template-free page still yields a page.
            var lone = PageXaml("<fx:ThrowingControl/>");
            f = await s.NextFrame(() => { s.Client.ExitNative(); s.Client.LoadXaml(lone, 400, 300, 1.0); }, TimeSpan.FromSeconds(30));
            Check("BEH-S7 lone throwing control -> frame, not error", f != null, string.Join("; ", s.TakeErrors()));
        }

        // ---------------------------------------------------------------- design-time data failure paths

        private static string DtdPage(string dataContext, string body) =>
            "<Page " + BehNs + " d:DataContext=\"" + dataContext + "\" Width=\"400\" Height=\"300\">\n<StackPanel>\n" + body + "\n</StackPanel>\n</Page>";

        private static async Task DesignTimeDataNegatives(Session s)
        {
            await s.Host(DtdPage("{d:DesignInstance Type=fx:SampleViewModel, IsDesignTimeCreatable=True}",
                "<TextBlock Text=\"{Binding Title}\"/>\n<TextBlock Text=\"{Binding Owner.Name}\"/>\n<ItemsControl ItemsSource=\"{Binding People}\" DisplayMemberPath=\"Name\"/>"));
            Check("BEH-D1 DesignInstance: flat binding", await s.Read("0.0.0", "Text") == "Sample title");
            Check("BEH-D2 DesignInstance: nested path binding", await s.Read("0.0.1", "Text") == "Grace Hopper");
            var ic = await s.Select("0.0.2");
            Check("BEH-D3 DesignInstance: collection-bound ItemsControl has height", ic != null && ic.H > 0, Bounds(ic));

            await s.Rehost(DtdPage("{d:DesignInstance Type=fx:SampleViewModel, IsDesignTimeCreatable=True, CreateList=True}",
                "<ListView ItemsSource=\"{Binding}\" DisplayMemberPath=\"Title\" Height=\"150\"/>"));
            Check("BEH-D4 CreateList=True builds a list DataContext",
                await s.WaitLog(l => l.Contains("DTD: set design-time DataContext") && l.Contains("ObservableCollection"), TimeSpan.FromSeconds(5)));

            async Task Degrades(string code, string label, string dc, string logNeedle)
            {
                s.TakeErrors();
                var h = await s.Rehost(DtdPage(dc, "<TextBlock Text=\"{Binding Title}\"/>"));
                Check($"{code} {label}: page still hosts", h != null && h.Hwnd != 0);
                Check($"{code} {label}: bound text empty, no surface error",
                    string.IsNullOrEmpty(await s.Read("0.0.0", "Text")) && s.TakeErrors().Length == 0);
                Check($"{code} {label}: logged", await s.WaitLog(l => l.Contains(logNeedle), TimeSpan.FromSeconds(5)), logNeedle);
            }

            await Degrades("BEH-D5", "missing type", "{d:DesignInstance Type=fx:DoesNotExist, IsDesignTimeCreatable=True}", "not found in loaded assemblies");
            await Degrades("BEH-D6", "ctor throws", "{d:DesignInstance Type=fx:ThrowingViewModel, IsDesignTimeCreatable=True}", "ThrowingViewModel");
            await Degrades("BEH-D7", "no default ctor", "{d:DesignInstance Type=fx:NoDefaultCtorViewModel, IsDesignTimeCreatable=True}", "NoDefaultCtorViewModel");

            var dir = Path.Combine(Path.GetTempPath(), "wxp-beh-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            try
            {
                var malformed = Path.Combine(dir, "Malformed.xaml");
                File.WriteAllText(malformed, "<TextBlock xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" Text=\"x\"");
                await Degrades("BEH-D8", "malformed DesignData file", "{d:DesignData Source=" + malformed + "}", "DesignData parse failed");
                await Degrades("BEH-D9", "missing DesignData file", "{d:DesignData Source=" + Path.Combine(dir, "Gone.xaml") + "}", "could not be located");
            }
            finally
            {
                try { Directory.Delete(dir, true); } catch { }
            }

            await Degrades("BEH-D10", "unparseable extension", "{d:DesignInstance}", "DTD");
        }

        // ---------------------------------------------------------------- sample rows for every list kind

        private static async Task SampleLists(Session s)
        {
            var page = PageXaml(
                "<StackPanel>\n" +
                "  <ItemsControl ItemsSource=\"{x:Bind ViewModel.Tags}\"/>\n" +
                "  <GridView ItemsSource=\"{x:Bind ViewModel.Photos}\" Height=\"120\"/>\n" +
                "  <ComboBox ItemsSource=\"{x:Bind ViewModel.Modes}\"/>\n" +
                "  <ListView ItemsSource=\"{x:Bind ViewModel.Groups}\" Height=\"200\">\n" +
                "    <ListView.ItemTemplate><DataTemplate x:DataType=\"x:String\">\n" +
                "      <ItemsControl ItemsSource=\"{x:Bind Children}\"/>\n" +
                "    </DataTemplate></ListView.ItemTemplate>\n" +
                "  </ListView>\n" +
                "</StackPanel>", "Width=\"400\" Height=\"600\"");
            await s.Host(page);

            foreach (var (kind, n, label) in new[] { ("ItemsControl", 3, "Tags"), ("GridView", 3, "Photos"), ("ComboBox", 3, "Modes"), ("ListView", 3, "Groups") })
            {
                Check($"BEH-L {kind} bound by x:Bind gets {n} sample rows",
                    await s.WaitLog(l => l.Contains($"SAMPLE: filled {kind} with {n} placeholder row(s) for {{{label}}}"), TimeSpan.FromSeconds(6)), label);
            }

            Check("BEH-L nested list inside an item template gets 2 rows",
                await s.WaitLog(l => l.Contains("SAMPLE: filled ItemsControl with 2 placeholder row(s) for {Children}"), TimeSpan.FromSeconds(6)));
            Check("BEH-L no surface errors with sample lists", s.TakeErrors().Length == 0);

            // Sample data off: nothing is filled.
            while (s.Logs.TryDequeue(out _)) { }
            s.Client.SampleData = false;
            await s.Rehost(page);
            await Task.Delay(1500);
            Check("BEH-L sample data off: no lists filled", !s.Logs.Any(l => l.Contains("SAMPLE: filled")));
            s.Client.SampleData = true;
        }
    }
}
