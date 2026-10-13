#nullable enable

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using WinUIXamlPreview.Protocol;

namespace WinUIXamlPreview.UITest;

/// <summary>Behaviours lane, part 2: root element types, resource lookup order, App.xaml failure and never-settling pages.</summary>
internal static partial class Program
{
    private static string s_behSurface = "";
    private static string? s_behUserDll;

    private static string Root(string tag, string body = "<TextBlock Text=\"r\"/>", string attrs = "Width=\"200\" Height=\"100\"") =>
        "<" + tag + " " + BehNs + " " + attrs + ">\n" + body + "\n</" + tag + ">";

    // ---------------------------------------------------------------- root types

    private static async Task RootTypes(Session s)
    {
        var f = await s.NextFrame(() => s.Client.LoadXaml(PageXaml("<TextBlock Text=\"ok\"/>"), 400, 300, 1.0), TimeSpan.FromSeconds(30));
        Check("BEH-R0 baseline renders", f != null);

        foreach (var (code, xaml) in new[]
        {
            ("BEH-R1 UserControl root renders", Root("UserControl")),
            ("BEH-R2 bare Grid root renders", Root("Grid")),
            ("BEH-R3 Border root renders", Root("Border")),
            ("BEH-R4 compiled custom UserControl (fx:ProfileCard) root renders", "<fx:ProfileCard " + BehNs + " Width=\"200\" Height=\"100\"/>"),
            ("BEH-R5 control root (Button) renders", "<Button " + BehNs + " Content=\"b\"/>"),
            ("BEH-R6 leading comment naming a Window does not misclassify",
                "<!-- <Window> --><Page " + BehNs + " Width=\"200\" Height=\"100\"><TextBlock Text=\"c\"/></Page>"),
        })
        {
            var errs = s.TakeErrors();
            f = await s.NextFrame(() => s.Client.UpdateXaml(xaml), TimeSpan.FromSeconds(30));
            Check(code, f != null && s.TakeErrors().Length == 0, f == null ? "no Frame" : Dims(f));
        }

        foreach (var (code, xaml) in new[]
        {
            ("BEH-R7 ResourceDictionary root -> nonpage", "<ResourceDictionary " + BehNs + "><SolidColorBrush x:Key=\"B\" Color=\"Red\"/></ResourceDictionary>"),
            ("BEH-R8 Window root -> nonpage", Root("Window", "<Grid/>", "")),
            ("BEH-R9 Application root -> nonpage", Root("Application", "", "")),
            ("BEH-R10 project-template placeholder -> nonpage",
                "<Page x:Class=\"$safeprojectname$.MainPage\" " + BehNs + "><Grid/></Page>"),
        })
        {
            var e = await NextError(s, () => s.Client.UpdateXaml(xaml));
            Check(code, e?.Phase == "nonpage" && e.Line == null, Pos(e));
            s.TakeErrors(); // the expected non-page Error is also recorded as a surface error
        }

        f = await s.NextFrame(() => s.Client.UpdateXaml(PageXaml("<TextBlock Text=\"back\"/>")), TimeSpan.FromSeconds(30));
        Check("BEH-R11 page renders after non-page roots", f != null);

        // Native mode: the root itself is selectable and keeps its type.
        await s.Host(Root("UserControl", "<StackPanel><TextBlock Text=\"in\"/></StackPanel>"));
        var root = await s.Select("0");
        Check("BEH-R12 native UserControl root selectable as UserControl", root?.ElementType == "UserControl", Bounds(root));
        Check("BEH-R13 UserControl content path 0.0.0", (await s.Select("0.0.0"))?.ElementType == "TextBlock");
        var rErr = s.TakeErrors();
        Check("BEH-R14 no surface errors", rErr.Length == 0, string.Join("; ", rErr));
    }

    // ---------------------------------------------------------------- resources

    private static bool IsColor(string? v, string rgb) =>
        v != null && v.EndsWith(rgb, StringComparison.OrdinalIgnoreCase);

