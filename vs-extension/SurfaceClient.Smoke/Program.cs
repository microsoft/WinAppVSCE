#nullable enable

using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using WinUIXamlPreview.Protocol;

namespace WinUIXamlPreview.Smoke
{
    /// <summary>
    /// Headless contract test for the C# <see cref="SurfaceClient"/> port. Proves
    /// launch -> SURFACE_PORT -> connect -> Hello/Ready -> LoadXaml/Frame -> Error+recovery
    /// against the real Surface.exe, entirely outside Visual Studio. Analogous to the VS Code
    /// side's <c>surface-smoke.mjs</c>.
    /// </summary>
    internal static class Program
    {
        private const string FrameworkXaml =
            "<Page xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" " +
            "xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\" " +
            "Width=\"400\" Height=\"300\">" +
            "<StackPanel Padding=\"24\" Spacing=\"12\">" +
            "<TextBlock Text=\"VS smoke\" Style=\"{StaticResource TitleTextBlockStyle}\"/>" +
            "<Button Content=\"Click me\"/>" +
            "</StackPanel></Page>";

        private const string CustomXaml =
            "<Page xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" " +
            "xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\" " +
            "xmlns:local=\"using:TestUserApp\" Width=\"400\" Height=\"200\">" +
            "<local:FancyBadge Label=\"live custom\"/></Page>";

        private const string BadXaml =
            "<Page xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\">" +
            "<ThisControlDoesNotExist/></Page>";

        // Classic {Binding} page whose design-time DataContext is supplied by {d:DesignInstance}. The Surface
        // host reflectively constructs TestUserApp.DemoViewModel and assigns it as the root DataContext, so the
        // two bound TextBlocks resolve to the VM's sample values (§51 M1). Requires --user-dll TestUserApp.dll.
        private const string DesignDataXaml =
            "<Page xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" " +
            "xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\" " +
            "xmlns:d=\"http://schemas.microsoft.com/expression/blend/2008\" " +
            "xmlns:mc=\"http://schemas.openxmlformats.org/markup-compatibility/2006\" " +
            "xmlns:vm=\"using:TestUserApp\" mc:Ignorable=\"d\" " +
            "d:DataContext=\"{d:DesignInstance Type=vm:DemoViewModel, IsDesignTimeCreatable=True}\" " +
            "Width=\"400\" Height=\"300\">" +
            "<StackPanel Padding=\"24\" Spacing=\"8\">" +
            "<TextBlock Text=\"{Binding Title}\"/>" +
            "<TextBlock Text=\"{Binding Subtitle}\"/>" +
            "</StackPanel></Page>";

        // Classic {Binding} page whose design-time DataContext is supplied by {d:DesignData Source=...}. The
        // Surface host loads DesignData/DemoSample.xaml via XamlReader.Load (a framework TextBlock sample
        // object) and assigns it as the root DataContext, so {Binding Text} resolves to the sample string
        // baked into that file (§51 M1). The sample file is copied next to TestUserApp.dll by the csproj.
        private const string DesignDataSourceXaml =
            "<Page xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" " +
            "xmlns:d=\"http://schemas.microsoft.com/expression/blend/2008\" " +
            "xmlns:mc=\"http://schemas.openxmlformats.org/markup-compatibility/2006\" " +
            "mc:Ignorable=\"d\" " +
            "d:DataContext=\"{d:DesignData Source=DesignData/DemoSample.xaml}\" " +
            "Width=\"400\" Height=\"300\">" +
            "<StackPanel Padding=\"24\" Spacing=\"8\">" +
            "<TextBlock Text=\"{Binding Text}\"/>" +
            "</StackPanel></Page>";

        // Live-mode wrapper for the M2 DesignMode contract control. Only the root x:Class matters in live
        // mode: the Surface host regex-extracts x:Class, activates the REAL compiled TestUserApp control (its
        // ctor seeds the sample x:Bind data + app singleton under the design-mode signal and forces the
        // "Loaded" state), and mounts it — the body here is ignored. Requires --user-dll TestUserApp.dll and
        // liveMode:true (SURFACE_LIVE_MODE=1) so activation runs instead of the x:Bind-stripping parse path.
        private const string DesignModeContractXaml =
            "<UserControl x:Class=\"TestUserApp.DesignModeDemoControl\" " +
            "xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" " +
            "xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\" " +
            "Width=\"400\" Height=\"300\" />";

        // Live-mode wrapper for the M3 zero-config reflection-fallback control. Same activation shape as the
        // M2 control (only the root x:Class matters); the control itself seeds nothing, so any content is the
        // work of the opt-in reflection fallback (SURFACE_DTD_REFLECT=1). Requires --user-dll TestUserApp.dll.
        private const string ReflectionFallbackXaml =
            "<UserControl x:Class=\"TestUserApp.ReflectionFallbackDemoControl\" " +
            "xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" " +
            "xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\" " +
            "Width=\"400\" Height=\"300\" />";

        // Live-mode wrapper for the M3 hardening SKIP control (defect dtd-reflect-overreach). Its x:Bind
        // collection's element type declares a `required` member, so the hardened injector — even with the
        // fallback opted in — must find the host (lever a), recognise the non-constructible element type
        // (lever b), and cleanly SKIP it (no fill, no state force, no throw). Requires --user-dll TestUserApp.dll.
        private const string ReflectionSkipXaml =
            "<UserControl x:Class=\"TestUserApp.ReflectionSkipDemoControl\" " +
            "xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" " +
            "xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\" " +
            "Width=\"400\" Height=\"300\" />";

        // P1 non-page classification inputs. A ResourceDictionary root is a styles/themes/control-template
        // dictionary — it has no visual root and is not a designable page. The host must return a distinct
        // NonPage result (phase="nonpage", NotDesignable=true) with a reason, NOT a generic parse error, so
        // the designer shows a sensible note and the oracle stops counting it as a failure.
        private const string ResourceDictionaryXaml =
            "<ResourceDictionary xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" " +
            "xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\">" +
            "<SolidColorBrush x:Key=\"AccentBrush\" Color=\"#0078D4\" />" +
            "<x:Double x:Key=\"StdSpacing\">12</x:Double>" +
            "</ResourceDictionary>";

        // P1: a Window/WindowEx root is a window, not a designable page (the preview hosts Pages/UserControls
        // into its OWN window). idx0 MainWindow (WindowEx) is exactly this family.
        private const string WindowRootXaml =
            "<Window xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" " +
            "xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\">" +
            "<Grid><TextBlock Text=\"in a window\" /></Grid></Window>";

