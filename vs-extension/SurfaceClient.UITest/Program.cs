#nullable enable

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using WinUIXamlPreview.Editor;
using WinUIXamlPreview.Protocol;

namespace WinUIXamlPreview.UITest
{
    internal static class Program
    {
        private static string DefaultSurfaceExe => throw new ArgumentException(
            "Specify --surface or WINUI_SURFACE_EXE pointing at a disposable migrated renderer copy.");
        private static string DefaultGalleryRoot => throw new ArgumentException(
            "This mode requires explicit --gallery-root or WINUI_GALLERY_ROOT. Gallery is not bundled.");
        private const string ExpectedCalendarPath = "0.0.0.0"; // Page -> StackPanel -> ControlExample -> CalendarView

        private static readonly List<TestResult> Results = new List<TestResult>();

        private static readonly string CalendarControlExampleXaml =
            "<Page\n" +
            "    xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\"\n" +
            "    xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\"\n" +
            "    xmlns:controls=\"using:WinUIGallery.Controls\"\n" +
            "    Width=\"900\" Height=\"700\">\n" +
            "    <StackPanel>\n" +
            "        <controls:ControlExample x:Name=\"ExampleAccessories\" SampleDefinition=\"CalendarView\\BasicCalendarView.txt\">\n" +
            "            <CalendarView\n" +
            "                x:Name=\"Control1\"\n" +
            "                VerticalAlignment=\"Top\"\n" +
            "                SelectionMode=\"Single\" />\n" +
            "            <controls:ControlExample.Options>\n" +
            "                <StackPanel Margin=\"0,-5,0,0\">\n" +
            "                    <CheckBox x:Name=\"isGroupLabelVisible\" Content=\"IsGroupLabelVisible\" IsChecked=\"True\" />\n" +
            "                </StackPanel>\n" +
            "            </controls:ControlExample.Options>\n" +
            "        </controls:ControlExample>\n" +
            "    </StackPanel>\n" +
            "</Page>";

        private static async Task<int> Main(string[] args)
        {
            if (args.Any(a => string.Equals(a, "--visible-host", StringComparison.OrdinalIgnoreCase)))
            {
                return await RunVisibleHost(args);
            }

            if (args.Any(a => string.Equals(a, "--p0", StringComparison.OrdinalIgnoreCase)))
            {
                return await RunP0(args);
            }

            if (args.Any(a => string.Equals(a, "--d2", StringComparison.OrdinalIgnoreCase)))
            {
                return RunD2(args);
            }

            if (args.Any(a => string.Equals(a, "--d2residual", StringComparison.OrdinalIgnoreCase)))
            {
                return RunD2Residual(args);
            }

            if (args.Any(a => string.Equals(a, "--d3", StringComparison.OrdinalIgnoreCase)))
            {
                return await RunD3(args);
            }

            string outDir = GetArg(args, "--out") ?? Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "qa-results");
            Directory.CreateDirectory(outDir);

            string surfaceExe = GetArg(args, "--surface") ?? Environment.GetEnvironmentVariable("WINUI_SURFACE_EXE") ?? DefaultSurfaceExe;
            string galleryRoot = GetArg(args, "--gallery-root") ?? Environment.GetEnvironmentVariable("WINUI_GALLERY_ROOT") ?? DefaultGalleryRoot;
            string? userDll = GetArg(args, "--user-dll") ?? Environment.GetEnvironmentVariable("WINUI_GALLERY_DLL") ?? FindGalleryDll(galleryRoot);
            string appXaml = GetArg(args, "--app-xaml") ?? Path.Combine(galleryRoot, "App.xaml");

            Console.WriteLine("Stage P protocol regression: v0.3.10 selection/inspection UX");
            Console.WriteLine("Surface.exe: " + surfaceExe);
            Console.WriteLine("Gallery DLL: " + (userDll ?? "(not found)"));
            Console.WriteLine("App.xaml:    " + appXaml);
            Console.WriteLine("Results dir: " + outDir);
            Console.WriteLine();

            Check("Surface.exe exists", File.Exists(surfaceExe), surfaceExe);
            Check("Gallery DLL exists", userDll != null && File.Exists(userDll), userDll ?? "missing");
            Check("Gallery App.xaml exists", File.Exists(appXaml), appXaml);

            string? sourceMapPath = null;
            var map = XamlSourceMap.Build(CalendarControlExampleXaml);
            int calendarOffset = CalendarControlExampleXaml.IndexOf("<CalendarView", StringComparison.Ordinal);
            if (map != null && calendarOffset >= 0)
            {
                sourceMapPath = map.PathForOffset(calendarOffset + 1);
            }

            Check("XamlSourceMap resolves CalendarView path", sourceMapPath == ExpectedCalendarPath, "expected " + ExpectedCalendarPath + ", actual " + (sourceMapPath ?? "(null)"));

            if (Results.Any(r => !r.Pass))
            {
                WriteResults(outDir);
                return 1;
            }

