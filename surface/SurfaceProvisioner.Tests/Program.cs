using System.Diagnostics;
using System.Text.Json;
using SurfaceProvisioner;
using WinUISurface.Shared;

if (args.Length == 2 && args[0] == "--lock")
{
    using var held = BuildStorage.AcquireLock(args[1], CancellationToken.None);
    Console.WriteLine("locked");
    Console.ReadLine();
    return;
}
var count = 0;
void Check(bool condition, string label) { if (!condition) throw new Exception(label); count++; Console.WriteLine("PASS " + label); }
void Reject(Action action, string label)
{
    try { action(); } catch { Check(true, label); return; }
    throw new Exception("Expected rejection: " + label);
}
var root = Path.Combine(Path.GetTempPath(), "wsp-test-" + Guid.NewGuid().ToString("N").Substring(0, 12));
Directory.CreateDirectory(root);
try
{
    var source = Path.Combine(root, "source");
    Directory.CreateDirectory(source);
    foreach (var file in new[] { "Surface.exe", "Surface.dll", "Surface.pri", "Surface.designtime.pri",
        "Surface.deps.json", "Surface.runtimeconfig.json", "Microsoft.WinUI.dll", "Microsoft.ui.xaml.dll" })
        File.WriteAllText(Path.Combine(source, file), file);
    var key = new string('a', 64);
    HostPayload.Seal(source, key, "2.2.0", "engine");
    Check(HostPayload.Validate(source, key).Files.Count == 8, "complete manifest");
    Reject(() => HostPayload.Validate(source, new string('b', 64)), "wrong identity fails");
    var cache = Path.Combine(root, "cache");
    var first = BuildStorage.Publish(cache, key, source);
    Check(BuildStorage.FindCompleted(cache, key) == first, "published cache resolves");
    Check(!File.Exists(Path.Combine(first, HostPayload.RunMarker)), "completed entry is not a mutable run");
    var second = BuildStorage.Publish(cache, key, source);
    Check(first != second && Directory.Exists(first), "replacement generation preserves immutable predecessor");
    Check(BuildStorage.FindCompleted(cache, key) == second, "atomic pointer selects newest completed entry");
    var run = Path.Combine(root, "run");
    var run2 = Path.Combine(root, "run2");
    HostPayload.CreateRunCopy(second, run);
    HostPayload.CreateRunCopy(second, run2);
    File.Copy(Path.Combine(run, "Surface.designtime.pri"), Path.Combine(run, "Surface.pri"), true);
    Check(File.ReadAllText(Path.Combine(second, "Surface.pri")) == "Surface.pri", "user PRI cannot mutate cache");
    Check(File.ReadAllText(Path.Combine(run2, "Surface.pri")) == "Surface.pri", "run sessions isolated");
    Reject(() => HostPayload.Validate(run), "mutated run cannot masquerade as pristine input");
    Reject(() => HostPayload.CreateRunCopy(second, run2), "existing run destination never overwritten");
    var pristine = Directory.GetFiles(second, "*", SearchOption.AllDirectories)
        .ToDictionary(path => path, path => HostPayload.Hash(path));
    foreach (var destination in new[] { second, second + "\\", Path.Combine(second, "run"),
        Path.Combine(second.ToUpperInvariant(), "new-parent", "run") + "\\",
        Path.Combine(second, "ignored", "..", "run") })
    {
        var directories = Directory.GetDirectories(second, "*", SearchOption.AllDirectories);
        using var output = new StringWriter();
        var exit = ProvisionerCommand.Run(new[] { "--prepare-run", "--host", second + "\\", "--run-root", destination },
            CancellationToken.None, output, _ => { });
        using var json = JsonDocument.Parse(output.ToString());
        Check(exit == 1 && !json.RootElement.GetProperty("success").GetBoolean() &&
            json.RootElement.GetProperty("hostDir").ValueKind == JsonValueKind.Null,
            "contained/equal --prepare-run destination rejected: " + destination);
        Check(Directory.GetDirectories(second, "*", SearchOption.AllDirectories).SequenceEqual(directories) &&
            Directory.GetFiles(second, "*", SearchOption.AllDirectories).Length == pristine.Count &&
            pristine.All(pair => HostPayload.Hash(pair.Key) == pair.Value) && HostPayload.Validate(second, key).Key == key,
            "rejected destination creates no directories and preserves manifest/all hashes");
    }
    using (var output = new StringWriter())
    {
        var sibling = second + "2";
        Check(ProvisionerCommand.Run(new[] { "--prepare-run", "--host", second.ToUpperInvariant() + "\\",
            "--run-root", sibling + "\\" }, CancellationToken.None, output, _ => { }) == 0 &&
            HostPayload.Validate(sibling, key).Key == key, "similarly-prefixed sibling allowed with case/trailing separators");
    }
    foreach (var phase in new[] { "before-copy", "after-copy", "before-validation" })
    {
        using var cancelRun = new CancellationTokenSource();
        if (phase == "before-copy") cancelRun.Cancel();
        var cancelledRun = Path.Combine(root, "cancelled-" + phase);
        using var output = new StringWriter();
        var copied = 0;
        // Exercise the real --prepare-run dispatch, synchronously cancelling at an exact I/O boundary,
        // not with a timer or an oversized file whose outcome depends on machine speed.
        var exit = ProvisionerCommand.Run(new[] { "--prepare-run", "--host", second, "--run-root", cancelledRun },
            cancelRun.Token, output, message =>
            {
                if (message.StartsWith("Copied run payload: ", StringComparison.Ordinal)) copied++;
                if ((phase == "after-copy" && copied == 1) ||
                    (phase == "before-validation" && message == "Validating prepared run payload."))
                    cancelRun.Cancel();
            });
        using var cancelledJson = JsonDocument.Parse(output.ToString());
        var result = cancelledJson.RootElement;
        Check(exit == 130 && result.GetProperty("cancelled").GetBoolean() &&
            !result.GetProperty("success").GetBoolean() && result.GetProperty("status").GetString() == "failed",
            "--prepare-run " + phase + " returns cancelled JSON and exit 130");
        Check(result.GetProperty("hostDir").ValueKind == JsonValueKind.Null &&
            result.GetProperty("hostExePath").ValueKind == JsonValueKind.Null,
            "--prepare-run " + phase + " exposes no usable output paths");
        Check(!Directory.Exists(cancelledRun) &&
            !Directory.EnumerateDirectories(root, "cancelled-" + phase + ".preparing-*").Any(),
            "--prepare-run " + phase + " removes only owned partial staging");
        Check(pristine.All(pair => HostPayload.Hash(pair.Key) == pair.Value) &&
            Directory.GetFiles(second, "*", SearchOption.AllDirectories).Length == pristine.Count,
            "--prepare-run " + phase + " leaves pristine published host unchanged");
        if (phase == "after-copy") Check(copied == 1, "--prepare-run stops between payload copies");
    }
    using (var cancelledRun = new CancellationTokenSource())
    {
        cancelledRun.Cancel();
        using var output = new StringWriter();
        Check(ProvisionerCommand.Run(new[] { "--prepare-run", "--host", second, "--run-root", second },
            cancelledRun.Token, output, _ => { }) == 130 && HostPayload.Validate(second, key).Key == key,
            "cancelled --prepare-run never deletes a supplied published generation");
        foreach (var operation in new Action[] {
            () => HostPayload.Hash(Path.Combine(second, "Surface.dll"), cancelledRun.Token),
            () => HostPayload.Validate(second, cancellation: cancelledRun.Token) })
        {
            var observed = false;
            try { operation(); }
            catch (OperationCanceledException) { observed = true; }
            Check(observed, "payload hash/validation observes cancellation");
        }
    }
    var occupiedRun = Path.Combine(root, "occupied-run");
    using (var output = new StringWriter())
    {
        var exit = ProvisionerCommand.Run(new[] { "--prepare-run", "--host", second, "--run-root", occupiedRun },
            CancellationToken.None, output, _ =>
            {
                if (!Directory.Exists(occupiedRun))
                {
                    Directory.CreateDirectory(occupiedRun);
                    File.WriteAllText(Path.Combine(occupiedRun, "owner.txt"), "another caller");
                }
            });
        Check(exit == 1 && File.ReadAllText(Path.Combine(occupiedRun, "owner.txt")) == "another caller" &&
            Directory.GetFiles(occupiedRun).Length == 1,
            "run publication collision preserves another caller's destination");
        Check(!Directory.EnumerateDirectories(root, "occupied-run.preparing-*").Any(),
            "failed run publication removes only owned partial staging");
    }
    File.WriteAllText(Path.Combine(second, "Surface.dll"), "tampered!");
    Reject(() => BuildStorage.FindCompleted(cache, key), "cache serve hashes managed payload");
    File.WriteAllText(Path.Combine(first, "rogue.dll"), "extra");
    Reject(() => HostPayload.Validate(first), "unknown assembly contamination fails");
    File.Delete(Path.Combine(first, "rogue.dll"));
    File.Delete(Path.Combine(first, "Surface.designtime.pri"));
    Reject(() => HostPayload.Validate(first), "missing PRI fails");
    Reject(() => new BuildStage(Path.Combine(root, new string('x', 90))), "deep staging fails clearly");
    string owned;
    using (var stage = new BuildStage(root)) { owned = stage.Root; Check(Directory.Exists(owned), "owned short staging created"); }
    Check(!Directory.Exists(owned) && Directory.Exists(root), "only owned stage cleaned");
    var sourceTree = Path.Combine(root, "tree");
    Directory.CreateDirectory(Path.Combine(sourceTree, "obj"));
    File.WriteAllText(Path.Combine(sourceTree, "asset.png"), "pixels");
    File.WriteAllText(Path.Combine(sourceTree, "obj", "stale"), "output");
    var destTree = Path.Combine(root, "copy");
    BuildStorage.CopySource(sourceTree, destTree);
    Check(File.Exists(Path.Combine(destTree, "asset.png")) && !Directory.Exists(Path.Combine(destTree, "obj")), "source copy includes resources excludes output");

    // Identity fixtures use actual resolved-assets documents + actual package files, without tool execution.
    var packageRoot = Path.Combine(root, "packages");
    var pkg = Path.Combine(packageRoot, "resources", "1.0.0");
    Directory.CreateDirectory(pkg);
    File.WriteAllText(Path.Combine(pkg, "Themes.pri"), "resources1");
    var libraries = new Dictionary<string, object> { ["Resources/1.0.0"] = new {
        type = "package", path = "resources/1.0.0", files = new[] { "Themes.pri" } } };
    var graph = JsonSerializer.Serialize(new { targets = new Dictionary<string, object> { ["net10.0/win-x64"] = new { } },
        libraries, packageFolders = new Dictionary<string, object> { [packageRoot + Path.DirectorySeparatorChar] = new { } } });
    var engine = Path.Combine(root, "engine"); var template = Path.Combine(root, "template");
    foreach (var dir in new[] { engine, template })
    {
        Directory.CreateDirectory(Path.Combine(dir, "obj"));
        File.WriteAllText(Path.Combine(dir, "obj", "project.assets.json"), graph);
        File.WriteAllText(Path.Combine(dir, "input.csproj"), "<Project/>");
    }
    string Identity(string ver = "2.2.0", string rid = "win-x64", string stamp = "engine") =>
        BuildStorage.Identity(engine, template, sourceTree, ver, "2.2.1", "x64", rid, stamp, "sdk10");
    var before = Identity();
    Check(before == Identity(), "identity stable");
    Check(before != Identity(ver: "2.3.0"), "resolved version identity");
    Check(before != Identity(rid: "win-arm64"), "RID identity");
    Check(before != Identity(stamp: "new-engine"), "engine stamp identity");
    File.WriteAllText(Path.Combine(template, "logo.png"), "logo");
    Check(before != Identity(), "template asset identity");
    before = Identity();
    File.WriteAllText(Path.Combine(pkg, "Themes.pri"), "resources2");
    Check(before != Identity(), "actual resource package closure identity");
    before = Identity();
    File.WriteAllText(Path.Combine(engine, "obj", "project.assets.json"), graph.Replace("net10.0/win-x64", "net11.0/win-x64"));
    Check(before != Identity(), "resolved TFM identity");

    // Only external dotnet execution is substituted. The actual --build dispatcher, HostBuilder,
    // identity, package matching, cache validation/publication and JSON/exit paths run unchanged.
    var buildFixture = Path.Combine(root, "build-fixture");
    var fixtureSurface = Path.Combine(buildFixture, "surface", "Surface.csproj");
    var fixtureTemplate = Path.Combine(buildFixture, "template", "DesignHost.csproj");
    var fixtureTarget = Path.Combine(buildFixture, "target", "Target.csproj");
    foreach (var project in new[] { fixtureSurface, fixtureTemplate, fixtureTarget })
    {
        Directory.CreateDirectory(Path.GetDirectoryName(project)!);
        File.WriteAllText(project, "<Project><ItemGroup><PackageReference Include=\"Microsoft.WindowsAppSDK\" Version=\"2.2.0\" /></ItemGroup></Project>");
    }
    var meta = Path.Combine(packageRoot, "microsoft.windowsappsdk", "2.2.0");
    Directory.CreateDirectory(meta);
    File.WriteAllText(Path.Combine(meta, "microsoft.windowsappsdk.nuspec"),
        "<package><metadata><dependencies><dependency id=\"Microsoft.WindowsAppSDK.WinUI\" version=\"2.2.1\" /></dependencies></metadata></package>");
    var componentRoot = Path.Combine(packageRoot, "microsoft.windowsappsdk.winui", "2.2.1");
    var nativeRoot = Path.Combine(componentRoot, "runtimes-framework", "win-x64", "native");
    Directory.CreateDirectory(nativeRoot);
    File.Copy(Path.Combine(source, "Microsoft.WinUI.dll"), Path.Combine(componentRoot, "Microsoft.WinUI.dll"));
    File.Copy(Path.Combine(source, "Microsoft.ui.xaml.dll"), Path.Combine(nativeRoot, "Microsoft.ui.xaml.dll"));
    string FakeTool(string exe, IEnumerable<string> arguments)
    {
        var toolArgs = arguments.ToArray();
        if (toolArgs[0] == "--version") return "fixture-sdk";
        var project = toolArgs[1];
        var projectDir = Path.GetDirectoryName(project)!;
        if (toolArgs[0] == "restore")
        {
            Directory.CreateDirectory(Path.Combine(projectDir, "obj"));
            File.WriteAllText(Path.Combine(projectDir, "obj", "project.assets.json"), graph);
        }
        else if (toolArgs[0] == "build")
        {
            var bin = Path.Combine(projectDir, "bin", "x64", "Debug", "net10.0-windows10.0.26100.0", "win-x64");
            Directory.CreateDirectory(bin);
            if (Path.GetFileName(project) == "Surface.csproj")
            {
                foreach (var file in Directory.GetFiles(source).Where(f =>
                    Path.GetFileName(f) != HostPayload.ManifestName && Path.GetFileName(f) != "Surface.designtime.pri"))
                    File.Copy(file, Path.Combine(bin, Path.GetFileName(file)));
            }
            else File.Copy(Path.Combine(source, "Surface.designtime.pri"), Path.Combine(bin, "resources.pri"));
        }
        else throw new Exception("Unexpected tool command: " + exe);
        return "";
    }
    var fixtureCache = Path.Combine(buildFixture, "cache");
    var buildArgs = new[] { "--build", "--project", fixtureTarget, "--surface-project", fixtureSurface,
        "--designhostpri-project", fixtureTemplate, "--cache", fixtureCache, "--nuget-cache", packageRoot,
        "--staging-root", root, "--bundled-host", source };
    string fixtureHost;
    using (var output = new StringWriter())
    {
        var exit = ProvisionerCommand.Run(buildArgs, CancellationToken.None, output, _ => { }, FakeTool);
        using var json = JsonDocument.Parse(output.ToString());
        Check(exit == 0 && json.RootElement.GetProperty("status").GetString() == "built", "fixture builds via actual command/cache pipeline");
        fixtureHost = json.RootElement.GetProperty("hostDir").GetString()!;
    }
    var fixturePristine = Directory.GetFiles(fixtureHost, "*", SearchOption.AllDirectories)
        .ToDictionary(path => path, path => HostPayload.Hash(path));
    var fixtureV2 = Path.Combine(fixtureCache, "v2");
    foreach (var phase in new[] { "cache-validation", "cache-success", "publication-copy", "publication-validation",
        "before-commit", "after-commit", "after-pointer" })
    {
        using var cancellation = new CancellationTokenSource();
        using var output = new StringWriter();
        var isCache = phase.StartsWith("cache-", StringComparison.Ordinal);
        var phaseArgs = isCache ? buildArgs : buildArgs.Concat(new[] { "--force-rebuild" }).ToArray();
        var entriesBefore = Directory.GetDirectories(Path.Combine(fixtureV2, "entries"));
        var pointer = Directory.GetFiles(Path.Combine(fixtureV2, "keys")).Single();
        var previousPointer = File.ReadAllText(pointer);
        var validatingCache = false;
        var validatingPublication = false;
        var triggered = false;
        var exit = ProvisionerCommand.Run(phaseArgs, cancellation.Token, output, message =>
        {
            if (message == "Validating cached payload.") validatingCache = true;
            if (message == "Validating prepared run payload.") validatingPublication = true;
            var cancelNow = phase switch
            {
                "cache-validation" => validatingCache && message.StartsWith("Validated payload member: ", StringComparison.Ordinal),
                "cache-success" => message.StartsWith("CACHE HIT ", StringComparison.Ordinal),
                "publication-copy" => message.StartsWith("Copied run payload: ", StringComparison.Ordinal),
                "publication-validation" => validatingPublication && message.StartsWith("Validated payload member: ", StringComparison.Ordinal),
                "before-commit" => message == "Committing completed cache generation.",
                "after-commit" => message == "Committed completed cache generation.",
                "after-pointer" => message == "Published cache pointer.",
                _ => false
            };
            if (cancelNow) { triggered = true; cancellation.Cancel(); }
        }, FakeTool);
        using var json = JsonDocument.Parse(output.ToString());
        var result = json.RootElement;
        Check(triggered && exit == 130 && result.GetProperty("cancelled").GetBoolean() &&
            result.GetProperty("status").GetString() == "failed" && !result.GetProperty("success").GetBoolean() &&
            !result.GetProperty("usedFallback").GetBoolean(), "--build " + phase + " cancelled JSON/exit130 without fallback");
        Check(new[] { "hostDir", "hostExePath", "mergedPriPath" }.All(p => result.GetProperty(p).ValueKind == JsonValueKind.Null),
            "--build " + phase + " exposes no runnable paths");
        Check(fixturePristine.All(pair => HostPayload.Hash(pair.Key) == pair.Value) &&
            Directory.GetFiles(fixtureHost, "*", SearchOption.AllDirectories).Length == fixturePristine.Count,
            "--build " + phase + " preserves cached host and manifest hashes");
        var entriesAfter = Directory.GetDirectories(Path.Combine(fixtureV2, "entries"));
        var committed = phase is "after-commit" or "after-pointer";
        Check(entriesAfter.Length == entriesBefore.Length + (committed ? 1 : 0) &&
            entriesAfter.All(p => !Path.GetFileName(p).StartsWith(".")) &&
            !Directory.GetFiles(Path.Combine(fixtureV2, "keys")).Any(p => Path.GetFileName(p).StartsWith(".")) &&
            !Directory.GetFiles(root, "*.lease").Any(),
            "--build " + phase + " leaves no pending entry/index or owned build stage");
        Check((File.ReadAllText(pointer) != previousPointer) == (phase == "after-pointer"),
            "--build " + phase + " respects atomic pointer boundary");
        foreach (var entry in entriesAfter)
            Check(HostPayload.Validate(Path.Combine(entry, "host")).Files.Count == 8,
                "--build " + phase + " retains only complete immutable generations");
    }

    var lockPath = Path.Combine(root, "locks", "shared");
    var psi = new ProcessStartInfo("dotnet") { RedirectStandardOutput = true, RedirectStandardInput = true, UseShellExecute = false };
    psi.ArgumentList.Add(typeof(HostBuilder).Assembly.Location); psi.ArgumentList.Add("--lock"); psi.ArgumentList.Add(lockPath);
    using (var child = Process.Start(psi)!)
    {
        try
        {
            Check(child.StandardOutput.ReadLine() == "locked", "independent process owns cache lock");
            using var cancel = new CancellationTokenSource(300);
            Reject(() => BuildStorage.AcquireLock(lockPath, cancel.Token).Dispose(), "lock wait cooperatively cancelled");
            child.StandardInput.WriteLine();
            Check(child.WaitForExit(5000) && child.ExitCode == 0, "lock owner exits cleanly");
        }
        finally { if (!child.HasExited) { child.Kill(true); child.WaitForExit(); } }
    }
    using (BuildStorage.AcquireLock(lockPath, CancellationToken.None)) Check(true, "cross-process lock released");
    HostBuilder.BuildOptions Options(string? bundled = null) => new() {
        ProjectPath = sourceTree, SurfaceProjectPath = Path.Combine(root, "missing.csproj"),
        DesignHostPriProjectPath = Path.Combine(root, "missing-template.csproj"), CacheRoot = cache, BundledHostDir = bundled };
    var failed = HostBuilder.Build(Options());
    Check(failed.Status == "failed" && !failed.Success && failed.Error!.Contains("Required source"), "missing inputs fail without tool invocation");
    var degraded = HostBuilder.Build(Options(source));
    Check(degraded.Status == "degraded" && !degraded.Success && degraded.UsedFallback && degraded.Error!.Contains("Required source"), "explicit fallback degraded retains cause");
    using var alreadyCancelled = new CancellationTokenSource();
    alreadyCancelled.Cancel();
    var cancelled = HostBuilder.Build(Options(source), cancellation: alreadyCancelled.Token);
    Check(cancelled.Cancelled && cancelled.Status == "failed" && !cancelled.UsedFallback, "cancellation never falls back");
    var overlayCancelled = Provisioner.Provision(new() { ProjectPath = sourceTree, BaseHostDir = source, OutDir = run },
        cancellation: alreadyCancelled.Token);
    Check(overlayCancelled.Cancelled && !overlayCancelled.Success, "native overlay honours cancellation");
    Console.WriteLine($"Provisioner fixtures: {count} passed.");
}
finally { Directory.Delete(root, true); }
