using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.Win32.SafeHandles;
using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Workspace;
using WinUiXaml.Xaml;
using Diagnostic = WinUiXaml.LanguageServer.Lsp.Diagnostic;

namespace WinUiXaml.LanguageServer;

/// <summary>Handles XAML language-server protocol requests.</summary>
internal sealed partial class XamlLanguageServer
{
    private static readonly Regex IdentifierPattern = new(@"^[A-Za-z_][A-Za-z0-9_]*$", RegexOptions.Compiled);

    private readonly JsonRpcConnection _connection;
    private readonly XamlProjectResolver _resolver;
    private readonly ConcurrentDictionary<string, TextDocument> _documents = new(StringComparer.OrdinalIgnoreCase);
    private readonly AsyncSingleFlightCache<string, XamlProjectContext> _contexts =
        new(StringComparer.OrdinalIgnoreCase);
    private readonly System.Runtime.CompilerServices.ConditionalWeakTable<Compilation, XamlTypeSystem> _typeSystems = new();
    private readonly XamlResourceGraph _resourceGraph = new();
    private readonly AsyncLocal<CancellationToken> _requestCancellation = new();
    private readonly object _semanticDiagnosticsGate = new();
    private readonly SemaphoreSlim _diagnosticsPublicationGate = new(1, 1);
    private readonly ConcurrentDictionary<string, AsyncCancellationLifetime> _semanticDiagnosticCancellations =
        new(StringComparer.OrdinalIgnoreCase);
    private int _msbuildUnavailableNotified;
    private readonly ConcurrentDictionary<string, byte> _restoreRequiredProjects =
        new(StringComparer.OrdinalIgnoreCase);
    private bool _shuttingDown;

    // MSBuild evaluation is restricted to trusted roots because project files can execute code. An empty list disables project evaluation.
    private string[] _allowedRoots = System.Array.Empty<string>();
    private string _diagnosticsLevel = "warning";
    private int _diagnosticsGeneration;

    public XamlLanguageServer(JsonRpcConnection connection, XamlProjectResolver resolver)
    {
        _connection = connection;
        _resolver = resolver;
        _connection.OnRequest = HandleRequestAsync;
        _connection.OnNotification = HandleNotificationAsync;
    }

    private async Task<object?> HandleRequestAsync(
        string method,
        JsonElement? @params,
        CancellationToken cancellationToken)
    {
        var previous = _requestCancellation.Value;
        _requestCancellation.Value = cancellationToken;
        try
        {
            return await DispatchRequestAsync(method, @params).ConfigureAwait(false);
        }
        finally
        {
            _requestCancellation.Value = previous;
        }
    }

