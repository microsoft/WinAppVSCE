#nullable enable
using System;
using System.IO;
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
    public static string BundledVersion
    {
        get
        {
            var directory = Path.GetDirectoryName(typeof(MatchedHostResolver).Assembly.Location)!;
            return File.ReadAllText(Path.Combine(directory, "Surface", "Surface.wasdk.version")).Trim();
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
        var version = WasdkVersionDiscovery.Discover(xamlPath, log).Version;
        var project = WasdkVersionDiscovery.FindOwningCsproj(xamlPath);
        var needsMatch = !string.IsNullOrEmpty(version) && !IsBundledCompatible(version!);
        var canBuild = needsMatch && project != null && HostBuildEnvironment.Probe(log).CanBuild;
        return new HostSelection
        {
            ExePath = bundled, Fidelity = HostFidelity.Baseline, VersionLabel = version ?? BundledVersion,
            NeedsUpgrade = bundled != null && canBuild,
            Upgrade = canBuild ? HostUpgradeKind.Build : HostUpgradeKind.None,
            TargetVersion = version, TargetProject = project,
            Note = needsMatch && !canBuild ? $"Matched WinAppSDK {version} preview requires a project and .NET SDK." : null
        };
    }

    public static (string exe, string pri)? PrepareMatchedRunCopy(string host, string runRoot, Action<string>? log = null)
    {
        try
        {
            HostPayload.CreateRunCopy(host, runRoot);
            return (Path.Combine(runRoot, "Surface.exe"), Path.Combine(runRoot, "Surface.designtime.pri"));
        }
        catch (Exception ex) { log?.Invoke("Matched run-copy failed: " + ex); return null; }
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