    private static async Task Resources(Session s)
    {
        // Paths (Page.Resources is not a visual child): 0.0 = StackPanel; its TextBlocks are 0.0.N.
        var page =
            "<Page " + BehNs + " Width=\"400\" Height=\"300\">\n" +
            "  <Page.Resources>\n" +
            "    <ResourceDictionary>\n" +
            "      <ResourceDictionary.MergedDictionaries>\n" +
            "        <ResourceDictionary><SolidColorBrush x:Key=\"K\" Color=\"#111111\"/><SolidColorBrush x:Key=\"M\" Color=\"#111111\"/></ResourceDictionary>\n" +
            "        <ResourceDictionary><SolidColorBrush x:Key=\"K\" Color=\"#222222\"/></ResourceDictionary>\n" +
            "      </ResourceDictionary.MergedDictionaries>\n" +
            "      <SolidColorBrush x:Key=\"M\" Color=\"#444444\"/>\n" +
            "      <SolidColorBrush x:Key=\"AppAccentBrush\" Color=\"#00AA00\"/>\n" +
            "    </ResourceDictionary>\n" +
            "  </Page.Resources>\n" +
            "  <StackPanel>\n" +
            "    <StackPanel.Resources><SolidColorBrush x:Key=\"M\" Color=\"#555555\"/></StackPanel.Resources>\n" +
            "    <TextBlock Text=\"0\" Foreground=\"{StaticResource K}\"/>\n" +              // later merged dict wins
            "    <TextBlock Text=\"1\" Foreground=\"{StaticResource M}\"/>\n" +              // nearest scope wins
            "    <TextBlock Text=\"2\" Foreground=\"{StaticResource AppAccentBrush}\"/>\n" + // page overrides App.xaml
            "    <TextBlock Text=\"3\" Foreground=\"{ThemeResource AppThemeBrush}\"/>\n" +   // App.xaml Light theme dict
            "    <Button Content=\"4\"/>\n" +                                                // App.xaml implicit style
            "    <Border Width=\"10\" Height=\"10\" Background=\"{StaticResource SystemAccentColor}\"/>\n" + // framework resource
            "  </StackPanel>\n" +
            "</Page>";
        await s.Host(page);
        Check("BEH-RS1 later merged dictionary wins", IsColor(await s.Read("0.0.0", "Foreground"), "222222"), await s.Read("0.0.0", "Foreground"));
        Check("BEH-RS2 element Resources beat page and merged", IsColor(await s.Read("0.0.1", "Foreground"), "555555"), await s.Read("0.0.1", "Foreground"));
        Check("BEH-RS3 page resource overrides App.xaml", IsColor(await s.Read("0.0.2", "Foreground"), "00AA00"), await s.Read("0.0.2", "Foreground"));
        Check("BEH-RS4 App.xaml Light ThemeDictionary resolves", IsColor(await s.Read("0.0.3", "Foreground"), "FFF3E0"), await s.Read("0.0.3", "Foreground"));
        Check("BEH-RS5 App.xaml implicit Button style applies", IsColor(await s.Read("0.0.4", "Background"), "00897B"), await s.Read("0.0.4", "Background"));
        Check("BEH-RS6 framework resource resolves (non-null brush)", (await s.Read("0.0.5", "Background")) is string bg && bg != "(none)", await s.Read("0.0.5", "Background"));

        // Without the page override, the App.xaml value comes through.
        await s.Rehost(PageXaml("<TextBlock Text=\"a\" Foreground=\"{StaticResource AppAccentBrush}\"/>"));
        Check("BEH-RS7 App.xaml resource used when not overridden", IsColor(await s.Read("0.0", "Foreground"), "D84315"), await s.Read("0.0", "Foreground"));

        // A missing StaticResource is dropped by cleaner rule 6: the element renders with its default value.
        var h = await s.Rehost(PageXaml("<StackPanel><TextBlock Text=\"m\" Foreground=\"{StaticResource NoSuchKey}\"/><TextBlock Text=\"n\"/></StackPanel>"));
        Check("BEH-RS8 missing StaticResource: page still renders", h != null && h.Hwnd != 0);
        Check("BEH-RS9 missing StaticResource: element kept, attribute dropped",
            await s.Read("0.0.0", "Text") == "m" && await s.Read("0.0.1", "Text") == "n");
        Check("BEH-RS10 no unexpected surface errors", s.TakeErrors().Length == 0);
    }

    // ---------------------------------------------------------------- App.xaml failure modes