    private Task<object?> DispatchRequestAsync(string method, JsonElement? @params) => method switch
    {
        "initialize" => Task.FromResult<object?>(Initialize(Deserialize<InitializeParams>(@params))),
        "shutdown" => Shutdown(),
        "textDocument/definition" => GoToDefinitionAsync(Deserialize<TextDocumentPositionParams>(@params)),
        "textDocument/references" => FindReferencesAsync(Deserialize<ReferenceParams>(@params)),
        "textDocument/documentHighlight" => DocumentHighlightAsync(Deserialize<TextDocumentPositionParams>(@params)),
        "textDocument/hover" => HoverAsync(Deserialize<TextDocumentPositionParams>(@params)),
        "textDocument/completion" => CompleteAsync(Deserialize<TextDocumentPositionParams>(@params)),
        "textDocument/documentSymbol" => Task.FromResult<object?>(DocumentSymbols(Deserialize<DocumentSymbolParams>(@params))),
        "textDocument/formatting" => FormatDocumentAsync(Deserialize<DocumentFormattingParams>(@params)),
        "textDocument/rangeFormatting" => FormatRangeAsync(Deserialize<DocumentRangeFormattingParams>(@params)),
        "textDocument/onTypeFormatting" => FormatOnTypeAsync(Deserialize<DocumentOnTypeFormattingParams>(@params)),
        "textDocument/foldingRange" => FoldingRangeAsync(Deserialize<FoldingRangeParams>(@params)),
        "textDocument/documentColor" => DocumentColorAsync(Deserialize<DocumentColorParams>(@params)),
        "textDocument/colorPresentation" => ColorPresentationAsync(Deserialize<ColorPresentationParams>(@params)),
        "textDocument/selectionRange" => SelectionRangeAsync(Deserialize<SelectionRangeParams>(@params)),
        "textDocument/linkedEditingRange" => LinkedEditingRangeAsync(Deserialize<TextDocumentPositionParams>(@params)),
        "textDocument/documentLink" => DocumentLinkAsync(Deserialize<DocumentLinkParams>(@params)),
        "textDocument/prepareRename" => PrepareRenameAsync(Deserialize<TextDocumentPositionParams>(@params)),
        "textDocument/rename" => RenameAsync(Deserialize<RenameParams>(@params)),
        "textDocument/semanticTokens/full" => SemanticTokensAsync(Deserialize<SemanticTokensParams>(@params)),
        "textDocument/semanticTokens/range" => SemanticTokensRangeAsync(Deserialize<SemanticTokensRangeParams>(@params)),
        "textDocument/codeAction" => CodeActionAsync(Deserialize<CodeActionParams>(@params)),
        _ => throw new MethodNotFoundException(method),
    };

    private async Task HandleNotificationAsync(string method, JsonElement? @params)
    {
        switch (method)
        {
            case "initialized":
                break;
            case "textDocument/didOpen":
                await DidOpenAsync(Deserialize<DidOpenTextDocumentParams>(@params)).ConfigureAwait(false);
                break;
            case "textDocument/didChange":
                await DidChangeAsync(Deserialize<DidChangeTextDocumentParams>(@params)).ConfigureAwait(false);
                break;
            case "textDocument/didClose":
                await DidCloseAsync(Deserialize<DidCloseTextDocumentParams>(@params)).ConfigureAwait(false);
                break;
            case "workspace/didChangeWatchedFiles":
                await DidChangeWatchedFilesAsync(Deserialize<DidChangeWatchedFilesParams>(@params)).ConfigureAwait(false);
                break;
            case "workspace/didChangeConfiguration":
                await DidChangeConfigurationAsync(Deserialize<DidChangeConfigurationParams>(@params)).ConfigureAwait(false);
                break;
            case "exit":
                Environment.Exit(_shuttingDown ? 0 : 1);
                break;
        }
    }

    private InitializeResult Initialize(InitializeParams p)
    {
        _allowedRoots = ResolveAllowedRoots(p);
        _diagnosticsLevel = NormalizeDiagnosticsLevel(
            p.InitializationOptions?.DiagnosticsLevel);
        Console.Error.WriteLine(
            $"[winui-xaml-ls] allowed roots: {(_allowedRoots.Length == 0 ? "(none — project evaluation disabled)" : string.Join("; ", _allowedRoots))}");
        return new()
        {
        Capabilities = new ServerCapabilities
        {
            TextDocumentSync = new TextDocumentSyncOptions { OpenClose = true, Change = 1 /* Full */ },
            DefinitionProvider = true,
            ReferencesProvider = true,
            DocumentHighlightProvider = true,
            HoverProvider = true,
            DocumentSymbolProvider = true,
            DocumentFormattingProvider = true,
            DocumentRangeFormattingProvider = true,
            DocumentOnTypeFormattingProvider = new DocumentOnTypeFormattingOptions
            {
                FirstTriggerCharacter = ">",
            },
            FoldingRangeProvider = true,
            ColorProvider = true,
            SelectionRangeProvider = true,
            LinkedEditingRangeProvider = true,
            DocumentLinkProvider = new DocumentLinkOptions { ResolveProvider = false },
            RenameProvider = new RenameOptions { PrepareProvider = true },
            SemanticTokensProvider = new SemanticTokensOptions
            {
                Legend = new SemanticTokensLegend
                {
                    TokenTypes = XamlSemanticTokens.TokenTypes,
                    TokenModifiers = XamlSemanticTokens.TokenModifiers,
                },
                Full = true,
                Range = true,
            },
            CodeActionProvider = new CodeActionOptions
            {
                CodeActionKinds = new[] { "quickfix", "source.organizeImports" },
            },
            CompletionProvider = new CompletionOptions
            {
                // Re-trigger on start-tag, the attribute gap, the attached-property dot, the prefix colon, and the opening quote of an attribute value (enum/bool value completion).
                TriggerCharacters = new[] { "<", " ", ".", ":", "\"", "'", "{", "=", "/" },
                ResolveProvider = false,
            },
        },
        ServerInfo = new ServerInfo { Version = "0.1.0" },
        };
    }

