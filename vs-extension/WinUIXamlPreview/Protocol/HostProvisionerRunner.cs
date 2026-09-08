#nullable enable

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using WinUISurface.Shared;

namespace WinUIXamlPreview.Protocol
{
    /// <summary>
    /// Probes for the on-machine ability to BUILD a version-matched host: a resolvable <c>dotnet</c> (the
    /// build-on-demand path shells <c>dotnet build</c>) plus the build inputs shipped inside the VSIX under
    /// <c>HostSDK\</c> (the certified Surface source, the DesignHost merged-pri source, and the pre-built
    /// framework-dependent net8 provisioner). When any piece is missing the preview stays on the bundled
    /// 2.2.0 host — never attempt an invocation that can't succeed.
    /// </summary>
    internal sealed class HostBuildEnvironment
    {
        public bool CanBuild { get; private set; }
        public string? DotnetPath { get; private set; }
        public string HostSdkDir { get; private set; } = string.Empty;
        public string? ProvisionerExe { get; private set; }
        public string? ProvisionerDll { get; private set; }
        public string? SurfaceProject { get; private set; }
        public string? DesignHostProject { get; private set; }
        public string? Reason { get; private set; }

        public static HostBuildEnvironment Probe(Action<string>? log = null)
        {
            log ??= _ => { };
            var env = new HostBuildEnvironment();

            try
            {
                var asmDir = Path.GetDirectoryName(typeof(HostBuildEnvironment).Assembly.Location);
                if (string.IsNullOrEmpty(asmDir))
                {
                    env.Reason = "extension directory not resolvable";
                    return env;
                }

                env.HostSdkDir = Path.Combine(asmDir!, "HostSDK");
                env.SurfaceProject = Path.Combine(env.HostSdkDir, "surface", "Surface", "Surface.csproj");
                env.DesignHostProject = Path.Combine(env.HostSdkDir, "DesignHost", "DesignHost.csproj");
                env.ProvisionerExe = Path.Combine(env.HostSdkDir, "SurfaceProvisioner", "SurfaceProvisioner.exe");
                env.ProvisionerDll = Path.Combine(env.HostSdkDir, "SurfaceProvisioner", "SurfaceProvisioner.dll");
                env.DotnetPath = FindDotnet();

                var haveProvisioner = File.Exists(env.ProvisionerExe) || File.Exists(env.ProvisionerDll);
                var haveInputs = File.Exists(env.SurfaceProject) && File.Exists(env.DesignHostProject);

                if (env.DotnetPath == null)
                {
                    env.Reason = "no dotnet on PATH";
                }
                else if (!haveProvisioner)
                {
                    env.Reason = "provisioner not present in HostSDK";
                }
                else if (!haveInputs)
                {
                    env.Reason = "HostSDK build inputs missing";
                }
                else
                {
                    env.CanBuild = true;
                }

                if (!env.CanBuild)
                {
                    log($"Build environment unavailable: {env.Reason}.");
                }

                return env;
            }
            catch (Exception ex)
            {
                env.Reason = ex.Message;
                return env;
            }
        }

        private static string? FindDotnet()
        {
            // 1. PATH (where.exe).
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "where.exe",
                    Arguments = "dotnet.exe",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                };
                using var p = Process.Start(psi);
                if (p != null)
                {
                    var outp = p.StandardOutput.ReadToEnd();
                    p.StandardError.ReadToEnd();
                    p.WaitForExit();
                    if (p.ExitCode == 0)
                    {
                        foreach (var line in outp.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
                        {
                            var candidate = line.Trim();
                            if (File.Exists(candidate))
                            {
                                return candidate;
                            }
                        }
                    }
                }
            }
            catch
            {
                // fall through
            }

            // 2. Well-known install locations.
            foreach (var root in new[]
            {
                Environment.GetEnvironmentVariable("ProgramFiles"),
                Environment.GetEnvironmentVariable("ProgramW6432"),
            })
            {
                if (!string.IsNullOrEmpty(root))
                {
                    var candidate = Path.Combine(root!, "dotnet", "dotnet.exe");
                    if (File.Exists(candidate))
                    {
                        return candidate;
                    }
                }
            }