        // P1: a Visual Studio project-template stub — the $safeprojectname$ token is never a resolvable CLR
        // type (idx39 MainWindow = "$safeprojectname$.MainWindow"). Classify it as a non-page placeholder,
        // not a "type not found" error.
        private const string TemplatePlaceholderXaml =
            "<Window x:Class=\"$safeprojectname$.MainWindow\" " +
            "xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" " +
            "xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\">" +
            "<Grid /></Window>";

        // P2 live-mode wrapper for the App-init-recovery demo control. Its ctor derefs a null static app
        // singleton (DesignTimeApp.AppService) BEFORE InitializeComponent — the exact shape of the gallery
        // ctors (idx3/idx23) that NRE on App.ModelDownloadQueue. Live activation throws first, the host's
        // App-init recovery seeds the singleton and retries, and it renders. Requires --user-dll + liveMode.
        private const string AppSingletonRecoveryXaml =
            "<UserControl x:Class=\"TestUserApp.AppSingletonDemoControl\" " +
            "xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" " +
            "xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\" " +
            "Width=\"400\" Height=\"300\" />";

        private const string RenderSettleXaml =
            "<UserControl x:Class=\"TestUserApp.SettleDemoControl\" " +
            "xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" " +
            "xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\" " +
            "Width=\"400\" Height=\"300\" />";



        private static int _pass;
        private static int _fail;

        private static SurfaceClient CreateClient(string exe, string? dll, Action<string> log,
            string? appXaml = null, bool liveMode = false, bool reflectionFallback = false, bool renderSettle = false)
            => new SurfaceClient(exe, dll, log, appXaml, liveMode: liveMode,
                reflectionFallback: reflectionFallback, renderSettle: renderSettle,
                userPri: Environment.GetEnvironmentVariable("WINUI_SURFACE_USER_PRI"));

        private static async Task<int> Main(string[] args)
        {
            var repoRoot = FindRepoRoot();
            var surfaceExe = SurfaceResolver.Resolve(
                preferred: Environment.GetEnvironmentVariable("WINUI_SURFACE_EXE"),
                nearPath: repoRoot,
                log: s => Console.Error.WriteLine("  " + s));

            if (surfaceExe == null)
            {
                Console.Error.WriteLine("FATAL: could not resolve Surface.exe (set WINUI_SURFACE_EXE).");
                return 2;
            }

            Console.WriteLine($"Surface.exe: {surfaceExe}");

            var userDll = FindTestUserDll(repoRoot);
            Console.WriteLine($"TestUserApp.dll: {(userDll ?? "(not found — custom test skipped)")}");
            Console.WriteLine();

            await RunFrameworkClient(surfaceExe);
            await RunDesignEditClient(surfaceExe);
            await RunNonPageClient(surfaceExe);
            if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable("WINUI_SURFACE_USER_PRI")))
                await RunPriIsolationAsync(surfaceExe);
            if (userDll != null)
            {
                await RunCustomClient(surfaceExe, userDll);
                await RunDesignDataClient(surfaceExe, userDll);
                await RunDesignDataSourceClient(surfaceExe, userDll);
                await RunDesignModeContractClient(surfaceExe, userDll);
                await RunReflectionFallbackClient(surfaceExe, userDll);
                await RunReflectionSkipClient(surfaceExe, userDll);
                await RunAppInitRecoveryClient(surfaceExe, userDll);
                await RunRenderSettleClient(surfaceExe, userDll);
            }

            // Real-project path (opt-in): set WINUI_GALLERY_PAGE to a page .xaml inside a built WinUI app
            // (e.g. the WinUI Gallery's Samples\Button\ButtonPage.xaml). Proves the C# ProjectDllLocator
            // (FindUserDll + FindAppXaml) + SurfaceClient's --user-appxaml wiring render a real page.
            var galleryPage = Environment.GetEnvironmentVariable("WINUI_GALLERY_PAGE");
            if (!string.IsNullOrEmpty(galleryPage) && File.Exists(galleryPage))
            {
                await RunGalleryClient(surfaceExe, galleryPage!);
                await RunGalleryLiveClient(surfaceExe, galleryPage!);
            }

