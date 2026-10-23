#nullable enable

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using WinUIXamlPreview.Protocol;

namespace WinUIXamlPreview.UITest
{
    // Q-suite fixtures: render the pages in surface\TestFixtureApp\Fixtures against the built TestFixtureApp.dll
    // and check that user-code controls (custom, other-project, Community Toolkit) load as themselves rather than
    // placeholders, and that resources resolve from every scope (page, project dictionaries, App.xaml, framework)
    // in both Light and Dark. Each page also goes through the I2 caret<->previewer parity check.
    internal static partial class Program
    {
        private sealed class Expect
        {
            public Expect(string path, string type, string? prop = null, string? light = null, string? dark = null, bool sized = false, bool themeFlips = false, double minHeight = 0)
            {
                Path = path; Type = type; Prop = prop; Light = light; Dark = dark; Sized = sized; ThemeFlips = themeFlips; MinHeight = minHeight;
            }

            /// <summary>Lower bound on laid-out height that only the control's real template reaches (an untemplated
            /// Toolkit control still sizes to its bare content, so <see cref="Sized"/> alone can't catch a missing PRI).</summary>
            public double MinHeight { get; }

            public string Path { get; }
            public string Type { get; }
            public string? Prop { get; }
            public string? Light { get; }
            public string? Dark { get; }

            /// <summary>Must lay out with a non-zero size: a templated control whose default style wasn't found is 0x0.</summary>
            public bool Sized { get; }

            /// <summary><see cref="Prop"/> must differ between the Light and Dark runs.</summary>
            public bool ThemeFlips { get; }
        }

        private static readonly (string File, Expect[] Expects)[] FixturePages =
        {
            ("CustomControlsPage.xaml", new[]
            {
                new Expect("0.0.0", "ProfileCard", "Title", "Ada Lovelace", sized: true),
                new Expect("0.0.1", "TagChip", "Text", "New", sized: true),
                new Expect("0.0.2", "Section", "Header", "Details", sized: true),
                new Expect("0.0.2.0", "TextBlock", "Text", "Section body", sized: true),
            }),
            ("ReferencedProjectPage.xaml", new[]
            {
                new Expect("0.0.0", "LibBadge", "Label", "From another project", sized: true),
                new Expect("0.0.1", "LibStack", "Spacing", "6", sized: true),
                new Expect("0.0.1.1", "TextBlock", "Text", "Second", sized: true),
            }),
            ("ToolkitPage.xaml", new[]
            {
                new Expect("0.0.0", "SettingsCard", "Header", "Notifications", sized: true, minHeight: 60),
                new Expect("0.0.0.0", "ToggleSwitch", sized: true),
                new Expect("0.0.1", "Segmented", "SelectedIndex", "0", sized: true),
                new Expect("0.0.1.1", "SegmentedItem", "Content", "Week", sized: true, minHeight: 25),
            }),
            // Win2D's native Microsoft.Graphics.Canvas.dll lives only in the app's output (runtimes\<rid>\native
            // for this RID-less build); without the host's native resolver, activation fails and the host fail-fasts.
            ("NativeDependencyPage.xaml", new[]
            {
                new Expect("0.0.0", "CanvasControl", sized: true),
                new Expect("0.0.1", "TextBlock", "Text", "Rendered with Win2D", sized: true),
            }),
            // An async-void Loaded handler reads FixtureContent\greeting.txt from AppContext.BaseDirectory (needs the
            // host to stage app content files), and another faults after load (the host's UnhandledException net
            // must contain it; see FixtureLogExpectations).
            ("ContentAndAsyncFaultPage.xaml", new[]
            {
                new Expect("0.0.0", "ContentFileReader", "Content", "Hello from a content file", sized: true),
                new Expect("0.0.2", "TextBlock", "Text", "Still alive", sized: true),
            }),
            ("StylingPage.xaml", new[]
            {
                new Expect("0.0.0", "TextBlock", "Foreground", "#FF7B1FA2", "#FF7B1FA2"),
                new Expect("0.0.1", "TextBlock", "FontSize", "28", "28"),
                new Expect("0.0.2", "TextBlock", "Foreground", "#FFD84315", "#FFD84315"),
                new Expect("0.0.3", "Button", "Background", "#FF00897B", "#FF00897B"),
                new Expect("0.0.4", "Border", "Background", "#FFF1F8E9", "#FF1B5E20"),
                new Expect("0.0.5", "Border", "Background", "#FFFFF3E0", "#FF3E2723"),
                new Expect("0.0.6", "Border", "Background", themeFlips: true),
                new Expect("0.0.7", "TextBlock", "Text", "{KeyAddedAtRuntime}", "{KeyAddedAtRuntime}"),
            }),
        };

