using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace Surface;

/// <summary>
/// The project's localized strings for <c>x:Uid</c> (BB-071). At runtime MRT fills <c>Uid.Property</c> entries from
/// <c>Strings\&lt;language&gt;\Resources.resw</c>; the design-time load has no resource map, so the strings are read
/// here in the project's default language and applied as plain attributes. Never throws; missing files are null.
/// </summary>
internal sealed class UidStrings
{
    private static readonly ConcurrentDictionary<string, (DateTime Stamp, IReadOnlyDictionary<string, string> Map)> s_cache =
        new(StringComparer.OrdinalIgnoreCase);

    private readonly string _projectDir;
    private readonly string? _language;

    private UidStrings(string projectDir, string? language)
    {
        _projectDir = projectDir;
        _language = language;
    }

    /// <summary>Strings for the page at <paramref name="documentPath"/>, or null when its project can't be found.</summary>
    public static UidStrings? For(string? documentPath)
    {
        try
        {
            if (string.IsNullOrEmpty(documentPath) || !File.Exists(documentPath))
            {
                return null;
            }
            for (var dir = new DirectoryInfo(Path.GetDirectoryName(Path.GetFullPath(documentPath))!); dir != null; dir = dir.Parent)
            {
                var csproj = dir.EnumerateFiles("*.csproj").FirstOrDefault();
                if (csproj != null)
                {
                    return new UidStrings(dir.FullName, DefaultLanguage(csproj.FullName, dir.FullName));
                }
            }
        }
        catch
        {
        }
        return null;
    }

    /// <summary>The <c>name → value</c> entries of the named resource file (<c>Resources</c> unless the x:Uid says otherwise).</summary>
    public IReadOnlyDictionary<string, string>? Get(string file)
    {
        try
        {
            var path = Find(file);
            if (path is null)
            {
                return null;
            }
            var stamp = File.GetLastWriteTimeUtc(path);
            if (s_cache.TryGetValue(path, out var hit) && hit.Stamp == stamp)
            {
                return hit.Map;
            }
            var map = ReadResw(path);
            s_cache[path] = (stamp, map);
            return map;
        }
        catch
        {
            return null;
        }
    }

    internal static IReadOnlyDictionary<string, string> ReadResw(string path)
    {
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        var doc = XDocument.Load(path);
        foreach (var data in doc.Root?.Elements("data") ?? Enumerable.Empty<XElement>())
        {
            var name = (string?)data.Attribute("name");
            var value = data.Element("value")?.Value;
            if (!string.IsNullOrEmpty(name) && value is not null && data.Attribute("type") is null)
            {
                map[name!] = value;
            }
        }
        return map;
    }

    // Strings\<lang>\X.resw in the default language (then en-US), Strings\X.resw, X.resw, then any language folder.
    private string? Find(string file)
    {
        var name = file + ".resw";
        var strings = Path.Combine(_projectDir, "Strings");
        var candidates = new List<string>();
        foreach (var lang in new[] { _language, "en-US", "en" })
        {
            if (!string.IsNullOrEmpty(lang))
            {
                candidates.Add(Path.Combine(strings, lang!, name));
            }
        }
        candidates.Add(Path.Combine(strings, name));
        candidates.Add(Path.Combine(_projectDir, name));
        var hit = candidates.FirstOrDefault(File.Exists);
        if (hit is not null || !Directory.Exists(strings))
        {
            return hit;
        }
        return Directory.EnumerateDirectories(strings)
            .Select(d => Path.Combine(d, name))
            .Where(File.Exists)
            .OrderBy(p => p, StringComparer.OrdinalIgnoreCase)
            .FirstOrDefault();
    }

    private static string? DefaultLanguage(string csproj, string projectDir)
    {
        try
        {
            var m = Regex.Match(File.ReadAllText(csproj), @"<DefaultLanguage>\s*([^<\s$]+)\s*</DefaultLanguage>");
            if (m.Success)
            {
                return m.Groups[1].Value;
            }
            var manifest = Path.Combine(projectDir, "Package.appxmanifest");
            if (File.Exists(manifest))
            {
                var lang = XDocument.Load(manifest).Descendants().Where(e => e.Name.LocalName == "Resource")
                    .Select(e => (string?)e.Attribute("Language"))
                    .FirstOrDefault(l => !string.IsNullOrEmpty(l) && !l!.StartsWith("x-", StringComparison.OrdinalIgnoreCase));
                if (lang is not null)
                {
                    return lang;
                }
            }
        }
        catch
        {
        }
        return null;
    }
}
