#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading;

namespace WinUISurface.Shared;

// Linked into net8 provisioning and net472 adapters. No IDE or UI dependencies.
internal sealed class PayloadManifest
{
    public int Format { get; set; } = 2;
    public string Key { get; set; } = "";
    public string Version { get; set; } = "";
    public string EngineStamp { get; set; } = "";
    public Dictionary<string, string> Files { get; set; } = new Dictionary<string, string>();
}

internal static class HostPayload
{
    public const string ManifestName = ".payload.json";
    public const string RunMarker = ".surface-run";
    public static string Hash(string path, CancellationToken cancellation = default)
    {
        cancellation.ThrowIfCancellationRequested();
        using var sha = SHA256.Create();
        using var stream = File.OpenRead(path);
        var buffer = new byte[81920];
        int read;
        while ((read = stream.Read(buffer, 0, buffer.Length)) != 0)
        {
            cancellation.ThrowIfCancellationRequested();
            sha.TransformBlock(buffer, 0, read, buffer, 0);
        }
        cancellation.ThrowIfCancellationRequested();
        sha.TransformFinalBlock(Array.Empty<byte>(), 0, 0);
        return BitConverter.ToString(sha.Hash!).Replace("-", "").ToLowerInvariant();
    }

    public static void Seal(string host, string key, string version, string stamp, CancellationToken cancellation = default)
    {
        var m = new PayloadManifest { Key = key, Version = version, EngineStamp = stamp };
        foreach (var path in Directory.GetFiles(host, "*", SearchOption.AllDirectories).OrderBy(p => p, StringComparer.Ordinal))
        {
            var rel = path.Substring(host.TrimEnd('\\', '/').Length + 1);
            if (rel != ManifestName) m.Files.Add(rel, Hash(path, cancellation));
        }
        cancellation.ThrowIfCancellationRequested();
        File.WriteAllText(Path.Combine(host, ManifestName), JsonSerializer.Serialize(m));
        Validate(host, key, cancellation);
    }

    public static PayloadManifest Validate(string host, string? key = null, CancellationToken cancellation = default,
        Action<string>? log = null)
    {
        cancellation.ThrowIfCancellationRequested();
        var m = JsonSerializer.Deserialize<PayloadManifest>(File.ReadAllText(Path.Combine(host, ManifestName)))
            ?? throw new InvalidDataException("Missing payload manifest.");
        if (m.Format != 2 || string.IsNullOrEmpty(m.Key) || (key != null && m.Key != key))
            throw new InvalidDataException("Payload identity mismatch.");
        foreach (var required in new[] { "Surface.exe", "Surface.dll", "Surface.pri", "Surface.designtime.pri",
            "Surface.deps.json", "Surface.runtimeconfig.json", "Microsoft.WinUI.dll", "Microsoft.ui.xaml.dll" })
            if (!m.Files.ContainsKey(required)) throw new InvalidDataException("Incomplete payload: " + required);
        foreach (var pair in m.Files)
        {
            cancellation.ThrowIfCancellationRequested();
            if (Path.IsPathRooted(pair.Key) || pair.Key.Split('\\', '/').Any(p => p == ".."))
                throw new InvalidDataException("Unsafe payload member.");
            if (Hash(Path.Combine(host, pair.Key), cancellation) != pair.Value)
                throw new InvalidDataException("Payload hash mismatch: " + pair.Key);
            log?.Invoke("Validated payload member: " + pair.Key);
        }
        // Unknown payload files could shadow assemblies/resources; run ownership marker is the only extra.
        foreach (var path in Directory.EnumerateFiles(host, "*", SearchOption.AllDirectories))
        {
            cancellation.ThrowIfCancellationRequested();
            if (!m.Files.ContainsKey(path.Substring(host.TrimEnd('\\', '/').Length + 1)) &&
                path != Path.Combine(host, ManifestName) && path != Path.Combine(host, RunMarker))
                throw new InvalidDataException("Unexpected payload file.");
        }
        cancellation.ThrowIfCancellationRequested();
        return m;
    }

