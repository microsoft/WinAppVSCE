using System.Diagnostics;
using WinUISurface.Shared;

namespace SurfaceProvisioner;

/// <summary>IDE-neutral matched managed/native host and target-package-aware template PRI builder.</summary>
public static class HostBuilder
{
    public sealed class BuildOptions
    {
        public required string ProjectPath { get; init; }
        public required string SurfaceProjectPath { get; init; }
        public required string DesignHostPriProjectPath { get; init; }
        public required string CacheRoot { get; init; }
        public string? BundledHostDir { get; init; }
        public string Platform { get; init; } = "x64";
        public string Rid { get; init; } = "win-x64";
        public string? NuGetCache { get; init; }
        public string? EngineStamp { get; init; }
        public string? StagingRoot { get; init; }
        public bool ForceRebuild { get; init; }
    }

    public sealed class BuildResult
    {
        public int ContractVersion { get; set; } = 1;
        public string Status { get; set; } = "failed";
        // Success means MATCHED, never a bundled fallback or native-only overlay.
        public bool Success { get; set; }
        public string? Error { get; set; }
        public bool Cancelled { get; set; }
        public string? DiscoveredVersion { get; set; }
        public VersionSourceKind VersionSource { get; set; }
        public string? VersionSourcePath { get; set; }
        public string? WinUiComponent { get; set; }
        public string? HostDir { get; set; }
        public string? HostExePath { get; set; }
        public string? MergedPriPath { get; set; }
        public string? CacheKey { get; set; }
        public string? EngineStamp { get; set; }
        public bool CacheHit { get; set; }
        public bool UsedFallback { get; set; }
        public string? ManagedHash { get; set; }
        public string? NativeHash { get; set; }
        public string? ExpectedManagedHash { get; set; }
        public string? ExpectedNativeHash { get; set; }
        public bool ManagedMatched { get; set; }
        public bool NativeMatched { get; set; }
        public bool MatchedHost => ManagedMatched && NativeMatched;
        public double SurfaceBuildSeconds { get; set; }
        public double PriBuildSeconds { get; set; }
        public double TotalSeconds { get; set; }
    }

    public static BuildResult Build(BuildOptions opt, Action<string>? log = null, CancellationToken cancellation = default)
        => Build(opt, log, cancellation, null);

