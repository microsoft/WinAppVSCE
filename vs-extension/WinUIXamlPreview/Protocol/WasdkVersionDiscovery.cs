#nullable enable

using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Xml.Linq;

namespace WinUIXamlPreview.Protocol
{
    /// <summary>How a project's Windows App SDK version was discovered (for logging / diagnostics).</summary>
    internal enum WasdkVersionSource
    {
        NotFound,
        ProjectAssetsJson,
        DirectoryPackagesProps,
        CsprojPackageReference,
    }

    internal readonly struct WasdkVersionResult
    {
        public WasdkVersionResult(string? version, WasdkVersionSource source, string? sourcePath)
        {
            Version = version;
            Source = source;
            SourcePath = sourcePath;
        }

        public string? Version { get; }
        public WasdkVersionSource Source { get; }
        public string? SourcePath { get; }
        public bool Found => !string.IsNullOrEmpty(Version);
    }

    /// <summary>
    /// In-process, synchronous discovery of a target project's RESOLVED Microsoft.WindowsAppSDK version,
    /// so the preview can pick the right host BEFORE launching anything. A net472 port of the certified
    /// <c>SurfaceProvisioner.Provisioner.DiscoverVersion</c> logic (project.assets.json →
    /// Directory.Packages.props → csproj PackageReference), kept byte-equivalent to the provisioner so the
    /// VSIX and the build tool agree on the version. Deliberately BCL-only (System.Text.Json +
    /// System.Xml.Linq, both already referenced by this project) and free of any build toolchain, so it
    /// works even on a machine with no .NET SDK — the resolver still knows "this is a 2.2.5 project" and
    /// can show the right fallback note. Every failure path returns NotFound; never throws into the editor.
    /// </summary>
    internal static class WasdkVersionDiscovery
    {
        private const string Metapackage = "Microsoft.WindowsAppSDK";

        /// <summary>
        /// Discover the WASDK version that owns <paramref name="xamlPath"/>. Walks up to the nearest
        /// <c>.csproj</c>, then reads (in priority order) the resolved graph, central package management,
        /// and the project file.
        /// </summary>
        public static WasdkVersionResult Discover(string? xamlPath, Action<string>? log = null)
        {
            log ??= _ => { };

            try
            {
                var csproj = FindOwningCsproj(xamlPath);
                if (csproj == null)
                {
                    log("WASDK discovery: no owning .csproj found.");
                    return new WasdkVersionResult(null, WasdkVersionSource.NotFound, null);
                }

                var projectDir = Path.GetDirectoryName(csproj)!;

                // 1. obj\project.assets.json — the authoritative resolved dependency graph.
                var assets = Path.Combine(projectDir, "obj", "project.assets.json");
                if (File.Exists(assets))
                {
                    var v = ReadVersionFromAssets(assets);
                    if (v != null)
                    {
                        log($"WASDK discovery: {v} (project.assets.json).");
                        return new WasdkVersionResult(v, WasdkVersionSource.ProjectAssetsJson, assets);
                    }
                }

                // 2. Directory.Packages.props (central package management), walking up.
                var dpp = FindUpwards(projectDir, "Directory.Packages.props");
                if (dpp != null)
                {
                    var v = ReadVersionFromXmlItem(dpp, "PackageVersion", Metapackage);
                    if (v != null)
                    {
                        log($"WASDK discovery: {v} (Directory.Packages.props).");
                        return new WasdkVersionResult(v, WasdkVersionSource.DirectoryPackagesProps, dpp);
                    }
                }

                // 3. csproj PackageReference.
                var vc = ReadVersionFromXmlItem(csproj, "PackageReference", Metapackage);
                if (vc != null)
                {
                    log($"WASDK discovery: {vc} (csproj PackageReference).");
                    return new WasdkVersionResult(vc, WasdkVersionSource.CsprojPackageReference, csproj);
                }

                log("WASDK discovery: no Microsoft.WindowsAppSDK version found.");
                return new WasdkVersionResult(null, WasdkVersionSource.NotFound, null);
            }
            catch (Exception ex)
            {
                log("WASDK discovery failed: " + ex.Message);
                return new WasdkVersionResult(null, WasdkVersionSource.NotFound, null);
            }
        }

        private static string? ReadVersionFromAssets(string assetsPath)
        {
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(assetsPath));
                if (doc.RootElement.TryGetProperty("libraries", out var libs) && libs.ValueKind == JsonValueKind.Object)
                {
                    foreach (var lib in libs.EnumerateObject())
                    {
                        var slash = lib.Name.IndexOf('/');
                        if (slash > 0 &&
                            lib.Name.AsSpan(0, slash).Equals(Metapackage.AsSpan(), StringComparison.OrdinalIgnoreCase))
                        {
                            return lib.Name.Substring(slash + 1);
                        }
                    }
                }
            }
            catch
            {
                // malformed / partial assets file — treat as not found, fall through to props/csproj
            }

            return null;
        }

        private static string? ReadVersionFromXmlItem(string xmlPath, string itemName, string include)
        {
            try
            {
                var xml = XDocument.Load(xmlPath);
                foreach (var el in xml.Descendants().Where(e => e.Name.LocalName == itemName))
                {
                    var inc = (string?)el.Attribute("Include") ?? (string?)el.Attribute("Update");
                    if (inc != null && inc.Equals(include, StringComparison.OrdinalIgnoreCase))
                    {
                        var ver = (string?)el.Attribute("Version")
                                  ?? el.Elements().FirstOrDefault(c => c.Name.LocalName == "Version")?.Value;
                        if (!string.IsNullOrWhiteSpace(ver))
                        {
                            return ver!.Trim();
                        }
                    }
                }
            }
            catch
            {
                // unreadable xml — treat as not found
            }

            return null;
        }

        private static string? FindUpwards(string startDir, string fileName)
        {
            try
            {
                var dir = new DirectoryInfo(startDir);
                for (int i = 0; dir != null && i < 30; i++)
                {
                    var p = Path.Combine(dir.FullName, fileName);
                    if (File.Exists(p))
                    {
                        return p;
                    }

                    dir = dir.Parent;
                }
            }
            catch
            {
                // ignore
            }

            return null;
        }

        internal static string? FindOwningCsproj(string? startPath)
        {
            if (string.IsNullOrWhiteSpace(startPath))
            {
                return null;
            }

            DirectoryInfo? dir;
            try
            {
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
