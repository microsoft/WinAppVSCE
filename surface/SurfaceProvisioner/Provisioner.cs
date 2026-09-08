#nullable enable

using System.Security.Cryptography;
using System.Text.Json;
using System.Xml.Linq;

namespace SurfaceProvisioner;

/// <summary>How the native payload for the resolved WASDK version was located.</summary>
public enum NativeSourceKind
{
    ProjectSelfContainedBin,
    NuGetCache,
    InstalledRuntime,
    Downloaded,
    NotFound,
}

/// <summary>Where the target project's resolved WASDK version came from.</summary>
public enum VersionSourceKind
{
    ProjectAssetsJson,
    DirectoryPackagesProps,
    CsprojPackageReference,
    NotFound,
}

/// <summary>Per-file overlay verification (SHA256 + size — never FileVersion).</summary>
public sealed class NativeFileResult
{
    public required string Name { get; init; }
    public long Size { get; init; }
    public required string Sha256 { get; init; }
    public bool Verified { get; init; }
    public bool IsManagedSkipped { get; init; }
}

public sealed class ProvisionOptions
{
    /// <summary>Target project .csproj OR the project directory.</summary>
    public required string ProjectPath { get; init; }

    /// <summary>The self-contained Surface base host directory (contains Surface.exe + app-local native).</summary>
    public required string BaseHostDir { get; init; }

    /// <summary>Output directory for the version-matched host (a copy of the base host + overlaid native).</summary>
    public required string OutDir { get; init; }

    /// <summary>NuGet global-packages folder. Defaults to NUGET_PACKAGES env, then %USERPROFILE%\.nuget\packages.</summary>
    public string? NuGetCache { get; init; }

    /// <summary>Runtime identifier native sub-path. Default win-x64.</summary>
    public string Rid { get; init; } = "win-x64";

    /// <summary>Enable the last-resort download from the NuGet flat-container. Default false (offline).</summary>
    public bool AllowDownload { get; init; }
}

public sealed class ProvisionResult
{
    public bool Success { get; set; }
    public string? Error { get; set; }
    public bool Cancelled { get; set; }

    public string? DiscoveredVersion { get; set; }
    public VersionSourceKind VersionSource { get; set; }
    public string? VersionSourcePath { get; set; }

    public string? WinUiComponentVersion { get; set; }
    public string? MetapackageNuspecPath { get; set; }

    public NativeSourceKind NativeSource { get; set; }
    public string? NativeSourceDir { get; set; }
    public string? OutHostDir { get; set; }

    public List<NativeFileResult> NativeFiles { get; } = new();

    /// <summary>Managed projection left at base (proof it was NOT overlaid).</summary>
    public string? ManagedProjectionSha256 { get; set; }
    public long ManagedProjectionSize { get; set; }
}

/// <summary>
/// IDE-neutral native-only overlay. This is degraded compatibility, not a matched managed/native host.
/// </summary>
public static class Provisioner
{
    private const string Metapackage = "Microsoft.WindowsAppSDK";
    private const string WinUiComponent = "Microsoft.WindowsAppSDK.WinUI";
    private const string ManagedProjection = "Microsoft.WinUI.dll";
    private const string NativeAnchor = "Microsoft.ui.xaml.dll";