            using (var client = new SurfaceClient(surfaceExe, userDll, s => Console.Error.WriteLine("  " + s), appXaml))
            {
                var box = new FrameBox(client);
                ReadyMsg? ready = null;
                try
                {
                    ready = await client.StartAsync(TimeSpan.FromSeconds(30));
                }
                catch (Exception ex)
                {
                    Check("Surface Ready received", false, ex.Message);
                    WriteResults(outDir);
                    return 1;
                }

                Check("Ready protocol == 1", ready.Protocol == 1, "protocol=" + ready.Protocol);
                Check("Ready advertises native-hwnd", ready.Caps != null && ready.Caps.Contains("native-hwnd"), string.Join(",", ready.Caps ?? new List<string>()));

                var hwndTask = box.NextHwnd(TimeSpan.FromSeconds(40));
                client.EnterNative(CalendarControlExampleXaml, 900, 700, 1.0);
                var hwnd = await hwndTask;
                Check("EnterNative returns HWND", hwnd != null && hwnd.Hwnd != 0, hwnd?.Hwnd.ToString() ?? "null");

                client.SetMode(true);
                await Task.Delay(300);

                var selectedTask = box.NextSelected(TimeSpan.FromSeconds(40));
                var propsTask = box.NextProps(TimeSpan.FromSeconds(40));
                client.SelectByPath(ExpectedCalendarPath);
                var selected = await selectedTask;
                var props = await propsTask;

                Check("SelectByPath emits Selected", selected != null, "no Selected message");
                Check("SelectByPath emits ElementProps", props != null, "no ElementProps message");
                Check("Selected TypeName is CalendarView", selected?.ElementType == "CalendarView", "actual " + (selected?.ElementType ?? "null"));
                Check("Selected x:Name is Control1", selected?.Name == "Control1", "actual " + (selected?.Name ?? "null"));
                Check("Selected path round-trips", selected?.Path == ExpectedCalendarPath, "expected " + ExpectedCalendarPath + ", actual " + (selected?.Path ?? "null"));
                Check("Selected bounds are non-empty", selected != null && selected.W > 0 && selected.H > 0, selected == null ? "null" : $"{selected.W}x{selected.H}");

                Check("ElementProps includes inspectable rows", props?.Props != null && props.Props.Count > 20, "count=" + (props?.Props?.Count.ToString() ?? "null"));
                var nameProp = FindProp(props, "Name");
                Check("ElementProps Name is Control1", nameProp?.Value == "Control1", "actual " + (nameProp?.Value ?? "null"));
                var initialVisibility = FindProp(props, "Visibility");
                Check("Enum property carries dropdown options", initialVisibility?.Options != null && initialVisibility.Options.Contains("Collapsed"), initialVisibility?.Options == null ? "no options" : string.Join(",", initialVisibility.Options));

                File.WriteAllLines(Path.Combine(outDir, "stage-p-calendarview-props.txt"), (props?.Props ?? new List<PropItemMsg>()).Select(p => p.Name + "=" + p.Value));

                int selectedId = selected?.Id ?? props?.Id ?? -1;
                var editedPropsTask = box.NextProps(TimeSpan.FromSeconds(40));
                client.SetProperty(selectedId, "Width", "444");
                var edited = await editedPropsTask;
                var width = FindProp(edited, "Width");
                Check("SetProperty Width echoes ElementProps", edited != null && edited.Id == selectedId, edited == null ? "no ElementProps" : "id=" + edited.Id);
                Check("SetProperty Width applied", width?.Value == "444", "actual " + (width?.Value ?? "null"));

                var vis = FindProp(edited, "Visibility");
                Check("Visibility still has enum options after edit", vis?.Options != null && vis.Options.Count >= 2, vis?.Options == null ? "no options" : string.Join(",", vis.Options));
            }

            WriteResults(outDir);
            int failed = Results.Count(r => !r.Pass);
            Console.WriteLine();
            Console.WriteLine($"===== {Results.Count - failed} passed, {failed} failed =====");
            return failed == 0 ? 0 : 1;
        }

        // ---- Bug D1 P0 regression: explicit-wrapper content-property alignment --------------------------------
        //
        // Locks in the fix for the coverage gap that let D1 ship: a Gallery page that wraps its demo in the
        // EXPLICIT property-element form (<controls:ControlExample.Example> <Inner/> </>) must resolve to the
        // SAME authored-tree path on the client (XAML source map) and the surface (live tree). Before the fix
        // the client pruned <ControlExample.Example> (not in its 4-name allow-list) and stopped at
        // ControlExample, while the surface descended to the inner control — so selection sync silently no-op'd.
        private static readonly string SyntheticFooBarXaml =
            "<Page\n" +
            "    xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\"\n" +
            "    xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\">\n" +
            "    <Foo>\n" +
            "        <Foo.Bar>\n" +
            "            <Button x:Name=\"InnerButton\" />\n" +
            "        </Foo.Bar>\n" +
            "    </Foo>\n" +
            "</Page>";

        // Same shape as the Stage-P CalendarView page (Page -> StackPanel -> ControlExample -> inner), but the
        // inner control is wrapped in the EXPLICIT <controls:ControlExample.Example> property element — the case
        // D1 broke. Expected inner path is therefore identical: "0.0.0.0".
        private static readonly string ButtonControlExampleExplicitXaml =
            "<Page\n" +
            "    xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\"\n" +
            "    xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\"\n" +
            "    xmlns:controls=\"using:WinUIGallery.Controls\"\n" +
            "    Width=\"900\" Height=\"700\">\n" +
            "    <StackPanel>\n" +
            "        <controls:ControlExample x:Name=\"Example1\">\n" +
            "            <controls:ControlExample.Example>\n" +
            "                <Button x:Name=\"InnerButton\" Content=\"Hi\" />\n" +
            "            </controls:ControlExample.Example>\n" +
            "        </controls:ControlExample>\n" +
            "    </StackPanel>\n" +
            "</Page>";

