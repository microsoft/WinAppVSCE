#nullable enable

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using WinUIXamlPreview.Protocol;

namespace WinUIXamlPreview.UITest;

/// <summary>Behaviours lane, part 2: root element types, resource lookup order, App.xaml failure and render settle.</summary>
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

    private static Task<Session> OpenWith(string? appXaml, bool renderSettle = false) => Open(s_behSurface, s_behUserDll, appXaml, renderSettle);

    // ---------------------------------------------------------------- render settle

    private const string ChurnPage =
        "<StackPanel>\n" +
        "  <Rectangle x:Name=\"Spin\" Width=\"40\" Height=\"40\" Fill=\"Teal\" RenderTransformOrigin=\"0.5,0.5\">\n" +
        "    <Rectangle.RenderTransform><RotateTransform/></Rectangle.RenderTransform>\n" +
        "    <Rectangle.Triggers><EventTrigger RoutedEvent=\"FrameworkElement.Loaded\"><BeginStoryboard><Storyboard RepeatBehavior=\"Forever\">\n" +
        "      <DoubleAnimation Storyboard.TargetName=\"Spin\" Storyboard.TargetProperty=\"(UIElement.RenderTransform).(RotateTransform.Angle)\" From=\"0\" To=\"360\" Duration=\"0:0:1\"/>\n" +
        "    </Storyboard></BeginStoryboard></EventTrigger></Rectangle.Triggers>\n" +
        "  </Rectangle>\n" +
        "  <fx:TickerControl/>\n" + // user code with a running DispatcherTimer: what the settle sweep stops
        "  <ProgressRing IsActive=\"True\" Width=\"40\" Height=\"40\"/>\n" +
        "  <ProgressBar IsIndeterminate=\"True\" Width=\"100\"/>\n" +
        "</StackPanel>";

    private static async Task RenderSettle(Session s)
    {
        var f = await s.NextFrame(() => s.Client.LoadXaml(PageXaml(ChurnPage), 400, 300, 1.0), TimeSpan.FromSeconds(30));
        Check("BEH-RT1 forever animation page renders (settle off)", f != null, string.Join("; ", s.TakeErrors()));
        f = await s.NextFrame(() => s.Client.UpdateXaml(PageXaml(ChurnPage.Replace("Teal", "Navy"))), TimeSpan.FromSeconds(30));
        Check("BEH-RT2 re-render of a churning page still completes", f != null);
        Check("BEH-RT3 settle sweep is off by default", !s.Logs.Any(l => l.Contains("SETTLE:")));

        // SurfaceClient owns SURFACE_RENDER_SETTLE (it always writes 1/0 into the child env), so opt in via the ctor.
        using var on = await OpenWith(null, renderSettle: true);
        f = await on.NextFrame(() => on.Client.LoadXaml(PageXaml(ChurnPage), 400, 300, 1.0), TimeSpan.FromSeconds(30));
        Check("BEH-RT4 forever animation page renders (settle on)", f != null, string.Join("; ", on.TakeErrors()));
        Check("BEH-RT5 settle sweep stopped the user DispatcherTimer",
            await on.WaitLog(l => l.Contains("SETTLE:") && !l.Contains("stopped 0 timer"), TimeSpan.FromSeconds(5)),
            on.Logs.FirstOrDefault(l => l.Contains("SETTLE:")) ?? "no SETTLE log");
        Check("BEH-RT6 settle on: surface alive", await Alive(on));
    }
}