    public static ProvisionResult Provision(ProvisionOptions opt, Action<string>? log = null, CancellationToken cancellation = default)
    {
        log ??= _ => { };
        var result = new ProvisionResult();

        try
        {
            cancellation.ThrowIfCancellationRequested();
            var (projectDir, csproj) = NormalizeProject(opt.ProjectPath);
            var cache = ResolveNuGetCache(opt.NuGetCache);
            log($"project dir : {projectDir}");
            log($"nuget cache : {cache}");

            // (a) discover the RESOLVED WASDK version.
            var (version, vsrc, vpath) = DiscoverWasdkVersion(projectDir, csproj, log);
            result.DiscoveredVersion = version;
            result.VersionSource = vsrc;
            result.VersionSourcePath = vpath;
            if (version == null)
            {
                result.Error = "Could not discover a Microsoft.WindowsAppSDK version from project.assets.json, Directory.Packages.props, or the csproj.";
                return result;
            }
            log($"discovered WASDK = {version}  (via {vsrc}: {vpath})");

            // (b) resolve the WinUI component sub-version from the metapackage nuspec.
            var (comp, nuspec) = ResolveWinUiComponent(version, cache, log);
            result.WinUiComponentVersion = comp;
            result.MetapackageNuspecPath = nuspec;
            if (comp == null)
            {
                result.Error = $"Could not resolve the {WinUiComponent} sub-version from the {Metapackage} {version} nuspec (cache miss at {cache}).";
                return result;
            }
            log($"resolved WinUI component = {comp}  (via {nuspec})");

            // (c) locate the native payload for that component.
            var (nativeDir, nkind) = LocateNative(projectDir, comp, cache, opt.Rid, opt.AllowDownload, log);
            result.NativeSource = nkind;
            result.NativeSourceDir = nativeDir;
            if (nativeDir == null)
            {
                result.Error = $"Could not locate native DLLs for {WinUiComponent} {comp} (rid {opt.Rid}). "
                    + "Tried: project self-contained bin, nuget cache runtimes-framework, installed runtime"
                    + (opt.AllowDownload ? ", flat-container download." : " (download disabled — pass --allow-download to enable).");
                return result;
            }
            log($"located native = {nativeDir}  (source {nkind})");
            cancellation.ThrowIfCancellationRequested();

            // (d)+(e) overlay ONLY native onto a COPY of the base host, verify each by SHA256 + size.
            OverlayAndVerify(opt.BaseHostDir, nativeDir, opt.OutDir, result, log, cancellation);
            result.OutHostDir = opt.OutDir;
            result.Success = result.NativeFiles.Any(f => !f.IsManagedSkipped) && result.NativeFiles.Where(f => !f.IsManagedSkipped).All(f => f.Verified);
            if (!result.Success && result.Error == null)
            {
                result.Error = "One or more native files failed SHA256/size verification after overlay.";
            }
            return result;
        }
        catch (OperationCanceledException)
        {
            result.Cancelled = true;
            result.Error = "Native overlay cancelled.";
            return result;
        }
        catch (Exception ex)
        {
            result.Error = ex.Message;
            return result;
        }
    }

    // ---- Public reuse surface for the build-based per-version host provisioner (HostBuilder) ---------

    /// <summary>Discover a target project's resolved WASDK version (assets.json → Directory.Packages.props → csproj).</summary>
    public static (string? version, VersionSourceKind source, string? path) DiscoverVersion(string projectPath, Action<string>? log = null)
    {
        log ??= _ => { };
        var (dir, csproj) = NormalizeProject(projectPath);
        return DiscoverWasdkVersion(dir, csproj, log);
    }

    /// <summary>Map a metapackage version to its Microsoft.WindowsAppSDK.WinUI sub-version via the cached nuspec.</summary>
    public static (string? component, string? nuspec) ResolveComponent(string metaVersion, string? nugetCache = null, Action<string>? log = null)
    {
        log ??= _ => { };
        return ResolveWinUiComponent(metaVersion, ResolveNuGetCache(nugetCache), log);
    }

    /// <summary>The effective NuGet global-packages cache root (explicit → NUGET_PACKAGES → %USERPROFILE%\.nuget\packages).</summary>
    public static string NuGetCacheRoot(string? explicitCache = null) => ResolveNuGetCache(explicitCache);

    /// <summary>SHA256 hex of a file (uppercase, no separators).</summary>
    public static string HashFile(string path) => Sha256(path);

    /// <summary>Locate the WinUI component's cached native dir (1.8+ runtimes-framework layout), or null.</summary>
    public static string? LocateComponentNative(string component, string? nugetCache = null, string rid = "win-x64")
    {
        var cache = ResolveNuGetCache(nugetCache);
        var loose = Path.Combine(cache, WinUiComponent.ToLowerInvariant(), component, "runtimes-framework", rid, "native");
        return Directory.Exists(loose) && File.Exists(Path.Combine(loose, NativeAnchor)) ? loose : null;
    }

    /// <summary>Locate the WinUI component's cached MANAGED projection (Microsoft.WinUI.dll), or null.</summary>
    public static string? LocateComponentManaged(string component, string? nugetCache = null)
    {
        var cache = ResolveNuGetCache(nugetCache);
        var root = Path.Combine(cache, WinUiComponent.ToLowerInvariant(), component);
        if (!Directory.Exists(root)) return null;
        try
        {
            return Directory.EnumerateFiles(root, ManagedProjection, SearchOption.AllDirectories)
                .OrderByDescending(f => new FileInfo(f).Length)
                .FirstOrDefault();
        }
        catch { return null; }
    }