        private static async Task<int> RunFixtures(string[] args)
        {
            string outDir = GetArg(args, "--out") ?? Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "qa-results");
            Directory.CreateDirectory(outDir);

            string surfaceExe = GetArg(args, "--surface") ?? Environment.GetEnvironmentVariable("WINUI_SURFACE_EXE") ?? DefaultSurfaceExe;
            string? userDll = FullPathOrNull(GetArg(args, "--user-dll"));
            string? fixturesDir = FullPathOrNull(GetArg(args, "--fixtures-dir"));
            string? appXaml = FullPathOrNull(GetArg(args, "--app-xaml")) ?? (fixturesDir == null ? null : Path.Combine(fixturesDir, "App.xaml"));

            Console.WriteLine("Q-suite fixtures: custom / referenced-project / Toolkit controls and resource scopes, Light + Dark");
            Console.WriteLine("Surface.exe:  " + surfaceExe);
            Console.WriteLine("User DLL:     " + (userDll ?? "(none)"));
            Console.WriteLine("Fixtures dir: " + (fixturesDir ?? "(none)"));
            Console.WriteLine();

            bool inputsOk = true;
            inputsOk &= CheckInput("FIX-0 Surface.exe exists", surfaceExe);
            inputsOk &= CheckInput("FIX-0 user DLL exists", userDll);
            inputsOk &= CheckInput("FIX-0 fixtures dir exists", fixturesDir, dir: true);
            inputsOk &= CheckInput("FIX-0 App.xaml exists", appXaml);
            if (!inputsOk)
            {
                WriteResults(outDir, "fixtures-results.json");
                return 1;
            }

            ResetDevHostStaging(surfaceExe, userDll);
            _hostHasToolkitTemplates = HostHasToolkitTemplates(surfaceExe);
            if (!_hostHasToolkitTemplates)
            {
                Console.WriteLine("WARN  Surface.pri has no baked Toolkit templates (a plain dev build, not a Build-Payload.ps1 host);");
                Console.WriteLine("      skipping the Toolkit template-height checks. Run against the payload host to cover them.");
                Console.WriteLine();
            }

            var lightValues = new Dictionary<string, string?>(StringComparer.Ordinal);
            foreach (var theme in new[] { "Light", "Dark" })
            {
                Console.WriteLine("== " + theme);
                try
                {
                    var surfaceLog = new System.Collections.Concurrent.ConcurrentQueue<string>();
                    using var client = new SurfaceClient(surfaceExe, userDll, s => { surfaceLog.Enqueue(s); Console.Error.WriteLine("  " + s); }, appXaml, theme)
                    {
                        SampleData = true, // the VS default
                    };
                    var box = new FrameBox(client);
                    await client.StartAsync(TimeSpan.FromSeconds(30));

                    bool hosted = false;
                    foreach (var (file, expects) in FixturePages)
                    {
                        // Dark only re-checks the pages with theme-dependent values.
                        if (theme == "Dark" && !expects.Any(e => e.Dark != null || e.ThemeFlips))
                        {
                            continue;
                        }

                        string name = theme + "/" + Path.GetFileNameWithoutExtension(file);
                        string xaml = File.ReadAllText(Path.Combine(fixturesDir!, file));

                        lock (box.Errors) box.Errors.Clear();
                        await CheckPageParity(client, box, name, xaml, hosted);
                        hosted = true;

                        string[] errors;
                        lock (box.Errors) errors = box.Errors.ToArray();
                        Check(name + ": renders without surface errors", errors.Length == 0, string.Join("; ", errors));

                        foreach (var e in expects)
                        {
                            await CheckExpect(client, box, name, theme, e, lightValues);
                        }

                        if (FixtureLogExpectations.TryGetValue(file, out var logLine))
                        {
                            Check(name + ": host logs '" + logLine + "'", await WaitForLog(surfaceLog, logLine, TimeSpan.FromSeconds(5)));
                        }
                    }
                }
                catch (Exception ex)
                {
                    Check(theme + ": FIX* ran without exception", false, ex.Message);
                }
            }