    internal static string NormalizeDiagnosticsLevel(string? value) =>
        value switch
        {
            "off" => "off",
            "error" or "errorsOnly" => "error",
            _ => "warning",
        };

    /// <summary>Computes the workspace-trust boundary from initialize params.</summary>
    private static string[] ResolveAllowedRoots(InitializeParams p)
    {
        var explicitRoots = p.InitializationOptions?.AllowedRoots;
        if (explicitRoots != null)
        {
            return NormalizeRoots(explicitRoots);
        }

        var fallback = new List<string>(2);
        if (!string.IsNullOrWhiteSpace(p.RootUri) && LspUri.ToPath(p.RootUri) is { } rootFromUri)
        {
            fallback.Add(rootFromUri);
        }
        if (fallback.Count == 0 && !string.IsNullOrWhiteSpace(p.RootPath))
        {
            fallback.Add(p.RootPath!);
        }

        return NormalizeRoots(fallback.ToArray());
    }

    internal static string[] NormalizeRoots(string[] roots)
    {
        if (roots.Length == 0)
        {
            return System.Array.Empty<string>();
        }

        var normalized = new List<string>(roots.Length);
        foreach (var root in roots)
        {
            if (string.IsNullOrWhiteSpace(root))
            {
                continue;
            }

            string full;
            try
            {
                full = CanonicalizePath(root);
            }
            catch (System.Exception)
            {
                continue;
            }

            // Trim a trailing separator so "C:\root" and "C:\root\" compare equal, but keep a bare drive root ("C:\") intact so it does not collapse to the drive-relative "C:".
            if (full.Length > 3 || !(full.Length == 3 && full[1] == ':'))
            {
                full = full.TrimEnd(System.IO.Path.DirectorySeparatorChar, System.IO.Path.AltDirectorySeparatorChar);
            }

            if (full.Length > 0)
            {
                normalized.Add(full);
            }
        }

        return normalized.ToArray();
    }

    /// <summary>True when path lies under one of the trusted _allowedRoots.</summary>
    private bool TryGetAllowedRoot(string path, out string canonicalPath, out string allowedRoot)
    {
        canonicalPath = string.Empty;
        allowedRoot = string.Empty;
        var roots = _allowedRoots;
        if (roots.Length == 0)
        {
            return false;
        }

        try
        {
            canonicalPath = CanonicalizePath(path);
        }
        catch (System.Exception)
        {
            return false;
        }

        foreach (var root in roots)
        {
            if (PathIsWithin(canonicalPath, root))
            {
                allowedRoot = root;
                return true;
            }
        }

        return false;
    }