    /// <summary>The managed-projection and native-anchor file names, for callers verifying a built host.</summary>
    public static string ManagedProjectionName => ManagedProjection;
    public static string NativeAnchorName => NativeAnchor;

    private static (string dir, string? csproj) NormalizeProject(string projectPath)
    {
        if (File.Exists(projectPath) && projectPath.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase))
        {
            return (Path.GetDirectoryName(Path.GetFullPath(projectPath))!, Path.GetFullPath(projectPath));
        }
        var dir = Path.GetFullPath(projectPath);
        var csproj = Directory.Exists(dir)
            ? Directory.EnumerateFiles(dir, "*.csproj").FirstOrDefault()
            : null;
        return (dir, csproj);
    }

    private static (string? version, VersionSourceKind src, string? path) DiscoverWasdkVersion(
        string projectDir, string? csproj, Action<string> log)
    {
        // 1. project.assets.json (authoritative resolved graph).
        var assets = Path.Combine(projectDir, "obj", "project.assets.json");
        if (File.Exists(assets))
        {
            var v = ReadVersionFromAssets(assets);
            if (v != null) return (v, VersionSourceKind.ProjectAssetsJson, assets);
            log("project.assets.json present but no Microsoft.WindowsAppSDK entry — falling back.");
        }

        // 2. Directory.Packages.props (central package management), walking up.
        var dpp = FindUpwards(projectDir, "Directory.Packages.props");
        if (dpp != null)
        {
            var v = ReadVersionFromXmlItem(dpp, "PackageVersion", Metapackage);
            if (v != null) return (v, VersionSourceKind.DirectoryPackagesProps, dpp);
        }

        // 3. csproj PackageReference.
        if (csproj != null && File.Exists(csproj))
        {
            var v = ReadVersionFromXmlItem(csproj, "PackageReference", Metapackage);
            if (v != null) return (v, VersionSourceKind.CsprojPackageReference, csproj);
        }

        return (null, VersionSourceKind.NotFound, null);
    }

    private static string? ReadVersionFromAssets(string assetsPath)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(assetsPath));
        // Look in "libraries" for the exact metapackage key "Microsoft.WindowsAppSDK/<ver>".
        if (doc.RootElement.TryGetProperty("libraries", out var libs) && libs.ValueKind == JsonValueKind.Object)
        {
            foreach (var lib in libs.EnumerateObject())
            {
                var slash = lib.Name.IndexOf('/');
                if (slash > 0 &&
                    lib.Name.AsSpan(0, slash).Equals(Metapackage, StringComparison.OrdinalIgnoreCase))
                {
                    return lib.Name[(slash + 1)..];
                }
            }
        }
        return null;
    }

    private static string? ReadVersionFromXmlItem(string xmlPath, string itemName, string include)
    {
        var xml = XDocument.Load(xmlPath);
        foreach (var el in xml.Descendants().Where(e => e.Name.LocalName == itemName))
        {
            var inc = (string?)el.Attribute("Include") ?? (string?)el.Attribute("Update");
            if (inc != null && inc.Equals(include, StringComparison.OrdinalIgnoreCase))
            {
                var ver = (string?)el.Attribute("Version")
                          ?? el.Elements().FirstOrDefault(c => c.Name.LocalName == "Version")?.Value;
                if (!string.IsNullOrWhiteSpace(ver)) return ver.Trim();
            }
        }
        return null;
    }

    // ---- (b) component resolution ---------------------------------------------------------------

    private static (string? comp, string? nuspec) ResolveWinUiComponent(string metaVersion, string cache, Action<string> log)
    {
        var nuspec = Path.Combine(cache, Metapackage.ToLowerInvariant(), metaVersion, Metapackage.ToLowerInvariant() + ".nuspec");
        if (!File.Exists(nuspec))
        {
            log($"metapackage nuspec not cached: {nuspec}");
            return (null, null);
        }
        var xml = XDocument.Load(nuspec);
        // Namespace-agnostic: match <dependency id="Microsoft.WindowsAppSDK.WinUI" version="..."/> by local name.
        foreach (var dep in xml.Descendants().Where(e => e.Name.LocalName == "dependency"))
        {
            var id = (string?)dep.Attribute("id");
            if (id != null && id.Equals(WinUiComponent, StringComparison.OrdinalIgnoreCase))
            {
                var ver = ((string?)dep.Attribute("version"))?.Trim().Trim('[', ']', '(', ')');
                // A version range like "[2.2.1]" reduces to the pinned value; take the first token.
                if (!string.IsNullOrWhiteSpace(ver))
                {
                    var comma = ver.IndexOf(',');
                    return (comma >= 0 ? ver[..comma] : ver, nuspec);
                }
            }
        }
        return (null, nuspec);
    }

    // ---- (c) native location --------------------------------------------------------------------

    private static (string? dir, NativeSourceKind kind) LocateNative(
        string projectDir, string comp, string cache, string rid, bool allowDownload, Action<string> log)
    {
        // Priority 1: the target project's own self-contained bin (exactly what it resolved).
        var fromBin = FindNativeInProjectBin(projectDir);
        if (fromBin != null) return (fromBin, NativeSourceKind.ProjectSelfContainedBin);

        // Priority 2a: nuget cache component (1.8+ loose native layout).
        var compRoot = Path.Combine(cache, WinUiComponent.ToLowerInvariant(), comp);
        var loose = Path.Combine(compRoot, "runtimes-framework", rid, "native");
        if (Directory.Exists(loose) && File.Exists(Path.Combine(loose, NativeAnchor)))
        {
            return (loose, NativeSourceKind.NuGetCache);
        }

        // Defensive: <=1.7 layout ships native inside a framework MSIX under tools\MSIX\win10-<arch>.
        var msixDir = Path.Combine(compRoot, "tools", "MSIX");
        if (Directory.Exists(msixDir))
        {
            log($"NOTE: component {comp} uses the <=1.7 framework-MSIX layout ({msixDir}). "
                + "MSIX extraction is not implemented in this build — skipping (detected, not hit for 1.8+ targets).");
        }

        // Priority 2b: installed Windows App Runtime (framework package). Best-effort; often ACL-gated.
        var installed = FindInstalledRuntimeNative(comp, rid, log);
        if (installed != null) return (installed, NativeSourceKind.InstalledRuntime);

        // Priority 3: last-resort download from the NuGet flat-container.
        if (allowDownload)
        {
            var dl = TryDownloadNative(comp, rid, cache, log);
            if (dl != null) return (dl, NativeSourceKind.Downloaded);
        }

        return (null, NativeSourceKind.NotFound);
    }

    private static string? FindNativeInProjectBin(string projectDir)
    {
        var bin = Path.Combine(projectDir, "bin");
        if (!Directory.Exists(bin)) return null;
        try
        {
            var hit = Directory.EnumerateFiles(bin, NativeAnchor, SearchOption.AllDirectories)
                .OrderByDescending(File.GetLastWriteTimeUtc)
                .FirstOrDefault();
            return hit != null ? Path.GetDirectoryName(hit) : null;
        }
        catch { return null; }
    }

    private static string? FindInstalledRuntimeNative(string comp, string rid, Action<string> log)
    {
        // Framework packages install under C:\Program Files\WindowsApps\Microsoft.WindowsAppRuntime.*.
        var apps = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "WindowsApps");
        if (!Directory.Exists(apps)) return null;
        try
        {
            foreach (var d in Directory.EnumerateDirectories(apps, "Microsoft.WindowsAppRuntime.*"))
            {
                var candidate = Path.Combine(d, NativeAnchor);
                if (File.Exists(candidate)) return d;
            }
        }
        catch (UnauthorizedAccessException)
        {
            log("installed-runtime scan skipped (WindowsApps is ACL-gated).");
        }
        catch { }
        return null;
    }

    private static string? TryDownloadNative(string comp, string rid, string cache, Action<string> log)
    {
        try
        {
            var id = WinUiComponent.ToLowerInvariant();
            var url = $"https://api.nuget.org/v3-flatcontainer/{id}/{comp}/{id}.{comp}.nupkg";
            log($"downloading {url} ...");
            var tmp = Path.Combine(Path.GetTempPath(), $"winui-{comp}-{Guid.NewGuid():N}");
            Directory.CreateDirectory(tmp);
            var nupkg = Path.Combine(tmp, "pkg.nupkg.zip");
            using (var http = new HttpClient())
            using (var s = http.GetStreamAsync(url).GetAwaiter().GetResult())
            using (var fs = File.Create(nupkg))
            {
                s.CopyTo(fs);
            }
            System.IO.Compression.ZipFile.ExtractToDirectory(nupkg, tmp);
            var native = Path.Combine(tmp, "runtimes-framework", rid, "native");
            return Directory.Exists(native) && File.Exists(Path.Combine(native, NativeAnchor)) ? native : null;
        }
        catch (Exception ex)
        {
            log($"download failed: {ex.Message}");
            return null;
        }
    }

    // ---- (d)+(e) overlay + verify ---------------------------------------------------------------

    private static void OverlayAndVerify(string baseHostDir, string nativeDir, string outDir, ProvisionResult result, Action<string> log, CancellationToken cancellation)
    {
        if (!Directory.Exists(baseHostDir) || !File.Exists(Path.Combine(baseHostDir, "Surface.exe")))
        {
            throw new DirectoryNotFoundException($"Base host not found (or missing Surface.exe): {baseHostDir}");
        }

        // Copy the base host to the output directory (never mutate the base).
        CopyDirectory(baseHostDir, outDir, cancellation);
        log($"copied base host -> {outDir}");

        // Overlay ONLY native files (the TARGET version's full native set); never the managed projection.
        foreach (var srcFile in Directory.EnumerateFiles(nativeDir))
        {
            cancellation.ThrowIfCancellationRequested();
            var name = Path.GetFileName(srcFile);
            if (name.Equals(ManagedProjection, StringComparison.OrdinalIgnoreCase))
            {
                result.NativeFiles.Add(new NativeFileResult
                {
                    Name = name, Size = new FileInfo(srcFile).Length, Sha256 = "(skipped)", Verified = true, IsManagedSkipped = true,
                });
                log($"SKIP managed {name} (stays at base — never overlaid)");
                continue;
            }

            var dst = Path.Combine(outDir, name);
            File.Copy(srcFile, dst, overwrite: true);

            var srcSha = Sha256(srcFile);
            var dstSha = Sha256(dst);
            var srcLen = new FileInfo(srcFile).Length;
            var dstLen = new FileInfo(dst).Length;
            var ok = srcSha == dstSha && srcLen == dstLen;

            result.NativeFiles.Add(new NativeFileResult
            {
                Name = name, Size = dstLen, Sha256 = dstSha, Verified = ok, IsManagedSkipped = false,
            });
            log($"{(ok ? "OK  " : "FAIL")} overlay {name}  size={dstLen}  sha={dstSha[..8]}");
        }

        // Record the managed projection left at base (proof it was NOT touched).
        var managed = Path.Combine(outDir, ManagedProjection);
        if (File.Exists(managed))
        {
            result.ManagedProjectionSha256 = Sha256(managed);
            result.ManagedProjectionSize = new FileInfo(managed).Length;
        }
    }

    // ---- helpers --------------------------------------------------------------------------------

    private static string ResolveNuGetCache(string? explicitCache)
    {
        if (!string.IsNullOrWhiteSpace(explicitCache)) return explicitCache!;
        var env = Environment.GetEnvironmentVariable("NUGET_PACKAGES");
        if (!string.IsNullOrWhiteSpace(env)) return env!;
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".nuget", "packages");
    }

    private static string? FindUpwards(string startDir, string fileName)
    {
        var dir = new DirectoryInfo(startDir);
        for (int i = 0; dir != null && i < 30; i++)
        {
            var candidate = Path.Combine(dir.FullName, fileName);
            if (File.Exists(candidate)) return candidate;
            dir = dir.Parent;
        }
        return null;
    }

    private static void CopyDirectory(string src, string dst, CancellationToken cancellation)
    {
        // Overlay mode is explicitly disposable too: never delete an existing caller/user cache.
        src = Path.GetFullPath(src).TrimEnd(Path.DirectorySeparatorChar);
        dst = Path.GetFullPath(dst).TrimEnd(Path.DirectorySeparatorChar);
        if (Directory.Exists(dst) || File.Exists(dst) ||
            dst.StartsWith(src + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new IOException("Overlay output must be a new directory outside the base host: " + dst);
        Directory.CreateDirectory(dst);
        foreach (var dir in Directory.EnumerateDirectories(src, "*", SearchOption.AllDirectories))
        {
            Directory.CreateDirectory(dir.Replace(src, dst));
        }
        foreach (var file in Directory.EnumerateFiles(src, "*", SearchOption.AllDirectories))
        {
            cancellation.ThrowIfCancellationRequested();
            File.Copy(file, file.Replace(src, dst), overwrite: true);
        }
    }

    private static string Sha256(string path)
    {
        using var sha = SHA256.Create();
        using var fs = File.OpenRead(path);
        return Convert.ToHexString(sha.ComputeHash(fs));
    }
}
