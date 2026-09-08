#nullable enable

using System;
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
            var assemblyName = Path.GetFileNameWithoutExtension(csproj);
            var binDir = Path.Combine(projectDir, "bin");
            if (!Directory.Exists(binDir))
            {
                log($"No bin directory under {projectDir}; rendering framework-only.");
                return null;
            }

            try
            {
                var dlls = Directory
                    .EnumerateFiles(binDir, assemblyName + ".dll", SearchOption.AllDirectories)
                    .OrderByDescending(File.GetLastWriteTimeUtc)
                    .ToList();

                if (dlls.Count == 0)
                {
                    log($"No {assemblyName}.dll under {binDir}; rendering framework-only.");
                    return null;
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
                    log($"Only a packaged (MSIX) build of {assemblyName} was found ({dll}). The preview host " +
                        "will register a sparse package identity so this build can be hosted (requires Windows " +
                        "Developer Mode). Custom controls resolve once identity is active.");
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

            log($"No App.xaml next to {Path.GetFileName(csproj)}; app resource scope skipped.");
            return null;
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
        public static bool IsWinUiXaml(string? xamlPath, Action<string>? log = null)
        {
            log ??= _ => { };

            if (string.IsNullOrWhiteSpace(xamlPath))
            {
                return true; // can't inspect — don't suppress
            }

            try
            {
                var csproj = FindOwningCsproj(xamlPath!);
                if (csproj != null)
                {
                    var verdict = Classify(SafeRead(csproj));
                    if (verdict == FrameworkKind.WinUi) { log("WinUI 3 project detected — designer enabled."); return true; }
                    if (verdict == FrameworkKind.Wpf) { log("WPF project detected — WinUI designer suppressed."); return false; }
                    if (verdict == FrameworkKind.Uwp) { log("UWP project detected — WinUI designer suppressed."); return false; }

                    // csproj was inconclusive (e.g. UseWinUI lives in a shared props file): scan up the tree.
                    var propsVerdict = ScanParentProps(Path.GetDirectoryName(csproj));
                    if (propsVerdict == FrameworkKind.WinUi) { log("WinUI 3 markers found in Directory.Build.props — designer enabled."); return true; }
                    if (propsVerdict == FrameworkKind.Wpf) { log("WPF markers found in shared props — WinUI designer suppressed."); return false; }
                    if (propsVerdict == FrameworkKind.Uwp) { log("UWP markers found in shared props — WinUI designer suppressed."); return false; }
                }

                // No project verdict — fall back to a markup heuristic. WPF maps CLR namespaces with
                // "clr-namespace:"; WinUI/UWP use "using:". A "clr-namespace:" is therefore a strong WPF signal.
                var markup = SafeRead(xamlPath!);
                if (markup != null && markup.IndexOf("clr-namespace:", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    log("Markup uses clr-namespace: (WPF) — WinUI designer suppressed.");
                    return false;
                }

                return true; // ambiguous — err toward showing so real WinUI is never hidden
            }
            catch (Exception ex)
            {
                log("WinUI detection failed (showing anyway): " + ex.Message);
                return true;
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

            // WinUI 3 is checked first — its markers are unambiguous and a WinUI project never carries the others.
            if (Has(t, "Microsoft.WindowsAppSDK") || HasBoolProp(t, "UseWinUI") || Has(t, "Microsoft.WinUI"))
            {
                return FrameworkKind.WinUi;
            }

            if (HasBoolProp(t, "UseWPF") || Has(t, "PresentationFramework") || Has(t, "Microsoft.NET.Sdk.WindowsDesktop"))
            {
                return FrameworkKind.Wpf;
            }

            if (Has(t, "uap10.0") || Has(t, "UniversalWindowsPlatform") ||
                Has(t, "<TargetPlatformIdentifier>UAP") || Has(t, "Windows.Foundation.UniversalApiContract"))
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

        private static string? FindOwningCsproj(string startPath)
        {
            DirectoryInfo? dir;
            try
            {
                dir = File.Exists(startPath) ? new FileInfo(startPath).Directory : new DirectoryInfo(startPath);
            }
            catch
            {
                return null;
            }

            for (int i = 0; dir != null && i < 30; i++)
            {
                try
                {
                    var csproj = Directory.EnumerateFiles(dir.FullName, "*.csproj", SearchOption.TopDirectoryOnly)
                        .FirstOrDefault();
                    if (csproj != null)
                    {
                        return csproj;
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
    }
}