        private const string ExpectedExplicitInnerPath = "0.0.0.0"; // Page -> StackPanel -> ControlExample -> Button

        private static async Task<int> RunP0(string[] args)
        {
            string outDir = GetArg(args, "--out") ?? Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "qa-results");
            Directory.CreateDirectory(outDir);

            string surfaceExe = GetArg(args, "--surface") ?? Environment.GetEnvironmentVariable("WINUI_SURFACE_EXE") ?? DefaultSurfaceExe;
            string galleryRoot = GetArg(args, "--gallery-root") ?? Environment.GetEnvironmentVariable("WINUI_GALLERY_ROOT") ?? DefaultGalleryRoot;
            string? userDll = GetArg(args, "--user-dll") ?? Environment.GetEnvironmentVariable("WINUI_GALLERY_DLL") ?? FindGalleryDll(galleryRoot);
            string appXaml = GetArg(args, "--app-xaml") ?? Path.Combine(galleryRoot, "App.xaml");

            Console.WriteLine("Bug D1 P0 regression: explicit-wrapper content-property alignment");
            Console.WriteLine("Surface.exe: " + surfaceExe);
            Console.WriteLine("Gallery DLL: " + (userDll ?? "(not found)"));
            Console.WriteLine();

            // ---- Part A: deterministic client unit test (no surface required) --------------------------------
            // A custom <Foo> whose content is the property element <Foo.Bar> wrapping a <Button>. With the map
            // {"Foo":"Bar"} the client must recurse into Foo.Bar and reach the Button at "0.0.0"; WITHOUT the map
            // the Button is pruned (unreachable) — proving the map is what unlocks the explicit-wrapper path.
            int fooButtonOffset = SyntheticFooBarXaml.IndexOf("<Button", StringComparison.Ordinal);
            var fooMap = new Dictionary<string, string> { { "Foo", "Bar" } };

            var withMap = XamlSourceMap.Build(SyntheticFooBarXaml, fooMap);
            string? pathWithMap = (withMap != null && fooButtonOffset >= 0) ? withMap.PathForOffset(fooButtonOffset + 1) : null;
            Check("A1 with map: Button resolves to 0.0.0", pathWithMap == "0.0.0", "actual " + (pathWithMap ?? "(null)"));
            Check("A2 with map: span exists for 0.0.0", withMap != null && withMap.TryGetSpan("0.0.0", out _, out _), "no span");

            var noMap = XamlSourceMap.Build(SyntheticFooBarXaml);
            string? pathNoMap = (noMap != null && fooButtonOffset >= 0) ? noMap.PathForOffset(fooButtonOffset + 1) : null;
            Check("A3 without map: Button NOT reachable (pruned to Foo 0.0)", pathNoMap != "0.0.0", "actual " + (pathNoMap ?? "(null)"));
            Check("A4 without map: no span for 0.0.0", noMap != null && !noMap.TryGetSpan("0.0.0", out _, out _), "unexpected span");

            // ---- Part B: end-to-end explicit-wrapper page against the live surface ----------------------------
            bool haveSurface = File.Exists(surfaceExe) && userDll != null && File.Exists(userDll) && File.Exists(appXaml);
            if (!haveSurface)
            {
                Check("B0 surface + gallery available for e2e", false, "surface/gallery inputs missing — e2e skipped");
            }
            else
            {
                try
                {
                    using var client = new SurfaceClient(surfaceExe, userDll, s => Console.Error.WriteLine("  " + s), appXaml);
                    var box = new FrameBox(client);
                    await client.StartAsync(TimeSpan.FromSeconds(30));

                    var hwndTask = box.NextHwnd(TimeSpan.FromSeconds(40));
                    var contentPropsTask = box.NextContentProps(TimeSpan.FromSeconds(40));
                    client.EnterNative(ButtonControlExampleExplicitXaml, 900, 700, 1.0);
                    var hwnd = await hwndTask;
                    var contentProps = await contentPropsTask;

                    Check("B1 EnterNative returns HWND", hwnd != null && hwnd.Hwnd != 0, hwnd?.Hwnd.ToString() ?? "null");
                    Check("B2 surface emits ContentProps", contentProps != null, contentProps == null ? "no ContentProps message" : "ok");
                    bool hasCe = contentProps?.Map != null && contentProps.Map.TryGetValue("ControlExample", out var ceProp) && ceProp == "Example";
                    Check("B3 ContentProps maps ControlExample->Example", hasCe,
                        contentProps?.Map == null ? "null map" : string.Join(",", contentProps.Map.Select(kv => kv.Key + "->" + kv.Value)));

                    // Client half: build the source map with the SURFACE-COLLECTED map and resolve the Button.
                    var surfaceCollected = contentProps?.Map;
                    int btnOffset = ButtonControlExampleExplicitXaml.IndexOf("<Button", StringComparison.Ordinal);
                    var clientMapWith = XamlSourceMap.Build(ButtonControlExampleExplicitXaml, surfaceCollected);
                    string? clientPath = (clientMapWith != null && btnOffset >= 0) ? clientMapWith.PathForOffset(btnOffset + 1) : null;
                    Check("B4 client resolves Button to " + ExpectedExplicitInnerPath + " (with surface map)",
                        clientPath == ExpectedExplicitInnerPath, "actual " + (clientPath ?? "(null)"));

                    var clientMapNo = XamlSourceMap.Build(ButtonControlExampleExplicitXaml);
                    string? clientPathNoMap = (clientMapNo != null && btnOffset >= 0) ? clientMapNo.PathForOffset(btnOffset + 1) : null;
                    Check("B5 client WITHOUT map does NOT reach " + ExpectedExplicitInnerPath + " (regression cause)",
                        clientPathNoMap != ExpectedExplicitInnerPath, "actual " + (clientPathNoMap ?? "(null)"));

                    // Surface half: select that client-derived path; the surface must resolve the same Button.
                    client.SetMode(true);
                    await Task.Delay(300);
                    var selectedTask = box.NextSelected(TimeSpan.FromSeconds(40));
                    client.SelectByPath(clientPath ?? ExpectedExplicitInnerPath);
                    var selected = await selectedTask;

                    Check("B6 SelectByPath emits Selected", selected != null, selected == null ? "no Selected" : "ok");
                    Check("B7 surface Selected.ElementType is Button", selected?.ElementType == "Button", "actual " + (selected?.ElementType ?? "null"));
                    Check("B8 surface Selected.Name is InnerButton", selected?.Name == "InnerButton", "actual " + (selected?.Name ?? "null"));
                    Check("B9 client path == surface path (" + ExpectedExplicitInnerPath + ")",
                        selected?.Path == clientPath && selected?.Path == ExpectedExplicitInnerPath,
                        "client=" + (clientPath ?? "null") + " surface=" + (selected?.Path ?? "null"));
                }
                catch (Exception ex)
                {
                    Check("B* e2e ran without exception", false, ex.Message);
                }
            }

