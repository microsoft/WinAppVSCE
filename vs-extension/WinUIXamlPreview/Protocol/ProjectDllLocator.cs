#nullable enable

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace WinUIXamlPreview.Protocol
{
    /// <summary>
    /// Best-effort discovery of the built user assembly for a <c>.xaml</c> document, so custom
    /// controls resolve through the surface's provider chain. Walks up to the nearest
    /// <c>.csproj</c> and returns the newest matching <c>&lt;project&gt;.dll</c> under its
    /// <c>bin</c> tree (assumes a recent build).
    ///
    /// This is a deliberate Phase-1 shortcut. Full parity with the VS Code client — evaluate the
    /// project, build it, shadow-copy the output, and (Option A) generate a version-matched design
    /// host — is a follow-up that ports <c>projectResolver.ts</c> / <c>hostBuilder.ts</c> to C#.
    /// </summary>
    internal static class ProjectDllLocator
    {
        // The packaged-build note is the same on every open of the project; say it once per build output.
        private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, byte> WarnedPackaged =
            new System.Collections.Concurrent.ConcurrentDictionary<string, byte>(StringComparer.OrdinalIgnoreCase);

        public static string? FindUserDll(string? xamlPath, Action<string>? log = null)
        {
            log ??= _ => { };

            if (string.IsNullOrWhiteSpace(xamlPath))
            {
                return null;
            }

            var csproj = FindOwningCsproj(xamlPath!);
            if (csproj == null)
            {
                log("No owning .csproj found for the document.");
                return null;
            }

            var projectDir = Path.GetDirectoryName(csproj)!;
            var assemblyName = AssemblyNameFor(csproj);
            var outputDirs = OutputDirs(csproj).Where(Directory.Exists).ToList();
            var binDir = outputDirs.Count == 1 ? outputDirs[0] : string.Join(", ", outputDirs);
            if (outputDirs.Count == 0)
            {
                log($"No bin directory under {projectDir}; rendering framework-only.");
                return null;
            }

            try
            {
                var dlls = outputDirs
                    .SelectMany(d => Directory.EnumerateFiles(d, assemblyName + ".dll", SearchOption.AllDirectories))
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .OrderByDescending(File.GetLastWriteTimeUtc)
                    .ToList();

                if (dlls.Count == 0)
                {
                    log($"No {assemblyName}.dll under {binDir}; rendering framework-only.");
                    return null;
                }

                // Prefer a build whose architecture the (arch-native) host can load: an ARM64 surface can't
                // load an x64 assembly and vice versa (FileLoadException → custom controls don't resolve).
                var loadable = dlls.Where(HostArch.CanHostLoad).ToList();
                if (loadable.Count == 0)
                {
                    log($"No {HostArch.Platform} build of {assemblyName} found under {binDir}; build the project for " +
                        $"{HostArch.Platform} so custom controls resolve. Trying the newest build anyway.");
                }
                else
                {
                    dlls = loadable;
                }

                // Prefer an UNPACKAGED build. A packaged (MSIX) build emits AppxManifest.xml next to the
                // assembly and compiles in the Windows App SDK DeploymentManager auto-initializer, whose
                // module initializer calls DeploymentManager.Initialize() — that requires package identity
                // and throws "The process has no package identity" inside our unpackaged surface host, so
                // the app's generated XamlTypeInfo provider can't be instantiated and custom controls fail
                // to resolve. An unpackaged build (WindowsPackageType=None) has no such initializer and loads
                // cleanly. Pick the newest unpackaged output; fall back to the newest packaged one + a warning.
                var unpackaged = dlls.FirstOrDefault(d => !IsPackagedBuild(d));
                var dll = unpackaged ?? dlls[0];

                if (unpackaged == null)
                {
                    if (WarnedPackaged.TryAdd(dll, 0))
                    {
                        log($"Only a packaged (MSIX) build of {assemblyName} was found ({dll}). The preview host " +
                            "loads it with the WinAppSDK deployment initializer disabled; if that fails it falls back " +
                            "to a sparse package identity (requires Windows Developer Mode).");
                    }
                }
                else if (dlls.Count > 1)
                {
                    log($"User assembly (preferred unpackaged build): {dll}");
                    return dll;
                }

                log($"User assembly: {dll}");
                return dll;
            }
            catch (Exception ex)
            {
                log("User DLL search failed: " + ex.Message);
                return null;
            }
        }

        /// <summary>
        /// True when the project's newest-build choice (as made by <see cref="FindUserDll"/>) would be a
        /// packaged (MSIX) build, i.e. at least one <c>&lt;project&gt;.dll</c> exists under <c>bin</c> and none
        /// is unpackaged. That's exactly when opening one of its pages will need the surface's sparse identity,
        /// so the package uses it to decide whether to prewarm registration. Never throws.
        /// </summary>
        public static bool NeedsPackagedIdentity(string csprojPath)
        {
            try
            {
                if (Path.GetDirectoryName(csprojPath) == null)
                {
                    return false;
                }

                var assemblyName = AssemblyNameFor(csprojPath);
                var any = false;
                foreach (var dll in OutputDirs(csprojPath).Where(Directory.Exists)
                    .SelectMany(d => Directory.EnumerateFiles(d, assemblyName + ".dll", SearchOption.AllDirectories)))
                {
                    if (!IsPackagedBuild(dll))
                    {
                        return false;
                    }
                    any = true;
                }

                return any;
            }
            catch
            {
                return false;
            }
        }

        /// <summary>
        /// A packaged (MSIX) build emits a generated <c>AppxManifest.xml</c> next to the output assembly.
        /// Presence of that file is a reliable, build-system-agnostic signal that the assembly was built
        /// packaged — and therefore that its module initializer will demand package identity. The preview
        /// host handles this by registering a sparse identity for its surface (see <c>SurfaceIdentity</c>);
        /// callers use this to decide whether that registration is needed for the chosen assembly.
        /// </summary>
        public static bool IsPackagedBuild(string dllPath)
        {
            try
            {
                var dir = Path.GetDirectoryName(dllPath);
                return dir != null && File.Exists(Path.Combine(dir, "AppxManifest.xml"));
            }
            catch
            {
                return false;
            }
        }

        /// <summary>
        /// Locates the owning project's <c>App.xaml</c> (the head app's resource root) so the surface
        /// can establish the app resource scope via <c>--user-appxaml</c>. Real app pages (e.g. the
        /// WinUI Gallery) reference resources declared in App.xaml's merged dictionaries
        /// (<c>{StaticResource GalleryTileGridStyle}</c>, implicit styles, theme dictionaries); without
        /// this the page renders unstyled or errors. Returns the <c>App.xaml</c> sitting next to the
        /// nearest <c>.csproj</c>, or null (a class library / app-less project renders framework-only).
        /// </summary>
        public static string? FindAppXaml(string? xamlPath, Action<string>? log = null)
        {
            log ??= _ => { };

            if (string.IsNullOrWhiteSpace(xamlPath))
            {
                return null;
            }

            var csproj = FindOwningCsproj(xamlPath!);
            if (csproj == null)
            {
                return null;
            }

            var projectDir = Path.GetDirectoryName(csproj)!;
            var appXaml = Path.Combine(projectDir, "App.xaml");

            if (File.Exists(appXaml))
            {
                log($"App.xaml: {appXaml}");
                return appXaml;
            }

            // BB-008: App.xaml moved into a subfolder (e.g. Application\App.xaml).
            var moved = FindApplicationDefinition(csproj);
            if (moved != null)
            {
                log($"App.xaml: {moved}");
                return moved;
            }

            log($"No App.xaml next to {Path.GetFileName(csproj)}; app resource scope skipped.");
            return null;
        }

        // ---- project layout (BB-008) -------------------------------------------------------
        //
        // A cheap, literal read of the project and its Directory.Build.props — no MSBuild evaluation. It covers
        // the common customizations: <AssemblyName>, <OutputPath>/<BaseOutputPath>, and the .NET 8 artifacts
        // layout (UseArtifactsOutput → <props dir>\artifacts\bin\<project>\…). Anything computed from other
        // properties falls back to the defaults.

        /// <summary>The output assembly name: a literal &lt;AssemblyName&gt;, else the project file name.</summary>
        internal static string AssemblyNameFor(string csproj)
        {
            var projectName = Path.GetFileNameWithoutExtension(csproj);
            foreach (var file in ProjectAndProps(csproj))
            {
                var value = ExpandLiteral(ReadProperty(SafeRead(file), "AssemblyName"), csproj);
                if (!string.IsNullOrWhiteSpace(value) && value!.IndexOfAny(Path.GetInvalidFileNameChars()) < 0)
                {
                    return value;
                }
            }

            return projectName;
        }

        /// <summary>Folders a build of <paramref name="csproj"/> may write its assembly to (existing or not).</summary>
        internal static List<string> OutputDirs(string csproj) => BuildDirs(csproj, "bin", "OutputPath", "BaseOutputPath");

        /// <summary>Folders holding the project's intermediate output (project.assets.json).</summary>
        internal static List<string> IntermediateDirs(string csproj) => BuildDirs(csproj, "obj", "BaseIntermediateOutputPath");

        private static List<string> BuildDirs(string csproj, string kind, params string[] pathProps)
        {
            var projectDir = Path.GetDirectoryName(csproj)!;
            var projectName = Path.GetFileNameWithoutExtension(csproj);
            var dirs = new List<string> { Path.Combine(projectDir, kind) };

            var text = SafeRead(csproj);
            foreach (var prop in pathProps)
            {
                var value = ExpandLiteral(ReadProperty(text, prop), csproj);
                if (!string.IsNullOrWhiteSpace(value))
                {
                    try { dirs.Add(Path.GetFullPath(Path.Combine(projectDir, value!.Trim()))); }
                    catch { }
                }
            }

            try
            {
                var dir = new DirectoryInfo(projectDir);
                for (int i = 0; dir != null && i < 6; i++, dir = dir.Parent)
                {
                    var artifacts = Path.Combine(dir.FullName, "artifacts", kind, projectName);
                    if (Directory.Exists(artifacts) ||
                        HasBoolProp(SafeRead(Path.Combine(dir.FullName, "Directory.Build.props")) ?? "", "UseArtifactsOutput") ||
                        (i == 0 && HasBoolProp(text ?? "", "UseArtifactsOutput")))
                    {
                        dirs.Add(artifacts);
                    }
                }
            }
            catch { }

            return dirs.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        }

        private static IEnumerable<string> ProjectAndProps(string csproj)
        {
            yield return csproj;
            var dir = new FileInfo(csproj).Directory;
            for (int i = 0; dir != null && i < 6; i++, dir = dir.Parent)
            {
                var props = Path.Combine(dir.FullName, "Directory.Build.props");
                if (File.Exists(props))
                {
                    yield return props;
                }
            }
        }

        /// <summary>The first literal value of &lt;<paramref name="name"/>&gt; in an MSBuild file, or null.</summary>
        internal static string? ReadProperty(string? text, string name)
        {
            if (string.IsNullOrEmpty(text))
            {
                return null;
            }

            var m = System.Text.RegularExpressions.Regex.Match(text,
                "<" + name + @"(\s[^>]*)?>([^<]*)</" + name + @"\s*>",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            return m.Success ? m.Groups[2].Value.Trim() : null;
        }

        // Expands $(…) references from the props chain; null when something can't be resolved statically.
        private static string? ExpandLiteral(string? value, string csproj) =>
            string.IsNullOrWhiteSpace(value) ? null : WinUISurface.Shared.ProjectFiles.ExpandProperties(value!, csproj);

        // <ApplicationDefinition Include="Application\App.xaml" />, else a shallow scan for an <Application> root.
        private static string? FindApplicationDefinition(string csproj)
        {
            var projectDir = Path.GetDirectoryName(csproj)!;
            var text = SafeRead(csproj);
            if (text != null)
            {
                var m = System.Text.RegularExpressions.Regex.Match(text,
                    @"<ApplicationDefinition\s[^>]*Include\s*=\s*""([^""$*]+)""",
                    System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                if (m.Success)
                {
                    var p = Path.Combine(projectDir, m.Groups[1].Value.Trim());
                    if (File.Exists(p))
                    {
                        return Path.GetFullPath(p);
                    }
                }
            }

            try
            {
                return EnumerateXaml(projectDir, depth: 3)
                    .OrderBy(f => string.Equals(Path.GetFileName(f), "App.xaml", StringComparison.OrdinalIgnoreCase) ? 0 : 1)
                    .FirstOrDefault(IsApplicationRoot);
            }
            catch
            {
                return null;
            }
        }

        private static IEnumerable<string> EnumerateXaml(string dir, int depth)
        {
            IEnumerable<string> files;
            try { files = Directory.EnumerateFiles(dir, "*.xaml", SearchOption.TopDirectoryOnly).ToList(); }
            catch { yield break; }
            foreach (var f in files)
            {
                yield return f;
            }

            if (depth <= 0)
            {
                yield break;
            }

            IEnumerable<string> subdirs;
            try { subdirs = Directory.EnumerateDirectories(dir).ToList(); }
            catch { yield break; }
            foreach (var sub in subdirs)
            {
                var name = Path.GetFileName(sub);
                if (name.StartsWith(".", StringComparison.Ordinal) ||
                    name.Equals("bin", StringComparison.OrdinalIgnoreCase) ||
                    name.Equals("obj", StringComparison.OrdinalIgnoreCase) ||
                    name.Equals("artifacts", StringComparison.OrdinalIgnoreCase) ||
                    name.Equals("node_modules", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                foreach (var f in EnumerateXaml(sub, depth - 1))
                {
                    yield return f;
                }
            }
        }

        private static bool IsApplicationRoot(string xamlPath)
        {
            try
            {
                using var reader = System.Xml.XmlReader.Create(xamlPath, new System.Xml.XmlReaderSettings { DtdProcessing = System.Xml.DtdProcessing.Prohibit });
                return reader.MoveToContent() == System.Xml.XmlNodeType.Element && reader.LocalName == "Application";
            }
            catch
            {
                return false;
            }
        }

        /// <summary>
        /// Decides whether a <c>.xaml</c> document belongs to a <b>WinUI 3</b> project, so the preview margin
        /// can skip WPF and UWP XAML (whose default namespace URI is identical to WinUI's, so they can't be
        /// told apart from the markup alone). Reads the owning <c>.csproj</c> (and, when inconclusive, nearby
        /// <c>Directory.Build.props</c>) for framework markers: <c>Microsoft.WindowsAppSDK</c> / <c>UseWinUI</c>
        /// mean WinUI 3; <c>UseWPF</c>/<c>PresentationFramework</c> mean WPF; <c>uap10.0</c>/
        /// <c>UniversalWindowsPlatform</c>/<c>TargetPlatformIdentifier=UAP</c> mean UWP. As a final tie-break the
        /// markup's <c>clr-namespace:</c> (WPF) vs <c>using:</c> (WinUI/UWP) mapping syntax is consulted. When
        /// nothing is conclusive it errs toward showing (returns true) so a genuine WinUI file is never hidden.
        /// Every failure path returns true for the same reason. Cheap and synchronous — safe on the UI thread.
        /// </summary>
        public static bool IsWinUiXaml(string? xamlPath, Action<string>? log = null) =>
            NonWinUiFramework(xamlPath, log) == null;

        /// <summary>
        /// "UWP" or "WPF" when <paramref name="xamlPath"/> belongs to that framework and must not be previewed;
        /// null when it is (or may be) WinUI 3. See <see cref="IsWinUiXaml"/>.
        /// </summary>
        public static string? NonWinUiFramework(string? xamlPath, Action<string>? log = null)
        {
            log ??= _ => { };

            if (string.IsNullOrWhiteSpace(xamlPath))
            {
                return null; // can't inspect — don't suppress
            }

            try
            {
                var projects = FindOwningProjectFiles(xamlPath!);
                if (projects.Count > 0)
                {
                    var verdict = FrameworkKind.Unknown;
                    foreach (var project in projects)
                    {
                        verdict = Classify(SafeRead(project));
                        if (verdict != FrameworkKind.Unknown)
                        {
                            break;
                        }
                    }

                    if (verdict == FrameworkKind.WinUi) { log("WinUI 3 project detected — previewer enabled."); return null; }
                    if (verdict == FrameworkKind.Wpf) { log("WPF project detected — WinUI previewer suppressed."); return "WPF"; }
                    if (verdict == FrameworkKind.Uwp) { log("UWP project detected — WinUI previewer suppressed."); return "UWP"; }

                    // Project was inconclusive (e.g. UseWinUI lives in a shared props file): scan up the tree.
                    var propsVerdict = ScanParentProps(Path.GetDirectoryName(projects[0]));
                    if (propsVerdict == FrameworkKind.WinUi) { log("WinUI 3 markers found in Directory.Build.props — previewer enabled."); return null; }
                    if (propsVerdict == FrameworkKind.Wpf) { log("WPF markers found in shared props — WinUI previewer suppressed."); return "WPF"; }
                    if (propsVerdict == FrameworkKind.Uwp) { log("UWP markers found in shared props — WinUI previewer suppressed."); return "UWP"; }
                }

                // No project verdict — fall back to a markup heuristic. WPF maps CLR namespaces with
                // "clr-namespace:"; WinUI/UWP use "using:". A "clr-namespace:" is therefore a strong WPF signal.
                var markup = SafeRead(xamlPath!);
                if (markup != null && markup.IndexOf("clr-namespace:", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    log("Markup uses clr-namespace: (WPF) — WinUI previewer suppressed.");
                    return "WPF";
                }

                return null; // ambiguous — err toward showing so real WinUI is never hidden
            }
            catch (Exception ex)
            {
                log("WinUI detection failed (showing anyway): " + ex.Message);
                return null;
            }
        }

        /// <summary>The project files (.csproj, .vcxproj, .vbproj) in the nearest folder at or above the page that has any.</summary>
        private static List<string> FindOwningProjectFiles(string startPath)
        {
            var found = new List<string>();
            DirectoryInfo? dir;
            try
            {
                dir = File.Exists(startPath) ? new FileInfo(startPath).Directory : new DirectoryInfo(startPath);
            }
            catch
            {
                return found;
            }

            for (int i = 0; dir != null && i < 30; i++)
            {
                try
                {
                    foreach (var pattern in new[] { "*.csproj", "*.vcxproj", "*.vbproj" })
                    {
                        found.AddRange(Directory.EnumerateFiles(dir.FullName, pattern, SearchOption.TopDirectoryOnly));
                    }

                    if (found.Count > 0)
                    {
                        return found;
                    }
                }
                catch
                {
                    // ignore access errors, keep walking up
                }

                dir = dir.Parent;
            }

            return found;
        }

        /// <summary>True when the project file (or a parent Directory.Build.props) carries WinUI 3 markers.</summary>
        public static bool IsWinUiProject(string csprojPath)
        {
            try
            {
                return Classify(SafeRead(csprojPath)) == FrameworkKind.WinUi
                    || ScanParentProps(Path.GetDirectoryName(csprojPath)) == FrameworkKind.WinUi;
            }
            catch
            {
                return false;
            }
        }

        private enum FrameworkKind { Unknown, WinUi, Wpf, Uwp }

        private static FrameworkKind Classify(string? projectText)
        {
            if (string.IsNullOrEmpty(projectText))
            {
                return FrameworkKind.Unknown;
            }

            // Squash whitespace so "<UseWinUI> true </UseWinUI>" and attribute spacing match reliably.
            var t = projectText!;

            // .NET UWP (UseUwp) is explicit about using system XAML, even if the project also pulls in other packages.
            if (HasBoolProp(t, "UseUwp"))
            {
                return FrameworkKind.Uwp;
            }

            // WinUI 3 is checked next — its markers are unambiguous and a WinUI project never carries the others.
            if (Has(t, "Microsoft.WindowsAppSDK") || HasBoolProp(t, "UseWinUI") || Has(t, "Microsoft.WinUI"))
            {
                return FrameworkKind.WinUi;
            }

            if (HasBoolProp(t, "UseWPF") || Has(t, "PresentationFramework") || Has(t, "Microsoft.NET.Sdk.WindowsDesktop"))
            {
                return FrameworkKind.Wpf;
            }

            if (Has(t, "uap10.0") || Has(t, "UniversalWindowsPlatform") ||
                Has(t, "<TargetPlatformIdentifier>UAP") || Has(t, "Windows.Foundation.UniversalApiContract") ||
                HasBoolProp(t, "AppContainerApplication")) // C++/CX and C++/WinRT UWP (.vcxproj)
            {
                return FrameworkKind.Uwp;
            }

            return FrameworkKind.Unknown;
        }

        private static FrameworkKind ScanParentProps(string? startDir)
        {
            try
            {
                var dir = startDir == null ? null : new DirectoryInfo(startDir);
                for (int i = 0; dir != null && i < 6; i++)
                {
                    foreach (var name in new[] { "Directory.Build.props", "Directory.Packages.props" })
                    {
                        var p = Path.Combine(dir.FullName, name);
                        if (File.Exists(p))
                        {
                            var verdict = Classify(SafeRead(p));
                            if (verdict != FrameworkKind.Unknown)
                            {
                                return verdict;
                            }
                        }
                    }

                    dir = dir.Parent;
                }
            }
            catch
            {
                // ignore — inconclusive
            }

            return FrameworkKind.Unknown;
        }

        private static bool Has(string haystack, string needle) =>
            haystack.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0;

        // Matches "<UseWinUI>true</UseWinUI>" tolerant of whitespace/casing, without a regex dependency.
        private static bool HasBoolProp(string text, string prop)
        {
            int i = 0;
            while (true)
            {
                int open = text.IndexOf("<" + prop, i, StringComparison.OrdinalIgnoreCase);
                if (open < 0)
                {
                    return false;
                }

                int close = text.IndexOf("</" + prop, open, StringComparison.OrdinalIgnoreCase);
                if (close > open)
                {
                    var inner = text.Substring(open, close - open);
                    if (inner.IndexOf("true", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        return true;
                    }
                }

                i = open + prop.Length + 1;
            }
        }

        private static string? SafeRead(string path)
        {
            try
            {
                return File.ReadAllText(path);
            }
            catch
            {
                return null;
            }
        }

        // BB-066: owners Visual Studio reported for open documents (linked pages, folders with several projects).
        private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, string> s_knownOwners =
            new System.Collections.Concurrent.ConcurrentDictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        /// <summary>
        /// Records the project that owns <paramref name="xamlPath"/> (from Visual Studio). A null or non-.csproj
        /// owner forgets any earlier answer, so discovery falls back to walking up from the file.
        /// </summary>
        internal static void RememberOwner(string xamlPath, string? csproj)
        {
            string key;
            try { key = Path.GetFullPath(xamlPath); }
            catch { return; }

            if (!string.IsNullOrEmpty(csproj) && csproj!.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase) && File.Exists(csproj))
            {
                s_knownOwners[key] = csproj;
            }
            else
            {
                s_knownOwners.TryRemove(key, out _);
            }
        }

        /// <summary>
        /// The project that owns <paramref name="startPath"/>: the one Visual Studio reported (see
        /// <see cref="RememberOwner"/>), else the nearest <c>.csproj</c> walking up from it.
        /// </summary>
        internal static string? FindOwningCsproj(string? startPath)
        {
            if (string.IsNullOrWhiteSpace(startPath))
            {
                return null;
            }

            DirectoryInfo? dir;
            try
            {
                if (s_knownOwners.TryGetValue(Path.GetFullPath(startPath!), out var known) && File.Exists(known))
                {
                    return known;
                }
                dir = File.Exists(startPath) ? new FileInfo(startPath!).Directory : new DirectoryInfo(startPath!);
            }
            catch
            {
                return null;
            }

            for (int i = 0; dir != null && i < 30; i++)
            {
                try
                {
                    var found = Directory.EnumerateFiles(dir.FullName, "*.csproj", SearchOption.TopDirectoryOnly).ToList();
                    if (found.Count > 0)
                    {
                        return PickCsproj(found, dir.FullName);
                    }
                }
                catch
                {
                    // ignore access errors, keep walking up
                }

                dir = dir.Parent;
            }

            return null;
        }

        /// <summary>
        /// BB-066: picks among several <c>.csproj</c> files in one folder instead of the alphabetically first: a
        /// restored project (it has <c>obj\&lt;file&gt;.nuget.g.props</c>) beats a never-built one, then a project
        /// named after its folder, then the first by name.
        /// </summary>
        internal static string PickCsproj(IReadOnlyList<string> candidates, string dir)
        {
            if (candidates.Count == 1)
            {
                return candidates[0];
            }

            var folder = Path.GetFileName(dir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
            return candidates
                .OrderByDescending(p => File.Exists(Path.Combine(dir, "obj", Path.GetFileName(p) + ".nuget.g.props")))
                .ThenByDescending(p => string.Equals(Path.GetFileNameWithoutExtension(p), folder, StringComparison.OrdinalIgnoreCase))
                .ThenBy(p => Path.GetFileName(p), StringComparer.OrdinalIgnoreCase)
                .First();
        }
    }
}
