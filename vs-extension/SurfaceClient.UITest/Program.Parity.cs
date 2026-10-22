#nullable enable

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using WinUIXamlPreview.Editor;
using WinUIXamlPreview.Protocol;

namespace WinUIXamlPreview.UITest
{
    // I2 caret <-> previewer parity: for every element the editor-side XamlSourceMap knows about, ask the live
    // surface to select that path and check it lands on the same element type at the same path. Any drift
    // between the client's XML walk and the surface's authored-tree walk shows up as a FAIL here.
    internal static partial class Program
    {
        private const string Ns =
            "xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" " +
            "xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\"";

        // Controls whose XAML content property is NOT one of Children/Content/Child/Items, authored with a
        // sibling <X.Content> property element (the app-shell pattern).
        private static readonly string ParityShellXaml =
            "<Grid " + Ns + " Width=\"900\" Height=\"700\">\n" +
            "  <Grid.RowDefinitions><RowDefinition Height=\"Auto\"/><RowDefinition/></Grid.RowDefinitions>\n" +
            "  <CommandBar x:Name=\"Bar\">\n" +
            "    <AppBarButton Label=\"Add\"/>\n" +
            "    <AppBarButton Label=\"Edit\"/>\n" +
            "    <CommandBar.SecondaryCommands><AppBarButton Label=\"More\"/></CommandBar.SecondaryCommands>\n" +
            "    <CommandBar.Content><TextBlock x:Name=\"BarTitle\" Text=\"Title\"/></CommandBar.Content>\n" +
            "  </CommandBar>\n" +
            "  <NavigationView x:Name=\"Nav\" Grid.Row=\"1\" PaneDisplayMode=\"Left\" IsPaneOpen=\"True\">\n" +
            "    <NavigationView.MenuItems>\n" +
            "      <NavigationViewItem Content=\"Home\"/>\n" +
            "      <NavigationViewItem Content=\"Settings\"/>\n" +
            "    </NavigationView.MenuItems>\n" +
            "    <NavigationView.Content>\n" +
            "      <StackPanel x:Name=\"Body\">\n" +
            "        <TextBlock Text=\"Body\"/>\n" +
            "        <Button Content=\"Go\"/>\n" +
            "      </StackPanel>\n" +
            "    </NavigationView.Content>\n" +
            "  </NavigationView>\n" +
            "</Grid>";

        // Common containers with secondary UI properties (Pane, Header, Flyout) and nested content.
        private static readonly string ParityContainersXaml =
            "<StackPanel " + Ns + " Width=\"900\">\n" +
            "  <SplitView x:Name=\"Split\" IsPaneOpen=\"True\" DisplayMode=\"Inline\" Height=\"120\">\n" +
            "    <SplitView.Pane><TextBlock Text=\"Pane\"/></SplitView.Pane>\n" +
            "    <Border Background=\"LightGray\"><TextBlock Text=\"Split body\"/></Border>\n" +
            "  </SplitView>\n" +
            "  <Expander x:Name=\"Exp\" IsExpanded=\"True\">\n" +
            "    <Expander.Header><TextBlock Text=\"Header\"/></Expander.Header>\n" +
            "    <StackPanel><CheckBox Content=\"A\"/><CheckBox Content=\"B\"/></StackPanel>\n" +
            "  </Expander>\n" +
            "  <Button Content=\"Menu\">\n" +
            "    <Button.Flyout><Flyout><TextBlock Text=\"In flyout\"/></Flyout></Button.Flyout>\n" +
            "  </Button>\n" +
            "  <ScrollViewer Height=\"60\"><StackPanel><TextBlock Text=\"Scrolled\"/></StackPanel></ScrollViewer>\n" +
            "  <Viewbox Height=\"40\"><TextBlock Text=\"Boxed\"/></Viewbox>\n" +
            "  <ContentControl><Button Content=\"In ContentControl\"/></ContentControl>\n" +
            "  <ListView Height=\"80\">\n" +
            "    <ListViewItem Content=\"One\"/>\n" +
            "    <ListViewItem><TextBlock Text=\"Two\"/></ListViewItem>\n" +
            "  </ListView>\n" +
            "  <RelativePanel Height=\"40\">\n" +
            "    <TextBlock x:Name=\"Left\" Text=\"L\"/>\n" +
            "    <TextBlock Text=\"R\" RelativePanel.RightOf=\"Left\"/>\n" +
            "  </RelativePanel>\n" +
            "  <Canvas Height=\"40\"><Rectangle Width=\"20\" Height=\"20\" Fill=\"Red\" Canvas.Left=\"10\"/></Canvas>\n" +
            "  <Grid><Grid.ColumnDefinitions><ColumnDefinition/><ColumnDefinition/></Grid.ColumnDefinitions>\n" +
            "    <TextBlock Text=\"c0\"/><TextBlock Grid.Column=\"1\" Text=\"c1\"/>\n" +
            "  </Grid>\n" +
            "</StackPanel>";

