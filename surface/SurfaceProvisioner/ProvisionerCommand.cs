using System.Text.Json;
using WinUISurface.Shared;

namespace SurfaceProvisioner;

internal static class ProvisionerCommand
{
    // Console wiring stays in Program; this is the same dispatch used by deterministic CLI fixtures.
    public static int Run(string[] args, CancellationToken cancellation, TextWriter output, Action<string> log,
        Func<string, IEnumerable<string>, string>? runTool = null)
    {
        var json = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
        string? Arg(string name)
        {
            var i = Array.IndexOf(args, name);
            return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
        }
        string Required(string name) => Arg(name) ?? throw new ArgumentException("Missing required option: " + name);
        HostBuilder.BuildResult result;
        string? preparedRun = null;
        try
        {
            if (args.Contains("--prepare-run"))
            {
                var host = Required("--host");
                var run = Required("--run-root");
                var manifest = HostPayload.CreateRunCopy(host, run, cancellation, log);
                preparedRun = run;
                result = new() { Status = "cached", Success = true, HostDir = run,
                    HostExePath = Path.Combine(run, "Surface.exe"), MergedPriPath = Path.Combine(run, "Surface.designtime.pri"),
                    CacheKey = manifest.Key, DiscoveredVersion = manifest.Version };
                cancellation.ThrowIfCancellationRequested();
            }
            else if (args.Contains("--build"))
            {
                result = HostBuilder.Build(new()
                {
                    ProjectPath = Required("--project"), SurfaceProjectPath = Required("--surface-project"),
                    DesignHostPriProjectPath = Required("--designhostpri-project"), CacheRoot = Required("--cache"),
                    BundledHostDir = Arg("--bundled-host"), Platform = Arg("--platform") ?? "x64",
                    Rid = Arg("--rid") ?? "win-x64", NuGetCache = Arg("--nuget-cache"),
                    EngineStamp = Arg("--engine-stamp"), StagingRoot = Arg("--staging-root"),
                    ForceRebuild = args.Contains("--force-rebuild"),
                }, log, cancellation, runTool);
                // Includes cancellation during Build's scoped disposal, after its success assignment.
                if (result.Success) cancellation.ThrowIfCancellationRequested();
            }
            else
            {
                var overlay = Provisioner.Provision(new()
                {
                    ProjectPath = Required("--project"), BaseHostDir = Required("--base-host"), OutDir = Required("--out"),
                    Rid = Arg("--rid") ?? "win-x64", NuGetCache = Arg("--nuget-cache"), AllowDownload = args.Contains("--allow-download")
                }, log, cancellation);
                output.WriteLine(JsonSerializer.Serialize(new { contractVersion = 1, status = overlay.Success ? "degraded" : "failed",
                    success = false, cancelled = overlay.Cancelled,
                    error = overlay.Error ?? "Native-only overlay: managed projection remains at base version.", overlay }, json));
                return overlay.Cancelled ? 130 : overlay.Success ? 3 : 1;
            }
        }
        catch (OperationCanceledException ex)
        {
            var error = "Provisioning cancelled.";
            if (preparedRun != null)
            {
                // Assigned only after this invocation created a NEW run; never a shared generation.
                try { HostPayload.DeleteOwnedDirectory(preparedRun); }
                catch (Exception cleanup) when (cleanup is IOException or UnauthorizedAccessException)
                {
                    error += " Run-copy cleanup failed: " + cleanup.Message;
                    log(error);
                }
            }
            result = new() { Cancelled = true, Error = error };
            log(ex.Message);
        }
        catch (Exception ex) { result = new() { Error = ex.ToString() }; }
        output.WriteLine(JsonSerializer.Serialize(result, json));
        return result.Success ? 0 : result.Cancelled ? 130 : result.Status == "degraded" ? 3 : 1;
    }
}
