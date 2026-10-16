#nullable enable
using System;
using System.IO;
using System.Linq;
using WinUISurface.Shared;

namespace WinUIXamlPreview.Protocol;

internal enum HostFidelity { Baseline, Matched }
internal enum HostUpgradeKind { None, Build }
internal sealed class HostSelection
{
    public string? ExePath { get; init; }
    public string? UserPri { get; init; }
    public HostFidelity Fidelity { get; init; }
    public string? VersionLabel { get; init; }
    public bool NeedsUpgrade { get; init; }
    public HostUpgradeKind Upgrade { get; init; }
    public string? TargetVersion { get; init; }
    public string? TargetProject { get; init; }
    public string? Note { get; init; }
}

// VS selects the instant bundled host; ONLY the shared provisioner owns cache identity/discovery.
internal static class MatchedHostResolver
{
    // Null when no bundled host is present (e.g. a broken install); callers degrade rather than throw.
    public static string? BundledVersion
    {
        get
        {
            var directory = Path.GetDirectoryName(typeof(MatchedHostResolver).Assembly.Location)!;
            var surfaceDir = HostArch.BundledSurfaceDir(directory) ?? Path.Combine(directory, "Surface");
            var file = Path.Combine(surfaceDir, "Surface.wasdk.version");
            try { return File.Exists(file) ? File.ReadAllText(file).Trim() : null; }
            catch (IOException) { return null; }
            catch (UnauthorizedAccessException) { return null; }
        }
    }
    public static string CacheRoot => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WinUISurface", "host-cache");
    public static bool IsBundledCompatible(string version) =>
        string.Equals(version, BundledVersion, StringComparison.OrdinalIgnoreCase);

    public static HostSelection Resolve(string? xamlPath, Action<string>? log = null)
    {
        log ??= _ => { };
        var bundled = SurfaceResolver.Resolve(preferred: null, nearPath: xamlPath, log: log);
        var discovery = WasdkVersionDiscovery.Discover(xamlPath, log);
        var version = discovery.Version;
        var project = WasdkVersionDiscovery.FindOwningCsproj(xamlPath);
        var versionMismatch = !string.IsNullOrEmpty(version) && !IsBundledCompatible(version!);
        // The bundled host only carries the baseline Toolkit templates; other PRI-bearing packages (or other
        // versions) need a host whose merged PRI is built from this project's own graph.
        var needsTemplates = !versionMismatch && !string.IsNullOrEmpty(version) &&
            discovery.Source == WasdkVersionSource.ProjectAssetsJson && NeedsTemplatePackages(discovery.SourcePath!, log);
        var needsMatch = versionMismatch || needsTemplates;
        var canBuild = needsMatch && project != null && HostBuildEnvironment.Probe(log).CanBuild;
        string? note = null;
        if (versionMismatch && !canBuild)
            note = $"Matched WinAppSDK {version} preview requires a project and .NET SDK.";
        else if (discovery.Source == WasdkVersionSource.Unresolved)
            note = $"Couldn't determine this project's WinAppSDK version, so the preview uses the bundled {BundledVersion}. Build the project, then reopen the file.";
        return new HostSelection
        {
            ExePath = bundled, Fidelity = HostFidelity.Baseline, VersionLabel = version ?? BundledVersion,
            NeedsUpgrade = bundled != null && canBuild,
            Upgrade = canBuild ? HostUpgradeKind.Build : HostUpgradeKind.None,
            TargetVersion = version, TargetProject = project,
            Note = note
        };
    }

    // True when the project's restore graph has a PRI-bearing package (id/version) the bundled host's
    // baked-in template PRI doesn't carry. The baked set is recorded at payload build in HostSDK\template-baseline.txt.
    internal static bool NeedsTemplatePackages(string assetsPath, Action<string> log)
    {
        var packages = ProjectFiles.ReadPriPackages(assetsPath);
        if (packages == null || packages.Count == 0) return false;
        var directory = Path.GetDirectoryName(typeof(MatchedHostResolver).Assembly.Location)!;
        var baseline = new System.Collections.Generic.HashSet<string>(StringComparer.OrdinalIgnoreCase);
        try { baseline.UnionWith(File.ReadAllLines(Path.Combine(directory, "HostSDK", "template-baseline.txt")).Select(l => l.Trim())); }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException) { }
        var missing = packages.Select(p => p.Key + "/" + p.Value).Where(p => !baseline.Contains(p)).ToList();
        if (missing.Count > 0) log("Template packages beyond the bundled baseline: " + string.Join(", ", missing));
        return missing.Count > 0;
    }

    // Missing source identity is an error, never a silently accepted old cache marker.
    public static string ShippedEngineStamp
    {
        get
        {
            var directory = Path.GetDirectoryName(typeof(MatchedHostResolver).Assembly.Location)!;
            var stamp = File.ReadAllText(Path.Combine(directory, "HostSDK", "engine.stamp")).Trim();
            if (stamp.Length != 64) throw new InvalidDataException("Invalid shared engine.stamp.");
            return stamp;
        }
    }
}
