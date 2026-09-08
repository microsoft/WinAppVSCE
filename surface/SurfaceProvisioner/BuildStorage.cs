using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using WinUISurface.Shared;

namespace SurfaceProvisioner;

internal sealed class BuildStage : IDisposable
{
    public string Root { get; }
    private readonly FileStream _lease;
    private readonly string _leasePath;
    public BuildStage(string? stagingRoot = null)
    {
        var root = Path.GetFullPath(stagingRoot ?? Path.Combine(Path.GetTempPath(), "wsp-v2"));
        // Reserve space for the SDK's longest generated MakePRI relative paths.
        if (root.Length > 80) throw new IOException("Staging root exceeds 80 characters; provide --staging-root at a shorter owned location.");
        Directory.CreateDirectory(root);
        var id = Guid.NewGuid().ToString("N").Substring(0, 16);
        Root = Path.Combine(root, id);
        _leasePath = Root + ".lease";
        _lease = new FileStream(_leasePath, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None);
        if (Directory.Exists(Root)) { _lease.Dispose(); throw new IOException("Staging collision: " + Root); }
        Directory.CreateDirectory(Root);
    }
    public void Dispose()
    {
        try { HostPayload.DeleteOwnedDirectory(Root); }
        finally { _lease.Dispose(); File.Delete(_leasePath); }
    }
}

internal static class BuildStorage
{
    // Source ownership is read-only: never clean/build inside an installed SDK or repository project.
    public static void CopySource(string source, string destination, CancellationToken cancellation = default)
    {
        Directory.CreateDirectory(destination);
        foreach (var file in Directory.GetFiles(source))
        {
            cancellation.ThrowIfCancellationRequested();
            if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw new IOException("Source link not supported: " + file);
            var name = Path.GetFileName(file);
            if (name.StartsWith(".") || name.EndsWith(".user") || name.EndsWith(".bak") || name.EndsWith(".log")) continue;
            HostPayload.CopyFile(file, Path.Combine(destination, name), cancellation);
        }
        foreach (var dir in Directory.GetDirectories(source))
        {
            var name = Path.GetFileName(dir);
            if (name is "bin" or "obj" or "Properties" || name.StartsWith(".")) continue;
            if ((File.GetAttributes(dir) & FileAttributes.ReparsePoint) != 0) throw new IOException("Source link not supported: " + dir);
            CopySource(dir, Path.Combine(destination, name), cancellation);
        }
    }