    // Test seam replaces only external tools; production identity/cache/copy/result paths remain real.
    internal static BuildResult Build(BuildOptions opt, Action<string>? log, CancellationToken cancellation,
        Func<string, IEnumerable<string>, string>? runTool)
    {
        log ??= _ => { };
        var sw = Stopwatch.StartNew();
        var r = new BuildResult { EngineStamp = opt.EngineStamp };
        string? gcRoot = null;
        try
        {
            cancellation.ThrowIfCancellationRequested();
            if (!((opt.Platform == "x64" && opt.Rid == "win-x64") || (opt.Platform == "ARM64" && opt.Rid == "win-arm64")))
                throw new NotSupportedException("This build lane supports only x64 / win-x64 and ARM64 / win-arm64.");
            foreach (var file in new[] { opt.SurfaceProjectPath, opt.DesignHostPriProjectPath })
                if (!File.Exists(file)) throw new FileNotFoundException("Required source project missing.", file);
            var (version, source, path) = Provisioner.DiscoverVersion(opt.ProjectPath, log);
            r.DiscoveredVersion = version; r.VersionSource = source; r.VersionSourcePath = path;
            if (version == null) throw new InvalidDataException("Could not discover a WindowsAppSDK version.");
            // Versions enter MSBuild command-line properties; reject expressions/ranges rather than guessing.
            if (!System.Text.RegularExpressions.Regex.IsMatch(version, @"^\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$"))
                throw new InvalidDataException("A concrete resolved WindowsAppSDK version is required: " + version);
            var surfaceSource = Path.GetDirectoryName(Path.GetFullPath(opt.SurfaceProjectPath))!;
            var templateSource = Path.GetDirectoryName(Path.GetFullPath(opt.DesignHostPriProjectPath))!;
            string RunTool(IEnumerable<string> args) => runTool == null
                ? Run("dotnet", args, opt, log, cancellation) : runTool("dotnet", args);
            var toolchain = RunTool(new[] { "--version" }).Trim();
            // Namespace v2 leaves all legacy user cache entries untouched.
            var cache = Path.Combine(Path.GetFullPath(opt.CacheRoot), "v2");
            gcRoot = cache;
            var memoPath = BuildStorage.MemoPath(cache, opt.ProjectPath, surfaceSource, templateSource,
                version, opt.Platform, opt.Rid, opt.EngineStamp ?? "", opt.NuGetCache);
            if (!opt.ForceRebuild)
            {
                var (knownComponent, _) = Provisioner.ResolveComponent(version, opt.NuGetCache, log);
                var recalled = knownComponent == null ? null
                    : BuildStorage.Recall(memoPath, surfaceSource, templateSource, knownComponent, toolchain, log, cancellation);
                if (recalled != null)
                {
                    r.WinUiComponent = knownComponent; r.CacheKey = recalled;
                    using var fastLock = BuildStorage.AcquireLock(Path.Combine(cache, "locks", recalled), cancellation);
                    var fast = BuildStorage.FindCompleted(cache, recalled, cancellation, log);
                    if (fast != null)
                    {
                        VerifyMatched(fast, knownComponent!, opt, r, cancellation);
                        log("CACHE HIT " + recalled + " (identity memo)");
                        cancellation.ThrowIfCancellationRequested();
                        SetHost(r, fast);
                        r.CacheHit = true; r.Success = true; r.Status = "cached";
                        return r;
                    }
                    log("Identity memo key has no completed cache entry; resolving fully.");
                }
            }
            var engineWitnesses = BuildStorage.SourceWitnesses(surfaceSource, cancellation);
            var templateWitnesses = BuildStorage.SourceWitnesses(templateSource, cancellation);
            using var stage = new BuildStage(opt.StagingRoot);
            var surface = Path.Combine(stage.Root, "s");
            var template = Path.Combine(stage.Root, "d");
            BuildStorage.CopySource(surfaceSource, surface, cancellation);
            BuildStorage.CopySource(templateSource, template, cancellation);
            var sp = Path.Combine(surface, Path.GetFileName(opt.SurfaceProjectPath));
            var dp = Path.Combine(template, Path.GetFileName(opt.DesignHostPriProjectPath));
            // F3: merge the target's own PRI-bearing packages (not a fixed list) so their templates resolve.
            TemplatePackages.Write(template, TemplatePackages.Discover(opt.ProjectPath, log));
            RunTool(BuildArgs("restore", sp, version, opt));
            try
            {
                RunTool(BuildArgs("restore", dp, version, opt));
            }
            catch (InvalidOperationException ex) when (File.Exists(Path.Combine(template, TemplatePackages.FileName)))
            {
                // A target package the template can't restore must not cost the matched host: fall back to
                // the fixed template baseline (identity is computed below, after the final restore).
                log("Template packages: restore failed with the target's packages; retrying with the template baseline. " + ex.Message);
                TemplatePackages.Write(template, null);
                RunTool(BuildArgs("restore", dp, version, opt));
            }
            var (component, _) = Provisioner.ResolveComponent(version, opt.NuGetCache, log);
            r.WinUiComponent = component ?? throw new InvalidDataException("Resolved WinUI component missing after restore.");
            var inputWitnesses = new List<BuildStorage.Witness>();
            var key = BuildStorage.Identity(surface, template, opt.ProjectPath, version, component,
                opt.Platform, opt.Rid, opt.EngineStamp ?? "", toolchain, cancellation, inputWitnesses);
            r.CacheKey = key;
            void RememberKey() => BuildStorage.Remember(memoPath, key, component, toolchain,
                engineWitnesses, templateWitnesses, inputWitnesses, log);
            using var cacheLock = BuildStorage.AcquireLock(Path.Combine(cache, "locks", key), cancellation);
            var existing = opt.ForceRebuild ? null : BuildStorage.FindCompleted(cache, key, cancellation, log);
            if (existing != null)
            {
                VerifyMatched(existing, component, opt, r, cancellation);
                RememberKey();
                log("CACHE HIT " + key);
                cancellation.ThrowIfCancellationRequested();
                SetHost(r, existing);
                r.CacheHit = true; r.Success = true; r.Status = "cached";
                return r;
            }
            var part = Stopwatch.StartNew();
            RunTool(BuildArgs("build", sp, version, opt));
            r.SurfaceBuildSeconds = part.Elapsed.TotalSeconds;
            part.Restart();
            RunTool(BuildArgs("build", dp, version, opt));
            r.PriBuildSeconds = part.Elapsed.TotalSeconds;
            var host = OutputDir(surface, opt);
            var priDir = OutputDir(template, opt);
            var mergedPri = Path.Combine(priDir, "resources.pri");
            if (!File.Exists(mergedPri)) throw new FileNotFoundException("DesignHost merged resources.pri missing.", mergedPri);
            HostPayload.CopyFile(mergedPri, Path.Combine(host, "Surface.designtime.pri"), cancellation);
            VerifyMatched(host, component, opt, r, cancellation);
            HostPayload.Seal(host, key, version, opt.EngineStamp ?? "", cancellation);
            if (BuildStorage.Identity(surface, template, opt.ProjectPath, version, component,
                opt.Platform, opt.Rid, opt.EngineStamp ?? "", toolchain, cancellation) != key)
                throw new IOException("Resolved inputs changed during build; no cache entry published. Retry after inputs stabilize.");
            cancellation.ThrowIfCancellationRequested();
            var published = BuildStorage.Publish(cache, key, host, cancellation, log);
            RememberKey();
            cancellation.ThrowIfCancellationRequested();
            SetHost(r, published);
            r.Success = true; r.Status = "built";
            return r;
        }
        catch (OperationCanceledException)
        {
            r.Success = false; r.Status = "failed";
            r.HostDir = null; r.HostExePath = null; r.MergedPriPath = null; r.CacheHit = false;
            r.Cancelled = true; r.Error = "Provisioning cancelled."; return r;
        }
        catch (Exception ex)
        {
            r.Success = false; r.Status = "failed";
            r.HostDir = null; r.HostExePath = null; r.MergedPriPath = null;
            r.Error = ex.ToString();
            // An explicit bundled path permits degradation, not success; preserve the originating error.
            if (opt.BundledHostDir != null && File.Exists(Path.Combine(opt.BundledHostDir, "Surface.exe")))
            {
                r.Status = "degraded"; r.UsedFallback = true;
                r.HostDir = opt.BundledHostDir; r.HostExePath = Path.Combine(opt.BundledHostDir, "Surface.exe");
            }
            return r;
        }
        finally
        {
            // A successful return evaluates before scoped disposal. Observe late cancellation only
            // after successful cleanup; never mask a cleanup failure or its degraded/error semantics.
            if (r.Success && cancellation.IsCancellationRequested)
            {
                r.Success = false; r.Status = "failed"; r.Cancelled = true; r.Error = "Provisioning cancelled.";
                r.HostDir = null; r.HostExePath = null; r.MergedPriPath = null; r.CacheHit = false;
            }
            // P3: bounded cache GC, only after a success (never on a failure path that may be mid-publish).
            if (r.Success && gcRoot != null && r.CacheKey != null)
            {
                try { BuildStorage.Collect(gcRoot, r.CacheKey, log); }
                catch (Exception ex) { log("Cache GC skipped: " + ex.Message); }
            }
            r.TotalSeconds = sw.Elapsed.TotalSeconds;
        }
    }