    private static async Task AppXamlFailures(Session ignored)
    {
        var dir = Path.Combine(Path.GetTempPath(), "wxp-appx-" + Guid.NewGuid().ToString("N").Substring(0, 8));
        Directory.CreateDirectory(dir);
        try
        {
            var probe = PageXaml("<TextBlock Text=\"x\" Foreground=\"{ThemeResource SystemControlForegroundBaseHighBrush}\"/>");
            foreach (var (code, content, logNeedle) in new (string, string?, string?)[]
            {
                ("BEH-A1 malformed App.xaml", "<Application xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\"><Application.Resources>", "could not read App.xaml"),
                ("BEH-A2 App.xaml without Resources", "<Application xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\"/>", "no <Application.Resources>"),
                ("BEH-A3 App.xaml with a bad resource", "<Application xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\"><Application.Resources><ResourceDictionary><NoSuchType x:Key=\"k\"/></ResourceDictionary></Application.Resources></Application>", null),
                ("BEH-A4 App.xaml path missing", null, null),
            })
            {
                var path = Path.Combine(dir, code.Substring(4, 2) + ".xaml");
                if (content != null) File.WriteAllText(path, content);
                Console.WriteLine("-- " + code);
                using var s = await OpenWith(path);
                var f = await s.NextFrame(() => s.Client.LoadXaml(probe, 400, 300, 1.0), TimeSpan.FromSeconds(30));
                Check(code + ": page still renders", f != null, string.Join("; ", s.TakeErrors()));
                if (logNeedle != null)
                {
                    Check(code + ": logged", await s.WaitLog(l => l.Contains(logNeedle), TimeSpan.FromSeconds(5)), logNeedle);
                }
            }
        }
        finally
        {
            try { Directory.Delete(dir, true); } catch { }
        }
    }

    // App.xaml MergedDictionaries with Source=: the compiler's app-relative shorthand must be normalized to
    // ms-appx:/// before the design-time load, and when the full load fails the per-Source fallback must still
    // merge the dictionaries. Points at the fixture's compiled Themes\Styles.xaml (staged as ms-appx:///TestFixtureApp/…).
    private static async Task AppXamlMergedSources(Session ignored)
    {
        const string ns = "xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\"";
        static string App(string merged, string inline = "") =>
            $"<Application {ns}><Application.Resources><ResourceDictionary><ResourceDictionary.MergedDictionaries>{merged}</ResourceDictionary.MergedDictionaries>{inline}</ResourceDictionary></Application.Resources></Application>";

        var dir = Path.Combine(Path.GetTempPath(), "wxp-apps-" + Guid.NewGuid().ToString("N").Substring(0, 8));
        Directory.CreateDirectory(dir);
        try
        {
            var probe = PageXaml("<TextBlock Text=\"x\" Style=\"{StaticResource FixtureHeaderStyle}\"/>");
            foreach (var (code, content, needles) in new (string, string, string[])[]
            {
                ("BEH-A5 leading-slash Source", App("<ResourceDictionary Source=\"/TestFixtureApp/Themes/Styles.xaml\"/>"),
                    new[] { "Normalized 1 app-relative dictionary Source", "Merged app resource scope from App.xaml: 1 merged dict(s)" }),
                ("BEH-A6 bare relative Source", App("<ResourceDictionary Source=\"TestFixtureApp/Themes/Styles.xaml\"/>"),
                    new[] { "Normalized 1 app-relative dictionary Source", "Merged app resource scope from App.xaml: 1 merged dict(s)" }),
                ("BEH-A7 absolute ms-appx Source", App("<ResourceDictionary Source=\"ms-appx:///TestFixtureApp/Themes/Styles.xaml\"/>"),
                    new[] { "Merged app resource scope from App.xaml: 1 merged dict(s)" }),
                ("BEH-A8 full load fails → per-Source fallback", App("<ResourceDictionary Source=\"/TestFixtureApp/Themes/Styles.xaml\"/>", "<NoSuchType x:Key=\"k\"/>"),
                    new[] { "Falling back to per-Source merge", "Merged app dictionary (fallback): ms-appx:///TestFixtureApp/Themes/Styles.xaml" }),
            })
            {
                var path = Path.Combine(dir, code.Substring(4, 2) + ".xaml");
                File.WriteAllText(path, content);
                Console.WriteLine("-- " + code);
                using var s = await OpenWith(path);
                var f = await s.NextFrame(() => s.Client.LoadXaml(probe, 400, 300, 1.0), TimeSpan.FromSeconds(30));
                Check(code + ": page using a key from the Source dictionary renders", f != null, string.Join("; ", s.TakeErrors()));
                foreach (var needle in needles)
                {
                    Check(code + ": logged '" + needle + "'", await s.WaitLog(l => l.Contains(needle), TimeSpan.FromSeconds(5)), needle);
                }
            }
        }
        finally
        {
            try { Directory.Delete(dir, true); } catch { }
        }
    }