            WriteResults(outDir, "p0-results.json");
            int failed = Results.Count(r => !r.Pass);
            Console.WriteLine();
            Console.WriteLine($"===== P0: {Results.Count - failed} passed, {failed} failed =====");
            return failed == 0 ? 0 : 1;
        }

        // ---- Bug D2 regression: non-FrameworkElement inline/primitive items must not shift sibling indices ----
        //
        // The surface's DesignSurface.AuthoredChildren is FE-only; the client's XamlSourceMap.AuthoredChildElements
        // now prunes the SAME non-FrameworkElements (XAML language primitives like <x:String>, text/inline
        // TextElements like <Run>) so both sides assign identical child indices. This page mixes a TextBlock with
        // inline <Run>s and a ComboBox whose first item is a non-FE <x:String> placed BEFORE a real
        // <ComboBoxItem>; post-fix the ComboBoxItem must resolve to child index 0 (path 0.0.1.0, NOT 0.0.1.1),
        // its span (designer->editor) must point at <ComboBoxItem> not <x:String>, and the trailing <Button> must
        // stay at 0.0.2. Pure client-side — no surface required (safe for the implementer to author under the
        // "Red-team is sole Surface runner" policy; Red-team executes it).
        private static readonly string D2InlineAndPrimitiveXaml =
            "<Page\n" +
            "    xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\"\n" +
            "    xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\">\n" +
            "    <StackPanel>\n" +
            "        <TextBlock><Run Text=\"Hello \" /><Run Text=\"World\" /></TextBlock>\n" +
            "        <ComboBox>\n" +
            "            <x:String>Alpha</x:String>\n" +
            "            <ComboBoxItem Content=\"Bravo\" />\n" +
            "        </ComboBox>\n" +
            "        <Button Content=\"After\" />\n" +
            "    </StackPanel>\n" +
            "</Page>";

        private static int RunD2(string[] args)
        {
            string outDir = GetArg(args, "--out") ?? Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "qa-results");
            Directory.CreateDirectory(outDir);

            Console.WriteLine("Bug D2 regression: non-FE inline/primitive items must not shift sibling indices");
            Console.WriteLine("(pure client-side XamlSourceMap test — no surface required)");
            Console.WriteLine();

            var map = XamlSourceMap.Build(D2InlineAndPrimitiveXaml);
            Check("D2-0 source map builds", map != null, map == null ? "null map" : "ok");
            if (map == null)
            {
                WriteResults(outDir, "d2-results.json");
                Console.WriteLine();
                Console.WriteLine("===== D2: 0 passed, 1 failed =====");
                return 1;
            }

            int textBlockOffset = D2InlineAndPrimitiveXaml.IndexOf("<TextBlock", StringComparison.Ordinal);
            int comboBoxOffset = D2InlineAndPrimitiveXaml.IndexOf("<ComboBox>", StringComparison.Ordinal);
            int comboItemOffset = D2InlineAndPrimitiveXaml.IndexOf("<ComboBoxItem", StringComparison.Ordinal);
            int alphaOffset = D2InlineAndPrimitiveXaml.IndexOf("Alpha", StringComparison.Ordinal);
            int buttonOffset = D2InlineAndPrimitiveXaml.IndexOf("<Button", StringComparison.Ordinal);

            // editor -> designer (caret offset -> authored path)
            string? tbPath = map.PathForOffset(textBlockOffset + 1);
            Check("D2-1 TextBlock resolves to 0.0.0", tbPath == "0.0.0", "actual " + (tbPath ?? "(null)"));

            string? cbPath = map.PathForOffset(comboBoxOffset + 1);
            Check("D2-2 ComboBox resolves to 0.0.1", cbPath == "0.0.1", "actual " + (cbPath ?? "(null)"));

            string? itemPath = map.PathForOffset(comboItemOffset + 1);
            Check("D2-3 ComboBoxItem resolves to 0.0.1.0 (x:String NOT counted)", itemPath == "0.0.1.0", "actual " + (itemPath ?? "(null)"));

            string? btnPath = map.PathForOffset(buttonOffset + 1);
            Check("D2-4 trailing Button stays 0.0.2", btnPath == "0.0.2", "actual " + (btnPath ?? "(null)"));

            string? alphaPath = map.PathForOffset(alphaOffset);
            Check("D2-5 caret inside <x:String> maps to container ComboBox 0.0.1 (not a child)", alphaPath == "0.0.1", "actual " + (alphaPath ?? "(null)"));

            // designer -> editor (authored path -> span): the SAME element resolves both directions
            bool haveItemSpan = map.TryGetSpan("0.0.1.0", out int itemStart, out int itemEnd);
            Check("D2-6 span exists for ComboBoxItem 0.0.1.0", haveItemSpan, haveItemSpan ? $"[{itemStart},{itemEnd})" : "no span");
            Check("D2-7 ComboBoxItem span starts at <ComboBoxItem>, not <x:String>", haveItemSpan && itemStart == comboItemOffset, $"start={itemStart} expected={comboItemOffset}");

            // anti-regression: pruned non-FE items create no phantom sibling paths (they would if reverted)
            Check("D2-8 Runs pruned: no phantom TextBlock child at 0.0.0.0", !map.TryGetSpan("0.0.0.0", out _, out _), "unexpected span");
            Check("D2-9 x:String pruned: no phantom ComboBox child at 0.0.1.1", !map.TryGetSpan("0.0.1.1", out _, out _), "unexpected span");

            WriteResults(outDir, "d2-results.json");
            int failed = Results.Count(r => !r.Pass);
            Console.WriteLine();
            Console.WriteLine($"===== D2: {Results.Count - failed} passed, {failed} failed =====");
            return failed == 0 ? 0 : 1;
        }

        // ---- Bug d2-sysstring-residual regression: System CLR-namespace primitives must not shift indices ----
        //
        // Follow-up to D2. XamlSourceMap.IsNonFrameworkElement originally pruned only the x: language namespace
        // and presentation-namespace text/inline names. A .NET primitive authored via a CLR namespace — e.g.
        // xmlns:sys="using:System" then <sys:String> — has namespace "using:System", hitting NEITHER branch, so
        // the client wrongly COUNTED it while the surface (System.String is not a FrameworkElement) pruned it,
        // reskewing sibling indices (same symptom class as D2). The fix also prunes SystemPrimitiveNames in the
        // System CLR namespace. Here <sys:String> sits before a real <ComboBoxItem> (StackPanel is the design
        // root, so ComboBox == 0.0): post-fix the ComboBoxItem is ComboBox child index 0 (path 0.0.0), its span
        // (designer->editor) points at <ComboBoxItem> not <sys:String>, and no phantom 0.0.1 sibling exists.
        // Pure client-side — no surface required (Red-team executes it).
        private static readonly string D2ResidualSysStringXaml =
            "<StackPanel\n" +
            "    xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\"\n" +
            "    xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\"\n" +
            "    xmlns:sys=\"using:System\">\n" +
            "    <ComboBox>\n" +
            "        <sys:String>Alpha</sys:String>\n" +
            "        <ComboBoxItem Content=\"Bravo\" />\n" +
            "    </ComboBox>\n" +
            "</StackPanel>";

        private static int RunD2Residual(string[] args)
        {
            string outDir = GetArg(args, "--out") ?? Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "qa-results");
            Directory.CreateDirectory(outDir);

            Console.WriteLine("Bug d2-sysstring-residual regression: System CLR-namespace primitives must not shift sibling indices");
            Console.WriteLine("(pure client-side XamlSourceMap test — no surface required)");
            Console.WriteLine();

            var map = XamlSourceMap.Build(D2ResidualSysStringXaml);
            Check("D2R-0 source map builds", map != null, map == null ? "null map" : "ok");
            if (map == null)
            {
                WriteResults(outDir, "d2residual-results.json");
                Console.WriteLine();
                Console.WriteLine("===== D2R: 0 passed, 1 failed =====");
                return 1;
            }

            int comboItemOffset = D2ResidualSysStringXaml.IndexOf("<ComboBoxItem", StringComparison.Ordinal);
            int alphaOffset = D2ResidualSysStringXaml.IndexOf("Alpha", StringComparison.Ordinal);

            // editor -> designer: <sys:String> is pruned, so <ComboBoxItem> is ComboBox child index 0 (0.0.0)
            string? itemPath = map.PathForOffset(comboItemOffset + 1);
            Check("D2R-1 ComboBoxItem resolves to 0.0.0 (sys:String NOT counted)", itemPath == "0.0.0", "actual " + (itemPath ?? "(null)"));

            // designer -> editor: the 0.0.0 span points at <ComboBoxItem>, not <sys:String>
            bool haveItemSpan = map.TryGetSpan("0.0.0", out int itemStart, out int itemEnd);
            Check("D2R-2 ComboBoxItem span 0.0.0 starts at <ComboBoxItem>, not <sys:String>", haveItemSpan && itemStart == comboItemOffset, haveItemSpan ? $"start={itemStart} expected={comboItemOffset}" : "no span");

            // anti-regression: the pruned sys:String creates no phantom sibling path
            Check("D2R-3 sys:String pruned: no phantom ComboBox child at 0.0.1", !map.TryGetSpan("0.0.1", out _, out _), "unexpected span");

            // caret inside <sys:String> maps to the container ComboBox 0.0 (the primitive is not a child)
            string? alphaPath = map.PathForOffset(alphaOffset);
            Check("D2R-4 caret inside <sys:String> maps to container ComboBox 0.0 (not a child)", alphaPath == "0.0", "actual " + (alphaPath ?? "(null)"));

            WriteResults(outDir, "d2residual-results.json");
            int failed = Results.Count(r => !r.Pass);
            Console.WriteLine();
            Console.WriteLine($"===== D2R: {Results.Count - failed} passed, {failed} failed =====");
            return failed == 0 ? 0 : 1;
        }

        // ---- Bug D3 regression: leaf-first pick must include transparent (no-Background) authored panels ------
        //
        // AuthoredChain used the 2-arg VisualTreeHelper.FindElementsInHostCoordinates, which returns only
        // hit-testable elements. A Panel with no Background is not hit-testable over its own padding, so a click
        // in a transparent StackPanel/Grid's padding skipped the panel and selected an opaque ancestor (or, when
        // the panel is the design root, nothing). The fix passes includeAllElements: true (+ a Visibility guard),
        // so the panel is returned by bounds. This test drives the surface headlessly via the TEST-ONLY PickAt
        // hook: it reads each element's reported bounds (adorner/artboard space == pick space) to compute
        // deterministic pick points, then asserts point -> element without synthesizing real pointer input.
        // Requires a live Surface.exe (Red-team is the sole surface runner; the implementer only compiles it).
        private static readonly string D3TransparentPanelXaml =
            "<Grid\n" +
            "    xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\"\n" +
            "    xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\"\n" +
            "    Background=\"White\">\n" +
            "    <StackPanel Padding=\"40\">\n" +
            "        <Button Content=\"Click me\" />\n" +
            "    </StackPanel>\n" +
            "</Grid>";

        private static readonly string D3RootTransparentXaml =
            "<StackPanel\n" +
            "    xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\"\n" +
            "    xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\"\n" +
            "    Padding=\"40\">\n" +
            "    <Button Content=\"Click me\" />\n" +
            "</StackPanel>";

        private static async Task<int> RunD3(string[] args)
        {
            string outDir = GetArg(args, "--out") ?? Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "qa-results");
            Directory.CreateDirectory(outDir);

            string surfaceExe = GetArg(args, "--surface") ?? Environment.GetEnvironmentVariable("WINUI_SURFACE_EXE") ?? DefaultSurfaceExe;
            string galleryRoot = GetArg(args, "--gallery-root") ?? Environment.GetEnvironmentVariable("WINUI_GALLERY_ROOT") ?? DefaultGalleryRoot;
            string? userDll = GetArg(args, "--user-dll") ?? Environment.GetEnvironmentVariable("WINUI_GALLERY_DLL") ?? FindGalleryDll(galleryRoot);
            string appXaml = GetArg(args, "--app-xaml") ?? Path.Combine(galleryRoot, "App.xaml");

            Console.WriteLine("Bug D3 regression: leaf-first pick must include transparent (no-Background) authored panels");
            Console.WriteLine("Surface.exe: " + surfaceExe);
            Console.WriteLine("Gallery DLL: " + (userDll ?? "(not found)"));
            Console.WriteLine();

            bool haveSurface = File.Exists(surfaceExe) && userDll != null && File.Exists(userDll) && File.Exists(appXaml);
            if (!haveSurface)
            {
                Check("D3-0 surface + gallery available for e2e", false, "surface/gallery inputs missing — D3 needs a live surface");
                WriteResults(outDir, "d3-results.json");
                Console.WriteLine();
                Console.WriteLine("===== D3: 0 passed, 1 failed =====");
                return 1;
            }

            try
            {
                using var client = new SurfaceClient(surfaceExe, userDll, s => Console.Error.WriteLine("  " + s), appXaml);
                var box = new FrameBox(client);
                await client.StartAsync(TimeSpan.FromSeconds(30));

                // ---- Scenario 1: transparent StackPanel (Padding=40) over an opaque white Grid --------------
                var hwndTask = box.NextHwnd(TimeSpan.FromSeconds(40));
                client.EnterNative(D3TransparentPanelXaml, 900, 700, 1.0);
                var hwnd = await hwndTask;
                Check("D3-1 EnterNative returns HWND", hwnd != null && hwnd.Hwnd != 0, hwnd?.Hwnd.ToString() ?? "null");
                if (hwnd == null || hwnd.Hwnd == 0)
                {
                    WriteResults(outDir, "d3-results.json");
                    Console.WriteLine("\n===== D3: aborted, no HWND =====");
                    return 1;
                }

                client.SetMode(true);
                // Realize the window on-screen so FindElementsInHostCoordinates hit-tests a composed tree.
                var handle = new IntPtr(hwnd.Hwnd);
                ShowWindow(handle, 5);
                MoveWindow(handle, 80, 80, Math.Max(900, hwnd.PixelWidth), Math.Max(700, hwnd.PixelHeight), true);
                SetForegroundWindow(handle);
                await Task.Delay(700); // compose + layout settle

                // Read authored-element bounds (adorner/artboard space == pick space) to compute pick points.
                var spSelTask = box.NextSelected(TimeSpan.FromSeconds(40));
                client.SelectByPath("0.0"); // StackPanel
                var sp = await spSelTask;
                Check("D3-2 StackPanel (0.0) selectable",
                    sp != null && sp.Path == "0.0" && sp.ElementType == "StackPanel",
                    sp == null ? "no Selected" : $"path={sp.Path} type={sp.ElementType}");

                var btnSelTask = box.NextSelected(TimeSpan.FromSeconds(40));
                client.SelectByPath("0.0.0"); // Button
                var btn = await btnSelTask;
                Check("D3-3 Button (0.0.0) selectable",
                    btn != null && btn.Path == "0.0.0" && btn.ElementType == "Button",
                    btn == null ? "no Selected" : $"path={btn.Path} type={btn.ElementType}");

                if (sp != null && btn != null)
                {
                    // A point in the StackPanel's transparent TOP padding band: horizontally over the button
                    // column, vertically between the StackPanel top and the Button top (inside the 40px padding,
                    // above the content). Pre-fix this hits the opaque Grid; post-fix it hits the StackPanel.
                    Check("D3-4 padding gap exists (Button starts below StackPanel top)", btn.Y > sp.Y + 1,
                        $"spY={sp.Y} btnY={btn.Y}");
                    double padX = btn.X + btn.W / 2;
                    double padY = (sp.Y + btn.Y) / 2;

                    var padPickTask = box.NextSelected(TimeSpan.FromSeconds(40));
                    client.PickAt(padX, padY);
                    var padPick = await padPickTask;
                    Check("D3-5 PickAt in transparent padding selects StackPanel (not Grid)",
                        padPick != null && padPick.Path == "0.0" && padPick.ElementType == "StackPanel",
                        padPick == null ? "no Selected (pick missed — pre-fix behavior)" : $"path={padPick.Path} type={padPick.ElementType}");

                    // Anti-regression: PickAt over the opaque Button still selects the Button (unchanged by fix).
                    double btnX = btn.X + btn.W / 2;
                    double btnY = btn.Y + btn.H / 2;
                    var btnPickTask = box.NextSelected(TimeSpan.FromSeconds(40));
                    client.PickAt(btnX, btnY);
                    var btnPick = await btnPickTask;
                    Check("D3-6 PickAt over opaque Button selects Button (anti-regression)",
                        btnPick != null && btnPick.Path == "0.0.0" && btnPick.ElementType == "Button",
                        btnPick == null ? "no Selected" : $"path={btnPick.Path} type={btnPick.ElementType}");
                }

                // ---- Scenario 2: transparent panel as the design ROOT (no opaque ancestor at all) -----------
                client.UpdateXaml(D3RootTransparentXaml);
                await Task.Delay(800); // native re-host + layout settle

                var rootSelTask = box.NextSelected(TimeSpan.FromSeconds(40));
                client.SelectByPath("0"); // root StackPanel
                var rootSp = await rootSelTask;
                Check("D3-7 root StackPanel (0) selectable after re-host",
                    rootSp != null && rootSp.Path == "0" && rootSp.ElementType == "StackPanel",
                    rootSp == null ? "no Selected" : $"path={rootSp.Path} type={rootSp.ElementType}");

                if (rootSp != null)
                {
                    var rootBtnTask = box.NextSelected(TimeSpan.FromSeconds(40));
                    client.SelectByPath("0.0"); // Button child of the root panel
                    var rootBtn = await rootBtnTask;
                    double rpadX = rootBtn != null ? rootBtn.X + rootBtn.W / 2 : rootSp.X + rootSp.W / 2;
                    double rpadY = rootBtn != null ? (rootSp.Y + rootBtn.Y) / 2 : rootSp.Y + 10;

                    var rootPickTask = box.NextSelected(TimeSpan.FromSeconds(40));
                    client.PickAt(rpadX, rpadY);
                    var rootPick = await rootPickTask;
                    Check("D3-8 PickAt in root transparent panel padding selects it (not null/empty)",
                        rootPick != null && rootPick.Path == "0" && rootPick.ElementType == "StackPanel",
                        rootPick == null ? "no Selected (pick missed — pre-fix behavior)" : $"path={rootPick.Path} type={rootPick.ElementType}");
                }
            }
            catch (Exception ex)
            {
                Check("D3* e2e ran without exception", false, ex.Message);
            }

            WriteResults(outDir, "d3-results.json");
            int d3Failed = Results.Count(r => !r.Pass);
            Console.WriteLine();
            Console.WriteLine($"===== D3: {Results.Count - d3Failed} passed, {d3Failed} failed =====");
            return d3Failed == 0 ? 0 : 1;
        }

        private static async Task<int> RunVisibleHost(string[] args)
        {
            string outDir = GetArg(args, "--out") ?? Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "qa-results", "tier-s");
            Directory.CreateDirectory(outDir);

            string surfaceExe = GetArg(args, "--surface") ?? Environment.GetEnvironmentVariable("WINUI_SURFACE_EXE") ?? DefaultSurfaceExe;
            string galleryRoot = GetArg(args, "--gallery-root") ?? Environment.GetEnvironmentVariable("WINUI_GALLERY_ROOT") ?? DefaultGalleryRoot;
            string? userDll = GetArg(args, "--user-dll") ?? Environment.GetEnvironmentVariable("WINUI_GALLERY_DLL") ?? FindGalleryDll(galleryRoot);
            string appXaml = GetArg(args, "--app-xaml") ?? Path.Combine(galleryRoot, "App.xaml");
            string readyPath = Path.Combine(outDir, "visible-host.json");
            string stopPath = Path.Combine(outDir, "stop-visible-host.txt");
            if (File.Exists(readyPath)) File.Delete(readyPath);
            if (File.Exists(stopPath)) File.Delete(stopPath);

            using (var client = new SurfaceClient(surfaceExe, userDll, s => Console.Error.WriteLine("  " + s), appXaml))
            {
                var box = new FrameBox(client);
                await client.StartAsync(TimeSpan.FromSeconds(30));
                var hwndTask = box.NextHwnd(TimeSpan.FromSeconds(40));
                client.EnterNative(CalendarControlExampleXaml, 900, 700, 1.0);
                var hwnd = await hwndTask;
                if (hwnd == null || hwnd.Hwnd == 0)
                {
                    Console.Error.WriteLine("No HWND received.");
                    return 1;
                }

                client.SetMode(true);
                var handle = new IntPtr(hwnd.Hwnd);
                ShowWindow(handle, 5);
                MoveWindow(handle, 80, 80, Math.Max(900, hwnd.PixelWidth), Math.Max(700, hwnd.PixelHeight), true);
                SetForegroundWindow(handle);

                var info = new
                {
                    hwnd = hwnd.Hwnd,
                    dipWidth = hwnd.DipWidth,
                    dipHeight = hwnd.DipHeight,
                    pixelWidth = hwnd.PixelWidth,
                    pixelHeight = hwnd.PixelHeight,
                    started = DateTime.UtcNow,
                };
                File.WriteAllText(readyPath, JsonSerializer.Serialize(info, new JsonSerializerOptions { WriteIndented = true }));
                Console.WriteLine("VISIBLE_HOST_READY " + readyPath);

                var deadline = DateTime.UtcNow.AddMinutes(10);
                while (DateTime.UtcNow < deadline && !File.Exists(stopPath))
                {
                    Thread.Sleep(500);
                }
            }

            return 0;
        }

        [DllImport("user32.dll")]
        private static extern bool MoveWindow(IntPtr hWnd, int x, int y, int nWidth, int nHeight, bool bRepaint);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        private static PropItemMsg? FindProp(ElementPropsMsg? msg, string name)
        {
            if (msg?.Props == null) return null;
            foreach (var p in msg.Props)
            {
                if (string.Equals(p.Name, name, StringComparison.Ordinal)) return p;
            }
            return null;
        }

        private static string? FindGalleryDll(string galleryRoot)
        {
            string bin = Path.Combine(galleryRoot, "bin", "WinUIGallery");
            if (!Directory.Exists(bin)) return null;
            try
            {
                return Directory.EnumerateFiles(bin, "WinUIGallery.dll", SearchOption.AllDirectories)
                    .Where(p => p.IndexOf("Debug", StringComparison.OrdinalIgnoreCase) >= 0 &&
                                p.IndexOf("Unpackaged", StringComparison.OrdinalIgnoreCase) >= 0 &&
                                p.IndexOf("win-x64", StringComparison.OrdinalIgnoreCase) >= 0)
                    .OrderByDescending(File.GetLastWriteTimeUtc)
                    .FirstOrDefault();
            }
            catch
            {
                return null;
            }
        }

        private static string? GetArg(string[] args, string name)
        {
            for (int i = 0; i < args.Length - 1; i++)
            {
                if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase)) return args[i + 1];
            }
            return null;
        }

        private static void Check(string name, bool ok, string? detail = null)
        {
            Results.Add(new TestResult { Name = name, Pass = ok, Detail = detail ?? string.Empty });
            Console.WriteLine("  " + (ok ? "PASS" : "FAIL") + "  " + name + (string.IsNullOrEmpty(detail) ? "" : " — " + detail));
        }

        private static void WriteResults(string outDir, string fileName = "stage-p-results.json")
        {
            var summary = new
            {
                passed = Results.Count(r => r.Pass),
                failed = Results.Count(r => !r.Pass),
                results = Results,
            };
            string json = JsonSerializer.Serialize(summary, new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(Path.Combine(outDir, fileName), json);
        }

        private sealed class TestResult
        {
            public string Name { get; set; } = "";
            public bool Pass { get; set; }
            public string Detail { get; set; } = "";
        }

        private sealed class FrameBox
        {
            private TaskCompletionSource<HwndMsg>? _hwnd;
            private TaskCompletionSource<SelectedMsg>? _selected;
            private TaskCompletionSource<ElementPropsMsg>? _props;
            private TaskCompletionSource<ContentPropsMsg>? _contentProps;

            public FrameBox(SurfaceClient client)
            {
                client.Hwnd += h => _hwnd?.TrySetResult(h);
                client.Selected += s => _selected?.TrySetResult(s);
                client.ElementProps += p => _props?.TrySetResult(p);
                client.ContentProps += c => _contentProps?.TrySetResult(c);
                client.Error += e => Console.Error.WriteLine($"  [surface-error] {e.Phase}: {e.Message}");
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

            public async Task<ContentPropsMsg?> NextContentProps(TimeSpan timeout)
            {
                _contentProps = new TaskCompletionSource<ContentPropsMsg>(TaskCreationOptions.RunContinuationsAsynchronously);
                var done = await Task.WhenAny(_contentProps.Task, Task.Delay(timeout));
                return done == _contentProps.Task ? _contentProps.Task.Result : null;
            }
        }
    }
}