    private static void SetHost(BuildResult r, string host)
    {
        r.HostDir = host; r.HostExePath = Path.Combine(host, "Surface.exe");
        r.MergedPriPath = Path.Combine(host, "Surface.designtime.pri");
    }
    private static string OutputDir(string projectDir, BuildOptions opt)
        => Path.Combine(projectDir, "bin", opt.Platform, "Debug", "net10.0-windows10.0.26100.0", opt.Rid);

    private static string[] BuildArgs(string verb, string project, string version, BuildOptions opt)
    {
        var args = new List<string> { verb, project, "-p:Configuration=Debug", "-p:Platform=" + opt.Platform,
            "-p:RuntimeIdentifier=" + opt.Rid, "-p:WinUISurfaceWasdkVersion=" + version,
            "-p:WindowsAppSDKSelfContained=true", "-nologo", "-v:minimal", "-nodeReuse:false" };
        if (verb == "build") args.Add("--no-restore");
        return args.ToArray();
    }

    private static void VerifyMatched(string host, string component, BuildOptions opt, BuildResult r,
        CancellationToken cancellation)
    {
        var managed = Provisioner.LocateComponentManaged(component, opt.NuGetCache)
            ?? throw new FileNotFoundException("Expected managed WinUI component missing.");
        var native = Provisioner.LocateComponentNative(component, opt.NuGetCache, opt.Rid)
            ?? throw new FileNotFoundException("Expected native WinUI component missing.");
        r.ExpectedManagedHash = HostPayload.Hash(managed, cancellation);
        r.ExpectedNativeHash = HostPayload.Hash(Path.Combine(native, "Microsoft.ui.xaml.dll"), cancellation);
        r.ManagedHash = HostPayload.Hash(Path.Combine(host, "Microsoft.WinUI.dll"), cancellation);
        r.NativeHash = HostPayload.Hash(Path.Combine(host, "Microsoft.ui.xaml.dll"), cancellation);
        r.ManagedMatched = r.ManagedHash == r.ExpectedManagedHash;
        r.NativeMatched = r.NativeHash == r.ExpectedNativeHash;
        if (!r.MatchedHost) throw new InvalidDataException("Matched-host verification failed: managed and/or native SHA256 mismatch.");
    }

    private static string Run(string exe, IEnumerable<string> args, BuildOptions opt, Action<string> log, CancellationToken cancellation)
    {
        var psi = new ProcessStartInfo(exe) { UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var arg in args) psi.ArgumentList.Add(arg);
        if (opt.NuGetCache != null) psi.Environment["NUGET_PACKAGES"] = opt.NuGetCache;
        psi.Environment["MSBUILDDISABLENODEREUSE"] = "1";
        using var process = new Process { StartInfo = psi };
        cancellation.ThrowIfCancellationRequested();
        process.Start();
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        try
        {
            while (!process.WaitForExit(100)) cancellation.ThrowIfCancellationRequested();
            var output = stdout.GetAwaiter().GetResult() + stderr.GetAwaiter().GetResult();
            log(output);
            cancellation.ThrowIfCancellationRequested();
            if (process.ExitCode != 0) throw new InvalidOperationException($"{exe} exit {process.ExitCode}:\n{output}");
            return output;
        }
        finally
        {
            if (!process.HasExited) { process.Kill(entireProcessTree: true); process.WaitForExit(); }
        }
    }
}