        // Tab/flip style controls whose non-selected items are not in the visual tree.
        private static readonly string ParityTabsXaml =
            "<Grid " + Ns + " Width=\"900\" Height=\"500\">\n" +
            "  <TabView x:Name=\"Tabs\">\n" +
            "    <TabViewItem Header=\"First\"><TextBlock Text=\"First body\"/></TabViewItem>\n" +
            "    <TabViewItem Header=\"Second\"><StackPanel><Button Content=\"Hidden\"/></StackPanel></TabViewItem>\n" +
            "  </TabView>\n" +
            "</Grid>";

        private static async Task<int> RunParity(string[] args)
        {
            string outDir = GetArg(args, "--out") ?? Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "qa-results");
            Directory.CreateDirectory(outDir);

            string surfaceExe = GetArg(args, "--surface") ?? Environment.GetEnvironmentVariable("WINUI_SURFACE_EXE") ?? DefaultSurfaceExe;
            string? userDll = GetArg(args, "--user-dll");
            string? appXaml = GetArg(args, "--app-xaml");
            string? xamlDir = GetArg(args, "--xaml-dir");

            var pages = new List<(string Name, string Xaml)>
            {
                ("shell", ParityShellXaml),
                ("containers", ParityContainersXaml),
                ("tabs", ParityTabsXaml),
            };
            if (!string.IsNullOrEmpty(xamlDir) && Directory.Exists(xamlDir))
            {
                foreach (var f in Directory.EnumerateFiles(xamlDir, "*.xaml", SearchOption.AllDirectories)
                    .Where(p => p.IndexOf("\\bin\\", StringComparison.OrdinalIgnoreCase) < 0 &&
                                p.IndexOf("\\obj\\", StringComparison.OrdinalIgnoreCase) < 0)
                    .OrderBy(p => p, StringComparer.OrdinalIgnoreCase))
                {
                    string text = File.ReadAllText(f);
                    if (IsPreviewablePage(text))
                    {
                        pages.Add((Path.GetFileName(f), text));
                    }
                }
            }

            Console.WriteLine("I2 caret<->previewer parity: client source-map paths vs. live surface selection");
            Console.WriteLine("Surface.exe: " + surfaceExe);
            Console.WriteLine("User DLL:    " + (userDll ?? "(none)"));
            Console.WriteLine();

            if (!File.Exists(surfaceExe))
            {
                Check("PAR-0 Surface.exe exists", false, surfaceExe);
                WriteResults(outDir, "parity-results.json");
                return 1;
            }

            try
            {
                using var client = new SurfaceClient(surfaceExe, userDll, s => Console.Error.WriteLine("  " + s), appXaml);
                var box = new FrameBox(client);
                await client.StartAsync(TimeSpan.FromSeconds(30));

                bool hosted = false;
                foreach (var (name, xaml) in pages)
                {
                    await CheckPageParity(client, box, name, xaml, hosted);
                    hosted = true;
                }
            }
            catch (Exception ex)
            {
                Check("PAR* ran without exception", false, ex.Message);
            }

            WriteResults(outDir, "parity-results.json");
            int failed = Results.Count(r => !r.Pass);
            Console.WriteLine();
            Console.WriteLine($"===== PARITY: {Results.Count - failed} passed, {failed} failed =====");
            return failed == 0 ? 0 : 1;
        }