    internal static bool PathIsWithin(string path, string root)
    {
        if (path.Length == root.Length)
        {
            return string.Equals(path, root, StringComparison.OrdinalIgnoreCase);
        }

        if (path.Length <= root.Length)
        {
            return false;
        }

        if (!path.StartsWith(root, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        // A bare drive/UNC root that NormalizeRoots leaves untrimmed already ends in a separator.
        var rootLast = root[root.Length - 1];
        if (rootLast == System.IO.Path.DirectorySeparatorChar
            || rootLast == System.IO.Path.AltDirectorySeparatorChar)
        {
            return true;
        }

        var boundary = path[root.Length];
        return boundary == System.IO.Path.DirectorySeparatorChar
            || boundary == System.IO.Path.AltDirectorySeparatorChar;
    }

    /// <summary>Returns the final on-disk path with reparse points (junctions/symlinks) resolved, so the allow-list cannot be bypassed by a link inside a trusted root that targets an external dir.</summary>
    internal static string CanonicalizePath(string path)
    {
        string full;
        try { full = System.IO.Path.GetFullPath(path); }
        catch { return path; }

        try
        {
            var existing = full;
            var suffix = string.Empty;
            while (existing != null
                && !System.IO.File.Exists(existing)
                && !System.IO.Directory.Exists(existing))
            {
                var name = System.IO.Path.GetFileName(existing);
                suffix = suffix.Length == 0 ? name : System.IO.Path.Combine(name, suffix);
                existing = System.IO.Path.GetDirectoryName(existing);
            }

            if (existing == null)
            {
                // Nothing in the chain exists, so there is no reparse point to follow.
                return full;
            }

            var resolved = TryGetFinalPath(existing) ?? existing;
            return suffix.Length == 0 ? resolved : System.IO.Path.Combine(resolved, suffix);
        }
        catch
        {
            return full;
        }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes,
        uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(
        SafeFileHandle hFile, [Out] char[] lpszFilePath, uint cchFilePath, uint dwFlags);

    private static string? TryGetFinalPath(string path)
    {
        const uint FILE_SHARE_READ = 0x1, FILE_SHARE_WRITE = 0x2, FILE_SHARE_DELETE = 0x4;
        const uint OPEN_EXISTING = 3;
        const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000; // allows opening directories
        using var handle = CreateFileW(path, 0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero);
        if (handle.IsInvalid) { return null; }
        var buffer = new char[512];
        uint len = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Length, 0);
        if (len == 0) { return null; }
        if (len > buffer.Length)
        {
            buffer = new char[len];
            len = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Length, 0);
            if (len == 0) { return null; }
        }
        var result = new string(buffer, 0, (int)len);
        const string uncPrefix = @"\\?\UNC\";
        const string dosPrefix = @"\\?\";
        if (result.StartsWith(uncPrefix, StringComparison.Ordinal)) { return @"\\" + result.Substring(uncPrefix.Length); }
        if (result.StartsWith(dosPrefix, StringComparison.Ordinal)) { return result.Substring(dosPrefix.Length); }
        return result;
    }

    /// <summary>Resolves the document's project context only when it is under a trusted workspace root; otherwise serves it project-less (no MSBuild evaluation).</summary>
    private Task<XamlResolution?> ResolveIfAllowedAsync(string path) =>
        ResolveIfAllowedAsync(path, _requestCancellation.Value, null);

    private Task<XamlResolution?> ResolveIfAllowedAsync(
        string path,
        CancellationToken cancellationToken,
        string? xamlText)
    {
        if (!TryGetAllowedRoot(path, out var canonicalPath, out var allowedRoot))
        {
            return Task.FromResult<XamlResolution?>(null);
        }

        return _resolver.ResolveAsync(canonicalPath, allowedRoot, cancellationToken, xamlText);
    }

    private Task<XamlResolution?> ResolveFrameworkIfAllowedAsync(
        string path,
        CancellationToken cancellationToken,
        string? xamlText)
    {
        if (!TryGetAllowedRoot(path, out var canonicalPath, out var allowedRoot))
        {
            return Task.FromResult<XamlResolution?>(null);
        }

        return _resolver.ResolveFrameworkAsync(
            canonicalPath,
            allowedRoot,
            cancellationToken,
            xamlText);
    }

    private Task<object?> Shutdown()
    {
        _shuttingDown = true;
        return Task.FromResult<object?>(null);
    }

    // --- Document sync ------------------------------------------------------

    private async Task DidOpenAsync(DidOpenTextDocumentParams p)
    {
        var doc = new TextDocument(
            p.TextDocument.Uri,
            p.TextDocument.Text,
            p.TextDocument.Version);
        _documents[p.TextDocument.Uri] = doc;
        await PublishDiagnosticsAsync(doc).ConfigureAwait(false);
        WarmUp(doc.Uri);
    }

    private async Task DidChangeAsync(DidChangeTextDocumentParams p)
    {
        if (p.ContentChanges.Count == 0)
        {
            return;
        }

        // Full sync: the last change carries the complete document text.
        var text = p.ContentChanges[^1].Text;
        _documents.TryGetValue(p.TextDocument.Uri, out var previous);
        var doc = new TextDocument(
            p.TextDocument.Uri,
            text,
            p.TextDocument.Version);
        _documents[p.TextDocument.Uri] = doc;
        if (!string.Equals(
            previous is null ? null : XamlIntrospection.GetClass(previous.Text),
            XamlIntrospection.GetClass(text),
            StringComparison.Ordinal))
        {
            InvalidateContextAndWarm(p.TextDocument.Uri);
        }
        await PublishDiagnosticsAsync(doc).ConfigureAwait(false);
    }

    private async Task DidCloseAsync(DidCloseTextDocumentParams p)
    {
        await _diagnosticsPublicationGate.WaitAsync().ConfigureAwait(false);
        try
        {
            _documents.TryRemove(p.TextDocument.Uri, out _);
            CancelSemanticDiagnostics(p.TextDocument.Uri);
            _contexts.Invalidate(p.TextDocument.Uri, discardLatest: true);
            await _connection.SendNotificationAsync(
                "winui-xaml/projectContextStatus",
                new { uri = p.TextDocument.Uri, state = "idle" })
                .ConfigureAwait(false);
            await _connection.SendNotificationAsync(
                "textDocument/publishDiagnostics",
                new PublishDiagnosticsParams { Uri = p.TextDocument.Uri, Diagnostics = new List<Diagnostic>() })
                .ConfigureAwait(false);
        }
        finally
        {
            _diagnosticsPublicationGate.Release();
        }
    }

    private async Task DidChangeConfigurationAsync(DidChangeConfigurationParams p)
    {
        var level = NormalizeDiagnosticsLevel(p.Settings?.DiagnosticsLevel);
        if (string.Equals(level, _diagnosticsLevel, StringComparison.Ordinal))
        {
            return;
        }

        _diagnosticsLevel = level;
        Interlocked.Increment(ref _diagnosticsGeneration);
        foreach (var document in _documents.Values)
        {
            CancelSemanticDiagnostics(document.Uri);
            await PublishDiagnosticsAsync(document).ConfigureAwait(false);
        }
    }

    /// <summary>Drops stale project data when source, build inputs, or NuGet assets change.</summary>
    private Task DidChangeWatchedFilesAsync(DidChangeWatchedFilesParams p)
    {
        if (p.Changes is null || p.Changes.Count == 0)
        {
            return Task.CompletedTask;
        }

        var projectsToInvalidate = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var invalidateAllProjects = false;
        foreach (var change in p.Changes)
        {
            var path = UriToPath(change.Uri);
            if (path == null)
            {
                continue;
            }

            var ext = System.IO.Path.GetExtension(path);
            var isCs = ext.Equals(".cs", StringComparison.OrdinalIgnoreCase);
            var isCsproj = ext.Equals(".csproj", StringComparison.OrdinalIgnoreCase);
            var isXaml = ext.Equals(".xaml", StringComparison.OrdinalIgnoreCase);
            var isImportedBuildFile =
                ext.Equals(".props", StringComparison.OrdinalIgnoreCase) ||
                ext.Equals(".targets", StringComparison.OrdinalIgnoreCase);
            var isNuGetAssets = IsNuGetAssetsPath(path);
            if (!isCs && !isCsproj && !isXaml && !isImportedBuildFile && !isNuGetAssets)
            {
                continue;
            }

            if (!TryGetAllowedRoot(path, out var canonicalPath, out var allowedRoot))
            {
                continue;
            }

            if (!isNuGetAssets && IsGeneratedBuildPath(canonicalPath, allowedRoot))
            {
                continue;
            }

            if (isXaml && change.Type == FileChangeType.Changed)
            {
                InvalidateIfSavedClassChanged(canonicalPath);
                continue;
            }

            // Source/project changes and added/removed XAML files affect the project graph.
            var structural =
                isCs || isCsproj || isImportedBuildFile || isNuGetAssets ||
                change.Type != FileChangeType.Changed;
            if (!structural)
            {
                continue;
            }

            if (isImportedBuildFile)
            {
                invalidateAllProjects = true;
                continue;
            }

            var owning = isCsproj
                ? canonicalPath
                : XamlProjectResolver.FindOwningProject(canonicalPath, allowedRoot);
            if (owning != null)
            {
                projectsToInvalidate.Add(owning);
            }
        }

        if (invalidateAllProjects)
        {
            _resolver.InvalidateAll();
            ResetContextsAndWarmDocuments();
        }
        else
        {
            foreach (var project in projectsToInvalidate)
            {
                _resolver.Invalidate(project);
            }
            if (projectsToInvalidate.Count > 0)
            {
                ResetContextsAndWarmDocuments();
            }
        }

        // A delete/rename will not update the timestamp of the path retained by the resource graph, so invalidate the graph whenever a project-affecting watched file changes.
        if (invalidateAllProjects || projectsToInvalidate.Count > 0)
        {
            _resourceGraph.Clear();
        }

        return Task.CompletedTask;
    }

    internal static bool IsGeneratedBuildPath(string path, string root)
    {
        var relativePath = System.IO.Path.GetRelativePath(root, path);
        return relativePath
            .Split(
                new[] { System.IO.Path.DirectorySeparatorChar, System.IO.Path.AltDirectorySeparatorChar },
                StringSplitOptions.RemoveEmptyEntries)
            .Any(segment =>
                segment.Equals("bin", StringComparison.OrdinalIgnoreCase) ||
                segment.Equals("obj", StringComparison.OrdinalIgnoreCase));
    }

    internal static bool IsNuGetAssetsPath(string path)
    {
        if (!System.IO.Path.GetFileName(path).Equals(
            "project.assets.json",
            StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var directory = System.IO.Path.GetDirectoryName(path);
        return directory != null &&
            System.IO.Path.GetFileName(directory).Equals("obj", StringComparison.OrdinalIgnoreCase);
    }

    private void ResetContextsAndWarmDocuments()
    {
        _contexts.InvalidateAll();

        // Rebuild invalidated contexts only for documents the user has opened.
        foreach (var uri in _documents.Keys)
        {
            WarmUp(uri);
        }
    }

    private void InvalidateContextAndWarm(string uri)
    {
        _contexts.Invalidate(uri);
        if (_documents.ContainsKey(uri))
        {
            WarmUp(uri);
        }
    }

    private void InvalidateIfSavedClassChanged(string canonicalPath)
    {
        var uri = _documents.Keys.FirstOrDefault(openUri =>
            UriToPath(openUri) is { } openPath &&
            string.Equals(CanonicalizePath(openPath), canonicalPath, StringComparison.OrdinalIgnoreCase));
        if (uri is null)
        {
            return;
        }

        if (!TryGetReadyContext(uri, out var context))
        {
            InvalidateContextAndWarm(uri);
            return;
        }

        try
        {
            var savedClass = XamlIntrospection.GetClass(System.IO.File.ReadAllText(canonicalPath));
            if (!string.Equals(savedClass, context.Resolution.ClassName, StringComparison.Ordinal))
            {
                InvalidateContextAndWarm(uri);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // A transient save/rename will produce another watched event.
        }
    }

}