            WriteResults(outDir, "fixtures-results.json");
            int failed = Results.Count(r => !r.Pass);
            Console.WriteLine();
            Console.WriteLine($"===== FIXTURES: {Results.Count - failed} passed, {failed} failed =====");
            return failed == 0 ? 0 : 1;
        }

        private static bool _hostHasToolkitTemplates = true;

        // Mirrors the host's staged extensions (App.cs StageLooseXamlResources / ContentExtensions).
        private static readonly HashSet<string> StagedExtensions = new(StringComparer.OrdinalIgnoreCase)
        {
            ".xbf", ".xaml",
            ".txt", ".json", ".xml", ".md", ".csv", ".html", ".htm", ".css", ".js", ".svg",
            ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".tif", ".tiff",
            ".ttf", ".otf",
        };

        /// <summary>
        /// A dev host (run straight from its build output, no <c>.payload.json</c>) keeps the user files it staged
        /// into its own folder across runs, so a broken staging step would still pass on the previous run's copies.
        /// Delete them first. Only files identical to the user's (same size + write time, which the host's copy
        /// preserves) with a staged extension are removed, so the host's own files are left alone. Payload run
        /// copies are fresh per launch and are skipped.
        /// </summary>
        internal static void ResetDevHostStaging(string surfaceExe, string? userDll)
        {
            string hostDir = Path.GetDirectoryName(Path.GetFullPath(surfaceExe))!;
            if (userDll == null || File.Exists(Path.Combine(hostDir, ".payload.json")))
            {
                return;
            }

            string userDir = Path.GetDirectoryName(userDll)!;
            if (string.Equals(Path.GetFullPath(userDir).TrimEnd('\\'), hostDir.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            int removed = 0;
            var touchedDirs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (string src in Directory.EnumerateFiles(userDir, "*", SearchOption.AllDirectories))
            {
                if (!StagedExtensions.Contains(Path.GetExtension(src)))
                {
                    continue;
                }

                string rel = src.Substring(userDir.TrimEnd('\\').Length + 1);
                string dest = Path.Combine(hostDir, rel);
                var s = new FileInfo(src);
                var d = new FileInfo(dest);
                if (!d.Exists || d.Length != s.Length || d.LastWriteTimeUtc != s.LastWriteTimeUtc)
                {
                    continue;
                }

                try
                {
                    d.Delete();
                    removed++;
                    touchedDirs.Add(d.DirectoryName!);
                }
                catch (IOException ex)
                {
                    Console.WriteLine("WARN  could not remove stale staged file " + dest + ": " + ex.Message);
                }
                catch (UnauthorizedAccessException ex)
                {
                    Console.WriteLine("WARN  could not remove stale staged file " + dest + ": " + ex.Message);
                }
            }

            // Prune directories the cleanup emptied, deepest first, never the host folder itself.
            foreach (string dir in touchedDirs.OrderByDescending(p => p.Length))
            {
                for (string? cur = dir;
                     cur != null && cur.Length > hostDir.TrimEnd('\\').Length &&
                     Directory.Exists(cur) && !Directory.EnumerateFileSystemEntries(cur).Any();
                     cur = Path.GetDirectoryName(cur))
                {
                    try { Directory.Delete(cur); } catch (IOException) { break; }
                }
            }

            if (removed > 0)
            {
                Console.WriteLine($"Dev host: removed {removed} file(s) staged by an earlier run so this run re-stages them.");
                Console.WriteLine();
            }
        }

        // Host behaviour that leaves no trace in the visual tree. An unhandled async-void fault does not always kill
        // the host (WinUI Gallery's ChartPage did; a plain control does not), so assert the safety net saw it.
        private static readonly Dictionary<string, string> FixtureLogExpectations = new(StringComparer.Ordinal)
        {
            ["ContentAndAsyncFaultPage.xaml"] = "contained by the preview host (at TestFixtureApp.Controls.AsyncThrowingControl",
        };

        private static async Task<bool> WaitForLog(System.Collections.Concurrent.ConcurrentQueue<string> log, string text, TimeSpan timeout)
        {
            var deadline = DateTime.UtcNow + timeout;
            while (true)
            {
                if (log.Any(l => l.Contains(text)))
                {
                    return true;
                }
                if (DateTime.UtcNow >= deadline)
                {
                    return false;
                }
                await Task.Delay(100);
            }
        }

        /// <summary>
        /// Build-Payload.ps1 bakes PreviewHost's merged pri (with the Toolkit's Themes\Generic.xbf) in as
        /// Surface.pri; a plain <c>dotnet build</c> of Surface leaves the host's own tiny pri, so Toolkit controls
        /// render untemplated. The merged pri names its component maps in ASCII, so a byte scan detects it.
        /// </summary>
        private static bool HostHasToolkitTemplates(string surfaceExe)
        {
            string pri = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(surfaceExe))!, "Surface.pri");
            if (!File.Exists(pri))
            {
                return false;
            }

            string text = System.Text.Encoding.ASCII.GetString(File.ReadAllBytes(pri));
            return text.Contains("CommunityToolkit.WinUI.Controls.SettingsControls")
                && text.Contains("CommunityToolkit.WinUI.Controls.Segmented");
        }