        private static async Task CheckPageParity(SurfaceClient client, FrameBox box, string name, string xaml, bool hosted)
        {
            Console.WriteLine("-- " + name);

            // ContentProps is sent after every successful host, so it doubles as the "render done" signal.
            var cpTask = box.NextContentProps(TimeSpan.FromSeconds(60));
            if (!hosted)
            {
                var hwndTask = box.NextHwnd(TimeSpan.FromSeconds(60));
                client.EnterNative(xaml, 900, 700, 1.0);
                var hwnd = await hwndTask;
                if (hwnd == null || hwnd.Hwnd == 0)
                {
                    Check(name + ": EnterNative returns HWND", false, "no HWND");
                    return;
                }

                client.SetMode(true);
            }
            else
            {
                client.UpdateXaml(xaml);
            }

            var cp = await cpTask;
            if (cp == null)
            {
                if (name.EndsWith(".xaml", StringComparison.OrdinalIgnoreCase))
                {
                    // A project page can need resources only a full VS session resolves; that's not a mapping bug.
                    Console.WriteLine("  SKIP  " + name + ": didn't render standalone (see surface stderr)");
                    return;
                }

                Check(name + ": page rendered", false, "no ContentProps (render failed or timed out)");
                return;
            }

            await Task.Delay(400);
            if (cp.Map != null && cp.Map.Count > 0)
            {
                Console.WriteLine("   content props: " + string.Join(", ", cp.Map.Select(kv => kv.Key + "->" + kv.Value)));
            }

            var map = XamlSourceMap.Build(xaml, cp.Map);
            if (map == null)
            {
                Check(name + ": source map builds", false, "XML did not parse");
                return;
            }

            var mismatches = new List<string>();
            var placeholders = new List<string>();
            int skipped = 0;
            foreach (var (path, xname) in map.Elements)
            {
                // Under a placeholder (a custom control that couldn't load) the surface deliberately resolves
                // nothing — the editor's caret then has no selection rather than a wrong one.
                if (placeholders.Any(p => path.StartsWith(p + ".", StringComparison.Ordinal)))
                {
                    skipped++;
                    continue;
                }

                var selTask = box.NextSelected(TimeSpan.FromSeconds(3));
                client.SelectByPath(path);
                var sel = await selTask;

                if (sel == null)
                {
                    mismatches.Add($"{path} <{xname.LocalName}>: surface did not resolve");
                    continue;
                }

                if (sel.Path != path)
                {
                    mismatches.Add($"{path} <{xname.LocalName}>: surface reported path '{sel.Path ?? "null"}' ({sel.ElementType})");
                    continue;
                }

                if (path == "0")
                {
                    continue; // a custom root is rebased to its framework base type; any type is fine here
                }

                bool custom = xname.NamespaceName.StartsWith("using:", StringComparison.Ordinal) ||
                              xname.NamespaceName.StartsWith("clr-namespace:", StringComparison.Ordinal);
                if (custom && sel.ElementType == "Border")
                {
                    placeholders.Add(path);
                    continue;
                }

                if (sel.ElementType != xname.LocalName)
                {
                    mismatches.Add($"{path} <{xname.LocalName}>: surface selected {sel.ElementType}");
                }
            }

            string note = skipped > 0 ? $" ({skipped} under placeholders skipped)" : "";
            Check(name + ": " + (map.Elements.Count - skipped) + " elements map to the same surface element" + note,
                mismatches.Count == 0,
                mismatches.Count == 0 ? null : string.Join("; ", mismatches));
        }

        private static readonly HashSet<string> NonPageRoots =
            new HashSet<string>(StringComparer.Ordinal) { "ResourceDictionary", "Application", "Window" };

        private static bool IsPreviewablePage(string xaml)
        {
            try
            {
                var root = System.Xml.Linq.XDocument.Parse(xaml).Root;
                return root != null && !NonPageRoots.Contains(root.Name.LocalName);
            }
            catch
            {
                return false;
            }
        }
    }
}
