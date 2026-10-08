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


        private static int _pass;
        private static int _fail;

        private static SurfaceClient CreateClient(string exe, string? dll, Action<string> log,
            string? appXaml = null)
            => new SurfaceClient(exe, dll, log, appXaml,
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
            }

            // Real-project path (opt-in): set WINUI_GALLERY_PAGE to a page .xaml inside a built WinUI app
            // (e.g. the WinUI Gallery's Samples\Button\ButtonPage.xaml). Proves the C# ProjectDllLocator
            // (FindUserDll + FindAppXaml) + SurfaceClient's --user-appxaml wiring render a real page.
            var galleryPage = Environment.GetEnvironmentVariable("WINUI_GALLERY_PAGE");
            if (!string.IsNullOrEmpty(galleryPage) && File.Exists(galleryPage))
            {
                await RunGalleryClient(surfaceExe, galleryPage!);
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