    private static Task<Session> OpenWith(string? appXaml) => Open(s_behSurface, s_behUserDll, appXaml);

    // ---------------------------------------------------------------- never-settling pages

    private const string ChurnPage =
        "<StackPanel>\n" +
        "  <Rectangle x:Name=\"Spin\" Width=\"40\" Height=\"40\" Fill=\"Teal\" RenderTransformOrigin=\"0.5,0.5\">\n" +
        "    <Rectangle.RenderTransform><RotateTransform/></Rectangle.RenderTransform>\n" +
        "    <Rectangle.Triggers><EventTrigger RoutedEvent=\"FrameworkElement.Loaded\"><BeginStoryboard><Storyboard RepeatBehavior=\"Forever\">\n" +
        "      <DoubleAnimation Storyboard.TargetName=\"Spin\" Storyboard.TargetProperty=\"(UIElement.RenderTransform).(RotateTransform.Angle)\" From=\"0\" To=\"360\" Duration=\"0:0:1\"/>\n" +
        "    </Storyboard></BeginStoryboard></EventTrigger></Rectangle.Triggers>\n" +
        "  </Rectangle>\n" +
        "  <fx:TickerControl/>\n" + // user code with a DispatcherTimer that never stops
        "  <ProgressRing IsActive=\"True\" Width=\"40\" Height=\"40\"/>\n" +
        "  <ProgressBar IsIndeterminate=\"True\" Width=\"100\"/>\n" +
        "</StackPanel>";

    private static async Task NeverSettlingPage(Session s)
    {
        var f = await s.NextFrame(() => s.Client.LoadXaml(PageXaml(ChurnPage), 400, 300, 1.0), TimeSpan.FromSeconds(30));
        Check("BEH-RT1 forever animation + running timer page renders", f != null, string.Join("; ", s.TakeErrors()));
        f = await s.NextFrame(() => s.Client.UpdateXaml(PageXaml(ChurnPage.Replace("Teal", "Navy"))), TimeSpan.FromSeconds(30));
        Check("BEH-RT2 re-render of a churning page still completes", f != null);
        Check("BEH-RT3 churning page: surface alive", await Alive(s));
    }

    // ---------------------------------------------------------------- malformed client payloads

    // The production client always sends well-typed messages, so wrongly typed fields go straight onto the
    // socket through its private Send (a JsonElement serializes as its raw JSON).
    private static readonly System.Reflection.MethodInfo s_send = typeof(SurfaceClient).GetMethod("Send",
        System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!;

    private static void SendRaw(Session s, string json)
    {
        using var doc = System.Text.Json.JsonDocument.Parse(json);
        s_send.Invoke(s.Client, new object[] { doc.RootElement.Clone() });
    }

    private static async Task<string?> NextError(Session s, Action send, TimeSpan timeout)
    {
        s.TakeErrors();
        send();
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            var e = s.TakeErrors();
            if (e.Length > 0) return e[0];
            await Task.Delay(50);
        }
        return null;
    }