            return null;
        }
    }

    /// <summary>The result of a background matched-host build attempt.</summary>
    internal sealed class HostBuildOutcome
    {
        public bool Success { get; init; }
        public string? Error { get; init; }
        public string? HostDir { get; init; }
        public string? Status { get; init; }
        public double DurationSeconds { get; init; }
    }

    /// <summary>
    /// A single in-flight matched-host request for a target project/version. Different project graphs
    /// are not joined merely because they use the same WASDK. Interest is
    /// ref-counted: a preview <see cref="Release"/>s when its document moves on or the user cancels, and the
    /// underlying build is only cancelled when the LAST interested preview releases — so one tab's cancel
    /// never kills a build another tab is still waiting on.
    /// </summary>
    internal sealed class MatchedHostBuild
    {
        private readonly object _gate = new object();
        private readonly CancellationTokenSource _cts = new CancellationTokenSource();
        private int _interest;

        public string Version { get; }
        public Task<HostBuildOutcome> Completion { get; private set; } = Task.FromResult(new HostBuildOutcome { Success = false });

        internal MatchedHostBuild(string version) => Version = version;

        internal void Start(Func<CancellationToken, Task<HostBuildOutcome>> run)
        {
            _interest = 1;
            Completion = run(_cts.Token);
        }

        internal void AddInterest()
        {
            lock (_gate) { _interest++; }
        }

        /// <summary>
        /// Drop this caller's interest. When <paramref name="cancelIfLast"/> and no interested previews
        /// remain, cancel the shared build (kills the ~170s spike). A build another tab still wants keeps
        /// running.
        /// </summary>
        public void Release(bool cancelIfLast)
        {
            lock (_gate)
            {
                if (_interest > 0)
                {
                    _interest--;
                }

                if (cancelIfLast && _interest == 0)
                {
                    try { _cts.Cancel(); } catch { }
                }
            }
        }
    }

    /// <summary>
    /// Runs the pre-built framework-dependent net8 provisioner (<c>HostSDK\SurfaceProvisioner</c>) to BUILD +
    /// cache a version-matched self-contained host for a target project's WASDK version, on a background
    /// thread. Success is judged by the provisioner's exit code AND a re-validation of the cache
    /// via the shared manifest validator — degraded output is not a matched host.
    /// The provisioner owns the cross-process input-identity lock.
    /// </summary>
    internal static class HostProvisionerRunner
    {
        private static readonly object BuildsGate = new object();
        private static readonly Dictionary<string, MatchedHostBuild> Builds =
            new Dictionary<string, MatchedHostBuild>(StringComparer.OrdinalIgnoreCase);

        /// <summary>
        /// Acquire (starting or joining) the shared build for <paramref name="version"/>. Returns null when
        /// the build toolchain isn't available. The caller MUST <see cref="MatchedHostBuild.Release"/> its
        /// interest exactly once (on promote, cancel, doc-switch, or dispose).
        /// </summary>
        public static MatchedHostBuild? Acquire(string version, string targetProject, Action<string> log)
        {
            // Do not join different target graphs solely because they share a WASDK version.
            var buildKey = version + "|" + Path.GetFullPath(targetProject);
            lock (BuildsGate)
            {
                if (Builds.TryGetValue(buildKey, out var existing))
                {
                    existing.AddInterest();
                    log($"Matched-host build for {version} already in flight — joining.");
                    return existing;
                }

                var env = HostBuildEnvironment.Probe(log);
                if (!env.CanBuild)
                {
                    return null;
                }

                var build = new MatchedHostBuild(version);
                build.Start(ct => Task.Run(() => RunBuild(env, version, targetProject, log, ct)));
                Builds[buildKey] = build;

                // Drop the dictionary entry once the build settles so a later re-open re-evaluates the cache.
                _ = build.Completion.ContinueWith(_ =>
                {
                    lock (BuildsGate)
                    {
                        if (Builds.TryGetValue(buildKey, out var cur) && ReferenceEquals(cur, build))
                        {
                            Builds.Remove(buildKey);
                        }
                    }
                }, TaskScheduler.Default);

                return build;
            }
        }

        private static HostBuildOutcome RunBuild(HostBuildEnvironment env, string version, string targetProject, Action<string> log, CancellationToken ct)
        {
            var sw = Stopwatch.StartNew();
            Process? proc = null;
            try
            {
                var cache = MatchedHostResolver.CacheRoot;
                Directory.CreateDirectory(cache);

                var bundledHostDir = BundledHostDir();
                var stamp = MatchedHostResolver.ShippedEngineStamp;

                // Provisioner --build: discover version from --project, build certified Surface + DesignHost
                // self-contained at that version, verify managed/native, resolve the complete input-keyed cache.
                var args = new StringBuilder();
                args.Append("--build --cancel-on-stdin");
                args.Append(" --project ").Append(Quote(targetProject));
                args.Append(" --surface-project ").Append(Quote(env.SurfaceProject!));
                args.Append(" --designhostpri-project ").Append(Quote(env.DesignHostProject!));
                args.Append(" --cache ").Append(Quote(cache));
                args.Append(" --engine-stamp ").Append(Quote(stamp));
                if (bundledHostDir != null)
                {
                    args.Append(" --bundled-host ").Append(Quote(bundledHostDir));
                }

                ProcessStartInfo psi;
                if (File.Exists(env.ProvisionerExe))
                {
                    psi = new ProcessStartInfo { FileName = env.ProvisionerExe!, Arguments = args.ToString() };
                }
                else
                {
                    // Fallback: run the managed dll through the SDK runtime.
                    psi = new ProcessStartInfo
                    {
                        FileName = env.DotnetPath!,
                        Arguments = Quote(env.ProvisionerDll!) + " " + args,
                    };
                }

                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.RedirectStandardInput = true;
                psi.WorkingDirectory = env.HostSdkDir;

                log($"Provisioner build starting for {version}…");
                proc = Process.Start(psi);
                if (proc == null)
                {
                    return new HostBuildOutcome { Success = false, Error = "failed to start provisioner" };
                }

                var stdout = proc.StandardOutput.ReadToEndAsync();
                var stderr = proc.StandardError.ReadToEndAsync();

                // Poll so cancellation can kill the (long) build promptly.
                while (!proc.WaitForExit(250))
                {
                    if (ct.IsCancellationRequested)
                    {
                        proc.StandardInput.Close();
                        if (!proc.WaitForExit(15000)) KillTree(proc);
                        log($"Provisioner build for {version} cancelled.");
                        return new HostBuildOutcome { Success = false, Error = "cancelled", DurationSeconds = sw.Elapsed.TotalSeconds };
                    }
                }

                var exit = proc.ExitCode;
                var output = stdout.GetAwaiter().GetResult();
                var diagnostics = stderr.GetAwaiter().GetResult();
                if (!string.IsNullOrWhiteSpace(diagnostics)) Log(log, diagnostics);
                sw.Stop();
                JsonDocument parsed;
                try { parsed = JsonDocument.Parse(output); }
                catch (JsonException ex)
                {
                    throw new InvalidDataException($"Provisioner exit {exit}; missing/invalid result JSON.\n{diagnostics}\n{output}", ex);
                }
                using var document = parsed;
                var result = document.RootElement;
                var status = result.GetProperty("status").GetString();
                var error = result.TryGetProperty("error", out var failure) ? failure.GetString() : null;
                if (exit != 0 || result.GetProperty("contractVersion").GetInt32() != 1 ||
                    !result.GetProperty("success").GetBoolean() || (status != "built" && status != "cached"))
                    return new HostBuildOutcome { Success = false, Status = status,
                        Error = error ?? $"provisioner exit {exit}: {diagnostics}", DurationSeconds = sw.Elapsed.TotalSeconds };
                var host = result.GetProperty("hostDir").GetString()!;
                var manifest = HostPayload.Validate(host, result.GetProperty("cacheKey").GetString());
                if (manifest.Version != version || manifest.EngineStamp != stamp)
                    throw new InvalidDataException("Provisioner returned an unexpected version/engine.");

                log($"Provisioner build for {version} succeeded in {sw.Elapsed.TotalSeconds:n1}s.");
                return new HostBuildOutcome { Success = true, HostDir = host, Status = status, DurationSeconds = sw.Elapsed.TotalSeconds };
            }
            catch (Exception ex)
            {
                try { if (proc != null && !proc.HasExited) KillTree(proc); } catch { }
                return new HostBuildOutcome { Success = false, Error = ex.Message, DurationSeconds = sw.Elapsed.TotalSeconds };
            }
            finally { proc?.Dispose(); }
        }

        private static string? BundledHostDir()
        {
            try
            {
                var asmDir = Path.GetDirectoryName(typeof(HostProvisionerRunner).Assembly.Location);
                if (string.IsNullOrEmpty(asmDir)) return null;
                var dir = Path.Combine(asmDir!, "Surface");
                return File.Exists(Path.Combine(dir, "Surface.exe")) ? dir : null;
            }
            catch
            {
                return null;
            }
        }

        private static void KillTree(Process proc)
        {
            // Kill the provisioner AND its child dotnet build (the actual CPU spike). taskkill /T walks the
            // tree by PID; Process.Kill() is the fallback for just the parent.
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "taskkill.exe",
                    Arguments = $"/T /F /PID {proc.Id}",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                };
                using var k = Process.Start(psi);
                k?.WaitForExit(3000);
            }
            catch
            {
                try { if (!proc.HasExited) proc.Kill(); } catch { }
            }
        }

        private static void Log(Action<string> log, string line)
        {
            try { log("  [provisioner] " + line); } catch { }
        }

        private static string Quote(string s) => "\"" + s.Replace("\"", "\\\"") + "\"";
    }
}