            Console.WriteLine();
            Console.WriteLine($"===== {_pass} passed, {_fail} failed =====");
            return _fail == 0 ? 0 : 1;
        }

        private static async Task RunPriIsolationAsync(string surfaceExe)
        {
            var source = Path.GetDirectoryName(surfaceExe)!;
            var before = WinUISurface.Shared.HostPayload.Hash(Path.Combine(source, "Surface.pri"));
            string? firstRun = null, secondRun = null;
            using (var first = CreateClient(surfaceExe, null, Console.Error.WriteLine))
            using (var second = CreateClient(surfaceExe, null, Console.Error.WriteLine))
            {
                var firstFrames = new FrameBox(first);
                var secondFrames = new FrameBox(second);
                await Task.WhenAll(first.StartAsync(TimeSpan.FromSeconds(30)), second.StartAsync(TimeSpan.FromSeconds(30)));
                var field = typeof(SurfaceClient).GetField("_privateRun", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!;
                firstRun = (string)field.GetValue(first);
                secondRun = (string)field.GetValue(second);
                Check("concurrent PRI clients have different private runs", firstRun != secondRun && firstRun != source && secondRun != source);
                first.LoadXaml(FrameworkXaml, 400, 300, 1);
                second.LoadXaml(FrameworkXaml, 400, 300, 1);
                var frames = await Task.WhenAll(firstFrames.NextFrame(TimeSpan.FromSeconds(20)), secondFrames.NextFrame(TimeSpan.FromSeconds(20)));
                Check("both private PRI clients render", frames[0] != null && frames[1] != null && IsPng(frames[0]!.Data) && IsPng(frames[1]!.Data));
                Check("actual --user-pri staged first run", WinUISurface.Shared.HostPayload.Hash(Path.Combine(firstRun, "Surface.pri")) ==
                    WinUISurface.Shared.HostPayload.Hash(Path.Combine(source, "Surface.designtime.pri")));
                Check("actual --user-pri staged second run", WinUISurface.Shared.HostPayload.Hash(Path.Combine(secondRun, "Surface.pri")) ==
                    WinUISurface.Shared.HostPayload.Hash(Path.Combine(source, "Surface.designtime.pri")));
            }
            Check("private run directories disposed", !Directory.Exists(firstRun) && !Directory.Exists(secondRun));
            Check("pristine input PRI unchanged after actual launches", WinUISurface.Shared.HostPayload.Hash(Path.Combine(source, "Surface.pri")) == before);
            WinUISurface.Shared.HostPayload.Validate(source);
            Check("all pristine input hashes unchanged", true);
        }

        private static async Task RunFrameworkClient(string surfaceExe)
        {
            Console.WriteLine("--- framework-only surface (no --user-dll) ---");
            using var client = CreateClient(surfaceExe, null, s => Console.Error.WriteLine("  " + s));
            var box = new FrameBox(client);

            var ready = await client.StartAsync(TimeSpan.FromSeconds(20));
            Check("Ready received", ready != null);
            Check("protocol == 1", ready!.Protocol == 1);
            Check("Ready advertises frame-stream", ready.Caps?.Contains("frame-stream") == true);
            Check("Ready advertises native-hwnd", ready.Caps?.Contains("native-hwnd") == true);
            Check("wasdk reported", !string.IsNullOrEmpty(ready.Wasdk));
            Console.WriteLine($"    wasdk = {ready.Wasdk}");

            client.LoadXaml(FrameworkXaml, 400, 300, 2.0);
            var frame = await box.NextFrame(TimeSpan.FromSeconds(20));
            Check("Frame received", frame != null);
            Check("format == png", frame!.Format == "png");
            Check("has dip dims", frame.DipWidth > 0 && frame.DipHeight > 0);
            Check("px >= dip (supersampled)", frame.Width >= frame.DipWidth && frame.Height >= frame.DipHeight);
            Check("data is PNG", IsPng(frame.Data));
            Console.WriteLine($"    frame {frame.Width}x{frame.Height}px @ {frame.DipWidth}x{frame.DipHeight}dip");

            client.LoadXaml(BadXaml, 400, 300, 1.0);
            var err = await box.NextError(TimeSpan.FromSeconds(20));
            Check("Error received for bad xaml", err != null);
            Check("error phase present", !string.IsNullOrEmpty(err!.Phase));
            Console.WriteLine($"    error phase={err.Phase} msg={Trunc(err.Message)}");

            client.LoadXaml(FrameworkXaml, 400, 300, 1.0);
            var recovered = await box.NextFrame(TimeSpan.FromSeconds(20));
            Check("recovered after error", recovered != null && IsPng(recovered.Data));
        }

        /// <summary>
        /// P1 (coverage hardening): non-page classification. Feeds the three non-designable root families the
        /// gallery corpus surfaces — a ResourceDictionary, a Window root, and a $safeprojectname$ VS template
        /// placeholder — and asserts each comes back as a DISTINCT structured NonPage result
        /// (phase="nonpage", NotDesignable=true, human-readable reason) rather than a generic error. Finally
        /// re-feeds a real page to prove the classification never touches a designable root (the certified
        /// default path is unaffected). Framework-only — classification is markup-driven, needs no --user-dll.
        /// </summary>
        private static async Task RunNonPageClient(string surfaceExe)
        {
            Console.WriteLine();
            Console.WriteLine("--- P1 non-page classification (ResourceDictionary / Window / template placeholder) ---");
            using var client = CreateClient(surfaceExe, null, s => Console.Error.WriteLine("  " + s));
            var box = new FrameBox(client);
            await client.StartAsync(TimeSpan.FromSeconds(20));

            // (1) ResourceDictionary root — no visual root; classify as a non-page, not a parse error.
            client.LoadXaml(ResourceDictionaryXaml, 400, 300, 1.0);
            var rd = await box.NextError(TimeSpan.FromSeconds(20));
            Check("RD: error received", rd != null);
            Check("RD: phase == nonpage", rd!.Phase == "nonpage");
            Check("RD: flagged NotDesignable", rd.NotDesignable);
            Check("RD: reason mentions ResourceDictionary", rd.Message?.Contains("ResourceDictionary") == true);
            Console.WriteLine($"    RD -> phase={rd.Phase} notDesignable={rd.NotDesignable} msg={Trunc(rd.Message)}");

            // (2) Window root — a window is not a designable page.
            client.LoadXaml(WindowRootXaml, 400, 300, 1.0);
            var win = await box.NextError(TimeSpan.FromSeconds(20));
            Check("Window: phase == nonpage", win!.Phase == "nonpage");
            Check("Window: flagged NotDesignable", win.NotDesignable);
            Check("Window: reason mentions Window", win.Message?.Contains("Window") == true);
            Console.WriteLine($"    Window -> phase={win.Phase} msg={Trunc(win.Message)}");

            // (3) $safeprojectname$ VS project-template placeholder — never a resolvable type.
            client.LoadXaml(TemplatePlaceholderXaml, 400, 300, 1.0);
            var tpl = await box.NextError(TimeSpan.FromSeconds(20));
            Check("Placeholder: phase == nonpage", tpl!.Phase == "nonpage");
            Check("Placeholder: reason mentions placeholder", tpl.Message?.Contains("placeholder") == true);
            Console.WriteLine($"    Placeholder -> phase={tpl.Phase} msg={Trunc(tpl.Message)}");

            // (4) a real page still renders — classification only fires on non-designable roots.
            client.LoadXaml(FrameworkXaml, 400, 300, 1.0);
            var frame = await box.NextFrame(TimeSpan.FromSeconds(20));
            Check("real page still renders after non-page inputs", frame != null && IsPng(frame.Data));
        }

        /// <summary>
        /// Proves the design-time selection + live property-edit round-trip (plan §41 Phase B/C) against the
        /// real surface, headlessly. Enters native mode (mounts the design surface), selects the TextBlock by
        /// its authored path, then edits its Text via SetProperty and asserts the echoed ElementProps carries
        /// the new value — i.e. the string was converted and applied to the live element.
        /// </summary>
        private static async Task RunDesignEditClient(string surfaceExe)
        {
            Console.WriteLine();
            Console.WriteLine("--- design-time selection + live property edit (SetProperty round-trip) ---");
            using var client = CreateClient(surfaceExe, null, s => Console.Error.WriteLine("  " + s));
            var box = new FrameBox(client);

            await client.StartAsync(TimeSpan.FromSeconds(20));

            // Native mode mounts the live design surface (SelectByPath/SetProperty only work there).
            var hwndTask = box.NextHwnd(TimeSpan.FromSeconds(20));
            client.EnterNative(FrameworkXaml, 400, 300, 1.0);
            var hwnd = await hwndTask;
            Check("EnterNative -> Hwnd", hwnd != null && hwnd.Hwnd != 0);
            client.SetMode(true); // design (select) mode

            // Select the TextBlock (authored path 0.0.0: page -> StackPanel -> child 0).
            var propsTask = box.NextProps(TimeSpan.FromSeconds(20));
            client.SelectByPath("0.0.0");
            var props = await propsTask;
            Check("SelectByPath -> ElementProps", props != null);
            var textRow = FindProp(props, "Text");
            Check("selected element has a Text property", textRow != null);
            Check("Text reads 'VS smoke'", textRow?.Value == "VS smoke");
            int id = props?.Id ?? -1;

            // Edit Text and assert the surface echoes the applied value.
            const string edited = "Edited by smoke";
            var editedTask = box.NextProps(TimeSpan.FromSeconds(20));
            client.SetProperty(id, "Text", edited);
            var after = await editedTask;
            Check("SetProperty -> ElementProps echo", after != null && after.Id == id);
            var editedRow = FindProp(after, "Text");
            Check("Text was applied to the live element", editedRow?.Value == edited);
            Console.WriteLine($"    Text: 'VS smoke' -> '{editedRow?.Value}'");

            // An enum property should expose Options (drives the panel dropdown). Visibility is on every element.
            var visRow = FindProp(after, "Visibility");
            Check("enum property carries dropdown Options", visRow?.Options != null && visRow.Options.Count >= 2);
        }

        private static PropItemMsg? FindProp(ElementPropsMsg? msg, string name)
        {
            if (msg?.Props == null)
            {
                return null;
            }

            foreach (var p in msg.Props)
            {
                if (string.Equals(p.Name, name, StringComparison.Ordinal))
                {
                    return p;
                }
            }

            return null;
        }

        private static async Task RunCustomClient(string surfaceExe, string userDll)
        {
            Console.WriteLine();
            Console.WriteLine("--- custom-control surface (--user-dll TestUserApp.dll) ---");
            using var client = CreateClient(surfaceExe, userDll, s => Console.Error.WriteLine("  " + s));
            var box = new FrameBox(client);

            await client.StartAsync(TimeSpan.FromSeconds(20));
            client.LoadXaml(CustomXaml, 400, 200, 2.0);
            var frame = await box.NextFrame(TimeSpan.FromSeconds(20));
            Check("custom-control Frame received", frame != null);
            Check("custom frame is PNG", frame != null && IsPng(frame.Data));
            if (frame != null)
            {
                Console.WriteLine($"    frame {frame.Width}x{frame.Height}px @ {frame.DipWidth}x{frame.DipHeight}dip");
            }
        }

        /// <summary>
        /// Proves §51 M1 design-time data end-to-end against the real surface: a classic <c>{Binding}</c> page
        /// whose <c>d:DataContext</c> is <c>{d:DesignInstance Type=vm:DemoViewModel, IsDesignTimeCreatable=True}</c>.
        /// The host reflectively constructs the VM and assigns it as the root DataContext, so the two bound
        /// TextBlocks must read the VM's sample values — read back deterministically via SelectByPath/ElementProps
        /// (the same mechanism the live property editor uses). Requires --user-dll TestUserApp.dll for the VM type.
        /// </summary>
        private static async Task RunDesignDataClient(string surfaceExe, string userDll)
        {
            Console.WriteLine();
            Console.WriteLine("--- design-time data ({d:DesignInstance} -> {Binding} sample data) ---");
            using var client = CreateClient(surfaceExe, userDll, s => Console.Error.WriteLine("  " + s));
            var box = new FrameBox(client);

            await client.StartAsync(TimeSpan.FromSeconds(20));

            // Native mode mounts the live design surface so SelectByPath can read back the resolved binding.
            var hwndTask = box.NextHwnd(TimeSpan.FromSeconds(20));
            client.EnterNative(DesignDataXaml, 400, 300, 1.0);
            var hwnd = await hwndTask;
            Check("design-data EnterNative -> Hwnd", hwnd != null && hwnd.Hwnd != 0);
            client.SetMode(true);

            // First bound TextBlock (page -> StackPanel -> child 0) must read the VM's sample Title — this is
            // the decisive proof that {Binding Title} resolved against the design-time DataContext.
            var titleTask = box.NextProps(TimeSpan.FromSeconds(20));
            client.SelectByPath("0.0.0");
            var titleProps = await titleTask;
            Check("design-data SelectByPath -> ElementProps", titleProps != null);
            var titleRow = FindProp(titleProps, "Text");
            Check("bound Title resolved to design-time sample", titleRow?.Value == "Design-time Title");
            Console.WriteLine($"    Title binding -> '{titleRow?.Value}'");

            // Second bound TextBlock (child 1) resolves Subtitle from the same design-time DataContext.
            var subTask = box.NextProps(TimeSpan.FromSeconds(20));
            client.SelectByPath("0.0.1");
            var subProps = await subTask;
            var subRow = FindProp(subProps, "Text");
            Check("bound Subtitle resolved to design-time sample", subRow?.Value == "Sample subtitle from DemoViewModel");
            Console.WriteLine($"    Subtitle binding -> '{subRow?.Value}'");
        }

        /// <summary>
        /// Design-time-data proof #2 (§51 M1): the page's design-time DataContext comes from a
        /// {d:DesignData Source=DesignData/DemoSample.xaml} document. The host resolves the file relative to
        /// the user assembly, loads it via XamlReader.Load into a framework sample object, and assigns it as
        /// the root DataContext, so {Binding Text} must read the sample string. This exercises the Source/file
        /// path of the feature (vs. the reflective DesignInstance path) with zero user-type dependency.
        /// </summary>
        private static async Task RunDesignDataSourceClient(string surfaceExe, string userDll)
        {
            Console.WriteLine();
            Console.WriteLine("--- design-time data ({d:DesignData Source} -> {Binding} sample data) ---");
            using var client = CreateClient(surfaceExe, userDll, s => Console.Error.WriteLine("  " + s));
            var box = new FrameBox(client);

            await client.StartAsync(TimeSpan.FromSeconds(20));

            var hwndTask = box.NextHwnd(TimeSpan.FromSeconds(20));
            client.EnterNative(DesignDataSourceXaml, 400, 300, 1.0);
            var hwnd = await hwndTask;
            Check("design-data-source EnterNative -> Hwnd", hwnd != null && hwnd.Hwnd != 0);
            client.SetMode(true);

            // The single bound TextBlock (page -> StackPanel -> child 0) must read the sample string loaded
            // from the DesignData source file — proof the file was located, parsed, and set as DataContext.
            var textTask = box.NextProps(TimeSpan.FromSeconds(20));
            client.SelectByPath("0.0.0");
            var textProps = await textTask;
            Check("design-data-source SelectByPath -> ElementProps", textProps != null);
            var row = FindProp(textProps, "Text");
            Check("bound Text resolved from DesignData source file", row?.Value == "Sample from d:DesignData");
            Console.WriteLine($"    Text binding -> '{row?.Value}'");
        }

        /// <summary>
        /// §51 M2 — the DesignMode sample-data contract for {x:Bind}. Launches the surface in LIVE mode so it
        /// activates the REAL compiled TestUserApp.DesignModeDemoControl. That control's ctor, seeing the
        /// surface's design-mode signal (WINUI_XAML_DESIGN_MODE=1), seeds a stand-in app singleton (crossing
        /// the construction gate that would otherwise NRE), fills its {x:Bind} sample collection (crossing the
        /// data gap XamlReader.Load cannot), and forces the "Loaded" visual state. Reading the three bound
        /// TextBlocks back proves all three: 0.0.0 = singleton-derived title, 0.0.1 = collection summary,
        /// 0.0.2 = forced visual-state text. Also asserts the live path actually engaged (LIVE-OK) and echoes
        /// the built-in DesignMode probe (the investigation of whether DesignModeEnabled is true in our host).
        /// </summary>
        private static async Task RunDesignModeContractClient(string surfaceExe, string userDll)
        {
            Console.WriteLine();
            Console.WriteLine("--- design-mode contract ({x:Bind} + app singleton, live-activated) ---");

            var log = new System.Text.StringBuilder();
            void Sink(string s) { lock (log) { log.AppendLine(s); } Console.Error.WriteLine("  " + s); }

            using var client = CreateClient(surfaceExe, userDll, Sink, null, liveMode: true);
            var box = new FrameBox(client);

            await client.StartAsync(TimeSpan.FromSeconds(20));

            var hwndTask = box.NextHwnd(TimeSpan.FromSeconds(20));
            client.EnterNative(DesignModeContractXaml, 400, 300, 1.0);
            var hwnd = await hwndTask;
            Check("design-mode-contract EnterNative -> Hwnd", hwnd != null && hwnd.Hwnd != 0);
            client.SetMode(true);

            // 0.0.0 (Title, {x:Bind}) — derived from the seeded app singleton's queue: proves the ctor's
            // singleton dereference succeeded under design mode (construction gate crossed).
            var titleTask = box.NextProps(TimeSpan.FromSeconds(20));
            client.SelectByPath("0.0.0");
            var titleProps = await titleTask;
            Check("design-mode-contract SelectByPath -> ElementProps", titleProps != null);
            var titleRow = FindProp(titleProps, "Text");
            Check("x:Bind Title from seeded singleton", titleRow?.Value == "2 models queued");
            Console.WriteLine($"    Title  (0.0.0) -> '{titleRow?.Value}'");

            // 0.0.1 (ItemsSummary, {x:Bind}) — summary of the sample collection: proves the x:Bind-backed
            // collection was filled under design mode (data gap crossed).
            var itemsTask = box.NextProps(TimeSpan.FromSeconds(20));
            client.SelectByPath("0.0.1");
            var itemsProps = await itemsTask;
            var itemsRow = FindProp(itemsProps, "Text");
            Check("x:Bind ItemsSummary from sample collection", itemsRow?.Value == "3 sample items");
            Console.WriteLine($"    Items  (0.0.1) -> '{itemsRow?.Value}'");

            // 0.0.2 (StatusText) — the forced "Populated" VisualState setter proves state forcing applied.
            var statusTask = box.NextProps(TimeSpan.FromSeconds(20));
            client.SelectByPath("0.0.2");
            var statusProps = await statusTask;
            var statusRow = FindProp(statusProps, "Text");
            Check("forced 'Populated' VisualState applied", statusRow?.Value == "Populated");
            Console.WriteLine($"    Status (0.0.2) -> '{statusRow?.Value}'");

            // The live path MUST have engaged (real compiled control activated), otherwise the x:Bind values
            // above could not exist (the parse path strips x:Bind). Guards against a silent parse-fallback.
            string captured; lock (log) { captured = log.ToString(); }
            Check("live activation engaged (LIVE-OK)", captured.Contains("LIVE-OK: activated TestUserApp.DesignModeDemoControl"));

            // Investigation echo (§51 M2): does the built-in WinRT DesignMode flag read true in our host?
            foreach (var line in captured.Split('\n'))
            {
                if (line.Contains("DesignMode probe:"))
                {
                    Console.WriteLine($"    investigation: {line.Trim()}");
                }
            }
        }

        // §51 M3 — opportunistic reflection fallback (opt-in). Two legs prove BOTH that the fallback lights up
        // a zero-config x:Bind page AND that it is strictly gated: with the opt-in OFF the injector must never
        // run (the certified default path stays untouched), with it ON the empty collection is filled and the
        // OneTime x:Bind count re-reads via the generated Bindings.Update().
        private static async Task RunReflectionFallbackClient(string surfaceExe, string userDll)
        {
            Console.WriteLine();
            Console.WriteLine("--- reflection fallback (opt-in x:Bind collection fill, live-activated) ---");

            async Task<(string? countText, bool sawLiveOk, bool sawInject, bool sawFill)> Run(bool reflectionFallback)
            {
                var log = new System.Text.StringBuilder();
                void Sink(string s) { lock (log) { log.AppendLine(s); } }

                using var client = CreateClient(surfaceExe, userDll, Sink, null, liveMode: true, reflectionFallback: reflectionFallback);
                var box = new FrameBox(client);
                await client.StartAsync(TimeSpan.FromSeconds(20));

                var hwndTask = box.NextHwnd(TimeSpan.FromSeconds(20));
                client.EnterNative(ReflectionFallbackXaml, 400, 300, 1.0);
                await hwndTask;
                client.SetMode(true);

                var propsTask = box.NextProps(TimeSpan.FromSeconds(20));
                client.SelectByPath("0.0.0");
                var props = await propsTask;
                var countText = FindProp(props, "Text")?.Value;

                await Task.Delay(200); // let the injector's DTD-INJECT diagnostic flush
                string captured; lock (log) { captured = log.ToString(); }
                return (countText,
                        captured.Contains("LIVE-OK: activated TestUserApp.ReflectionFallbackDemoControl"),
                        captured.Contains("DTD-INJECT"),
                        captured.Contains("collections+1"));
            }

            // Leg 1 — opt-in OFF: real control still activates, but the injector must stay dormant.
            var off = await Run(false);
            Check("fallback OFF: live activation engaged", off.sawLiveOk);
            Check("fallback OFF: injector did NOT run (gate respected)", !off.sawInject);
            Check("fallback OFF: empty x:Bind collection stays empty ('0 items')", off.countText == "0 items");
            Console.WriteLine($"    fallback OFF -> '{off.countText}'");

            // Leg 2 — opt-in ON: the injector fills the empty collection and Bindings.Update() re-reads the count.
            var on = await Run(true);
            Check("fallback ON: live activation engaged", on.sawLiveOk);
            Check("fallback ON: injector ran and filled a collection", on.sawInject && on.sawFill);
            Check("fallback ON: empty x:Bind collection filled ('3 items')", on.countText == "3 items");
            Console.WriteLine($"    fallback ON  -> '{on.countText}'");
        }

        /// <summary>
        /// M3 hardening SKIP test (defect dtd-reflect-overreach). With the fallback OPTED IN, activate a control
        /// whose empty x:Bind collection has a NON-cleanly-constructible element type (a `required` member).
        /// Lever (a) finds the empty items host in the live tree; lever (b) recognises the element type as
        /// non-constructible and the injector cleanly SKIPS the collection — no fabricate, no Bindings.Update,
        /// no VisualState force, no throw — so the count stays "0 items" and the host logs DTD-SKIP (not
        /// DTD-INJECT). This proves the scope/exclude levers host-independently, before the gallery re-cert.
        /// </summary>
        private static async Task RunReflectionSkipClient(string surfaceExe, string userDll)
        {
            Console.WriteLine();
            Console.WriteLine("--- reflection fallback SKIP (non-constructible element type is cleanly skipped) ---");

            var log = new System.Text.StringBuilder();
            void Sink(string s) { lock (log) { log.AppendLine(s); } }

            using var client = CreateClient(surfaceExe, userDll, Sink, null, liveMode: true, reflectionFallback: true);
            var box = new FrameBox(client);
            await client.StartAsync(TimeSpan.FromSeconds(20));

            var hwndTask = box.NextHwnd(TimeSpan.FromSeconds(20));
            client.EnterNative(ReflectionSkipXaml, 400, 300, 1.0);
            await hwndTask;
            client.SetMode(true);

            var propsTask = box.NextProps(TimeSpan.FromSeconds(20));
            client.SelectByPath("0.0.0");
            var props = await propsTask;
            var countText = FindProp(props, "Text")?.Value;

            await Task.Delay(200); // let the injector's DTD diagnostic flush
            string captured; lock (log) { captured = log.ToString(); }
            bool sawLiveOk = captured.Contains("LIVE-OK: activated TestUserApp.ReflectionSkipDemoControl");
            bool sawInject = captured.Contains("DTD-INJECT");
            bool sawSkip = captured.Contains("DTD-SKIP");

            // Opt-in is ON, but the non-constructible element type must be skipped: activation succeeds, the
            // injector logs a clean skip (DTD-SKIP, never DTD-INJECT), and the collection stays empty.
            Check("skip: live activation engaged", sawLiveOk);
            Check("skip: injector logged a clean skip (DTD-SKIP, not DTD-INJECT)", sawSkip && !sawInject);
            Check("skip: non-constructible collection left empty ('0 items')", countText == "0 items");
            Console.WriteLine($"    skip ON -> '{countText}'  (DTD-SKIP={sawSkip}, DTD-INJECT={sawInject})");
        }

        /// <summary>
        /// P2 (coverage hardening) — the ctor construction gate. Live-activates a control whose constructor
        /// dereferences a null static app singleton (the shape of gallery idx3 DownloadProgressList / idx23
        /// FoundryLocalPickerView, which NRE on App.ModelDownloadQueue). The first activation throws; the
        /// host's App-init recovery reflectively seeds the cleanly-constructible singleton
        /// (DesignTimeApp.AppService) and retries, and the control renders — the two TextBlocks (0.0.0 / 0.0.1)
        /// surface values read from the SEEDED instance, proving the gate is crossed via a real singleton.
        /// A second leg activates a control whose ctor never throws and asserts NO recovery fires — the
        /// certified happy/default path is completely untouched. Requires --user-dll + live mode.
        /// </summary>
        private static async Task RunAppInitRecoveryClient(string surfaceExe, string userDll)
        {
            Console.WriteLine();
            Console.WriteLine("--- P2 App-init recovery (ctor-throw on null app singleton -> seed + retry) ---");

            // Leg 1 — recovery path: the ctor derefs a null singleton, throws, is recovered, and renders.
            {
                var log = new System.Text.StringBuilder();
                void Sink(string s) { lock (log) { log.AppendLine(s); } }

                using var client = CreateClient(surfaceExe, userDll, Sink, null, liveMode: true);
                var box = new FrameBox(client);
                await client.StartAsync(TimeSpan.FromSeconds(20));

                var hwndTask = box.NextHwnd(TimeSpan.FromSeconds(20));
                client.EnterNative(AppSingletonRecoveryXaml, 400, 300, 1.0);
                await hwndTask;
                client.SetMode(true);

                // 0.0.0 (StatusText) reads DemoAppService.Status — only non-null if the singleton was seeded.
                var statusTask = box.NextProps(TimeSpan.FromSeconds(20));
                client.SelectByPath("0.0.0");
                var statusRow = FindProp(await statusTask, "Text");
                Check("P2 recovery: 0.0.0 read from seeded singleton", statusRow?.Value == "App singleton recovered");
                Console.WriteLine($"    Status (0.0.0) -> '{statusRow?.Value}'");

                // 0.0.1 (CountText) reflects the seeded instance's sample content (2 items).
                var countTask = box.NextProps(TimeSpan.FromSeconds(20));
                client.SelectByPath("0.0.1");
                var countRow = FindProp(await countTask, "Text");
                Check("P2 recovery: 0.0.1 reflects seeded singleton content", countRow?.Value == "2 items");
                Console.WriteLine($"    Count  (0.0.1) -> '{countRow?.Value}'");

                await Task.Delay(200); // let the recovery diagnostics flush
                string captured; lock (log) { captured = log.ToString(); }
                Check("P2 recovery: App-init recovery seeded the singleton",
                    captured.Contains("APP-INIT-RECOVER: seeded DesignTimeApp.AppService"));
                Check("P2 recovery: live re-activation engaged after seeding",
                    captured.Contains("LIVE-OK: activated TestUserApp.AppSingletonDemoControl"));
            }

            // Leg 2 — happy path: a control whose ctor never throws must NOT trigger recovery.
            {
                var log = new System.Text.StringBuilder();
                void Sink(string s) { lock (log) { log.AppendLine(s); } }

                using var client = CreateClient(surfaceExe, userDll, Sink, null, liveMode: true);
                var box = new FrameBox(client);
                await client.StartAsync(TimeSpan.FromSeconds(20));

                var hwndTask = box.NextHwnd(TimeSpan.FromSeconds(20));
                client.EnterNative(ReflectionFallbackXaml, 400, 300, 1.0);
                await hwndTask;
                client.SetMode(true);

                await Task.Delay(300); // allow activation + any (unexpected) recovery to log
                string captured; lock (log) { captured = log.ToString(); }
                Check("P2 happy path: live activation engaged",
                    captured.Contains("LIVE-OK: activated TestUserApp.ReflectionFallbackDemoControl"));
                Check("P2 happy path: NO App-init recovery (gate untouched)",
                    !captured.Contains("APP-INIT-RECOVER"));
            }
        }

        private static async Task RunRenderSettleClient(string surfaceExe, string userDll)
        {
            Console.WriteLine();
            Console.WriteLine("--- P3 render-settle (opt-in SURFACE_RENDER_SETTLE gate; default path untouched) ---");

            // Two legs on the same SettleDemoControl (a UserControl that starts an auto-advance DispatcherTimer
            // on Loaded), proving the opt-in gate: leg OFF must NOT run the sweep (no SETTLE token — the certified
            // default render path is byte-clean and the page still activates fine); leg ON must run it and stop
            // the churn timer. The gate is what keeps the sweep's tree-walk off already-OK pages by default.
            async Task<(bool framed, bool sawLiveOk, bool sawSettle, string settleLine)> Run(bool renderSettle)
            {
                var log = new System.Text.StringBuilder();
                void Sink(string s) { lock (log) { log.AppendLine(s); } }

                using var client = CreateClient(surfaceExe, userDll, Sink, null, liveMode: true, renderSettle: renderSettle);
                var box = new FrameBox(client);
                await client.StartAsync(TimeSpan.FromSeconds(20));

                var hwndTask = box.NextHwnd(TimeSpan.FromSeconds(20));
                client.EnterNative(RenderSettleXaml, 400, 300, 1.0);
                var hwnd = await hwndTask;
                client.SetMode(true);

                await Task.Delay(400); // allow activation + (when enabled) the render-settle sweep to run and log
                string captured; lock (log) { captured = log.ToString(); }

                string settleLine = "(none)";
                foreach (var line in captured.Split('\n'))
                {
                    if (line.Contains("SETTLE:")) { settleLine = line.Trim(); break; }
                }
                bool framed = hwnd != null && hwnd.Hwnd != 0;
                bool sawLiveOk = captured.Contains("LIVE-OK: activated TestUserApp.SettleDemoControl");
                bool sawSettle = captured.Contains("SETTLE: stopped") && captured.Contains("timer");
                return (framed, sawLiveOk, sawSettle, settleLine);
            }

            var off = await Run(renderSettle: false);
            Check("P3 settle: leg OFF -> Hwnd (page activates without the sweep)", off.framed);
            Check("P3 settle: leg OFF -> live activation engaged", off.sawLiveOk);
            Check("P3 settle: leg OFF -> NO settle sweep (default render path untouched)", !off.sawSettle);
            Console.WriteLine($"    leg OFF settle -> {off.settleLine}");

            var on = await Run(renderSettle: true);
            Check("P3 settle: leg ON -> Hwnd (page settled, did not hang)", on.framed);
            Check("P3 settle: leg ON -> live activation engaged", on.sawLiveOk);
            Check("P3 settle: leg ON -> render-settle stopped the churn timer", on.sawSettle);
            Console.WriteLine($"    leg ON  settle -> {on.settleLine}");
        }

        private static async Task RunGalleryClient(string surfaceExe, string pagePath)
        {
            Console.WriteLine();
            Console.WriteLine("--- real project page (FindUserDll + FindAppXaml + --user-appxaml) ---");
            Console.WriteLine($"    page: {pagePath}");

            var dll = ProjectDllLocator.FindUserDll(pagePath, s => Console.Error.WriteLine("  " + s));
            var appXaml = ProjectDllLocator.FindAppXaml(pagePath, s => Console.Error.WriteLine("  " + s));
            Check("user dll located", dll != null);
            Check("App.xaml located", appXaml != null);
            Console.WriteLine($"    dll:     {dll ?? "(none)"}");
            Console.WriteLine($"    appXaml: {appXaml ?? "(none)"}");

            var xaml = File.ReadAllText(pagePath);
            using var client = CreateClient(surfaceExe, dll, s => Console.Error.WriteLine("  " + s), appXaml);
            var box = new FrameBox(client);

            var ready = await client.StartAsync(TimeSpan.FromSeconds(30));
            Check("Ready received", ready != null);
            client.LoadXaml(xaml, 1200, 900, 1.0);
            var frame = await box.NextFrame(TimeSpan.FromSeconds(30));
            Check("gallery page Frame received", frame != null && IsPng(frame.Data));
            if (frame != null)
            {
                Console.WriteLine($"    frame {frame.Width}x{frame.Height}px @ {frame.DipWidth}x{frame.DipHeight}dip");
            }
        }

        /// <summary>
        /// Proves the live-mode flag on <see cref="SurfaceClient"/> (which sets SURFACE_LIVE_MODE on the
        /// child process env) actually flips the surface between the parse path and real-type activation
        /// (plan §39). Same page, two launches: liveMode:false must NOT log LIVE-OK; liveMode:true MUST log
        /// LIVE-OK (the real x:Class type was instantiated). Point WINUI_GALLERY_PAGE at a page whose x:Class
        /// type lives in the built DLL (e.g. the Gallery's ButtonPage.xaml).
        /// </summary>
        private static async Task RunGalleryLiveClient(string surfaceExe, string pagePath)
        {
            Console.WriteLine();
            Console.WriteLine("--- LIVE MODE: SurfaceClient liveMode flag flips real-type activation ---");

            var dll = ProjectDllLocator.FindUserDll(pagePath, _ => { });
            var appXaml = ProjectDllLocator.FindAppXaml(pagePath, _ => { });
            var xaml = File.ReadAllText(pagePath);

            async Task<(bool framed, bool sawLiveOk)> Run(bool liveMode)
            {
                var log = new System.Text.StringBuilder();
                void Sink(string s) { lock (log) { log.AppendLine(s); } }
                using var client = CreateClient(surfaceExe, dll, Sink, appXaml, liveMode);
                var box = new FrameBox(client);
                await client.StartAsync(TimeSpan.FromSeconds(30));
                client.LoadXaml(xaml, 1200, 900, 1.0);
                var frame = await box.NextFrame(TimeSpan.FromSeconds(30));
                await Task.Delay(300); // let stderr flush the LIVE-OK/-FALLBACK diagnostic
                string captured; lock (log) { captured = log.ToString(); }
                return (frame != null && IsPng(frame.Data), captured.Contains("LIVE-OK"));
            }

            var parse = await Run(false);
            Check("parse mode: frame received", parse.framed);
            Check("parse mode: NO real-type activation (no LIVE-OK)", !parse.sawLiveOk);

            var live = await Run(true);
            Check("live mode: frame received", live.framed);
            Check("live mode: real type activated (LIVE-OK)", live.sawLiveOk);
        }

        // ---- helpers --------------------------------------------------------

        private sealed class FrameBox
        {
            private TaskCompletionSource<FrameMsg>? _frame;
            private TaskCompletionSource<ErrorMsg>? _error;
            private TaskCompletionSource<HwndMsg>? _hwnd;
            private TaskCompletionSource<SelectedMsg>? _selected;
            private TaskCompletionSource<ElementPropsMsg>? _props;

            public FrameBox(SurfaceClient client)
            {
                client.Frame += f => _frame?.TrySetResult(f);
                client.Error += e => _error?.TrySetResult(e);
                client.Hwnd += h => _hwnd?.TrySetResult(h);
                client.Selected += s => _selected?.TrySetResult(s);
                client.ElementProps += p => _props?.TrySetResult(p);
            }

            public async Task<FrameMsg?> NextFrame(TimeSpan timeout)
            {
                _frame = new TaskCompletionSource<FrameMsg>(TaskCreationOptions.RunContinuationsAsynchronously);
                var done = await Task.WhenAny(_frame.Task, Task.Delay(timeout));
                return done == _frame.Task ? _frame.Task.Result : null;
            }

            public async Task<ErrorMsg?> NextError(TimeSpan timeout)
            {
                _error = new TaskCompletionSource<ErrorMsg>(TaskCreationOptions.RunContinuationsAsynchronously);
                var done = await Task.WhenAny(_error.Task, Task.Delay(timeout));
                return done == _error.Task ? _error.Task.Result : null;
            }

            public async Task<HwndMsg?> NextHwnd(TimeSpan timeout)
            {
                _hwnd = new TaskCompletionSource<HwndMsg>(TaskCreationOptions.RunContinuationsAsynchronously);
                var done = await Task.WhenAny(_hwnd.Task, Task.Delay(timeout));
                return done == _hwnd.Task ? _hwnd.Task.Result : null;
            }

            public async Task<SelectedMsg?> NextSelected(TimeSpan timeout)
            {
                _selected = new TaskCompletionSource<SelectedMsg>(TaskCreationOptions.RunContinuationsAsynchronously);
                var done = await Task.WhenAny(_selected.Task, Task.Delay(timeout));
                return done == _selected.Task ? _selected.Task.Result : null;
            }

            public async Task<ElementPropsMsg?> NextProps(TimeSpan timeout)
            {
                _props = new TaskCompletionSource<ElementPropsMsg>(TaskCreationOptions.RunContinuationsAsynchronously);
                var done = await Task.WhenAny(_props.Task, Task.Delay(timeout));
                return done == _props.Task ? _props.Task.Result : null;
            }
        }

        private static bool IsPng(string? base64)
        {
            if (string.IsNullOrEmpty(base64))
            {
                return false;
            }

            try
            {
                var bytes = Convert.FromBase64String(base64);
                return bytes.Length > 8 &&
                       bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47;
            }
            catch
            {
                return false;
            }
        }

        private static void Check(string name, bool ok)
        {
            if (ok)
            {
                _pass++;
                Console.WriteLine($"  PASS  {name}");
            }
            else
            {
                _fail++;
                Console.WriteLine($"  FAIL  {name}");
            }
        }

        private static string Trunc(string? s) =>
            string.IsNullOrEmpty(s) ? "" : (s!.Length > 80 ? s.Substring(0, 80) + "…" : s);

        private static string FindRepoRoot()
        {
            var dir = new DirectoryInfo(AppDomain.CurrentDomain.BaseDirectory);
            for (int i = 0; dir != null && i < 30; i++)
            {
                if (Directory.Exists(Path.Combine(dir.FullName, "surface")) &&
                    Directory.Exists(Path.Combine(dir.FullName, "vs-extension")))
                {
                    return dir.FullName;
                }

                dir = dir.Parent;
            }

            return Environment.CurrentDirectory;
        }

        private static string? FindTestUserDll(string repoRoot)
        {
            var root = Path.Combine(repoRoot, "surface", "TestUserApp", "bin");
            if (!Directory.Exists(root))
            {
                return null;
            }

            try
            {
                string? best = null;
                DateTime bestTime = DateTime.MinValue;
                foreach (var f in Directory.EnumerateFiles(root, "TestUserApp.dll", SearchOption.AllDirectories))
                {
                    var t = File.GetLastWriteTimeUtc(f);
                    if (t > bestTime)
                    {
                        bestTime = t;
                        best = f;
                    }
                }

                return best;
            }
            catch
            {
                return null;
            }
        }
    }
}