    // Caller supplies a NEW, private path; no mirrors/deletions of caller-owned existing directories.
    public static PayloadManifest CreateRunCopy(string host, string destination,
        CancellationToken cancellation = default, Action<string>? log = null)
    {
        cancellation.ThrowIfCancellationRequested();
        host = CanonicalDirectory(host);
        destination = CanonicalDirectory(destination);
        var staging = destination + ".preparing-" + Guid.NewGuid().ToString("N");
        // Component boundaries matter: H2 is a valid sibling of H, but H/run is not.
        // Check both paths before any filesystem writes, including creation of staging parents.
        if (IsWithin(destination, host) || IsWithin(staging, host))
            throw new IOException("Run-copy destination and staging must be outside the pristine host.");
        var m = Validate(host, cancellation: cancellation);
        if (Directory.Exists(destination) || File.Exists(destination))
            throw new IOException("Run-copy destination must not exist: " + destination);
        // Publish without replacing an existing destination. Cancellation owns only this unique sibling,
        // never the caller's destination or the validated source/cache generation.
        if (Directory.Exists(staging) || File.Exists(staging))
            throw new IOException("Run-copy staging collision: " + staging);
        Directory.CreateDirectory(staging);
        try
        {
            foreach (var rel in m.Files.Keys.Concat(new[] { ManifestName }))
            {
                cancellation.ThrowIfCancellationRequested();
                var dest = Path.Combine(staging, rel);
                Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
                CopyFile(Path.Combine(host, rel), dest, cancellation);
                log?.Invoke("Copied run payload: " + rel);
            }
            log?.Invoke("Validating prepared run payload.");
            Validate(staging, m.Key, cancellation, log);
            File.WriteAllText(Path.Combine(staging, RunMarker), Guid.NewGuid().ToString("N"));
            cancellation.ThrowIfCancellationRequested();
            Directory.Move(staging, destination);
            return m;
        }
        finally
        {
            if (Directory.Exists(staging)) DeleteOwnedDirectory(staging);
        }
    }

    public static void CopyFile(string source, string destination, CancellationToken cancellation = default)
    {
        cancellation.ThrowIfCancellationRequested();
        using var input = File.OpenRead(source);
        using var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None);
        var buffer = new byte[81920];
        int read;
        while ((read = input.Read(buffer, 0, buffer.Length)) != 0)
        {
            cancellation.ThrowIfCancellationRequested();
            output.Write(buffer, 0, read);
        }
        cancellation.ThrowIfCancellationRequested();
    }

    private static string CanonicalDirectory(string path)
    {
        var full = Path.GetFullPath(path);
        var root = Path.GetPathRoot(full)!;
        full = full.Length == root.Length ? root : full.TrimEnd('\\', '/');
        // Reject Windows aliases and reparse ancestors instead of resolving through them.
        for (var current = full; current != null; current = Path.GetDirectoryName(current))
        {
            var name = Path.GetFileName(current);
            if (name.EndsWith(".", StringComparison.Ordinal) || name.EndsWith(" ", StringComparison.Ordinal))
                throw new IOException("Ambiguous directory component: " + current);
            if ((Directory.Exists(current) || File.Exists(current)) &&
                (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("Run-copy directory links are not supported: " + current);
        }
        return full;
    }

    private static bool IsWithin(string path, string parent) =>
        string.Equals(path, parent, StringComparison.OrdinalIgnoreCase) ||
        path.StartsWith(parent.TrimEnd('\\', '/') + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);

    // Only for invocation-owned paths. Never traverse a directory junction/symlink during cleanup.
    public static void DeleteOwnedDirectory(string path)
    {
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) == 0)
        {
            foreach (var file in Directory.GetFiles(path)) File.Delete(file);
            foreach (var child in Directory.GetDirectories(path)) DeleteOwnedDirectory(child);
        }
        Directory.Delete(path);
    }
}
