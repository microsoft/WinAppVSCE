using System.Collections.Concurrent;
using WinUiXaml.Workspace;
using WinUiXaml.Xaml;

namespace WinUiXaml.LanguageServer;

internal sealed class XamlResourceGraph
{
    internal const int MaxFiles = 256;
    internal const long MaxFileBytes = 4 * 1024 * 1024;
    internal const long MaxTotalBytes = 16 * 1024 * 1024;
    internal const int MaxDepth = 64;

    private readonly int _maxFiles;
    private readonly long _maxFileBytes;
    private readonly long _maxTotalBytes;
    private readonly int _maxDepth;
    private readonly ConcurrentDictionary<string, CachedResourceFile> _cache =
        new(StringComparer.OrdinalIgnoreCase);

    public XamlResourceGraph()
        : this(MaxFiles, MaxFileBytes, MaxTotalBytes, MaxDepth)
    {
    }

    internal XamlResourceGraph(int maxFiles, long maxFileBytes, long maxTotalBytes, int maxDepth)
    {
        _maxFiles = maxFiles;
        _maxFileBytes = maxFileBytes;
        _maxTotalBytes = maxTotalBytes;
        _maxDepth = maxDepth;
    }

    public IReadOnlyList<ResourceFile> ReadReachable(
        string rootPath,
        string projectRoot,
        Func<string, string?> authorizePath,
        Action<string> log,
        Func<string, string?>? getOpenDocumentText = null,
        CancellationToken cancellationToken = default,
        XamlTypeSystem? typeSystem = null)
    {
        var result = new List<ResourceFile>();
        var pending = new Stack<(string Path, int Depth)>();
        var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        long totalBytes = 0;
        pending.Push((rootPath, 0));

        while (pending.Count > 0 && result.Count < _maxFiles && totalBytes < _maxTotalBytes)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var (requested, depth) = pending.Pop();
            if (depth > _maxDepth)
            {
                continue;
            }

            var path = authorizePath(requested);
            if (path is null || !visited.Add(path))
            {
                continue;
            }

            var file = Read(path, log, getOpenDocumentText);
            if (file is null)
            {
                continue;
            }

            if (file.Value.ByteCount > _maxFileBytes ||
                totalBytes + file.Value.ByteCount > _maxTotalBytes)
            {
                log($"resource graph skipped oversized input '{path}'");
                continue;
            }

            var resourceFile = file.Value;
            if (resourceFile.Parsed.Root is { } root)
            {
                resourceFile = resourceFile with
                {
                    Keys = XamlSemanticFacts.CreateResourceIndex(root, typeSystem)
                        .GetVisibleKeys(root)
                        .ToArray(),
                };
            }

            totalBytes += resourceFile.ByteCount;
            result.Add(resourceFile);
            // A ResourceDictionary resolves duplicate keys from its local entries first, then from merged dictionaries in reverse declaration order. Pushing sources forward onto a stack visits the last declared dictionary first and preserves that runtime lookup precedence.
            foreach (var source in CollectSources(resourceFile.Parsed, typeSystem))
            {
                var resolved = ResolveSourcePath(path, projectRoot, source);
                if (resolved is not null)
                {
                    pending.Push((resolved, depth + 1));
                }
            }
        }

        return result;
    }

    public void Clear() => _cache.Clear();

    internal static string? ResolveSourcePath(string ownerPath, string projectRoot, string source)
    {
        source = source.Trim();
        if (source.Length == 0 || source[0] == '{')
        {
            return null;
        }

        return XamlDocumentLinks.ResolvePath(
            source,
            Path.GetDirectoryName(ownerPath),
            projectRoot,
            _ => true);
    }

    private ResourceFile? Read(
        string path,
        Action<string> log,
        Func<string, string?>? getOpenDocumentText)
    {
        var openText = getOpenDocumentText?.Invoke(path);
        if (openText is not null)
        {
            var openByteCount = checked((long)openText.Length * sizeof(char));
            if (openByteCount > _maxFileBytes)
            {
                log($"resource graph skipped oversized open input '{path}'");
                return null;
            }

            return Parse(path, openText, openByteCount);
        }

        DateTime stamp;
        long byteCount;
        try
        {
            var info = new FileInfo(path);
            stamp = File.GetLastWriteTimeUtc(path);
            byteCount = info.Length;
        }
        catch (IOException ex)
        {
            log($"resource graph timestamp '{path}': {ex.Message}");
            return null;
        }
        catch (UnauthorizedAccessException ex)
        {
            log($"resource graph timestamp '{path}': {ex.Message}");
            return null;
        }

        if (byteCount > _maxFileBytes)
        {
            log($"resource graph skipped oversized input '{path}'");
            return null;
        }

        if (_cache.TryGetValue(path, out var cached) && cached.Stamp == stamp)
        {
            return cached.File;
        }

        string text;
        try
        {
            text = File.ReadAllText(path);
        }
        catch (IOException ex)
        {
            log($"resource graph read '{path}': {ex.Message}");
            return null;
        }
        catch (UnauthorizedAccessException ex)
        {
            log($"resource graph read '{path}': {ex.Message}");
            return null;
        }

        var file = Parse(path, text, byteCount);
        _cache[path] = new CachedResourceFile(stamp, file);
        return file;
    }

    private static ResourceFile Parse(string path, string text, long byteCount)
    {
        var parsed = XamlParser.Parse(text);
        return new ResourceFile(
            path,
            text,
            parsed,
            System.Array.Empty<string>(),
            byteCount);
    }

    private static IEnumerable<string> CollectSources(
        XamlDocument document,
        XamlTypeSystem? typeSystem)
    {
        if (document.Root is null)
        {
            yield break;
        }

        var index = XamlSemanticFacts.CreateResourceIndex(document.Root, typeSystem);
        foreach (var dictionary in index.GetVisibleSourceDictionaries(document.Root))
        {
            if (dictionary.GetAttribute("Source")?.Value is
                {
                    MarkupExtension: null,
                    Text.Length: > 0,
                } value)
            {
                yield return value.Text;
            }
        }
    }

    internal readonly record struct ResourceFile(
        string Path,
        string Text,
        XamlDocument Parsed,
        string[] Keys,
        long ByteCount);

    private readonly record struct CachedResourceFile(DateTime Stamp, ResourceFile File);
}