    private static async Task MalformedPayloads(Session s)
    {
        await s.Host(PageXaml(EditPage));
        var btn = await s.Select("0.0.0");
        Check("BEH-M0 Button selectable", btn?.ElementType == "Button", Bounds(btn));
        if (btn == null) return;
        int id = btn.Id;
        var t5 = TimeSpan.FromSeconds(5);

        // SetProperty: every wrong shape is a clean parse error, never a "render" server error.
        foreach (var (code, json) in new[]
        {
            ("BEH-M1 SetProperty without id", "{\"type\":\"SetProperty\",\"name\":\"Width\",\"value\":\"50\"}"),
            ("BEH-M2 SetProperty string id", $"{{\"type\":\"SetProperty\",\"id\":\"{id}\",\"name\":\"Width\",\"value\":\"50\"}}"),
            ("BEH-M3 SetProperty fractional id", "{\"type\":\"SetProperty\",\"id\":1.5,\"name\":\"Width\",\"value\":\"50\"}"),
            ("BEH-M4 SetProperty negative id", "{\"type\":\"SetProperty\",\"id\":-3,\"name\":\"Width\",\"value\":\"50\"}"),
            ("BEH-M5 SetProperty numeric name", $"{{\"type\":\"SetProperty\",\"id\":{id},\"name\":5,\"value\":\"50\"}}"),
        })
        {
            var err = await NextError(s, () => SendRaw(s, json), t5);
            Check(code + ": parse error", err != null && err.StartsWith("parse:") && err.Contains("SetProperty requires"), err ?? "no error");
        }

        var unknown = await NextError(s, () => SendRaw(s, "{\"type\":\"SetProperty\",\"id\":987654,\"name\":\"Width\",\"value\":\"50\"}"), TimeSpan.FromSeconds(2));
        Check("BEH-M6 SetProperty on an unknown element: no error, logged", unknown == null &&
            await s.WaitLog(l => l.Contains("SetProperty #987654 Width did not apply"), t5), unknown ?? "");

        // PickAt: non-numeric coordinates are a parse error.
        var pick = await NextError(s, () => SendRaw(s, "{\"type\":\"PickAt\",\"x\":\"10\",\"y\":10}"), t5);
        Check("BEH-M7 PickAt string x: parse error", pick != null && pick.StartsWith("parse:") && pick.Contains("PickAt requires"), pick ?? "no error");

        // SelectByPath with a non-string path resolves nothing and reports nothing.
        var sel = await NextError(s, () => SendRaw(s, "{\"type\":\"SelectByPath\",\"path\":5}"), TimeSpan.FromSeconds(2));
        Check("BEH-M8 SelectByPath numeric path: no error, logged", sel == null &&
            await s.WaitLog(l => l.Contains("SelectByPath: path '' did not resolve"), t5), sel ?? "");

        // SetCanvasSize: wrong types, a missing side and non-positive sizes all mean "auto" and still re-host
        // at the page's auto board (same shape as before), never at the 375x667 the bad payload hinted at.
        var autoRoot = await s.Select("0");
        foreach (var (code, json) in new[]
        {
            ("BEH-M9 SetCanvasSize string width", "{\"type\":\"SetCanvasSize\",\"width\":\"375\",\"height\":667}"),
            ("BEH-M10 SetCanvasSize missing height", "{\"type\":\"SetCanvasSize\",\"width\":375}"),
            ("BEH-M11 SetCanvasSize negative", "{\"type\":\"SetCanvasSize\",\"width\":-375,\"height\":-667}"),
        })
        {
            var t = s.Box.NextHwnd(TimeSpan.FromSeconds(30));
            SendRaw(s, json);
            var re = await t;
            await Task.Delay(300);
            var root = await s.Select("0");
            Check(code + ": treated as auto (re-hosts at the auto board)", re != null && autoRoot != null &&
                Aspect(root, autoRoot.W, autoRoot.H) && !Aspect(root, 375, 667), Bounds(root) + " vs " + Bounds(autoRoot));
        }

        // sampleData with a non-boolean value is ignored; the document still re-hosts.
        foreach (var (code, raw) in new[] { ("BEH-M12 sampleData string", "\"yes\""), ("BEH-M13 sampleData null", "null") })
        {
            var t = s.Box.NextHwnd(TimeSpan.FromSeconds(30));
            var xaml = System.Text.Json.JsonSerializer.Serialize(PageXaml(EditPage));
            SendRaw(s, $"{{\"type\":\"UpdateXaml\",\"xaml\":{xaml},\"sampleData\":{raw}}}");
            Check(code + ": ignored, page re-hosts", await t != null, string.Join("; ", s.TakeErrors()));
        }

        // After all of that the connection is healthy: a real edit still applies.
        await Task.Delay(300);
        btn = await s.Select("0.0.0");
        var echo = btn == null ? null : await s.Set(btn.Id, "Width", "130");
        Check("BEH-M14 a valid edit still applies afterwards", FindProp(echo, "Width")?.Value == "130", FindProp(echo, "Width")?.Value ?? "(no echo)");
        Check("BEH-M15 client never faulted", !s.Client.IsFaulted);
    }
}