    public static string Identity(string surface, string template, string project, string version,
        string component, string platform, string rid, string engine, string toolchain, CancellationToken cancellation = default)
    {
        var lines = new List<string> { "cache-format=2", version, component, platform, rid, engine, toolchain };
        foreach (var item in new[] { (surface, "engine"), (template, "template") })
        {
            foreach (var file in Directory.GetFiles(item.Item1, "*", SearchOption.AllDirectories)
                .Where(f => !Path.GetRelativePath(item.Item1, f).Split(Path.DirectorySeparatorChar).Any(p => p is "bin" or "obj"))
                .OrderBy(f => f, StringComparer.Ordinal))
            {
                cancellation.ThrowIfCancellationRequested();
                lines.Add(item.Item2 + "/" + Path.GetRelativePath(item.Item1, file) + "=" + HostPayload.Hash(file, cancellation));
            }
            AddResolvedClosure(Path.Combine(item.Item1, "obj", "project.assets.json"), lines, cancellation);
        }
        // Target graph/TFMs/resource closure affect identity even though arbitrary resources are not yet merged.
        if (File.Exists(project)) lines.Add("project=" + HostPayload.Hash(project, cancellation));
        var targetAssets = Path.Combine(File.Exists(project) ? Path.GetDirectoryName(project)! : project, "obj", "project.assets.json");
        if (File.Exists(targetAssets)) AddResolvedClosure(targetAssets, lines, cancellation);
        else lines.Add("target-assets=unresolved");
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join("\n", lines)))).ToLowerInvariant();
    }

    private static void AddResolvedClosure(string assets, List<string> lines, CancellationToken cancellation)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(assets));
        var root = doc.RootElement;
        // Targets captures exact TFM/RID and selected compile/runtime/resource assets, without staging paths.
        lines.Add("targets=" + root.GetProperty("targets").GetRawText());
        var folders = root.GetProperty("packageFolders").EnumerateObject().Select(p => p.Name).ToArray();
        foreach (var lib in root.GetProperty("libraries").EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal))
        {
            lines.Add("library=" + lib.Name + ":" + lib.Value.GetRawText());
            if (lib.Value.GetProperty("type").GetString() != "package") continue;
            var rel = lib.Value.GetProperty("path").GetString()!;
            var package = folders.Select(f => Path.Combine(f, rel)).FirstOrDefault(Directory.Exists)
                ?? throw new FileNotFoundException("Resolved package missing: " + rel);
            // Hash actual restored files, not just version or nupkg metadata: PRI/assets can change in-place.
            foreach (var file in lib.Value.GetProperty("files").EnumerateArray().Select(f => f.GetString()!).OrderBy(f => f, StringComparer.Ordinal))
            {
                cancellation.ThrowIfCancellationRequested();
                lines.Add(lib.Name + "/" + file + "=" + HostPayload.Hash(Path.Combine(package, file), cancellation));
            }
        }
    }

    public static FileStream AcquireLock(string path, CancellationToken cancellation)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        while (true)
        {
            cancellation.ThrowIfCancellationRequested();
            try { return new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException ex) when ((ex.HResult & 0xffff) is 32 or 33)
            {
                if (cancellation.WaitHandle.WaitOne(100)) cancellation.ThrowIfCancellationRequested();
            }
        }
    }

    public static string? FindCompleted(string root, string key, CancellationToken cancellation = default,
        Action<string>? log = null)
    {
        cancellation.ThrowIfCancellationRequested();
        var index = Path.Combine(root, "keys", key);
        if (!File.Exists(index)) return null;
        var name = File.ReadAllText(index);
        if (name.Length != 97 || !name.StartsWith(key + "-", StringComparison.Ordinal) ||
            name.Any(c => !char.IsAsciiHexDigit(c) && c != '-')) throw new InvalidDataException("Invalid cache index.");
        var host = Path.Combine(root, "entries", name, "host");
        log?.Invoke("Validating cached payload.");
        HostPayload.Validate(host, key, cancellation, log); // Corruption fails explicitly; never overwrite a completed entry.
        cancellation.ThrowIfCancellationRequested();
        return host;
    }

    public static string Publish(string root, string key, string host, CancellationToken cancellation = default,
        Action<string>? log = null)
    {
        HostPayload.Validate(host, key, cancellation);
        var name = key + "-" + Guid.NewGuid().ToString("N");
        var entries = Path.Combine(root, "entries");
        var keys = Path.Combine(root, "keys");
        Directory.CreateDirectory(entries);
        Directory.CreateDirectory(keys);
        var pending = Path.Combine(entries, "." + name);
        var final = Path.Combine(entries, name);
        try
        {
            log?.Invoke("Preparing cache publication.");
            HostPayload.CreateRunCopy(host, Path.Combine(pending, "host"), cancellation, log);
            File.Delete(Path.Combine(pending, "host", HostPayload.RunMarker));
            log?.Invoke("Committing completed cache generation.");
            cancellation.ThrowIfCancellationRequested();
            Directory.Move(pending, final); // Same-volume atomic completed entry publication.
            // Commit boundary: final is immutable/shared now. Never delete it, even on cancellation.
            log?.Invoke("Committed completed cache generation.");
            cancellation.ThrowIfCancellationRequested();
            var indexTemp = Path.Combine(keys, "." + name);
            try {
                File.WriteAllText(indexTemp, name);
                cancellation.ThrowIfCancellationRequested();
                File.Move(indexTemp, Path.Combine(keys, key), true); // Atomic pointer, old generations immutable.
            } finally { if (File.Exists(indexTemp)) File.Delete(indexTemp); }
            log?.Invoke("Published cache pointer.");
            cancellation.ThrowIfCancellationRequested();
            return Path.Combine(final, "host");
        }
        finally { if (Directory.Exists(pending)) HostPayload.DeleteOwnedDirectory(pending); }
    }
}