        private static async Task CheckExpect(SurfaceClient client, FrameBox box, string page, string theme, Expect e, Dictionary<string, string?> lightValues)
        {
            var selTask = box.NextSelected(TimeSpan.FromSeconds(5));
            box.ClearProps();
            client.SelectByPath(e.Path);
            var sel = await selTask;

            string label = $"{page}: {e.Path} <{e.Type}>";
            if (sel == null)
            {
                Check(label + " resolves", false, "no Selected");
                return;
            }

            var props = await box.WaitProps(p => p.Id == sel.Id, TimeSpan.FromSeconds(5));

            // A custom control that failed to load is swapped for a placeholder Border.
            Check(label + " is a real " + e.Type, sel.ElementType == e.Type, "selected " + (sel.ElementType ?? "null"));
            if (sel.ElementType != e.Type)
            {
                return;
            }

            if (e.Sized)
            {
                Check(label + " has a laid-out size", sel.W > 0 && sel.H > 0, $"{sel.W}x{sel.H}");
            }

            if (e.MinHeight > 0)
            {
                if (_hostHasToolkitTemplates)
                {
                    Check(label + $" has its template (height >= {e.MinHeight})", sel.H >= e.MinHeight, $"{sel.W}x{sel.H}");
                }
                else
                {
                    Console.WriteLine($"  SKIP  {label} has its template (height >= {e.MinHeight}) — host has no baked Toolkit templates");
                }
            }

            if (e.Prop == null)
            {
                return;
            }

            string? actual = FindProp(props, e.Prop)?.Value;
            string key = page.Substring(page.IndexOf('/') + 1) + "|" + e.Path + "|" + e.Prop;
            if (theme == "Light")
            {
                lightValues[key] = actual;
            }

            if (e.ThemeFlips)
            {
                if (theme == "Dark")
                {
                    lightValues.TryGetValue(key, out var light);
                    Check(label + " " + e.Prop + " follows the theme", !string.IsNullOrEmpty(actual) && actual != light,
                        "light " + (light ?? "null") + ", dark " + (actual ?? "null"));
                }

                return;
            }

            string? expected = theme == "Dark" ? e.Dark : e.Light;
            if (expected == null)
            {
                return;
            }

            Check(label + " " + e.Prop + " = " + expected, actual == expected,
                "actual " + (actual ?? (props == null ? "(no ElementProps for this selection)" : $"(no {e.Prop} row among {props.Props?.Count ?? 0})")));
        }

        // The surface runs from its own folder, so relative inputs must be resolved here.
        private static string? FullPathOrNull(string? path) =>
            string.IsNullOrEmpty(path) ? null : Path.GetFullPath(path);

        private static bool CheckInput(string name, string? path, bool dir = false)
        {
            bool ok = !string.IsNullOrEmpty(path) && (dir ? Directory.Exists(path) : File.Exists(path));
            Check(name, ok, path ?? "not specified");
            return ok;
        }
    }
}
