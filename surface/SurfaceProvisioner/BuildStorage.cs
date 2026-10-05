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
            if (SkipSourceFile(name)) continue;
            HostPayload.CopyFile(file, Path.Combine(destination, name), cancellation);
        }
        foreach (var dir in Directory.GetDirectories(source))
        {
            var name = Path.GetFileName(dir);
            if (SkipSourceDir(name)) continue;
            if ((File.GetAttributes(dir) & FileAttributes.ReparsePoint) != 0) throw new IOException("Source link not supported: " + dir);
            CopySource(dir, Path.Combine(destination, name), cancellation);
        }
    }

    private static bool SkipSourceFile(string name) =>
        name.StartsWith(".") || name.EndsWith(".user") || name.EndsWith(".bak") || name.EndsWith(".log");
    private static bool SkipSourceDir(string name) => name is "bin" or "obj" or "Properties" || name.StartsWith(".");

    /// <summary>Size+timestamp of a file that fed a cache identity; Length -1 records absence.</summary>
    public sealed record Witness(string Path, long Length, long Ticks)
    {
        public static Witness Of(string path, string? name = null)
        {
            var info = new FileInfo(path);
            return info.Exists ? new Witness(name ?? path, info.Length, info.LastWriteTimeUtc.Ticks) : new Witness(name ?? path, -1, 0);
        }
    }

    /// <summary>Witnesses for exactly the files <see cref="CopySource"/> would stage, keyed by relative path.</summary>
    public static List<Witness> SourceWitnesses(string source, CancellationToken cancellation = default)
    {
        var result = new List<Witness>();
        void Walk(string dir)
        {
            foreach (var file in Directory.GetFiles(dir).OrderBy(f => f, StringComparer.Ordinal))
            {
                cancellation.ThrowIfCancellationRequested();
                if (SkipSourceFile(Path.GetFileName(file))) continue;
                result.Add(Witness.Of(file, Path.GetRelativePath(source, file)));
            }
            foreach (var sub in Directory.GetDirectories(dir).OrderBy(d => d, StringComparer.Ordinal))
                if (!SkipSourceDir(Path.GetFileName(sub))) Walk(sub);
        }
        Walk(source);
        return result;
    }

    private sealed class IdentityMemo
    {
        public int Format { get; set; }
        public string Key { get; set; } = "";
        public string Component { get; set; } = "";
        public string Toolchain { get; set; } = "";
        public List<Witness> Engine { get; set; } = new();
        public List<Witness> Template { get; set; } = new();
        public List<Witness> Files { get; set; } = new();
    }

    // Fast cache-hit path: a full Identity() restores three package graphs and SHA-256s every restored
    // package file (tens of seconds in an IDE). The memo records the key plus size/mtime witnesses of
    // every file that fed it; when all witnesses still match, the key is reused. The cached payload is
    // still fully validated and matched-host verified, so a stale memo can only cause a miss, never a
    // wrong-but-accepted host.
    public static string MemoPath(string cacheV2, string project, string surfaceSource, string templateSource,
        string version, string platform, string rid, string engine, string? nugetCache)
    {
        var inputs = string.Join("\n", "memo-format=1", version, platform, rid, engine, nugetCache ?? "",
            Path.GetFullPath(project).ToUpperInvariant(), Path.GetFullPath(surfaceSource).ToUpperInvariant(),
            Path.GetFullPath(templateSource).ToUpperInvariant());
        var name = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(inputs))).ToLowerInvariant();
        return Path.Combine(cacheV2, "memo", name + ".json");
    }

    public static string? Recall(string memoPath, string surfaceSource, string templateSource, string component,
        string toolchain, Action<string> log, CancellationToken cancellation = default)
    {
        if (!File.Exists(memoPath)) return null;
        string? Miss(string why) { log("Identity memo miss: " + why + "."); return null; }
        IdentityMemo? memo;
        try { memo = JsonSerializer.Deserialize<IdentityMemo>(File.ReadAllText(memoPath)); }
        catch (Exception ex) when (ex is JsonException or IOException) { return Miss("unreadable"); }
        if (memo == null || memo.Format != 1 || memo.Key.Length != 64 || memo.Key.Any(c => !char.IsAsciiHexDigit(c)))
            return Miss("invalid");
        if (memo.Component != component) return Miss("WinUI component changed");
        if (memo.Toolchain != toolchain) return Miss("toolchain changed");
        if (!SourceWitnesses(surfaceSource, cancellation).SequenceEqual(memo.Engine)) return Miss("engine sources changed");
        if (!SourceWitnesses(templateSource, cancellation).SequenceEqual(memo.Template)) return Miss("template sources changed");
        foreach (var witness in memo.Files)
        {
            cancellation.ThrowIfCancellationRequested();
            if (Witness.Of(witness.Path) != witness) return Miss("input changed: " + witness.Path);
        }
        return memo.Key;
    }

    public static void Remember(string memoPath, string key, string component, string toolchain,
        List<Witness> engine, List<Witness> template, List<Witness> files, Action<string> log)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(memoPath)!);
            var temp = memoPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(new IdentityMemo { Format = 1, Key = key,
                Component = component, Toolchain = toolchain, Engine = engine, Template = template, Files = files }));
            File.Move(temp, memoPath, true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            log("Identity memo not saved: " + ex.Message);
        }
    }

    public static string Identity(string surface, string template, string project, string version,
        string component, string platform, string rid, string engine, string toolchain, CancellationToken cancellation = default,
        List<Witness>? witnesses = null)
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
            AddResolvedClosure(Path.Combine(item.Item1, "obj", "project.assets.json"), lines, cancellation, witnesses);
        }
        // Target graph/TFMs/resource closure affect identity even though arbitrary resources are not yet merged.
        witnesses?.Add(Witness.Of(project));
        if (File.Exists(project)) lines.Add("project=" + HostPayload.Hash(project, cancellation));
        var targetAssets = Path.Combine(File.Exists(project) ? Path.GetDirectoryName(project)! : project, "obj", "project.assets.json");
        witnesses?.Add(Witness.Of(targetAssets));
        if (File.Exists(targetAssets)) AddResolvedClosure(targetAssets, lines, cancellation, witnesses);
        else lines.Add("target-assets=unresolved");
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join("\n", lines)))).ToLowerInvariant();
    }

    private static void AddResolvedClosure(string assets, List<string> lines, CancellationToken cancellation,
        List<Witness>? witnesses)
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
                var full = Path.Combine(package, file);
                witnesses?.Add(Witness.Of(full));
                lines.Add(lib.Name + "/" + file + "=" + HostPayload.Hash(full, cancellation));
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
        try { File.SetLastWriteTimeUtc(index, DateTime.UtcNow); } catch (IOException) { } catch (UnauthorizedAccessException) { } // last-use stamp for Collect
        return host;
    }

    public const int KeepRecentKeys = 3;
    public static readonly TimeSpan UnusedKeyLifetime = TimeSpan.FromDays(1);
    public static readonly TimeSpan OrphanGrace = TimeSpan.FromHours(1);

    private static bool IsKeyName(string name) => name.Length == 64 && name.All(char.IsAsciiHexDigit);

    // Bounded cache GC, run after a successful provision. Every extension update changes the engine stamp
    // and therefore the key, so without this each update leaves a ~150 MB generation behind forever.
    // A key is retired only if it is not the current key, not among the KeepRecentKeys most recently
    // used, unused for UnusedKeyLifetime, and its build lock is free. A generation is removed only when
    // no pointer references it, it is older than OrphanGrace, and no process has files open in it.
    public static int Collect(string root, string currentKey, Action<string> log)
    {
        var keysDir = Path.Combine(root, "keys");
        var entriesDir = Path.Combine(root, "entries");
        if (!Directory.Exists(keysDir) || !Directory.Exists(entriesDir)) return 0;
        var now = DateTime.UtcNow;
        var removed = 0;
        var pointers = Directory.GetFiles(keysDir).Where(p => IsKeyName(Path.GetFileName(p)))
            .OrderByDescending(File.GetLastWriteTimeUtc).ToList();
        for (var i = KeepRecentKeys; i < pointers.Count; i++)
        {
            var key = Path.GetFileName(pointers[i]);
            if (key == currentKey || now - File.GetLastWriteTimeUtc(pointers[i]) < UnusedKeyLifetime) continue;
            FileStream? held = null;
            try { held = new FileStream(Path.Combine(root, "locks", key), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException) { continue; }
            catch (UnauthorizedAccessException) { continue; }
            using (held)
            {
                try { File.Delete(pointers[i]); log("Cache GC: retired key " + key + "."); }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
            }
        }

        var live = new HashSet<string>(StringComparer.Ordinal);
        foreach (var pointer in Directory.GetFiles(keysDir))
        {
            var name = Path.GetFileName(pointer);
            if (IsKeyName(name)) { try { live.Add(File.ReadAllText(pointer)); } catch (IOException) { return removed; } }
            else if (name.StartsWith(".") && now - File.GetLastWriteTimeUtc(pointer) > OrphanGrace)
                try { File.Delete(pointer); } catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        }
        foreach (var entry in Directory.GetDirectories(entriesDir))
        {
            var name = Path.GetFileName(entry);
            if (live.Contains(name)) continue;
            if (!name.StartsWith(HostPayload.TrashPrefix, StringComparison.Ordinal) &&
                now - Directory.GetLastWriteTimeUtc(entry) < OrphanGrace) continue;
            if ((File.GetAttributes(entry) & FileAttributes.ReparsePoint) != 0) continue;
            if (HostPayload.TryRetire(entry, log)) { removed++; log("Cache GC: removed generation " + name + "."); }
        }

        var memoDir = Path.Combine(root, "memo");
        if (Directory.Exists(memoDir))
            foreach (var memo in Directory.GetFiles(memoDir, "*.json"))
            {
                try
                {
                    var key = JsonSerializer.Deserialize<IdentityMemo>(File.ReadAllText(memo))?.Key ?? "";
                    if (!IsKeyName(key) || !File.Exists(Path.Combine(keysDir, key))) File.Delete(memo);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException) { }
            }
        var locksDir = Path.Combine(root, "locks");
        if (Directory.Exists(locksDir))
            foreach (var lockFile in Directory.GetFiles(locksDir))
            {
                if (File.Exists(Path.Combine(keysDir, Path.GetFileName(lockFile)))) continue;
                if (now - File.GetLastWriteTimeUtc(lockFile) < OrphanGrace) continue;
                try { File.Delete(lockFile); } // fails while held by an in-progress build
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
            }
        return removed;
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
