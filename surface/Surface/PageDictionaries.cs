using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Xml.Linq;

namespace Surface;

/// <summary>
/// Resolves a page's <c>&lt;ResourceDictionary Source="…"&gt;</c> the way the compiled app does. The design-time
/// <c>XamlReader.Load</c> has no base URI, so a document-relative Source (<c>../Themes/X.xaml</c>) can't load;
/// it is rewritten to the project-relative <c>ms-appx:///</c> URI of the staged dictionary. The dictionary's keys
/// are read from the source file so the cleaner keeps references to them instead of treating them as undefined.
/// Never throws; an unresolvable Source is left as written.
/// </summary>
internal sealed class PageDictionaries
{
    private const string MsAppx = "ms-appx:///";
    private const int MaxDepth = 8;
    private static readonly XNamespace Xaml = "http://schemas.microsoft.com/winfx/2006/xaml";

    private readonly string _documentDir;
    private readonly string _projectDir;

    private PageDictionaries(string documentDir, string projectDir)
    {
        _documentDir = documentDir;
        _projectDir = projectDir;
    }

    /// <summary>A resolver for the page at <paramref name="documentPath"/>, or null when its project can't be found.</summary>
    public static PageDictionaries? For(string? documentPath)
    {
        try
        {
            if (string.IsNullOrEmpty(documentPath) || !File.Exists(documentPath))
            {
                return null;
            }
            var docDir = Path.GetDirectoryName(Path.GetFullPath(documentPath))!;
            for (var dir = new DirectoryInfo(docDir); dir != null; dir = dir.Parent)
            {
                if (dir.EnumerateFiles("*.csproj").Any())
                {
                    return new PageDictionaries(docDir, dir.FullName);
                }
            }
        }
        catch
        {
        }
        return null;
    }

    /// <summary>
    /// The loadable Source for <paramref name="source"/> and the keys its dictionary defines (including merged and
    /// theme dictionaries), or null when it doesn't name a dictionary file of this project.
    /// </summary>
    public (string Source, IReadOnlyCollection<string> Keys)? Resolve(string source)
    {
        var file = ToFile(source, _documentDir);
        if (file is null)
        {
            return null;
        }
        var relative = ProjectRelative(file);
        if (relative is null)
        {
            return null;
        }
        var keys = new HashSet<string>(StringComparer.Ordinal);
        CollectKeys(file, keys, new HashSet<string>(StringComparer.OrdinalIgnoreCase), 0);
        var rewritten = IsDocumentRelative(source) ? MsAppx + relative : source;
        return (rewritten, keys);
    }

    private static bool IsDocumentRelative(string source) =>
        !source.StartsWith("/", StringComparison.Ordinal) && !Uri.TryCreate(source, UriKind.Absolute, out _);

    // The project file a Source names: ms-appx:/// and leading-slash are project-relative, anything else is
    // relative to the referencing file.
    private string? ToFile(string source, string baseDir)
    {
        try
        {
            var s = source.Trim();
            if (s.Length == 0)
            {
                return null;
            }
            string full;
            if (s.StartsWith(MsAppx, StringComparison.OrdinalIgnoreCase))
            {
                full = Path.Combine(_projectDir, Uri.UnescapeDataString(s.Substring(MsAppx.Length)).Replace('/', '\\'));
            }
            else if (Uri.TryCreate(s, UriKind.Absolute, out _) && !s.StartsWith("/", StringComparison.Ordinal))
            {
                return null;
            }
            else if (s.StartsWith("/", StringComparison.Ordinal))
            {
                full = Path.Combine(_projectDir, s.TrimStart('/').Replace('/', '\\'));
            }
            else
            {
                full = Path.Combine(baseDir, s.Replace('/', '\\'));
            }
            full = Path.GetFullPath(full);
            return File.Exists(full) ? full : null;
        }
        catch
        {
            return null;
        }
    }

    private string? ProjectRelative(string file)
    {
        var root = _projectDir.TrimEnd('\\') + "\\";
        return file.StartsWith(root, StringComparison.OrdinalIgnoreCase)
            ? file.Substring(root.Length).Replace('\\', '/')
            : null;
    }

    private void CollectKeys(string file, HashSet<string> keys, HashSet<string> visited, int depth)
    {
        if (depth > MaxDepth || !visited.Add(file))
        {
            return;
        }
        XDocument doc;
        try
        {
            doc = XDocument.Load(file);
        }
        catch
        {
            return;
        }
        if (doc.Root is null)
        {
            return;
        }
        foreach (var el in doc.Root.DescendantsAndSelf())
        {
            var key = el.Attribute(Xaml + "Key")?.Value;
            if (!string.IsNullOrWhiteSpace(key))
            {
                keys.Add(key!.Trim());
            }
            if (el.Name.LocalName == "ResourceDictionary" && el.Attribute("Source")?.Value is { } nested &&
                ToFile(nested, Path.GetDirectoryName(file)!) is { } nestedFile)
            {
                CollectKeys(nestedFile, keys, visited, depth + 1);
            }
        }
    }
}
