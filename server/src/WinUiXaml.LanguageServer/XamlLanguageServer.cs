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
using SymbolKind = WinUiXaml.LanguageServer.Lsp.SymbolKind;

namespace WinUiXaml.LanguageServer;

/// <summary>
/// The WinUI XAML language server. Wires the tolerant parser (syntax + diagnostics) and the
/// project resolver (semantic navigation) to LSP requests coming over a <see cref="JsonRpcConnection"/>.
/// <para>
/// First features: publish syntactic diagnostics on open/change, and go-to-definition from an
/// event-handler / member-name attribute value to the C# member on the page's <c>x:Class</c> type.
/// </para>
/// </summary>
internal sealed class XamlLanguageServer
{
    private static readonly Regex IdentifierPattern = new(@"^[A-Za-z_][A-Za-z0-9_]*$", RegexOptions.Compiled);

    private readonly JsonRpcConnection _connection;
    private readonly XamlProjectResolver _resolver;
    private readonly ConcurrentDictionary<string, TextDocument> _documents = new(StringComparer.OrdinalIgnoreCase);
    private readonly System.Runtime.CompilerServices.ConditionalWeakTable<Compilation, XamlTypeSystem> _typeSystems = new();
    private readonly ConcurrentDictionary<string, (System.DateTime Stamp, string[] Keys)> _appResourceCache = new(StringComparer.OrdinalIgnoreCase);
    private bool _shuttingDown;

    // Workspace-trust boundary (defense-in-depth): normalized absolute directories the client trusts.
    // Project discovery + MSBuild evaluation only runs for documents under one of these roots. Empty =>
    // no project evaluation at all (e.g. an empty window, or a loose file outside every workspace root),
    // so merely opening an attacker-controlled .xaml can never trigger MSBuildWorkspace.OpenProjectAsync.
    private string[] _allowedRoots = System.Array.Empty<string>();

    public XamlLanguageServer(JsonRpcConnection connection, XamlProjectResolver resolver)
    {
        _connection = connection;
        _resolver = resolver;
        _connection.OnRequest = HandleRequestAsync;
        _connection.OnNotification = HandleNotificationAsync;
    }

    private Task<object?> HandleRequestAsync(string method, JsonElement? @params) => method switch
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
            case "exit":
                Environment.Exit(_shuttingDown ? 0 : 1);
                break;
        }
    }

    private InitializeResult Initialize(InitializeParams p)
    {
        _allowedRoots = ResolveAllowedRoots(p);
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
            CodeActionProvider = new CodeActionOptions { CodeActionKinds = new[] { "quickfix" } },
            CompletionProvider = new CompletionOptions
            {
                // Re-trigger on start-tag, the attribute gap, the attached-property dot, the prefix
                // colon, and the opening quote of an attribute value (enum/bool value completion).
                TriggerCharacters = new[] { "<", " ", ".", ":", "\"", "'", "{", "=", "/" },
                ResolveProvider = false,
            },
        },
        ServerInfo = new ServerInfo { Version = "0.1.0" },
        };
    }

    /// <summary>
    /// Computes the workspace-trust boundary from initialize params. The client's
    /// <c>initializationOptions.allowedRoots</c> is authoritative when present (a non-null list, even
    /// empty); only a legacy client that omits it falls back to the declared <c>rootUri</c>/<c>rootPath</c>.
    /// All entries are normalized to full paths with any trailing separator trimmed.
    /// </summary>
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

            // Trim a trailing separator so "C:\root" and "C:\root\" compare equal, but keep a bare drive
            // root ("C:\") intact so it does not collapse to the drive-relative "C:".
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

    /// <summary>
    /// True when <paramref name="path"/> lies under one of the trusted <see cref="_allowedRoots"/>.
    /// An empty allow-list always returns false (no project evaluation). Comparison is case-insensitive
    /// and separator-boundary aware so "C:\root" never matches "C:\rootEvil".
    /// </summary>
    private bool IsPathUnderAllowedRoot(string path)
    {
        var roots = _allowedRoots;
        if (roots.Length == 0)
        {
            return false;
        }

        string full;
        try
        {
            full = CanonicalizePath(path);
        }
        catch (System.Exception)
        {
            return false;
        }

        foreach (var root in roots)
        {
            if (PathIsWithin(full, root))
            {
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

        // A bare drive/UNC root that NormalizeRoots leaves untrimmed already ends in a separator
        // (e.g. "C:\"), so the prefix match itself is the boundary — every child is contained.
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

    /// <summary>
    /// Returns the final on-disk path with reparse points (junctions/symlinks) resolved, so the
    /// allow-list cannot be bypassed by a link inside a trusted root that targets an external dir.
    /// The document leaf need NOT exist: <c>FindOwningProject</c> walks the containing DIRECTORY
    /// (via <c>new FileInfo(path).Directory</c>) and enumerates its <c>.csproj</c> files, so a
    /// not-yet-created <c>Page.xaml</c> under an in-root junction would still reach the junction's
    /// external project. We therefore resolve the deepest EXISTING ancestor (which follows any
    /// junction/symlink in the chain) and re-append the not-yet-existing tail, instead of falling
    /// back to the lexical path when only the leaf is missing. Pure lexical fallback is used only
    /// when no ancestor exists (nothing to follow) or the OS call fails.
    /// </summary>
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

    /// <summary>
    /// Resolves the document's project context only when it is under a trusted workspace root; otherwise
    /// serves it project-less (no MSBuild evaluation). This is the workspace-trust boundary enforcement.
    /// </summary>
    private Task<XamlResolution?> ResolveIfAllowedAsync(string path)
    {
        if (!IsPathUnderAllowedRoot(path))
        {
            return Task.FromResult<XamlResolution?>(null);
        }

        return _resolver.ResolveAsync(path);
    }

    private Task<object?> Shutdown()
    {
        _shuttingDown = true;
        return Task.FromResult<object?>(null);
    }

    // --- Document sync ------------------------------------------------------

    private async Task DidOpenAsync(DidOpenTextDocumentParams p)
    {
        var doc = new TextDocument(p.TextDocument.Uri, p.TextDocument.Text);
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
        var doc = new TextDocument(p.TextDocument.Uri, text);
        _documents[p.TextDocument.Uri] = doc;
        await PublishDiagnosticsAsync(doc).ConfigureAwait(false);
    }

    private async Task DidCloseAsync(DidCloseTextDocumentParams p)
    {
        _documents.TryRemove(p.TextDocument.Uri, out _);
        await _connection.SendNotificationAsync(
            "textDocument/publishDiagnostics",
            new PublishDiagnosticsParams { Uri = p.TextDocument.Uri, Diagnostics = new List<Diagnostic>() })
            .ConfigureAwait(false);
    }

    /// <summary>
    /// Reacts to on-disk changes reported by the client's <c>**/*.{csproj,xaml}</c> watcher by dropping
    /// stale cached Roslyn project/type data. Without this, a project reference or file added on disk
    /// stays invisible until the server is restarted.
    /// <para>
    /// A <c>.csproj</c> change, or a <c>.xaml</c> file being created/deleted, alters the project's
    /// type/reference set, so the owning project's cached workspace is invalidated (the next resolve
    /// reloads it). A plain <c>.xaml</c> content save is already reflected through the open buffer and
    /// the timestamp-guarded App.xaml resource cache, so it does not force a full project reload.
    /// </para>
    /// </summary>
    private Task DidChangeWatchedFilesAsync(DidChangeWatchedFilesParams p)
    {
        if (p.Changes is null || p.Changes.Count == 0)
        {
            return Task.CompletedTask;
        }

        var projectsToInvalidate = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var change in p.Changes)
        {
            var path = UriToPath(change.Uri);
            if (path == null)
            {
                continue;
            }

            var ext = System.IO.Path.GetExtension(path);
            var isCsproj = ext.Equals(".csproj", StringComparison.OrdinalIgnoreCase);
            var isXaml = ext.Equals(".xaml", StringComparison.OrdinalIgnoreCase);
            if (!isCsproj && !isXaml)
            {
                continue;
            }

            // Structural change: a project-file edit, or a page added/removed. A plain .xaml content
            // save (Changed) does not change the project's type/reference graph, so skip the reload.
            var structural = isCsproj || change.Type != FileChangeType.Changed;
            if (!structural)
            {
                continue;
            }

            var owning = isCsproj ? path : XamlProjectResolver.FindOwningProject(path);
            if (owning != null)
            {
                projectsToInvalidate.Add(owning);
            }
        }

        foreach (var project in projectsToInvalidate)
        {
            _resolver.Invalidate(project);
        }

        // The App.xaml resource-key cache is timestamp-guarded, but a delete/rename won't bump a stamp
        // we still hold; drop it wholesale on any watched change (it repopulates lazily and cheaply).
        if (projectsToInvalidate.Count > 0)
        {
            _appResourceCache.Clear();
        }

        return Task.CompletedTask;
    }

    private async Task PublishDiagnosticsAsync(TextDocument doc)
    {
        var syntactic = new List<Diagnostic>(doc.Parsed.Diagnostics.Count);
        foreach (var d in doc.Parsed.Diagnostics)
        {
            syntactic.Add(new Diagnostic
            {
                Range = doc.RangeOf(d.Span),
                Severity = MapSeverity(d.Severity),
                Code = d.Id,
                Message = d.Message,
            });
        }

        await _connection.SendNotificationAsync(
            "textDocument/publishDiagnostics",
            new PublishDiagnosticsParams { Uri = doc.Uri, Diagnostics = syntactic }).ConfigureAwait(false);

        // Semantic validation needs the project's type system (async; the first load is slow). Run it off
        // the hot path and re-publish a combined set, but only while this remains the current document.
        _ = Task.Run(() => PublishSemanticDiagnosticsAsync(doc, syntactic));
    }

    /// <summary>
    /// Computes semantic diagnostics against the loaded type system and re-publishes them combined with
    /// the already-sent syntactic set. A reference-equality guard on the current document drops results
    /// for versions the user has already edited past, avoiding stale squiggles under rapid typing.
    /// </summary>
    private async Task PublishSemanticDiagnosticsAsync(TextDocument doc, List<Diagnostic> syntactic)
    {
        try
        {
            var typeSystem = await GetTypeSystemAsync(doc.Uri).ConfigureAwait(false);
            if (typeSystem == null || !IsCurrent(doc))
            {
                return;
            }

            var semantic = XamlValidator.Validate(doc, typeSystem);
            if (semantic.Count == 0 || !IsCurrent(doc))
            {
                // No semantic issues: the syntactic-only publish already sent is the correct final state.
                return;
            }

            var combined = new List<Diagnostic>(syntactic.Count + semantic.Count);
            combined.AddRange(syntactic);
            combined.AddRange(semantic);

            if (!IsCurrent(doc))
            {
                return;
            }

            await _connection.SendNotificationAsync(
                "textDocument/publishDiagnostics",
                new PublishDiagnosticsParams { Uri = doc.Uri, Diagnostics = combined }).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[winui-xaml-ls] semantic validation failed: {ex.Message}");
        }
    }

    private bool IsCurrent(TextDocument doc) =>
        _documents.TryGetValue(doc.Uri, out var current) && ReferenceEquals(current, doc);

    // --- Document symbols (outline) -----------------------------------------

    /// <summary>
    /// Builds the hierarchical outline (Outline view, breadcrumbs, Go to Symbol) from the parsed tree.
    /// Each element becomes a symbol named by its tag, annotated with its x:Name when present; property
    /// elements (<c>Grid.RowDefinitions</c>) are shown as property nodes. AST-only — no type system.
    /// </summary>
    private object DocumentSymbols(DocumentSymbolParams p)
    {
        var result = new List<DocumentSymbol>();
        if (_documents.TryGetValue(p.TextDocument.Uri, out var doc) && doc.Parsed.Root is { } root)
        {
            AddOutlineSymbol(doc, root, result);
        }

        return result;
    }

    private static void AddOutlineSymbol(TextDocument doc, XamlElement element, List<DocumentSymbol> siblings)
    {
        // A malformed element with no name still contributes its children to the outline.
        if (element.Name is not { LocalName.Length: > 0 } name)
        {
            foreach (var child in element.Content)
            {
                if (child is XamlElement childElement)
                {
                    AddOutlineSymbol(doc, childElement, siblings);
                }
            }

            return;
        }

        var xName = GetXName(element);
        var children = new List<DocumentSymbol>();
        foreach (var child in element.Content)
        {
            if (child is XamlElement childElement)
            {
                AddOutlineSymbol(doc, childElement, children);
            }
        }

        siblings.Add(new DocumentSymbol
        {
            Name = xName != null ? $"{name.FullName} ({xName})" : name.FullName,
            Detail = xName,
            Kind = element.IsPropertyElement ? SymbolKind.Property : SymbolKind.Class,
            Range = doc.RangeOf(element.Span),
            SelectionRange = doc.RangeOf(name.Span),
            Children = children.Count > 0 ? children : null,
        });
    }

    /// <summary>Returns the element's <c>x:Name</c> (or <c>Name</c>) value, or null if unset.</summary>
    private static string? GetXName(XamlElement element)
    {
        var attr = element.GetAttribute("x:Name") ?? element.GetAttribute("Name");
        var text = attr?.Value?.Text;
        return string.IsNullOrWhiteSpace(text) ? null : text!.Trim();
    }

    // --- Semantic navigation (definition + hover) ---------------------------

    private async Task<object?> GoToDefinitionAsync(TextDocumentPositionParams p)
    {
        // A {StaticResource Key} value is not a type/member name, so try the resource-key pipeline
        // first; it is cheap (no project load) when the caret is not on such a reference.
        var resource = await ResolveResourceKeyDefinitionAsync(p).ConfigureAwait(false);
        if (resource != null)
        {
            return resource;
        }

        // A named-element reference (Binding ElementName=Foo, Storyboard.TargetName="Foo") navigates to
        // the x:Name declaration in this document. Tried before the member pipeline so TargetName does
        // not fall through and mis-resolve to the generated x:Name backing field in the .g.i.cs.
        var nameRef = await ResolveNameReferenceAsync(p).ConfigureAwait(false);
        if (nameRef != null)
        {
            return nameRef.Value.Declaration;
        }

        var (symbol, _) = await ResolveNamedSymbolAsync(p).ConfigureAwait(false);
        var location = symbol?.Locations.FirstOrDefault(l => l.IsInSource);
        return location != null ? ToLspLocation(location) : null;
    }

    // --- Find All References (Shift+F12) ------------------------------------

    /// <summary>
    /// Handles <c>textDocument/references</c> (Find All References). Resolves the symbol under the caret —
    /// an <c>x:Name</c> (declaration or an <c>ElementName=</c>/<c>Storyboard.TargetName</c> usage) or a
    /// resource key (an <c>x:Key</c> declaration or a <c>{StaticResource}</c>/<c>{ThemeResource}</c>/
    /// <c>{CustomResource}</c> usage) — then returns every reference, honoring
    /// <c>context.includeDeclaration</c>. An <c>x:Name</c> stays document-scoped (its cross-file identity is
    /// the generated code-behind field — future work). A RESOURCE KEY additionally resolves across the
    /// project: every other XAML document (App.xaml + pages) that declares or uses it (read-only). Returns
    /// null when the caret is not on a supported symbol.
    /// </summary>
    private async Task<object?> FindReferencesAsync(ReferenceParams p)
    {
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc) || doc.Parsed.Root is not { } root)
        {
            return null;
        }

        int offset = doc.OffsetAt(p.Position);
        var occurrences = ResolveOccurrences(doc, root, offset);
        if (occurrences is null)
        {
            return null;
        }

        bool includeDeclaration = p.Context?.IncludeDeclaration ?? true;
        var locations = occurrences
            .Where(o => includeDeclaration || !o.IsDeclaration)
            .Select(o => new Lsp.Location { Uri = doc.Uri, Range = o.Range })
            .ToList();

        // A resource key is a PROJECT-WIDE symbol: its x:Key is typically declared in App.xaml and used
        // across pages. Extend the (document-scoped) occurrences with references in every OTHER project
        // XAML file. This is READ-ONLY and additive; x:Name is per-file (its cross-file identity lives in
        // generated code-behind fields — separate future work), so only resource keys reach across files.
        if (DetectSymbolAt(doc, offset) is { Kind: XamlRenameKind.Key, Name: { Length: > 0 } key })
        {
            await AddCrossFileResourceReferencesAsync(p.TextDocument.Uri, key, includeDeclaration, locations)
                .ConfigureAwait(false);
        }

        return locations;
    }

    /// <summary>
    /// Adds, to <paramref name="locations"/>, every reference to the resource <paramref name="key"/> in the
    /// project's OTHER XAML documents — each <c>x:Key</c> declaration (honoring
    /// <paramref name="includeDeclaration"/>) and every <c>{StaticResource}</c>/<c>{ThemeResource}</c>/
    /// <c>{CustomResource}</c> usage. READ-ONLY and additive. The current document is collected from its open
    /// (possibly unsaved) buffer by the caller, so its on-disk copy is skipped to avoid stale duplicates;
    /// build output (<c>bin</c>/<c>obj</c>) is excluded. Best-effort: a file that cannot be read or parsed is
    /// skipped. No-ops when the project cannot be resolved, leaving references document-scoped.
    /// </summary>
    private async Task AddCrossFileResourceReferencesAsync(
        string currentUri, string key, bool includeDeclaration, List<Lsp.Location> locations)
    {
        var context = await GetContextAsync(currentUri).ConfigureAwait(false);
        if (context == null)
        {
            return;
        }

        var projectDir = System.IO.Path.GetDirectoryName(context.Value.Resolution.ProjectPath);
        if (string.IsNullOrEmpty(projectDir))
        {
            return;
        }

        var currentPath = UriToPath(currentUri) is { } cp ? System.IO.Path.GetFullPath(cp) : null;

        foreach (var file in EnumerateProjectXamlFiles(projectDir))
        {
            // The open document was already collected from its (possibly unsaved) buffer; skip its disk copy.
            if (currentPath != null &&
                string.Equals(System.IO.Path.GetFullPath(file), currentPath, System.StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            string text;
            try
            {
                text = System.IO.File.ReadAllText(file);
            }
            catch (System.Exception ex)
            {
                System.Console.Error.WriteLine($"[winui-xaml-ls] xref read '{file}': {ex.Message}");
                continue;
            }

            // Cheap literal pre-filter: only parse files that mention the key at all. The collector still
            // matches the key EXACTLY, so this never widens results — it only skips irrelevant files.
            if (text.IndexOf(key, System.StringComparison.Ordinal) < 0)
            {
                continue;
            }

            TextDocument fileDoc;
            try
            {
                fileDoc = new TextDocument(PathToUri(file), text);
            }
            catch (System.Exception ex)
            {
                System.Console.Error.WriteLine($"[winui-xaml-ls] xref parse '{file}': {ex.Message}");
                continue;
            }

            if (fileDoc.Parsed.Root is not { } fileRoot)
            {
                continue;
            }

            var fileOccurrences = new List<(Lsp.Range Range, bool IsDeclaration)>();
            CollectResourceOccurrences(fileRoot, key, fileDoc, fileOccurrences);
            foreach (var occurrence in DedupeAndSort(fileOccurrences))
            {
                if (!includeDeclaration && occurrence.IsDeclaration)
                {
                    continue;
                }

                locations.Add(new Lsp.Location { Uri = fileDoc.Uri, Range = occurrence.Range });
            }
        }
    }

    /// <summary>
    /// The project's <c>.xaml</c> files under <paramref name="projectDir"/>, excluding build output
    /// (<c>bin</c>/<c>obj</c>). Empty when the directory cannot be enumerated (best-effort).
    /// </summary>
    private static List<string> EnumerateProjectXamlFiles(string projectDir)
    {
        var result = new List<string>();
        try
        {
            foreach (var file in System.IO.Directory.EnumerateFiles(
                projectDir, "*.xaml", System.IO.SearchOption.AllDirectories))
            {
                if (!IsUnderBuildOutput(file))
                {
                    result.Add(file);
                }
            }
        }
        catch (System.Exception ex)
        {
            System.Console.Error.WriteLine($"[winui-xaml-ls] xref enumerate '{projectDir}': {ex.Message}");
        }

        return result;
    }

    /// <summary>True when <paramref name="path"/> lies under a <c>bin</c> or <c>obj</c> directory segment
    /// (build output, whose copied XAML must never be surfaced as a real source reference).</summary>
    private static bool IsUnderBuildOutput(string path)
    {
        foreach (var segment in path.Split(System.IO.Path.DirectorySeparatorChar, System.IO.Path.AltDirectorySeparatorChar))
        {
            if (string.Equals(segment, "bin", System.StringComparison.OrdinalIgnoreCase) ||
                string.Equals(segment, "obj", System.StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Handles <c>textDocument/documentHighlight</c> — highlights every occurrence of the symbol under the
    /// caret in this document (the read-only sibling of Find All References). The declaration is a Write
    /// highlight (kind 3); every usage is a Read highlight (kind 2). Returns null when the caret is not on a
    /// supported symbol.
    /// </summary>
    private async Task<object?> DocumentHighlightAsync(TextDocumentPositionParams p)
    {
        await Task.CompletedTask.ConfigureAwait(false);
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc) || doc.Parsed.Root is not { } root)
        {
            return null;
        }

        var occurrences = ResolveOccurrences(doc, root, doc.OffsetAt(p.Position));
        if (occurrences is null)
        {
            return null;
        }

        return occurrences
            .Select(o => new Lsp.DocumentHighlight { Range = o.Range, Kind = o.IsDeclaration ? 3 : 2 })
            .ToList();
    }

    /// <summary>
    /// Handles <c>textDocument/prepareRename</c> — confirms the caret sits on a renameable symbol (an
    /// <c>x:Name</c>/<c>Name</c> or an <c>x:Key</c> resource key) and returns the exact editable token range
    /// plus the current name as the rename placeholder. Returns null when the caret is not on a supported
    /// symbol, which makes the editor report that the element cannot be renamed.
    /// </summary>
    private async Task<object?> PrepareRenameAsync(TextDocumentPositionParams p)
    {
        await Task.CompletedTask.ConfigureAwait(false);
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc))
        {
            return null;
        }

        return XamlRename.PrepareRename(doc, doc.OffsetAt(p.Position));
    }

    /// <summary>
    /// Handles <c>textDocument/rename</c> — renames the <c>x:Name</c>/<c>Name</c> or <c>x:Key</c> resource key
    /// under the caret and every reference to it in the document, returning a single-document
    /// <see cref="WorkspaceEdit"/>. Throws (surfaced to the user) when the new name is invalid, so a rename can
    /// never corrupt the markup. Returns null when the caret is not on a supported symbol.
    /// </summary>
    private async Task<object?> RenameAsync(RenameParams p)
    {
        await Task.CompletedTask.ConfigureAwait(false);
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc))
        {
            return null;
        }

        return XamlRename.Rename(doc, doc.OffsetAt(p.Position), p.NewName);
    }

    /// <summary>
    /// Handles <c>textDocument/formatting</c> (Format Document) — returns leading-indentation edits that
    /// normalize every structural line to its element-nesting depth. Conservative and non-destructive:
    /// see <see cref="XamlFormatter"/>. Returns null when the document is not open.
    /// </summary>
    private Task<object?> FormatDocumentAsync(DocumentFormattingParams p)
    {
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc))
        {
            return Task.FromResult<object?>(null);
        }

        return Task.FromResult<object?>(XamlFormatter.Format(doc, p.Options));
    }

    /// <summary>
    /// Handles <c>textDocument/rangeFormatting</c> (Format Selection) — the same reindentation as
    /// <see cref="FormatDocumentAsync"/>, but only edits lines intersecting the requested range. Returns
    /// null when the document is not open.
    /// </summary>
    private Task<object?> FormatRangeAsync(DocumentRangeFormattingParams p)
    {
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc))
        {
            return Task.FromResult<object?>(null);
        }

        return Task.FromResult<object?>(XamlFormatter.Format(doc, p.Options, p.Range));
    }

    private Task<object?> FoldingRangeAsync(FoldingRangeParams p)
    {
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc))
        {
            return Task.FromResult<object?>(null);
        }

        return Task.FromResult<object?>(XamlFolding.Compute(doc));
    }

    private Task<object?> DocumentColorAsync(DocumentColorParams p)
    {
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc))
        {
            return Task.FromResult<object?>(null);
        }

        return Task.FromResult<object?>(XamlColor.Collect(doc));
    }

    private Task<object?> ColorPresentationAsync(ColorPresentationParams p) =>
        Task.FromResult<object?>(XamlColor.Present(p.Color, p.Range));

    private Task<object?> SelectionRangeAsync(SelectionRangeParams p)
    {
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc))
        {
            return Task.FromResult<object?>(null);
        }

        return Task.FromResult<object?>(XamlSelectionRange.Compute(doc, p.Positions));
    }

    private Task<object?> LinkedEditingRangeAsync(TextDocumentPositionParams p)
    {
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc))
        {
            return Task.FromResult<object?>(null);
        }

        return Task.FromResult<object?>(XamlLinkedEditing.Compute(doc, p.Position));
    }

    /// <summary>
    /// Whole-document semantic tokens: a purely syntactic classification of every name in the parse tree
    /// (element types, members, prefixes, markup-extension names/args). Read-only and cheap — safe to fire
    /// on every keystroke.
    /// </summary>
    private Task<object?> SemanticTokensAsync(SemanticTokensParams p)
    {
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc))
        {
            return Task.FromResult<object?>(null);
        }

        return Task.FromResult<object?>(XamlSemanticTokens.Compute(doc));
    }

    private Task<object?> SemanticTokensRangeAsync(SemanticTokensRangeParams p)
    {
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc))
        {
            return Task.FromResult<object?>(null);
        }

        return Task.FromResult<object?>(XamlSemanticTokens.ComputeRange(doc, p.Range));
    }

    /// <summary>
    /// Quick fixes (<c>textDocument/codeAction</c>). Delegates to the pure <see cref="XamlCodeActions"/>:
    /// for each unknown-name diagnostic in the request context that carries spelling suggestions
    /// (round-tripped in <see cref="Diagnostic.Data"/> from the earlier publish), offers a "Change 'X' to
    /// 'Y'" edit that replaces EXACTLY the flagged span with a known-valid name; and for an undeclared-prefix
    /// diagnostic (WXAML0001) offers "Add xmlns:… declaration" — the standard URI for a well-known prefix, or
    /// an inferred <c>using:</c> for a custom prefix naming one of the project's own types (hence the type
    /// system is resolved here). Read-only apart from the offered single-document edits; returns an empty
    /// list when nothing applies.
    /// </summary>
    private async Task<object?> CodeActionAsync(CodeActionParams p)
    {
        _documents.TryGetValue(p.TextDocument.Uri, out var doc);
        var context = await GetContextAsync(p.TextDocument.Uri).ConfigureAwait(false);
        var typeSystem = context?.TypeSystem;
        var actions = XamlCodeActions.Compute(p.TextDocument.Uri, doc, p.Context, typeSystem);

        // Cross-file "Generate event handler 'X'" quick fix (VS parity for F12/generate on a missing
        // handler): when the caret sits on an event attribute whose handler is absent from the code-behind,
        // offer to stub it into the user's .xaml.cs partial. Requires the resolved class symbol, so it lives
        // here rather than in the pure XamlCodeActions computer.
        if (doc != null && context is { } ctx && XamlCodeActions.QuickFixKindAllowed(p.Context?.Only))
        {
            var generate = GenerateEventHandlerAction(
                p.TextDocument.Uri, doc, p.Range, ctx.TypeSystem, ctx.Resolution.ClassSymbol);
            if (generate != null)
            {
                actions.Add(generate);
            }
        }

        return actions;
    }

    /// <summary>
    /// Builds the "Generate event handler 'X'" quick fix, or <c>null</c> when it doesn't apply. Fires when the
    /// caret sits on an unprefixed EVENT attribute (e.g. <c>Click="OnGo_Click"</c>) whose plain-identifier
    /// value names a method that is ABSENT from the x:Class code-behind. The signature comes from the event's
    /// delegate (<c>RoutedEventHandler → object sender, RoutedEventArgs e</c>); the stub is inserted into the
    /// USER <c>.xaml.cs</c> partial (never the generated <c>.g.cs</c>) as a single-file cross-document
    /// <see cref="WorkspaceEdit"/>. Conservative — no code-behind / unresolved event / markup-extension value /
    /// method already present → <c>null</c>.
    /// </summary>
    private CodeAction? GenerateEventHandlerAction(
        string uri, TextDocument doc, Lsp.Range range, XamlTypeSystem typeSystem, INamedTypeSymbol? classSymbol)
    {
        if (classSymbol == null || doc.Parsed.Root == null)
        {
            return null;
        }

        int offset = doc.OffsetAt(range.Start);

        // Walk up from the node under the caret to the enclosing attribute and its owning element.
        XamlAttribute? attr = null;
        XamlElement? element = null;
        for (var current = doc.Parsed.FindNode(offset); current != null; current = current.Parent)
        {
            if (attr == null)
            {
                if (current is XamlAttribute a)
                {
                    attr = a;
                }
            }
            else if (current is XamlElement e)
            {
                element = e;
                break;
            }
        }

        if (attr == null || element == null || element.Name == null)
        {
            return null;
        }

        // Must be an unprefixed attribute with a plain-identifier value (a handler name — not a namespace
        // declaration, markup extension, or dotted path).
        if (attr.Name.HasPrefix || attr.IsNamespaceDeclaration || attr.Value == null || attr.Value.IsMarkupExtension)
        {
            return null;
        }

        var handlerName = attr.Value.Text.Trim();
        if (!IdentifierPattern.IsMatch(handlerName))
        {
            return null;
        }

        // The attribute must resolve to an EVENT on the element's type.
        var scope = element.NamespaceScope ?? doc.Parsed.Root.NamespaceScope;
        if (scope == null || !scope.TryResolvePrefix(element.Name.Prefix, out var nsUri))
        {
            return null;
        }

        var ownerType = typeSystem.ResolveType(nsUri, element.Name.LocalName);
        if (ownerType == null)
        {
            return null;
        }

        if (typeSystem.FindMember(ownerType, attr.Name.LocalName) is not { Kind: XamlMemberKind.Event } evt)
        {
            return null;
        }

        // The handler must be ABSENT from the code-behind. Roslyn merges partials into one symbol, so a
        // member of that name anywhere (any partial, any kind) means we must NOT generate — a duplicate would
        // fail to compile.
        if (FindMember(classSymbol, handlerName) != null)
        {
            return null;
        }

        // Signature from the event delegate's Invoke method (RoutedEventHandler → object sender,
        // RoutedEventArgs e). Minimally-qualified argument types rely on the code-behind's WinUI usings — the
        // VS-parity form for a WinUI page.
        if (evt.Type is not INamedTypeSymbol { DelegateInvokeMethod: { } invoke })
        {
            return null;
        }

        var edit = BuildHandlerInsertionEdit(uri, classSymbol, handlerName, BuildParameterList(invoke));
        if (edit == null)
        {
            return null;
        }

        return new CodeAction
        {
            Title = $"Generate event handler '{handlerName}'",
            Kind = "quickfix",
            IsPreferred = true,
            Edit = edit,
        };
    }

    /// <summary>Renders a delegate's parameters as a C# parameter list, minimally qualified (e.g.
    /// <c>object sender, RoutedEventArgs e</c>). Unnamed metadata parameters fall back to <c>arg1</c>…</summary>
    private static string BuildParameterList(IMethodSymbol invoke)
    {
        var parts = new List<string>(invoke.Parameters.Length);
        for (int i = 0; i < invoke.Parameters.Length; i++)
        {
            var parameter = invoke.Parameters[i];
            var typeName = parameter.Type.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat);
            var name = string.IsNullOrEmpty(parameter.Name) ? $"arg{i + 1}" : parameter.Name;
            parts.Add($"{typeName} {name}");
        }

        return string.Join(", ", parts);
    }

    /// <summary>
    /// Builds the cross-file <see cref="WorkspaceEdit"/> that inserts a handler stub into the user code-behind,
    /// or <c>null</c> when no user partial can be found / read. Chooses the non-generated declaring partial
    /// (preferring the conventional <c>&lt;xaml&gt;.cs</c> sibling), re-reads and re-parses it FRESH from disk
    /// so the insertion position never lags a stale compilation, and anchors the stub after the class's last
    /// member (or its open brace when empty) with matched indentation.
    /// </summary>
    private WorkspaceEdit? BuildHandlerInsertionEdit(
        string xamlUri, INamedTypeSymbol classSymbol, string handlerName, string parameters)
    {
        var xamlPath = UriToPath(xamlUri);
        string? preferred = xamlPath != null ? xamlPath + ".cs" : null;
        string? codeBehindPath = null;
        foreach (var reference in classSymbol.DeclaringSyntaxReferences)
        {
            var file = reference.SyntaxTree.FilePath;
            if (string.IsNullOrEmpty(file) || IsGeneratedCodeBehind(file))
            {
                continue;
            }

            if (preferred != null && string.Equals(file, preferred, StringComparison.OrdinalIgnoreCase))
            {
                codeBehindPath = file;
                break;
            }

            codeBehindPath ??= file;
        }

        if (codeBehindPath == null)
        {
            return null;
        }

        string source;
        try
        {
            source = File.ReadAllText(codeBehindPath);
        }
        catch
        {
            return null;
        }

        var tree = Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree.ParseText(source);
        var classDecl = tree.GetRoot()
            .DescendantNodes()
            .OfType<Microsoft.CodeAnalysis.CSharp.Syntax.ClassDeclarationSyntax>()
            .FirstOrDefault(c => string.Equals(c.Identifier.Text, classSymbol.Name, StringComparison.Ordinal));
        if (classDecl == null)
        {
            return null;
        }

        int anchor;
        string indent;
        bool afterMember;
        if (classDecl.Members.Count > 0)
        {
            var last = classDecl.Members[classDecl.Members.Count - 1];
            anchor = last.Span.End;
            indent = LeadingIndent(source, last.SpanStart) ?? "    ";
            afterMember = true;
        }
        else
        {
            anchor = classDecl.OpenBraceToken.Span.End;
            indent = (LeadingIndent(source, classDecl.Keyword.SpanStart) ?? string.Empty) + "    ";
            afterMember = false;
        }

        string nl = source.Contains("\r\n") ? "\r\n" : "\n";
        string lead = afterMember ? nl + nl : nl;
        string stub = $"{lead}{indent}private void {handlerName}({parameters}){nl}{indent}{{{nl}{indent}}}";

        var position = OffsetToPosition(source, anchor);
        return new WorkspaceEdit
        {
            Changes = new Dictionary<string, List<TextEdit>>(StringComparer.Ordinal)
            {
                [PathToUri(codeBehindPath)] = new List<TextEdit>
                {
                    new TextEdit
                    {
                        Range = new Lsp.Range { Start = position, End = position },
                        NewText = stub,
                    },
                },
            },
        };
    }

    /// <summary>True for a generated code-behind (<c>*.g.cs</c>/<c>*.g.i.cs</c>) or a build-output copy
    /// (any <c>obj</c>/<c>bin</c> path segment) — files we must never write a handler stub into.</summary>
    private static bool IsGeneratedCodeBehind(string path)
    {
        var name = Path.GetFileName(path);
        if (name.EndsWith(".g.cs", StringComparison.OrdinalIgnoreCase) ||
            name.EndsWith(".g.i.cs", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        foreach (var segment in path.Split('\\', '/'))
        {
            if (string.Equals(segment, "obj", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(segment, "bin", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>The leading whitespace run of the line containing <paramref name="offset"/>, or <c>null</c>
    /// when non-whitespace precedes the offset on that line (so the caller can fall back to a default indent).</summary>
    private static string? LeadingIndent(string source, int offset)
    {
        int lineStart = source.LastIndexOf('\n', Math.Max(0, offset - 1)) + 1;
        int i = lineStart;
        while (i < offset && (source[i] == ' ' || source[i] == '\t'))
        {
            i++;
        }

        return i == offset ? source.Substring(lineStart, offset - lineStart) : null;
    }

    /// <summary>
    /// Resolves <c>ResourceDictionary Source="..."</c> references to clickable file links. The owning
    /// project is found with a cheap directory walk-up (not the full MSBuild resolve) so this
    /// frequently-fired request never blocks on project load; ms-appx/app-root paths resolve under the
    /// project root, bare relative paths next to the current document.
    /// </summary>
    private Task<object?> DocumentLinkAsync(DocumentLinkParams p)
    {
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc))
        {
            return Task.FromResult<object?>(null);
        }

        var docPath = UriToPath(p.TextDocument.Uri);
        var documentDirectory = docPath == null ? null : System.IO.Path.GetDirectoryName(docPath);
        var projectPath = docPath == null ? null : XamlProjectResolver.FindOwningProject(docPath);
        var projectDirectory = projectPath == null ? null : System.IO.Path.GetDirectoryName(projectPath);

        return Task.FromResult<object?>(XamlDocumentLinks.Collect(doc, documentDirectory, projectDirectory));
    }

    /// <summary>
    /// Resolves the symbol under the caret — an <c>x:Name</c> (declaration or an <c>ElementName=</c>/
    /// <c>Storyboard.TargetName</c> usage) or a resource key (an <c>x:Key</c> declaration or a
    /// <c>{StaticResource}</c>/<c>{ThemeResource}</c>/<c>{CustomResource}</c> usage) — and returns every
    /// occurrence in this document (deduped, sorted by position), each flagged as declaration or usage.
    /// Returns null when the caret is not on a supported symbol. Shared by Find All References and Document
    /// Highlights. Deliberately document-scoped: code-behind field references and cross-file (App.xaml)
    /// resource usages are future work.
    /// </summary>
    internal static List<(Lsp.Range Range, bool IsDeclaration)>? ResolveOccurrences(TextDocument doc, XamlElement root, int offset)
    {
        // Malformed, still-being-typed markup: stay silent when the caret sits inside an unterminated
        // extension (self or an enclosing one). The parser's recovery spans are unreliable there, so a
        // symbol resolved from inside them would highlight/reference bogus occurrences. F12/hover keep
        // their deliberate leniency -- they resolve through ResolveResourceReferenceAsync, not this path.
        if (IsInsideUnterminatedExtension(root, offset))
        {
            return null;
        }

        if (DetectSymbolAt(doc, offset) is not { } symbol)
        {
            return null;
        }

        var occurrences = new List<(Lsp.Range Range, bool IsDeclaration)>();
        if (symbol.Kind == XamlRenameKind.Name)
        {
            CollectNameOccurrences(root, symbol.Name, doc, occurrences);
        }
        else
        {
            CollectResourceOccurrences(root, symbol.Name, doc, occurrences);
        }

        return DedupeAndSort(occurrences);
    }

    /// <summary>
    /// Classifies the renameable/referenceable symbol the caret sits on: an <c>x:Name</c>/<c>Name</c>
    /// (whether the caret is on the declaration or a usage) or an <c>x:Key</c> resource key. Returns null
    /// when the caret is not on a supported symbol. Name is checked first so a caret on a name declaration
    /// never falls through to the key branch.
    /// </summary>
    internal static (XamlRenameKind Kind, string Name)? DetectSymbolAt(TextDocument doc, int offset)
    {
        // x:Name: the caret is on a usage (ElementName=/Storyboard.TargetName) or on the declaration itself.
        var name = FindNameReferenceAt(doc, offset)?.Name ?? FindNameDeclarationAt(doc, offset);
        if (name is { Length: > 0 })
        {
            return (XamlRenameKind.Name, name);
        }

        // Resource key: the caret is on a {StaticResource}-family usage or on the x:Key declaration.
        var key = FindResourceKeyReferenceAt(doc, offset)?.Key ?? FindKeyDeclarationAt(doc, offset);
        if (key is { Length: > 0 })
        {
            return (XamlRenameKind.Key, key);
        }

        return null;
    }

    /// <summary>
    /// True when the caret sits inside a markup extension that is not closed (or whose enclosing extension
    /// is not closed). References/highlights stay silent inside such malformed, still-being-typed markup;
    /// every extension that contains the offset is an ancestor of the innermost one, so an unclosed match
    /// anywhere in that chain means the whole expression is incomplete.
    /// </summary>
    internal static bool IsInsideUnterminatedExtension(XamlElement root, int offset)
    {
        foreach (var node in root.DescendantNodesAndSelf())
        {
            if (node is XamlMarkupExtension { IsClosed: false } extension &&
                extension.Span.ContainsInclusive(offset))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>The <c>x:Name</c>/bare <c>Name</c> literal the caret sits inside (the declaration), or null.
    /// A prefixed form other than <c>x:</c> (e.g. design-time <c>d:Name</c>) is NOT a real name declaration.</summary>
    private static string? FindNameDeclarationAt(TextDocument doc, int offset) =>
        DeclarationValueAt(doc, offset, static name =>
            string.Equals(name.LocalName, "Name", StringComparison.Ordinal) &&
            (!name.HasPrefix || string.Equals(name.Prefix, "x", StringComparison.Ordinal)));

    /// <summary>The <c>x:Key</c> literal the caret sits inside (the declaration), or null. Only the
    /// <c>x:</c>-prefixed form is a resource key.</summary>
    private static string? FindKeyDeclarationAt(TextDocument doc, int offset) =>
        DeclarationValueAt(doc, offset, static name =>
            name.HasPrefix && string.Equals(name.Prefix, "x", StringComparison.Ordinal) &&
            string.Equals(name.LocalName, "Key", StringComparison.Ordinal));

    /// <summary>
    /// The trimmed value of a non-markup attribute whose name matches <paramref name="nameMatches"/> and
    /// whose value literal contains the caret — used to start a reference search from the declaration.
    /// </summary>
    private static string? DeclarationValueAt(TextDocument doc, int offset, Func<XamlName, bool> nameMatches)
    {
        for (var current = doc.Parsed.FindNode(offset); current != null; current = current.Parent)
        {
            if (current is XamlAttribute attr && !attr.IsNamespaceDeclaration &&
                attr.Value is { IsMarkupExtension: false } value && value.InnerSpan.ContainsInclusive(offset) &&
                nameMatches(attr.Name))
            {
                var text = value.Text.Trim();
                return text.Length > 0 ? text : null;
            }

            if (current is XamlElement)
            {
                break;
            }
        }

        return null;
    }

    /// <summary>
    /// The span of an attribute value's inner text with surrounding whitespace stripped, so an occurrence
    /// range covers exactly the identifier/key token (e.g. <c>x:Name="Root "</c> resolves to <c>Root</c>,
    /// never the trailing padding). Mirrors the <c>Trim()</c> used when matching the value to the symbol,
    /// keeping rename edits — and the Find All References / Document Highlights ranges that share this
    /// engine — precise. The caller only builds a range after a non-empty trimmed match, so the result is
    /// always non-empty.
    /// </summary>
    private static TextSpan TrimmedValueSpan(XamlAttributeValue value)
    {
        var text = value.Text;
        int lead = 0;
        while (lead < text.Length && char.IsWhiteSpace(text[lead]))
        {
            lead++;
        }

        int trail = text.Length;
        while (trail > lead && char.IsWhiteSpace(text[trail - 1]))
        {
            trail--;
        }

        int start = value.InnerSpan.Start;
        return new TextSpan(start + lead, start + trail);
    }

    /// <summary>
    /// Collects, into <paramref name="results"/>, the <c>x:Name</c>/bare <c>Name</c> declaration literal
    /// (flagged as declaration) plus every named-element usage of <paramref name="name"/> in the subtree:
    /// <c>ElementName=</c> markup-extension arguments (including nested extensions) and
    /// <c>Storyboard.TargetName</c> attribute values (flagged as usages).
    /// </summary>
    private static void CollectNameOccurrences(
        XamlElement element, string name, TextDocument doc, List<(Lsp.Range Range, bool IsDeclaration)> results)
    {
        if ((element.GetAttribute("x:Name") ?? element.GetAttribute("Name")) is { Value: { IsMarkupExtension: false } declValue } &&
            string.Equals(declValue.Text.Trim(), name, StringComparison.Ordinal))
        {
            results.Add((doc.RangeOf(TrimmedValueSpan(declValue)), true));
        }

        foreach (var attr in element.Attributes)
        {
            if (attr.IsNamespaceDeclaration)
            {
                continue;
            }

            // Storyboard.TargetName="Foo" (a plain element-name attribute value).
            if (attr.Value is { IsMarkupExtension: false } plain && IsNameReferenceAttribute(attr.Name) &&
                string.Equals(plain.Text.Trim(), name, StringComparison.Ordinal))
            {
                results.Add((doc.RangeOf(TrimmedValueSpan(plain)), false));
            }

            // VSM <Setter Target="Element.Property"> — only the element-name segment (before the first dot)
            // names an x:Name'd element; the ".Property" tail is a member on that element.
            if (element.Name is { HasPrefix: false, LocalName: "Setter" } &&
                !attr.Name.HasPrefix && string.Equals(attr.Name.LocalName, "Target", StringComparison.Ordinal) &&
                SetterTargetElementSpan(attr.Value) is { } target &&
                string.Equals(target.Element, name, StringComparison.Ordinal))
            {
                results.Add((doc.RangeOf(target.Span), false));
            }

            // {Binding ElementName=Foo} — any markup extension with a matching named ElementName argument.
            if (attr.Value?.MarkupExtension is { } ext)
            {
                ForEachExtension(ext, e =>
                {
                    foreach (var arg in e.Arguments)
                    {
                        if (arg.IsNamed &&
                            string.Equals(arg.Name?.LocalName, "ElementName", StringComparison.Ordinal) &&
                            arg.Value is { Length: > 0 } v && string.Equals(v.Trim(), name, StringComparison.Ordinal) &&
                            arg.ValueSpan is { } vs)
                        {
                            results.Add((doc.RangeOf(vs), false));
                        }
                    }
                });
            }
        }

        foreach (var child in element.Content)
        {
            if (child is XamlElement childElement)
            {
                CollectNameOccurrences(childElement, name, doc, results);
            }
        }
    }

    /// <summary>
    /// Collects, into <paramref name="results"/>, the <c>x:Key</c> declaration literal (flagged as
    /// declaration) plus every <c>{StaticResource}</c>/<c>{ThemeResource}</c>/<c>{CustomResource}</c> usage
    /// of <paramref name="key"/> in the subtree (including nested extensions, flagged as usages).
    /// </summary>
    private static void CollectResourceOccurrences(
        XamlElement element, string key, TextDocument doc, List<(Lsp.Range Range, bool IsDeclaration)> results)
    {
        if (element.GetAttribute("x:Key") is { Value: { IsMarkupExtension: false } keyValue } &&
            string.Equals(keyValue.Text.Trim(), key, StringComparison.Ordinal))
        {
            results.Add((doc.RangeOf(TrimmedValueSpan(keyValue)), true));
        }

        foreach (var attr in element.Attributes)
        {
            if (attr.Value?.MarkupExtension is { } ext)
            {
                ForEachExtension(ext, e =>
                {
                    if (e.Name is not { HasPrefix: false } n ||
                        n.LocalName is not ("StaticResource" or "ThemeResource" or "CustomResource"))
                    {
                        return;
                    }

                    foreach (var arg in e.Arguments)
                    {
                        if (!arg.IsNamed && arg.Value is { Length: > 0 } v &&
                            string.Equals(v.Trim(), key, StringComparison.Ordinal))
                        {
                            results.Add((doc.RangeOf(arg.ValueSpan ?? arg.Span), false));
                        }
                    }
                });
            }
        }

        foreach (var child in element.Content)
        {
            if (child is XamlElement childElement)
            {
                CollectResourceOccurrences(childElement, key, doc, results);
            }
        }
    }

    /// <summary>
    /// Invokes <paramref name="action"/> on <paramref name="extension"/> and each nested extension, but
    /// prunes any unterminated (malformed / still-being-typed) extension subtree: references are only
    /// collected from well-formed markup, so incomplete input never invents a reference.
    /// </summary>
    private static void ForEachExtension(XamlMarkupExtension extension, Action<XamlMarkupExtension> action)
    {
        if (!extension.IsClosed)
        {
            return;
        }

        action(extension);
        foreach (var arg in extension.Arguments)
        {
            if (arg.NestedExtension is { } nested)
            {
                ForEachExtension(nested, action);
            }
        }
    }

    /// <summary>Removes duplicate ranges and orders the occurrences by document position.</summary>
    private static List<(Lsp.Range Range, bool IsDeclaration)> DedupeAndSort(List<(Lsp.Range Range, bool IsDeclaration)> occurrences) =>
        occurrences
            .GroupBy(o => (o.Range.Start.Line, o.Range.Start.Character, o.Range.End.Line, o.Range.End.Character))
            .Select(g => g.First())
            .OrderBy(o => o.Range.Start.Line).ThenBy(o => o.Range.Start.Character)
            .ToList();

    /// <summary>
    /// F12 on a <c>{StaticResource Key}</c> / <c>{ThemeResource Key}</c> / <c>{CustomResource Key}</c>
    /// value: navigates to the matching <c>x:Key</c> declaration in the current document, or (failing
    /// that) in the project's App.xaml. Returns null when the caret is not on a resource-key reference
    /// or the key is not declared in either place (framework theme-dictionary keys are not indexed yet).
    /// </summary>
    private async Task<object?> ResolveResourceKeyDefinitionAsync(TextDocumentPositionParams p) =>
        (await ResolveResourceReferenceAsync(p).ConfigureAwait(false))?.Declaration;

    /// <summary>
    /// Hover over a resource-key reference: shows the referenced resource's element type and where it is
    /// declared (this file or App.xaml). Returns null when the caret is not on a resolvable reference.
    /// </summary>
    private async Task<Hover?> ResolveResourceKeyHoverAsync(TextDocumentPositionParams p)
    {
        var hit = await ResolveResourceReferenceAsync(p).ConfigureAwait(false);
        if (hit == null)
        {
            return null;
        }

        var typePrefix = string.IsNullOrEmpty(hit.Value.TypeName) ? string.Empty : hit.Value.TypeName + " ";
        return new Hover
        {
            Contents = new MarkupContent
            {
                Kind = "markdown",
                Value = $"```csharp\n(resource) {typePrefix}\"{hit.Value.Key}\"\n```\nDefined in {hit.Value.FileLabel}",
            },
            Range = hit.Value.ReferenceRange,
        };
    }

    /// <summary>
    /// Shared resolver for resource-key definition and hover: detects a resource reference under the
    /// caret, then locates its <c>x:Key</c> declaration in the current document (no project load) or,
    /// failing that, in the project's App.xaml. Returns null when no reference/declaration is found.
    /// </summary>
    private async Task<ResourceReferenceHit?> ResolveResourceReferenceAsync(TextDocumentPositionParams p)
    {
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc))
        {
            return null;
        }

        int offset = doc.OffsetAt(p.Position);
        var reference = FindResourceKeyReferenceAt(doc, offset);
        if (reference == null)
        {
            return null;
        }

        var (key, referenceSpan) = reference.Value;
        var referenceRange = doc.RangeOf(referenceSpan);

        // 1) The current document, resolved in lexical scope (nearest <Owner.Resources> wins) so an inner
        //    dictionary shadows an outer one; fall back to a document-wide search for keys outside the
        //    reference's ancestor scopes.
        var referenceElement = NearestEnclosingElement(doc, offset);
        var local = (referenceElement != null ? FindResourceDeclarationScoped(referenceElement, key) : null)
            ?? FindResourceDeclaration(doc.Parsed, key);
        if (local != null)
        {
            return new ResourceReferenceHit(
                key,
                referenceRange,
                new Lsp.Location { Uri = doc.Uri, Range = doc.RangeOf(local.Value.NavSpan) },
                local.Value.TypeName,
                "this file");
        }

        // 2) The project's App.xaml (parsed off disk; only reached for keys not declared locally).
        var context = await GetContextAsync(p.TextDocument.Uri).ConfigureAwait(false);
        if (context == null)
        {
            return null;
        }

        var appXaml = FindAppXamlPath(context.Value.Resolution);
        if (appXaml == null)
        {
            return null;
        }

        string appText;
        try
        {
            appText = System.IO.File.ReadAllText(appXaml);
        }
        catch (System.Exception ex)
        {
            System.Console.Error.WriteLine($"[winui-xaml-ls] resource ref: {ex.Message}");
            return null;
        }

        var app = FindResourceDeclaration(XamlParser.Parse(appText), key);
        if (app == null)
        {
            return null;
        }

        return new ResourceReferenceHit(
            key,
            referenceRange,
            new Lsp.Location { Uri = PathToUri(appXaml), Range = SpanToRange(appText, app.Value.NavSpan) },
            app.Value.TypeName,
            System.IO.Path.GetFileName(appXaml));
    }

    // --- Named-element references (ElementName / Storyboard.TargetName) ------

    /// <summary>
    /// F12/hover shared resolver for a named-element reference under the caret: a classic
    /// <c>{Binding ElementName=Foo}</c> argument or a <c>Storyboard.TargetName="Foo"</c> attribute value.
    /// Locates the <c>x:Name="Foo"</c> declaration in the current document (x:Name scope is per-file) and
    /// returns the reference range, its declaration location, and the declaring element's type name.
    /// </summary>
    private async Task<NameReferenceHit?> ResolveNameReferenceAsync(TextDocumentPositionParams p)
    {
        await Task.CompletedTask.ConfigureAwait(false);
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc) || doc.Parsed.Root is not { } root)
        {
            return null;
        }

        int offset = doc.OffsetAt(p.Position);
        var reference = FindNameReferenceAt(doc, offset);
        if (reference == null)
        {
            return null;
        }

        var (name, referenceSpan) = reference.Value;
        var declaration = FindNamedElement(root, name);
        if (declaration == null)
        {
            return null;
        }

        return new NameReferenceHit(
            name,
            doc.RangeOf(referenceSpan),
            new Lsp.Location { Uri = doc.Uri, Range = doc.RangeOf(declaration.Value.NavSpan) },
            declaration.Value.TypeName);
    }

    /// <summary>Hover for a named-element reference: identifies the referenced element and its type.</summary>
    private async Task<Hover?> ResolveNameReferenceHoverAsync(TextDocumentPositionParams p)
    {
        var hit = await ResolveNameReferenceAsync(p).ConfigureAwait(false);
        if (hit == null)
        {
            return null;
        }

        var typePrefix = string.IsNullOrEmpty(hit.Value.TypeName) ? string.Empty : hit.Value.TypeName + " ";
        return new Hover
        {
            Contents = new MarkupContent
            {
                Kind = "markdown",
                Value = $"```csharp\n(element) {typePrefix}\"{hit.Value.Name}\"\n```",
            },
            Range = hit.Value.ReferenceRange,
        };
    }

    /// <summary>
    /// Detects a named-element reference at <paramref name="offset"/>: the value of a <c>{Binding</c>
    /// (or other) <c>ElementName=</c> named argument, or a <c>Storyboard.TargetName="..."</c> attribute
    /// value. Returns the referenced name and the span of the reference, or null.
    /// </summary>
    private static (string Name, TextSpan Span)? FindNameReferenceAt(TextDocument doc, int offset)
    {
        if (doc.Parsed.Root is not { } root)
        {
            return null;
        }

        // 1) A markup-extension named "ElementName" argument ({Binding ElementName=Foo}).
        var extension = InnermostMarkupExtensionAt(root, offset);
        if (extension is not null)
        {
            foreach (var argument in extension.Arguments)
            {
                if (argument.IsNamed &&
                    string.Equals(argument.Name?.LocalName, "ElementName", StringComparison.Ordinal) &&
                    argument.Value is { Length: > 0 } name &&
                    argument.ValueSpan is { } valueSpan &&
                    valueSpan.ContainsInclusive(offset))
                {
                    return (name.Trim(), valueSpan);
                }
            }
        }

        // 2) A plain Storyboard.TargetName="Foo" attribute value (an element name, not a member).
        for (var current = doc.Parsed.FindNode(offset); current != null; current = current.Parent)
        {
            if (current is XamlAttribute attr && !attr.IsNamespaceDeclaration &&
                attr.Value is { IsMarkupExtension: false } value && value.Span.ContainsInclusive(offset) &&
                IsNameReferenceAttribute(attr.Name))
            {
                var text = value.Text.Trim();
                return text.Length > 0 ? (text, value.InnerSpan) : ((string, TextSpan)?)null;
            }

            // A VSM <Setter Target="Element.Property"> value: only the element-name segment (before the
            // first dot) is a name reference; a caret in the ".Property" tail falls through (not a name).
            if (current is XamlAttribute setterAttr &&
                setterAttr.Parent is XamlElement { Name: { HasPrefix: false, LocalName: "Setter" } } &&
                !setterAttr.Name.HasPrefix &&
                string.Equals(setterAttr.Name.LocalName, "Target", StringComparison.Ordinal) &&
                SetterTargetElementSpan(setterAttr.Value) is { } target && target.Span.ContainsInclusive(offset))
            {
                return (target.Element, target.Span);
            }

            if (current is XamlElement)
            {
                break;
            }
        }

        return null;
    }

    /// <summary>
    /// The element-name segment of a VSM <c>&lt;Setter Target="Element.Property"&gt;</c> value — the token
    /// before the first dot with surrounding whitespace stripped — plus its span, or null when the value is a
    /// markup extension or the segment is empty. Only this segment names an <c>x:Name</c>'d element; the
    /// <c>.Property</c> tail is a member on that element, so keeping the span pre-dot makes rename replace the
    /// element name alone and never touch the property.
    /// </summary>
    private static (string Element, TextSpan Span)? SetterTargetElementSpan(XamlAttributeValue? value)
    {
        if (value is not { IsMarkupExtension: false })
        {
            return null;
        }

        var text = value.Text;
        int lead = 0;
        while (lead < text.Length && char.IsWhiteSpace(text[lead]))
        {
            lead++;
        }

        int end = text.IndexOf('.', lead);
        if (end < 0)
        {
            end = text.Length;
        }

        while (end > lead && char.IsWhiteSpace(text[end - 1]))
        {
            end--;
        }

        if (end <= lead)
        {
            return null;
        }

        int start = value.InnerSpan.Start;
        return (text.Substring(lead, end - lead), new TextSpan(start + lead, start + end));
    }

    /// <summary>Attribute names whose (bare) value is an element x:Name reference (not a CLR member or type):
    /// <c>Storyboard.TargetName</c> and the <c>RelativePanel</c> alignment attached properties
    /// (<c>RelativePanel.RightOf</c>, <c>AlignTopWith</c>, …). VSM <c>Setter.Target</c> is handled separately
    /// because only its element-name segment (before the first dot) is the reference.</summary>
    private static bool IsNameReferenceAttribute(XamlName name) =>
        !name.HasPrefix &&
        (string.Equals(name.LocalName, "Storyboard.TargetName", StringComparison.Ordinal) ||
         CompletionProvider.RelativePanelAlignmentTargets.Contains(name.LocalName));

    /// <summary>
    /// Finds the element declaring <c>x:Name="name"</c> (or <c>Name="name"</c>) anywhere in the document
    /// and returns its element type name plus the span of the name literal to navigate to, or null.
    /// </summary>
    private static (string TypeName, TextSpan NavSpan)? FindNamedElement(XamlElement element, string name)
    {
        var attr = element.GetAttribute("x:Name") ?? element.GetAttribute("Name");
        if (attr?.Value is { } value && !value.IsMarkupExtension &&
            string.Equals(value.Text.Trim(), name, StringComparison.Ordinal))
        {
            var typeName = element.Name is { LocalName.Length: > 0 } elementName ? elementName.FullName : string.Empty;
            return (typeName, value.InnerSpan);
        }

        foreach (var child in element.Content)
        {
            if (child is XamlElement childElement)
            {
                var hit = FindNamedElement(childElement, name);
                if (hit != null)
                {
                    return hit;
                }
            }
        }

        return null;
    }

    // --- Attached-property hover --------------------------------------------

    /// <summary>
    /// Hover for an attached property referenced by an attribute name (<c>Grid.Row="1"</c>) or by a
    /// <c>&lt;Setter Property="Grid.Row"&gt;</c> value. Resolves the owner type through the attribute's
    /// namespace scope, confirms it is a real attached property, and renders its value type. Null when the
    /// caret is not on such an attached property, so the caller falls through to the other resolvers.
    /// </summary>
    private async Task<Hover?> ResolveAttachedPropertyHoverAsync(TextDocumentPositionParams p)
    {
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc))
        {
            return null;
        }

        int offset = doc.OffsetAt(p.Position);

        XamlAttribute? attr = null;
        for (var current = doc.Parsed.FindNode(offset); current != null; current = current.Parent)
        {
            if (current is XamlAttribute a)
            {
                attr = a;
                break;
            }

            if (current is XamlElement)
            {
                break;
            }
        }

        if (attr is null || attr.IsNamespaceDeclaration ||
            attr.Parent is not XamlElement { Name: { } ownerElementName } ownerElement)
        {
            return null;
        }

        string ownerName;
        string memberName;
        TextSpan hoverSpan;

        // Case 1: caret on a dotted attached-property attribute name (Grid.Row="1").
        if (!attr.Name.HasPrefix && attr.Name.IsDotted && attr.Name.Span.ContainsInclusive(offset))
        {
            int dot = attr.Name.LocalName.LastIndexOf('.');
            ownerName = attr.Name.LocalName.Substring(0, dot);
            memberName = attr.Name.LocalName.Substring(dot + 1);
            hoverSpan = attr.Name.Span;
        }
        // Case 2: caret in a <Setter Property="Grid.Row"> value (dotted -> attached property).
        else if (!attr.Name.HasPrefix && string.Equals(attr.Name.LocalName, "Property", StringComparison.Ordinal) &&
                 string.Equals(ownerElementName.LocalName, "Setter", StringComparison.Ordinal) &&
                 !ownerElementName.HasPrefix &&
                 attr.Value is { IsMarkupExtension: false } setterValue &&
                 setterValue.Span.ContainsInclusive(offset))
        {
            var text = setterValue.Text.Trim();
            int dot = text.IndexOf('.');
            if (dot <= 0 || dot >= text.Length - 1)
            {
                return null;
            }

            ownerName = text.Substring(0, dot);
            memberName = text.Substring(dot + 1);
            hoverSpan = setterValue.InnerSpan;
        }
        else
        {
            return null;
        }

        var typeSystem = await GetTypeSystemAsync(p.TextDocument.Uri).ConfigureAwait(false);
        if (typeSystem == null)
        {
            return null;
        }

        var ownerType = ResolveXamlTypeName(ownerName, ownerElement.NamespaceScope, typeSystem);
        if (ownerType == null)
        {
            return null;
        }

        var attached = typeSystem.GetAttachedProperties(ownerType)
            .FirstOrDefault(m => string.Equals(m.Name, memberName, StringComparison.Ordinal));
        if (attached == null)
        {
            return null;
        }

        var valueType = attached.Type?.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat) ?? "object";
        return new Hover
        {
            Contents = new MarkupContent
            {
                Kind = "markdown",
                Value = HoverMarkdown($"(attached property) {valueType} {ownerType.Name}.{attached.Name}", attached.Symbol, methodDetails: false),
            },
            Range = doc.RangeOf(hoverSpan),
        };
    }

    /// <summary>
    /// Hover for an x:Bind attached-property path step (<c>{x:Bind (Grid.Row)}</c>): resolves the
    /// parenthesized <c>Owner.Member</c> to an attached property on the owner type and renders it exactly
    /// like the attribute-form attached-property hover. Returns null when the caret is not inside such a
    /// step, the owner does not resolve, or the member is not a real attached property.
    /// </summary>
    private async Task<Hover?> ResolveBindAttachedHoverAsync(TextDocumentPositionParams p)
    {
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc))
        {
            return null;
        }

        int offset = doc.OffsetAt(p.Position);
        if (FindBindAttachedAt(doc, offset) is not { } hit)
        {
            return null;
        }

        var typeSystem = await GetTypeSystemAsync(p.TextDocument.Uri).ConfigureAwait(false);
        if (typeSystem == null)
        {
            return null;
        }

        var ownerType = ResolveXamlTypeName(hit.Owner, hit.Scope, typeSystem);
        if (ownerType == null)
        {
            return null;
        }

        var attached = typeSystem.GetAttachedProperties(ownerType)
            .FirstOrDefault(m => string.Equals(m.Name, hit.Member, StringComparison.Ordinal));
        if (attached == null)
        {
            return null;
        }

        var valueType = attached.Type?.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat) ?? "object";
        return new Hover
        {
            Contents = new MarkupContent
            {
                Kind = "markdown",
                Value = HoverMarkdown($"(attached property) {valueType} {ownerType.Name}.{attached.Name}", attached.Symbol, methodDetails: false),
            },
            Range = doc.RangeOf(hit.Span),
        };
    }

    /// <summary>
    /// Locates an x:Bind attached-property path step (<c>(Owner.Member)</c>) under <paramref name="offset"/>:
    /// the caret must sit inside the parentheses of the first positional (or <c>Path=</c>) argument of an
    /// <c>{x:Bind}</c> whose parenthesized content is a dotted <c>Owner.Member</c>. Returns null otherwise.
    /// </summary>
    private static BindAttachedHit? FindBindAttachedAt(TextDocument doc, int offset)
    {
        for (var current = doc.Parsed.FindNode(offset); current != null; current = current.Parent)
        {
            if (current is not XamlMarkupExtensionArgument arg)
            {
                continue;
            }

            if (arg.Value == null || arg.ValueSpan is not { } valueSpan)
            {
                return null;
            }

            if (arg.IsNamed && arg.Name?.LocalName != "Path")
            {
                return null;
            }

            if (arg.Parent is not XamlMarkupExtension ext || ext.Name?.LocalName != "Bind")
            {
                return null;
            }

            if (!valueSpan.ContainsInclusive(offset))
            {
                return null;
            }

            // Skip a leading negation/whitespace, then require an opening '(' (the attached-property step).
            string raw = arg.Value;
            int open = 0;
            while (open < raw.Length && (raw[open] == '!' || char.IsWhiteSpace(raw[open])))
            {
                open++;
            }

            if (open >= raw.Length || raw[open] != '(')
            {
                return null;
            }

            int close = raw.IndexOf(')', open + 1);
            if (close < 0)
            {
                return null;
            }

            // Locate the dot separating Owner.Member within the parentheses (raw coordinates).
            int innerStart = open + 1;
            int dot = raw.LastIndexOf('.', close - 1, close - innerStart);
            if (dot <= innerStart || dot >= close - 1)
            {
                return null; // not an Owner.Member form (a dot-less cast is handled by the member walk)
            }

            // The caret must sit on the Member portion (after the dot) -- hovering the Owner type or the
            // dot itself is not the attached property, so it must not render the attached-property hover.
            int rel = offset - valueSpan.Start;
            if (rel <= dot || rel > close)
            {
                return null;
            }

            var scope = NearestElementScope(arg) ?? doc.Parsed.Root?.NamespaceScope;
            if (scope == null)
            {
                return null;
            }

            string owner = raw.Substring(innerStart, dot - innerStart).Trim();
            string member = raw.Substring(dot + 1, close - dot - 1).Trim();
            if (owner.Length == 0 || member.Length == 0)
            {
                return null;
            }

            // Span covers just the member identifier so the hover highlight is precise.
            var span = new TextSpan(valueSpan.Start + dot + 1, valueSpan.Start + close);
            return new BindAttachedHit(owner, member, scope, span);
        }

        return null;
    }

    private async Task<object?> HoverAsync(TextDocumentPositionParams p)
    {
        var resourceHover = await ResolveResourceKeyHoverAsync(p).ConfigureAwait(false);
        if (resourceHover != null)
        {
            return resourceHover;
        }

        // Named-element reference (Binding ElementName=Foo / Storyboard.TargetName="Foo") -> the element
        // it points at. Before the symbol pipeline so TargetName does not render the generated field.
        var nameRefHover = await ResolveNameReferenceHoverAsync(p).ConfigureAwait(false);
        if (nameRefHover != null)
        {
            return nameRefHover;
        }

        // Attached-property attribute name (Grid.Row="1") or a Setter's Property="Grid.Row" value.
        var attachedHover = await ResolveAttachedPropertyHoverAsync(p).ConfigureAwait(false);
        if (attachedHover != null)
        {
            return attachedHover;
        }

        // Markup-extension names ({x:Bind}, {StaticResource}) and enum attribute/argument values
        // ("Center", Mode=OneWay) are not resolvable to a single navigable symbol the way an x:Class
        // member is, so they get their own hover resolver ahead of the symbol pipeline.
        var valueHover = await ResolveValueHoverAsync(p).ConfigureAwait(false);
        if (valueHover != null)
        {
            return valueHover;
        }

        // An x:Bind attached-property path step ({x:Bind (Grid.Row)}): resolved like the attribute-form
        // attached-property hover. Before the symbol pipeline (the member walk does not model it).
        var bindAttachedHover = await ResolveBindAttachedHoverAsync(p).ConfigureAwait(false);
        if (bindAttachedHover != null)
        {
            return bindAttachedHover;
        }

        // A parenthesized (Owner.AttachedProperty) inside Storyboard.TargetProperty ((Canvas.Left)) renders with
        // the attached-property framing. Instance members and the owner-type caret fall through to the symbol
        // pipeline (which renders "T Owner.Member" / the type). Before the symbol pipeline for the same reason.
        var qualifiedTargetHover = await ResolveQualifiedTargetPropertyHoverAsync(p).ConfigureAwait(false);
        if (qualifiedTargetHover != null)
        {
            return qualifiedTargetHover;
        }

        var (symbol, span) = await ResolveNamedSymbolAsync(p).ConfigureAwait(false);
        if (symbol == null || span == null)
        {
            return null;
        }

        return new Hover
        {
            Contents = new MarkupContent { Kind = "markdown", Value = HoverMarkdown(DescribeForHover(symbol), symbol) },
            Range = _documents.TryGetValue(p.TextDocument.Uri, out var doc) ? doc.RangeOf(span.Value) : null,
        };
    }

    /// <summary>
    /// Hover for markup-extension NAMES (a curated description of <c>{x:Bind}</c>, <c>{StaticResource}</c>,
    /// ...) and for enum VALUES typed as a plain attribute value (<c>HorizontalAlignment="Center"</c>) or a
    /// markup-extension named argument (<c>{x:Bind ..., Mode=OneWay}</c>). Returns null when the caret is
    /// not on one of these, so the caller falls through to the symbol pipeline.
    /// </summary>
    private async Task<Hover?> ResolveValueHoverAsync(TextDocumentPositionParams p)
    {
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc) || doc.Parsed.Root is not { } root)
        {
            return null;
        }

        int offset = doc.OffsetAt(p.Position);

        // 1) Markup-extension name, and enum value inside a markup-extension argument.
        var extension = InnermostMarkupExtensionAt(root, offset);
        if (extension is not null)
        {
            if (extension.Name is { } exName && exName.Span.ContainsInclusive(offset) &&
                DescribeMarkupExtension(exName.FullName) is { } description)
            {
                return new Hover
                {
                    Contents = new MarkupContent { Kind = "markdown", Value = description },
                    Range = doc.RangeOf(exName.Span),
                };
            }

            var typeSystem = await GetTypeSystemAsync(p.TextDocument.Uri).ConfigureAwait(false);
            var argHover = typeSystem is null ? null : ResolveMarkupArgumentEnumHover(extension, offset, typeSystem, doc);
            if (argHover is not null)
            {
                return argHover;
            }
        }

        // 2) Enum value typed directly as an attribute value (HorizontalAlignment="Center").
        var ts = await GetTypeSystemAsync(p.TextDocument.Uri).ConfigureAwait(false);
        return ts is null ? null : ResolveAttributeEnumHover(doc, offset, ts);
    }

    /// <summary>Returns the innermost <see cref="XamlMarkupExtension"/> whose span contains the offset, or null.</summary>
    private static XamlMarkupExtension? InnermostMarkupExtensionAt(XamlElement root, int offset)
    {
        XamlMarkupExtension? extension = null;
        foreach (var node in root.DescendantNodesAndSelf())
        {
            // Pre-order walk => the last containing extension is the innermost (handles nesting).
            if (node is XamlMarkupExtension candidate && candidate.Span.ContainsInclusive(offset))
            {
                extension = candidate;
            }
        }

        return extension;
    }

    /// <summary>Curated hover markdown for a known markup extension name (by full name, e.g. <c>x:Bind</c>), or null.</summary>
    private static string? DescribeMarkupExtension(string fullName) => fullName switch
    {
        "x:Bind" or "Bind" =>
            "```xaml\n{x:Bind}\n```\nCompiled binding — resolves a field, property, or method against the page's `x:Class` (or the enclosing `DataTemplate` `x:DataType`) at compile time.",
        "Binding" =>
            "```xaml\n{Binding}\n```\nClassic runtime binding — resolves a path against the target's `DataContext`.",
        "StaticResource" =>
            "```xaml\n{StaticResource}\n```\nLooks up a resource by key from the merged resource dictionaries once, at load time.",
        "ThemeResource" =>
            "```xaml\n{ThemeResource}\n```\nLooks up a resource by key and re-evaluates it when the app theme changes.",
        "TemplateBinding" =>
            "```xaml\n{TemplateBinding}\n```\nBinds a property inside a `ControlTemplate` to a property on the templated control.",
        "RelativeSource" =>
            "```xaml\n{RelativeSource}\n```\nSpecifies a binding source relative to the target (`Self`, `TemplatedParent`, `FindAncestor`).",
        "CustomResource" =>
            "```xaml\n{CustomResource}\n```\nLooks up a resource through a custom resource provider.",
        "x:Null" =>
            "```xaml\n{x:Null}\n```\nThe null reference value.",
        "x:Static" =>
            "```xaml\n{x:Static}\n```\nReferences a static field, property, or constant.",
        "x:Type" =>
            "```xaml\n{x:Type}\n```\nReferences a `System.Type` object for the named type.",
        _ => null,
    };

    /// <summary>
    /// Hover for an enum value inside a markup-extension named argument (e.g. the <c>OneWay</c> in
    /// <c>{x:Bind ..., Mode=OneWay}</c>). Resolves the argument's type on the extension and, when it is an
    /// enum matching the value text, returns the enum member. Null otherwise.
    /// </summary>
    private Hover? ResolveMarkupArgumentEnumHover(
        XamlMarkupExtension extension, int offset, XamlTypeSystem typeSystem, TextDocument doc)
    {
        if (extension.Name is not { } extName)
        {
            return null;
        }

        foreach (var argument in extension.Arguments)
        {
            if (argument is not { IsNamed: true, Name: { } argName } ||
                argument.Value is not { Length: > 0 } valueText ||
                argument.ValueSpan is not { } valueSpan ||
                !valueSpan.ContainsInclusive(offset))
            {
                continue;
            }

            var argType = ResolveMarkupArgumentType(extName.FullName, argName.LocalName, typeSystem);
            if (argType is { TypeKind: TypeKind.Enum } &&
                FindEnumMember(argType, valueText) is { } member)
            {
                return new Hover
                {
                    Contents = new MarkupContent { Kind = "markdown", Value = HoverMarkdown(DescribeForHover(member), member) },
                    Range = doc.RangeOf(valueSpan),
                };
            }
        }

        return null;
    }

    /// <summary>Resolves the value type of a markup-extension named argument (e.g. <c>Mode</c> -> <c>BindingMode</c>).</summary>
    private static ITypeSymbol? ResolveMarkupArgumentType(string extensionFullName, string argName, XamlTypeSystem typeSystem)
    {
        var extensionType = extensionFullName switch
        {
            "RelativeSource" => typeSystem.ResolveMetadataType("Microsoft.UI.Xaml.Data.RelativeSource"),
            "Binding" => typeSystem.ResolveMetadataType("Microsoft.UI.Xaml.Data.Binding"),
            _ => null,
        };

        var argType = extensionType is null ? null : typeSystem.FindMember(extensionType, argName)?.Type;

        // x:Bind has no reflectable extension type; its Mode argument is a BindingMode like Binding's.
        if (argType is null && string.Equals(argName, "Mode", StringComparison.Ordinal))
        {
            argType = typeSystem.ResolveMetadataType("Microsoft.UI.Xaml.Data.BindingMode");
        }

        return argType;
    }

    /// <summary>
    /// Hover for an enum value typed directly as an attribute value (<c>HorizontalAlignment="Center"</c>):
    /// resolves the attribute's member type on the owner element and, when it is an enum matching the value
    /// text, returns the enum member. Null otherwise.
    /// </summary>
    private Hover? ResolveAttributeEnumHover(TextDocument doc, int offset, XamlTypeSystem typeSystem)
    {
        XamlAttribute? attr = null;
        for (var current = doc.Parsed.FindNode(offset); current is not null; current = current.Parent)
        {
            if (current is XamlAttribute a)
            {
                attr = a;
                break;
            }

            if (current is XamlElement)
            {
                break;
            }
        }

        if (attr is null || attr.IsNamespaceDeclaration ||
            attr.Value is not { IsMarkupExtension: false } value ||
            !value.InnerSpan.ContainsInclusive(offset) || value.Text.Length == 0 ||
            attr.Parent is not XamlElement { Name: { } ownerName } owner ||
            !owner.NamespaceScope.TryResolvePrefix(ownerName.Prefix, out var uri))
        {
            return null;
        }

        var ownerType = typeSystem.ResolveType(uri, ownerName.LocalName);
        if (ownerType is null)
        {
            return null;
        }

        var memberType = typeSystem.FindMember(ownerType, attr.Name.LocalName)?.Type;
        if (memberType is not { TypeKind: TypeKind.Enum } || FindEnumMember(memberType, value.Text) is not { } member)
        {
            return null;
        }

        return new Hover
        {
            Contents = new MarkupContent { Kind = "markdown", Value = HoverMarkdown(DescribeForHover(member), member) },
            Range = doc.RangeOf(value.InnerSpan),
        };
    }

    /// <summary>Finds an enum member field by name (exact, then case-insensitive) on an enum type, or null.</summary>
    private static IFieldSymbol? FindEnumMember(ITypeSymbol enumType, string name)
    {
        IFieldSymbol? caseInsensitive = null;
        foreach (var member in enumType.GetMembers())
        {
            if (member is not IFieldSymbol { IsConst: true } field)
            {
                continue;
            }

            if (string.Equals(field.Name, name, StringComparison.Ordinal))
            {
                return field;
            }

            if (caseInsensitive is null && string.Equals(field.Name, name, StringComparison.OrdinalIgnoreCase))
            {
                caseInsensitive = field;
            }
        }

        return caseInsensitive;
    }

    /// <summary>
    /// Resolves the symbol under the caret for hover/definition, trying two pipelines in order: an
    /// element or attribute <em>name</em> resolved against the XAML type system (works for framework
    /// and user types alike), then a member <em>value</em> (event handler or x:Bind path) resolved
    /// against the page's x:Class type.
    /// </summary>
    private async Task<(ISymbol? Symbol, TextSpan? Span)> ResolveNamedSymbolAsync(TextDocumentPositionParams p)
    {
        var typeHit = await ResolveTypeSymbolAtAsync(p).ConfigureAwait(false);
        if (typeHit.Symbol != null)
        {
            return typeHit;
        }

        var (symbol, target) = await ResolveSymbolAtAsync(p).ConfigureAwait(false);
        return (symbol, target?.Span);
    }

    /// <summary>
    /// Resolves the positional argument of an <c>{x:Type TypeName}</c> or <c>{x:Static Owner.Member}</c>
    /// markup extension to a symbol: the referenced type, or the static field/property/const/enum member.
    /// For <c>{x:Static}</c> the caret's position within <c>Owner.Member</c> decides — on the owner segment
    /// (or the dot) it resolves the owner type, on the member it resolves the static member — matching the
    /// property-element caret-precision behavior. Navigation lands on the symbol's source (user types);
    /// framework symbols resolve for hover but have no source location, so F12 returns null there. Returns
    /// (null, null) when the caret is not inside such an argument or the reference does not resolve.
    /// </summary>
    private async Task<(ISymbol? Symbol, TextSpan? Span)> ResolveXReferenceSymbolAsync(string uri, int offset)
    {
        if (!_documents.TryGetValue(uri, out var doc) || doc.Parsed.Root is not { } root)
        {
            return (null, null);
        }

        var extension = InnermostMarkupExtensionAt(root, offset);
        if (extension?.Name is not { } exName)
        {
            return (null, null);
        }

        bool isType = exName.FullName is "x:Type";
        bool isStatic = exName.FullName is "x:Static";
        if (!isType && !isStatic)
        {
            return (null, null);
        }

        var arg = extension.Arguments.FirstOrDefault(
            a => !a.IsNamed && a.Value != null && a.ValueSpan is { } vs && vs.ContainsInclusive(offset));
        if (arg?.Value is not { } value || arg.ValueSpan is not { } valueSpan)
        {
            return (null, null);
        }

        var typeSystem = await GetTypeSystemAsync(uri).ConfigureAwait(false);
        if (typeSystem == null)
        {
            return (null, null);
        }

        var scope = NearestElementScope(extension) ?? root.NamespaceScope;

        // {x:Type ...}, or {x:Static Owner} with no member part yet: the whole value is a type name.
        int dot = value.LastIndexOf('.');
        if (isType || dot <= 0 || dot >= value.Length - 1)
        {
            var type = ResolveXamlTypeName(value, scope, typeSystem);
            return type == null ? (null, null) : (type, valueSpan);
        }

        // {x:Static Owner.Member}: split on the last dot into the owner type and the static member.
        var owner = ResolveXamlTypeName(value.Substring(0, dot), scope, typeSystem);
        if (owner == null)
        {
            return (null, null);
        }

        // Caret on the owner segment or the dot -> resolve the owner type, never the member the caret is
        // not on. valueSpan.Start is the first char of the (trimmed) value, so value indices map directly.
        int memberStart = valueSpan.Start + dot + 1;
        if (offset < memberStart)
        {
            return (owner, new TextSpan(valueSpan.Start, valueSpan.Start + dot));
        }

        var member = FindStaticMember(owner, value.Substring(dot + 1));
        return member == null ? (null, null) : (member, new TextSpan(memberStart, valueSpan.End));
    }

    /// <summary>Resolves the property named by a <c>{TemplateBinding Property}</c> argument to the member on
    /// the enclosing <c>ControlTemplate</c>/<c>Style</c> <c>TargetType</c> (the templated parent), for F12/hover.
    /// TemplateBinding takes a single simple property name (no dotted paths), so the whole trimmed value is the
    /// member. The extension NAME hover ("TemplateBinding" macro description) is handled earlier by
    /// <see cref="ResolveValueHoverAsync"/>, which only fires when the caret is on the name — no overlap. Framework
    /// members resolve for hover but have no source location -> F12 returns null (the metadata-as-source boundary).</summary>
    private async Task<(ISymbol? Symbol, TextSpan? Span)> ResolveTemplateBindingMemberAsync(string uri, int offset)
    {
        if (!_documents.TryGetValue(uri, out var doc) || doc.Parsed.Root is not { } root)
        {
            return (null, null);
        }

        var extension = InnermostMarkupExtensionAt(root, offset);
        if (extension?.Name is not { } exName || exName.FullName is not "TemplateBinding")
        {
            return (null, null);
        }

        // The bound property is the first positional argument; only fire when the caret is on its value.
        var arg = extension.Arguments.FirstOrDefault(
            a => !a.IsNamed && a.Value != null && a.ValueSpan is { } vs && vs.ContainsInclusive(offset));
        if (arg?.Value is not { } value || arg.ValueSpan is not { } valueSpan)
        {
            return (null, null);
        }

        var propName = value.Trim();
        if (propName.Length == 0)
        {
            return (null, null);
        }

        var typeSystem = await GetTypeSystemAsync(uri).ConfigureAwait(false);
        if (typeSystem == null)
        {
            return (null, null);
        }

        var caretNode = doc.Parsed.FindNode(offset);
        var scope = (caretNode != null ? NearestElementScope(caretNode) : null) ?? root.NamespaceScope;

        var targetType = CompletionProvider.ResolveStyleTargetType(caretNode, scope, typeSystem);
        if (targetType == null)
        {
            return (null, null);
        }

        var member = FindMember(targetType, propName);
        return member == null ? (null, null) : (member, valueSpan);
    }

    /// <summary>The first public static field/property named <paramref name="name"/> on the type or a base
    /// type (enum members and constants are static fields), or null. Used to resolve <c>{x:Static}</c>.</summary>
    private static ISymbol? FindStaticMember(INamedTypeSymbol type, string name)
    {
        for (INamedTypeSymbol? t = type; t != null; t = t.BaseType)
        {
            foreach (var member in t.GetMembers(name))
            {
                if (member.IsStatic && member is (IFieldSymbol or IPropertySymbol))
                {
                    return member;
                }
            }
        }

        return null;
    }

    /// <summary>Walks up the parent chain to the nearest enclosing <see cref="XamlElement"/>'s namespace
    /// scope (so a markup extension inside an attribute value can resolve prefixes), or null.</summary>
    private static XamlNamespaceScope? NearestElementScope(XamlNode node)
    {
        for (XamlNode? n = node; n != null; n = n.Parent)
        {
            if (n is XamlElement element)
            {
                return element.NamespaceScope;
            }
        }

        return null;
    }

    /// <summary>
    /// Resolves an element name (open or end tag) to its type symbol, a no-prefix <c>&lt;Owner.Member&gt;</c>
    /// property element to the <c>Member</c> property symbol on the owner type, or a simple attribute name
    /// to the property/event symbol on the enclosing element's type. Returns (null, null) when the caret is
    /// not on such a name, or the name (prefix/type/member) does not resolve. Prefixed (x:/d:) and dotted
    /// (attached) attribute names are deliberately not handled here.
    /// </summary>
    private async Task<(ISymbol? Symbol, TextSpan? Span)> ResolveTypeSymbolAtAsync(TextDocumentPositionParams p)
    {
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc))
        {
            return (null, null);
        }

        int offset = doc.OffsetAt(p.Position);
        var node = doc.Parsed.FindNode(offset);

        // Type-valued / Setter.Property attribute values (TargetType="...", <Setter Property="...">)
        // resolve to the referenced type or the target type's member — before the generic pipelines,
        // so they take precedence over the page-member fallback (which would mis-resolve Property="Content").
        var styleValue = await ResolveStyleAttributeValueAsync(p.TextDocument.Uri, offset, node).ConfigureAwait(false);
        if (styleValue.Symbol != null)
        {
            return styleValue;
        }

        // The MEMBER segment of a VSM <Setter Target="Element.Property"> value, or a bare
        // Storyboard.TargetProperty="Property" value — the property on the target element's type. Powers
        // F12/hover on the animated/set property, symmetric with <Setter Property="...">. The Setter.Target
        // ELEMENT segment is a name reference resolved earlier; only the post-dot member lands here.
        var vsmMember = await ResolveVsmTargetMemberAsync(p.TextDocument.Uri, offset, node).ConfigureAwait(false);
        if (vsmMember.Symbol != null)
        {
            return vsmMember;
        }

        // A parenthesized (Owner.Property) qualifier inside Storyboard.TargetProperty — the property on the
        // EXPLICITLY named owner type (instance or attached), independent of Storyboard.TargetName. F12/hover;
        // the read-side counterpart of the round-77 qualified-group completion. Framework members have no
        // source, so F12 returns null there.
        var qualifiedTarget = await ResolveQualifiedTargetPropertyMemberAsync(p.TextDocument.Uri, offset).ConfigureAwait(false);
        if (qualifiedTarget.Symbol != null)
        {
            return qualifiedTarget;
        }

        // {x:Type TypeName} / {x:Static Owner.Member} arguments resolve to the referenced type or static
        // member. Checked before the name switch since the caret sits inside a markup-extension argument.
        var xReference = await ResolveXReferenceSymbolAsync(p.TextDocument.Uri, offset).ConfigureAwait(false);
        if (xReference.Symbol != null)
        {
            return xReference;
        }

        // {TemplateBinding Property} — the bound property on the enclosing ControlTemplate's TargetType
        // (the templated parent). Powers F12/hover on the property, symmetric with the completion. Framework
        // members resolve for hover but have no source location, so F12 returns null there.
        var templateBinding = await ResolveTemplateBindingMemberAsync(p.TextDocument.Uri, offset).ConfigureAwait(false);
        if (templateBinding.Symbol != null)
        {
            return templateBinding;
        }

        switch (node)
        {
            case XamlElement { IsPropertyElement: false } element:
            {
                var name = NameHitInElement(element, offset);
                if (name == null || name.LocalName.Length == 0)
                {
                    return (null, null);
                }

                var typeSystem = await GetTypeSystemAsync(p.TextDocument.Uri).ConfigureAwait(false);
                if (typeSystem == null || !element.NamespaceScope.TryResolvePrefix(name.Prefix, out var uri))
                {
                    return (null, null);
                }

                var type = typeSystem.ResolveType(uri, name.LocalName);
                return type == null ? (null, null) : (type, name.LocalNameSpan);
            }

            case XamlElement { IsPropertyElement: true } propertyElement:
            {
                // F12/hover on a no-prefix <Owner.Member> property element (e.g. <Grid.RowDefinitions>).
                // The caret's position within the dotted name decides what resolves: on the Member part it
                // is the property on the Owner type (the same Owner/Member split WXAML0006 uses); on the
                // Owner part (or the dot) it is the Owner type itself, exactly like hovering an element name.
                // Navigation lands on the symbol's source (user types); framework symbols resolve for hover
                // but have no source location, so F12 returns null there (the metadata-as-source gap).
                var peName = NameHitInElement(propertyElement, offset);
                if (peName == null)
                {
                    return (null, null);
                }

                int dot = peName.LocalName.LastIndexOf('.');
                if (dot <= 0 || dot >= peName.LocalName.Length - 1)
                {
                    return (null, null); // malformed dotted name — leave it to the parser
                }

                var typeSystem = await GetTypeSystemAsync(p.TextDocument.Uri).ConfigureAwait(false);
                if (typeSystem == null ||
                    !propertyElement.NamespaceScope.TryResolvePrefix(peName.Prefix, out var uri))
                {
                    return (null, null);
                }

                var ownerType = typeSystem.ResolveType(uri, peName.LocalName.Substring(0, dot));
                if (ownerType == null)
                {
                    return (null, null);
                }

                // Only resolve the member when the caret is actually on the Member part (past the dot);
                // otherwise the caret is on the Owner segment, so resolve the Owner type instead of letting
                // the member masquerade under a caret that is not on it.
                int memberStart = peName.LocalNameSpan.Start + dot + 1;
                if (offset < memberStart)
                {
                    var ownerSpan = new TextSpan(peName.LocalNameSpan.Start, peName.LocalNameSpan.Start + dot);
                    return (ownerType, ownerSpan);
                }

                var member = FindMember(ownerType, peName.LocalName.Substring(dot + 1));
                if (member == null)
                {
                    return (null, null); // unknown member (or attached-only) — stay silent, no guess
                }

                // Highlight just the member part, past "Owner.", matching the validator's member span.
                var memberSpan = new TextSpan(memberStart, peName.LocalNameSpan.End);
                return (member, memberSpan);
            }

            case XamlAttribute attr
                when !attr.IsNamespaceDeclaration && !attr.Name.HasPrefix && !attr.Name.IsDotted &&
                     attr.Name.Span.ContainsInclusive(offset):
            {
                if (attr.Parent is not XamlElement { Name: { } elementName } owner)
                {
                    return (null, null);
                }

                var typeSystem = await GetTypeSystemAsync(p.TextDocument.Uri).ConfigureAwait(false);
                if (typeSystem == null || !owner.NamespaceScope.TryResolvePrefix(elementName.Prefix, out var uri))
                {
                    return (null, null);
                }

                var elementType = typeSystem.ResolveType(uri, elementName.LocalName);
                if (elementType == null)
                {
                    return (null, null);
                }

                var member = FindMember(elementType, attr.Name.LocalName);
                return member == null ? (null, null) : (member, attr.Name.Span);
            }
        }

        return (null, null);
    }

    /// <summary>
    /// Resolves a type-valued attribute value (<c>TargetType="Foo"</c>) to its type symbol, or a
    /// <c>&lt;Setter Property="Bar"&gt;</c> value to the <c>Bar</c> member on the enclosing
    /// <c>Style</c>/<c>ControlTemplate</c> <c>TargetType</c>. Powers F12/hover for these values and,
    /// crucially for Setter.Property, scopes the symbol to the styled type rather than the page class.
    /// </summary>
    private async Task<(ISymbol? Symbol, TextSpan? Span)> ResolveStyleAttributeValueAsync(
        string uri, int offset, XamlNode? node)
    {
        XamlAttribute? attr = null;
        for (var current = node; current != null; current = current.Parent)
        {
            if (current is XamlAttribute a)
            {
                attr = a;
                break;
            }

            if (current is XamlElement)
            {
                break;
            }
        }

        if (attr?.Value is not { } value || value.IsMarkupExtension ||
            !value.Span.ContainsInclusive(offset) ||
            attr.Parent is not XamlElement { Name: { HasPrefix: false } ownerName } owner)
        {
            return (null, null);
        }

        // Type-valued attributes we navigate/hover from: unprefixed TargetType, and x:DataType on a template.
        bool isTargetType = !attr.Name.HasPrefix &&
            string.Equals(attr.Name.LocalName, "TargetType", StringComparison.Ordinal);
        bool isDataType = string.Equals(attr.Name.Prefix, "x", StringComparison.Ordinal) &&
            string.Equals(attr.Name.LocalName, "DataType", StringComparison.Ordinal);
        bool isSetterProperty = !attr.Name.HasPrefix &&
            string.Equals(ownerName.LocalName, "Setter", StringComparison.Ordinal) &&
            string.Equals(attr.Name.LocalName, "Property", StringComparison.Ordinal);

        if (!isTargetType && !isDataType && !isSetterProperty)
        {
            return (null, null);
        }

        var text = value.Text.Trim();
        if (text.Length == 0)
        {
            return (null, null);
        }

        var typeSystem = await GetTypeSystemAsync(uri).ConfigureAwait(false);
        if (typeSystem == null)
        {
            return (null, null);
        }

        // TargetType="Foo" / x:DataType="Foo" -> the referenced type (F12 to user-type source, hover describes it).
        if (isTargetType || isDataType)
        {
            var type = ResolveXamlTypeName(text, owner.NamespaceScope, typeSystem);
            return type == null ? (null, null) : (type, value.InnerSpan);
        }

        // <Setter Property="Bar"> -> the Bar member on the enclosing TargetType (attached if dotted).
        {
            int dot = text.IndexOf('.');
            if (dot > 0)
            {
                var attachedOwner = ResolveXamlTypeName(text.Substring(0, dot), owner.NamespaceScope, typeSystem);
                var attached = attachedOwner == null ? null : FindMember(attachedOwner, text.Substring(dot + 1));
                return attached == null ? (null, null) : (attached, value.InnerSpan);
            }

            var targetType = ResolveEnclosingTargetType(owner, typeSystem);
            var member = targetType == null ? null : FindMember(targetType, text);
            return member == null ? (null, null) : (member, value.InnerSpan);
        }
    }

    /// <summary>
    /// Resolves the MEMBER segment of a VSM <c>&lt;Setter Target="Element.Property"&gt;</c> value (the
    /// property AFTER the first dot, on the target element's type) or a bare
    /// <c>Storyboard.TargetProperty="Property"</c> value (the property on the element named by the sibling
    /// <c>Storyboard.TargetName</c> on the same animation) to its member symbol — powering F12/hover on the
    /// animated/set property, symmetric with <c>&lt;Setter Property="..."&gt;</c>. The Setter.Target ELEMENT
    /// segment is a name reference resolved earlier (round 80); only a caret on the post-dot member lands
    /// here. Framework members resolve for hover but have no source location, so F12 returns null there
    /// (the documented metadata boundary). Parenthesized <c>(Owner.Property)</c>, dotted multi-segment, and
    /// attached animation-target paths are deliberately deferred (graceful fall-through). Returns (null,
    /// null) when the caret is not on such a member, the value is a markup extension, or it does not resolve.
    /// </summary>
    private async Task<(ISymbol? Symbol, TextSpan? Span)> ResolveVsmTargetMemberAsync(
        string uri, int offset, XamlNode? node)
    {
        if (!_documents.TryGetValue(uri, out var doc) || doc.Parsed.Root is not { } root)
        {
            return (null, null);
        }

        XamlAttribute? attr = null;
        for (var current = node; current != null; current = current.Parent)
        {
            if (current is XamlAttribute a)
            {
                attr = a;
                break;
            }

            if (current is XamlElement)
            {
                break;
            }
        }

        if (attr is null || attr.Name.HasPrefix ||
            attr.Value is not { IsMarkupExtension: false } value ||
            !value.Span.ContainsInclusive(offset) ||
            attr.Parent is not XamlElement { Name: { HasPrefix: false } } owner)
        {
            return (null, null);
        }

        var text = value.Text;
        string? elementName;
        int memStart;
        int memEnd;

        if (string.Equals(attr.Name.LocalName, "Target", StringComparison.Ordinal) &&
            string.Equals(owner.Name.LocalName, "Setter", StringComparison.Ordinal))
        {
            // <Setter Target="Element.Property"> — the member is the single segment after the first dot.
            int dot = text.IndexOf('.');
            if (dot < 0 || text.IndexOf('.', dot + 1) >= 0)
            {
                // No dot yet (element segment, round-80 territory) or a further dot (multi-segment) -> defer.
                return (null, null);
            }

            elementName = text.Substring(0, dot).Trim();
            memStart = dot + 1;
            memEnd = text.Length;
        }
        else if (string.Equals(attr.Name.LocalName, "Storyboard.TargetProperty", StringComparison.Ordinal))
        {
            // Storyboard.TargetProperty="Property" — a bare single-segment member rooted at the sibling
            // Storyboard.TargetName. Parenthesized/dotted/attached target paths are deferred.
            if (text.IndexOf('.') >= 0 || text.IndexOf('(') >= 0)
            {
                return (null, null);
            }

            elementName = owner.Attributes.FirstOrDefault(
                a => !a.Name.HasPrefix &&
                     string.Equals(a.Name.LocalName, "Storyboard.TargetName", StringComparison.Ordinal))
                ?.Value?.Text?.Trim();
            memStart = 0;
            memEnd = text.Length;
        }
        else
        {
            return (null, null);
        }

        // Trim surrounding whitespace of the member segment, then require the caret to sit on it.
        while (memStart < memEnd && char.IsWhiteSpace(text[memStart]))
        {
            memStart++;
        }

        while (memEnd > memStart && char.IsWhiteSpace(text[memEnd - 1]))
        {
            memEnd--;
        }

        if (memEnd <= memStart || string.IsNullOrEmpty(elementName))
        {
            return (null, null);
        }

        int absStart = value.InnerSpan.Start + memStart;
        int absEnd = value.InnerSpan.Start + memEnd;
        if (offset < absStart || offset > absEnd)
        {
            return (null, null);
        }

        var typeSystem = await GetTypeSystemAsync(uri).ConfigureAwait(false);
        if (typeSystem == null)
        {
            return (null, null);
        }

        var elementType = CompletionProvider.ResolveNamedElementType(root, elementName!, owner.NamespaceScope, typeSystem);
        if (elementType == null)
        {
            return (null, null);
        }

        var memberSymbol = FindMember(elementType, text.Substring(memStart, memEnd - memStart));
        return memberSymbol == null ? (null, null) : (memberSymbol, new TextSpan(absStart, absEnd));
    }

    /// <summary>A parenthesized <c>(Owner.Member)</c> qualifier group under the caret inside a
    /// <c>Storyboard.TargetProperty</c> value: the explicitly named owner-type token + span, the member token +
    /// span (null when the caret is on the owner or no member is typed yet), whether the caret sits on the
    /// member, and the namespace scope that resolves the owner. Structural only — no symbol resolution.</summary>
    private readonly record struct QualifiedTargetHit(
        string OwnerToken, TextSpan OwnerSpan,
        string? MemberToken, TextSpan MemberSpan,
        bool CaretOnMember, XamlNamespaceScope Scope);

    /// <summary>
    /// Locates a parenthesized <c>(Owner.Member)</c> qualifier group (as used by <c>Storyboard.TargetProperty</c>
    /// PropertyPaths — <c>(Canvas.Left)</c>, <c>(UIElement.Opacity)</c>, chained
    /// <c>(UIElement.RenderTransform).(CompositeTransform.TranslateX)</c>) whose parentheses enclose
    /// <paramref name="offset"/>. The owner type is named EXPLICITLY inside the group, so it is resolved
    /// independently of <c>Storyboard.TargetName</c>. Returns null when the caret is not inside such a group, on
    /// neither the owner nor the first member segment, or the enclosing attribute is not a bare
    /// <c>Storyboard.TargetProperty</c> with a non-markup value. Multi-segment tails past the first member and a
    /// caret between/after groups fall through (null).
    /// </summary>
    private static QualifiedTargetHit? FindQualifiedTargetPropertyAt(TextDocument doc, int offset)
    {
        if (doc.Parsed.Root is not { } root)
        {
            return null;
        }

        var node = doc.Parsed.FindNode(offset);
        XamlAttribute? attr = null;
        for (var current = node; current != null; current = current.Parent)
        {
            if (current is XamlAttribute a)
            {
                attr = a;
                break;
            }

            if (current is XamlElement)
            {
                break;
            }
        }

        if (attr is null || attr.Name.HasPrefix ||
            !string.Equals(attr.Name.LocalName, "Storyboard.TargetProperty", StringComparison.Ordinal) ||
            attr.Value is not { IsMarkupExtension: false } value ||
            !value.Span.ContainsInclusive(offset) ||
            attr.Parent is not XamlElement { Name: { HasPrefix: false } } owner)
        {
            return null;
        }

        var text = value.Text;
        int innerStart = value.InnerSpan.Start;
        int rel = offset - innerStart;
        if (rel < 0 || rel > text.Length)
        {
            return null;
        }

        // Find the group whose parens enclose the caret: scan back from the caret — a ')' first means the
        // caret is outside any open group; a '(' first opens the caret's group.
        int open = -1;
        for (int i = rel - 1; i >= 0; i--)
        {
            char c = text[i];
            if (c == ')')
            {
                return null;
            }

            if (c == '(')
            {
                open = i;
                break;
            }
        }

        if (open < 0)
        {
            return null;
        }

        int close = text.IndexOf(')', open + 1);
        if (close < 0)
        {
            close = text.Length; // unterminated group (tolerant, mid-type)
        }

        int firstDot = text.IndexOf('.', open + 1);
        if (firstDot >= close)
        {
            firstDot = -1;
        }

        (int Start, int End) Trim(int s, int e)
        {
            while (s < e && char.IsWhiteSpace(text[s]))
            {
                s++;
            }

            while (e > s && char.IsWhiteSpace(text[e - 1]))
            {
                e--;
            }

            return (s, e);
        }

        if (firstDot < 0)
        {
            // No member dot yet: the whole group content is the owner token; only an owner caret resolves.
            var (os, oe) = Trim(open + 1, close);
            if (oe <= os || offset < innerStart + os || offset > innerStart + oe)
            {
                return null;
            }

            return new QualifiedTargetHit(
                text.Substring(os, oe - os), new TextSpan(innerStart + os, innerStart + oe),
                null, default, false, owner.NamespaceScope);
        }

        var (ownS, ownE) = Trim(open + 1, firstDot);
        if (ownE <= ownS)
        {
            return null;
        }

        int secondDot = text.IndexOf('.', firstDot + 1);
        int memberEnd = secondDot >= 0 && secondDot < close ? secondDot : close;
        var (memS, memE) = Trim(firstDot + 1, memberEnd);
        string ownerToken = text.Substring(ownS, ownE - ownS);
        var ownerSpan = new TextSpan(innerStart + ownS, innerStart + ownE);

        // The member caret takes precedence; otherwise an owner caret resolves the owner type.
        if (memE > memS && offset >= innerStart + memS && offset <= innerStart + memE)
        {
            return new QualifiedTargetHit(
                ownerToken, ownerSpan,
                text.Substring(memS, memE - memS), new TextSpan(innerStart + memS, innerStart + memE),
                true, owner.NamespaceScope);
        }

        if (offset >= innerStart + ownS && offset <= innerStart + ownE)
        {
            return new QualifiedTargetHit(ownerToken, ownerSpan, null, default, false, owner.NamespaceScope);
        }

        return null;
    }

    /// <summary>
    /// Resolves a parenthesized <c>(Owner.Member)</c> qualifier inside <c>Storyboard.TargetProperty</c> to its
    /// symbol for F12/hover — the read-side counterpart of the round-77 qualified-group COMPLETION. A caret on
    /// the owner resolves the explicitly named owner TYPE (like <c>{x:Type}</c>); a caret on the member resolves
    /// an INSTANCE property or an ATTACHED property of that owner. Framework members/types have no source, so
    /// F12 returns null there (the documented metadata boundary); hover still renders. Returns (null, null)
    /// when the caret is not on such a group or the owner/member does not resolve.
    /// </summary>
    private async Task<(ISymbol? Symbol, TextSpan? Span)> ResolveQualifiedTargetPropertyMemberAsync(string uri, int offset)
    {
        if (!_documents.TryGetValue(uri, out var doc) ||
            FindQualifiedTargetPropertyAt(doc, offset) is not { } hit)
        {
            return (null, null);
        }

        var typeSystem = await GetTypeSystemAsync(uri).ConfigureAwait(false);
        if (typeSystem == null)
        {
            return (null, null);
        }

        var ownerType = ResolveXamlTypeName(hit.OwnerToken, hit.Scope, typeSystem);
        if (ownerType == null)
        {
            return (null, null);
        }

        if (!hit.CaretOnMember)
        {
            // Caret on the explicitly named owner type -> the type itself.
            return (ownerType, hit.OwnerSpan);
        }

        // Caret on the member: an instance property on the owner, or one of its attached properties.
        var member = FindMember(ownerType, hit.MemberToken!)
            ?? typeSystem.GetAttachedProperties(ownerType)
                .FirstOrDefault(m => string.Equals(m.Name, hit.MemberToken, StringComparison.Ordinal))?.Symbol;
        return member == null ? (null, null) : (member, hit.MemberSpan);
    }

    /// <summary>
    /// Hover for the caret on an ATTACHED-property member of a parenthesized <c>(Owner.Member)</c> qualifier in
    /// <c>Storyboard.TargetProperty</c> (e.g. <c>(Canvas.Left)</c>) — rendered with the same
    /// <c>(attached property) T Owner.Member</c> framing as the attribute-form / x:Bind attached hovers. Instance
    /// members and the owner-type caret return null here and fall through to the shared symbol pipeline (which
    /// renders <c>T Owner.Member</c> / the type). Null when the caret is not on such an attached member.
    /// </summary>
    private async Task<Hover?> ResolveQualifiedTargetPropertyHoverAsync(TextDocumentPositionParams p)
    {
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc))
        {
            return null;
        }

        int offset = doc.OffsetAt(p.Position);
        if (FindQualifiedTargetPropertyAt(doc, offset) is not { CaretOnMember: true } hit)
        {
            return null;
        }

        var typeSystem = await GetTypeSystemAsync(p.TextDocument.Uri).ConfigureAwait(false);
        if (typeSystem == null)
        {
            return null;
        }

        var ownerType = ResolveXamlTypeName(hit.OwnerToken, hit.Scope, typeSystem);
        if (ownerType == null)
        {
            return null;
        }

        // Only ATTACHED members get the dedicated framing here; an instance member of the same name (rare) wins
        // and falls through so hover and F12 agree on the instance property.
        if (FindMember(ownerType, hit.MemberToken!) != null)
        {
            return null;
        }

        var attached = typeSystem.GetAttachedProperties(ownerType)
            .FirstOrDefault(m => string.Equals(m.Name, hit.MemberToken, StringComparison.Ordinal));
        if (attached == null)
        {
            return null;
        }

        var valueType = attached.Type?.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat) ?? "object";
        return new Hover
        {
            Contents = new MarkupContent
            {
                Kind = "markdown",
                Value = HoverMarkdown($"(attached property) {valueType} {ownerType.Name}.{attached.Name}", attached.Symbol, methodDetails: false),
            },
            Range = doc.RangeOf(hit.MemberSpan),
        };
    }

    /// <summary>Resolves a (possibly <c>prefix:</c>-qualified) XAML type name against a namespace scope.</summary>
    private static INamedTypeSymbol? ResolveXamlTypeName(
        string text, XamlNamespaceScope scope, XamlTypeSystem typeSystem)
    {
        string prefix = string.Empty;
        string local = text;
        int colon = text.IndexOf(':');
        if (colon >= 0)
        {
            prefix = text.Substring(0, colon);
            local = text.Substring(colon + 1);
        }

        return scope.TryResolvePrefix(prefix, out var nsUri) ? typeSystem.ResolveType(nsUri, local) : null;
    }

    /// <summary>Walks up to the nearest <c>Style</c>/<c>ControlTemplate</c> and resolves its TargetType.</summary>
    private static INamedTypeSymbol? ResolveEnclosingTargetType(XamlElement start, XamlTypeSystem typeSystem)
    {
        for (XamlNode? node = start; node != null; node = node.Parent)
        {
            if (node is not XamlElement { Name: { HasPrefix: false } name } element ||
                (name.LocalName != "Style" && name.LocalName != "ControlTemplate"))
            {
                continue;
            }

            var targetType = element.Attributes.FirstOrDefault(
                a => !a.Name.HasPrefix && string.Equals(a.Name.LocalName, "TargetType", StringComparison.Ordinal));
            var text = targetType?.Value?.Text?.Trim();
            return string.IsNullOrEmpty(text) ? null : ResolveXamlTypeName(text!, element.NamespaceScope, typeSystem);
        }

        return null;
    }

    private static XamlName? NameHitInElement(XamlElement element, int offset)
    {
        if (element.Name is { } name && name.Span.ContainsInclusive(offset))
        {
            return name;
        }

        if (element.EndTagName is { } endName && endName.Span.ContainsInclusive(offset))
        {
            return endName;
        }

        return null;
    }

    private static string DescribeForHover(ISymbol symbol) => symbol switch
    {
        INamedTypeSymbol type => $"{TypeKeyword(type)} {type.ToDisplayString()}",
        _ => symbol.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat),
    };

    /// <summary>
    /// Builds hover markdown for a symbol: the C# <paramref name="signature"/> in a fenced code block, followed
    /// by the symbol's XML-doc <c>&lt;summary&gt;</c> as a plain paragraph when one is available (WinUI framework
    /// reference assemblies and the user's own source both ship docs). For a method symbol (event handlers,
    /// x:Bind function bindings) it also appends the <c>&lt;returns&gt;</c> and documented <c>&lt;param&gt;</c>s
    /// below the summary — VS quick-info parity. When <paramref name="symbol"/> is <see langword="null"/> or has
    /// no summary/returns/params, only the signature block is returned, so enrichment is purely additive.
    /// <paramref name="methodDetails"/> is set <see langword="false"/> where a method symbol is PRESENTED as a
    /// property (attached-property getters), keeping those hovers summary-only.
    /// </summary>
    private static string HoverMarkdown(string signature, ISymbol? symbol, bool methodDetails = true)
    {
        var doc = symbol is null ? QuickInfoDoc.Empty : XmlDocSummary.ExtractQuickInfo(symbol.GetDocumentationCommentXml());
        var sb = new System.Text.StringBuilder();
        sb.Append("```csharp\n").Append(signature).Append("\n```");

        if (doc.Summary is not null)
        {
            sb.Append("\n\n").Append(doc.Summary);
        }

        // Gated to IMethodSymbol so property/field/type/event hovers (whose docs carry no returns/params anyway)
        // stay byte-identical to the summary-only behavior.
        if (methodDetails && symbol is IMethodSymbol)
        {
            if (doc.Returns is not null)
            {
                sb.Append("\n\n**Returns:** ").Append(doc.Returns);
            }

            var wroteHeader = false;
            foreach (var param in doc.Parameters)
            {
                if (param.Text is null)
                {
                    continue;
                }

                if (!wroteHeader)
                {
                    sb.Append("\n\n**Parameters:**");
                    wroteHeader = true;
                }

                sb.Append("\n- `").Append(param.Name).Append("`: ").Append(param.Text);
            }
        }

        return sb.ToString();
    }

    private static string TypeKeyword(INamedTypeSymbol type) => type.TypeKind switch
    {
        TypeKind.Interface => "interface",
        TypeKind.Struct => "struct",
        TypeKind.Enum => "enum",
        TypeKind.Delegate => "delegate",
        _ => "class",
    };

    // --- Completion (IntelliSense) ------------------------------------------

    private async Task<object?> CompleteAsync(TextDocumentPositionParams p)
    {
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc))
        {
            return new CompletionList();
        }

        var context = await GetContextAsync(p.TextDocument.Uri).ConfigureAwait(false);
        if (context == null)
        {
            return new CompletionList();
        }

        int offset = doc.OffsetAt(p.Position);
        var appKeys = GetAppResourceKeys(context.Value.Resolution);
        return CompletionProvider.Provide(doc, offset, context.Value.TypeSystem, context.Value.Resolution.ClassSymbol, appKeys);
    }

    /// <summary>
    /// Collects the <c>x:Key</c> resource keys declared in the project's App.xaml (found next to the
    /// project file), cached by last-write time. Returns an empty set when there is no App.xaml. These
    /// feed <c>{StaticResource}</c>/<c>{ThemeResource}</c> key completion alongside document-local keys.
    /// </summary>
    private string[] GetAppResourceKeys(XamlResolution resolution)
    {
        try
        {
            var appXaml = FindAppXamlPath(resolution);
            if (appXaml == null)
            {
                return System.Array.Empty<string>();
            }

            var stamp = System.IO.File.GetLastWriteTimeUtc(appXaml);
            if (_appResourceCache.TryGetValue(appXaml, out var cached) && cached.Stamp == stamp)
            {
                return cached.Keys;
            }

            var parsed = XamlParser.Parse(System.IO.File.ReadAllText(appXaml));
            var keys = CompletionProvider.CollectResourceKeys(parsed).ToArray();
            _appResourceCache[appXaml] = (stamp, keys);
            return keys;
        }
        catch (System.Exception ex)
        {
            System.Console.Error.WriteLine($"[winui-xaml-ls] app resources: {ex.Message}");
            return System.Array.Empty<string>();
        }
    }

    /// <summary>
    /// Returns the path to the project's App.xaml (located next to the project file), or null when the
    /// project path is unknown or no App.xaml exists beside it.
    /// </summary>
    private static string? FindAppXamlPath(XamlResolution resolution)
    {
        var dir = System.IO.Path.GetDirectoryName(resolution.ProjectPath);
        if (string.IsNullOrEmpty(dir))
        {
            return null;
        }

        var appXaml = System.IO.Path.Combine(dir, "App.xaml");
        return System.IO.File.Exists(appXaml) ? appXaml : null;
    }

    /// <summary>
    /// Resolves the document's project and returns a (cached) type-system provider for its compilation.
    /// The cache is keyed by the Roslyn <see cref="Compilation"/>, which is stable per loaded project.
    /// </summary>
    private async Task<XamlTypeSystem?> GetTypeSystemAsync(string uri) =>
        (await GetContextAsync(uri).ConfigureAwait(false))?.TypeSystem;

    /// <summary>
    /// Resolves the document to its project <see cref="XamlResolution"/> (for the x:Class symbol) plus
    /// the cached <see cref="XamlTypeSystem"/> for its compilation.
    /// </summary>
    private async Task<(XamlResolution Resolution, XamlTypeSystem TypeSystem)?> GetContextAsync(string uri)
    {
        var path = UriToPath(uri);
        if (path == null)
        {
            Console.Error.WriteLine($"[winui-xaml-ls] context: UriToPath returned null for '{uri}'");
            return null;
        }

        XamlResolution? resolution;
        try
        {
            resolution = await ResolveIfAllowedAsync(path).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[winui-xaml-ls] resolve failed: {ex.Message}");
            return null;
        }

        if (resolution == null)
        {
            Console.Error.WriteLine($"[winui-xaml-ls] context: resolver returned null for path '{path}'");
            return null;
        }

        var typeSystem = _typeSystems.GetValue(resolution.Compilation, _ => XamlTypeSystem.FromResolution(resolution));
        return (resolution, typeSystem);
    }

    /// <summary>
    /// Shared pipeline for definition/hover: map the caret to a member name on the page's x:Class type
    /// (either an event-handler attribute value or an x:Bind path segment) and resolve it to a symbol.
    /// </summary>
    private async Task<(ISymbol? Symbol, MemberTarget? Target)> ResolveSymbolAtAsync(TextDocumentPositionParams p)
    {
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc))
        {
            return (null, null);
        }

        int offset = doc.OffsetAt(p.Position);
        var target = FindMemberTargetAt(doc, offset);
        if (target == null)
        {
            return (null, null);
        }

        var path = UriToPath(p.TextDocument.Uri);
        if (path == null)
        {
            return (null, target);
        }

        XamlResolution? resolution;
        try
        {
            resolution = await ResolveIfAllowedAsync(path).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[winui-xaml-ls] resolve failed: {ex.Message}");
            return (null, target);
        }

        var classSymbol = resolution?.ClassSymbol;
        if (classSymbol == null)
        {
            return (null, target);
        }

        // Inside a DataTemplate the x:Bind root is the template's x:DataType, not the page's x:Class.
        var rootType = await ResolveBindRootTypeAsync(doc, offset, p.TextDocument.Uri).ConfigureAwait(false) ?? classSymbol;

        // Walk any dotted path segments typed before the caret one so the caret segment resolves against
        // the correct type (e.g. GreetingText.Length -> Length on String, not on the page's x:Class).
        // Indexer segments (Items[0]) unwrap the collection element type as they are walked.
        var currentType = rootType;

        // A leading cast ((local:Type)Member) rebinds the walk to the named type instead of the root.
        if (target.Value.CastType is { } castName)
        {
            var typeSystem = await GetTypeSystemAsync(p.TextDocument.Uri).ConfigureAwait(false);
            var caretNode = doc.Parsed.FindNode(offset);
            var scope = (caretNode != null ? NearestElementScope(caretNode) : null) ?? doc.Parsed.Root?.NamespaceScope;
            var castType = typeSystem != null && scope != null
                ? ResolveXamlTypeName(castName, scope, typeSystem)
                : null;
            if (castType == null)
            {
                return (null, target);
            }

            currentType = castType;
        }

        foreach (var segment in target.Value.Preceding)
        {
            var next = WalkBindSegmentType(currentType, segment);
            if (next == null)
            {
                return (null, target);
            }

            currentType = next;
        }

        return (FindMember(currentType, target.Value.Name), target);
    }

    /// <summary>The named type a member evaluates to (a property/field's type or a method's return type), or null.</summary>
    private static INamedTypeSymbol? MemberResultType(ISymbol? member) => member switch
    {
        IPropertySymbol p => p.Type as INamedTypeSymbol,
        IFieldSymbol f => f.Type as INamedTypeSymbol,
        IMethodSymbol m => m.ReturnType as INamedTypeSymbol,
        _ => null,
    };

    /// <summary>
    /// Resolves one preceding <c>{x:Bind}</c> path segment to the type it evaluates to, unwrapping the
    /// collection element type once per trailing <c>[...]</c> indexer group (so <c>Items[0]</c> on an
    /// <c>IReadOnlyList&lt;string&gt;</c> member yields <c>string</c>). Returns null when a member or an
    /// element type can't be resolved.
    /// </summary>
    private static INamedTypeSymbol? WalkBindSegmentType(INamedTypeSymbol currentType, string segment)
    {
        var (name, indexers) = SplitIndexers(segment);
        var type = MemberResultType(FindMember(currentType, name));
        for (int i = 0; i < indexers && type != null; i++)
        {
            type = XamlTypeSystem.GetCollectionElementType(type) as INamedTypeSymbol;
        }

        return type;
    }

    /// <summary>Splits an x:Bind path segment into its member name and the number of trailing <c>[...]</c>
    /// indexer groups (e.g. <c>"Items[0]"</c> -&gt; <c>("Items", 1)</c>).</summary>
    private static (string Name, int Indexers) SplitIndexers(string segment)
    {
        int bracket = segment.IndexOf('[');
        if (bracket < 0)
        {
            return (segment, 0);
        }

        string name = segment.Substring(0, bracket);
        int count = 0;
        for (int i = bracket; i < segment.Length; i++)
        {
            if (segment[i] == '[')
            {
                count++;
            }
        }

        return (name, count);
    }

    /// <summary>
    /// Returns the type an <c>{x:Bind}</c> path binds against at <paramref name="offset"/>: the nearest
    /// enclosing <c>DataTemplate</c>'s <c>x:DataType</c>, or null when not inside a data template (the
    /// caller then falls back to the page's x:Class).
    /// </summary>
    private async Task<INamedTypeSymbol?> ResolveBindRootTypeAsync(TextDocument doc, int offset, string uri)
    {
        for (XamlNode? node = doc.Parsed.FindNode(offset); node != null; node = node.Parent)
        {
            if (node is not XamlElement { Name: { HasPrefix: false, LocalName: "DataTemplate" } } template)
            {
                continue;
            }

            var dataType = template.Attributes.FirstOrDefault(
                a => string.Equals(a.Name.Prefix, "x", StringComparison.Ordinal) &&
                     string.Equals(a.Name.LocalName, "DataType", StringComparison.Ordinal));
            var text = dataType?.Value?.Text?.Trim();
            if (string.IsNullOrEmpty(text))
            {
                return null;
            }

            var typeSystem = await GetTypeSystemAsync(uri).ConfigureAwait(false);
            return typeSystem == null ? null : ResolveXamlTypeName(text!, template.NamespaceScope, typeSystem);
        }

        return null;
    }

    /// <summary>
    /// Maps a caret offset to a member name on the x:Class type. Handles two shapes:
    /// a plain event-handler value (<c>Click="OnGo_Click"</c>) and the first segment of an
    /// <c>{x:Bind Path}</c> expression.
    /// </summary>
    private static MemberTarget? FindMemberTargetAt(TextDocument doc, int offset)
    {
        var node = doc.Parsed.FindNode(offset);
        for (var current = node; current != null; current = current.Parent)
        {
            switch (current)
            {
                case XamlMarkupExtensionArgument arg:
                {
                    // The bindable path of an {x:Bind ...} expression: either the first positional
                    // argument ({x:Bind Greeting}) or the value of a named "Path=" argument
                    // ({x:Bind Path=Greeting}). Other named arguments (Mode=, Converter=) are not paths.
                    if (arg.Value == null || arg.ValueSpan is not { } valueSpan)
                    {
                        return null;
                    }

                    if (arg.IsNamed && arg.Name?.LocalName != "Path")
                    {
                        return null;
                    }

                    if (arg.Parent is not XamlMarkupExtension ext || ext.Name?.LocalName != "Bind")
                    {
                        return null;
                    }

                    if (!valueSpan.ContainsInclusive(offset))
                    {
                        return null;
                    }

                    return PathSegmentAt(arg.Value, valueSpan, offset);
                }

                case XamlAttribute attr:
                {
                    if (attr.IsNamespaceDeclaration || attr.Value == null || attr.Value.IsMarkupExtension)
                    {
                        return null;
                    }

                    if (!attr.Value.Span.ContainsInclusive(offset))
                    {
                        return null;
                    }

                    // A Storyboard.TargetProperty value is an animation target-property path resolved
                    // against the target element (see ResolveVsmTargetMemberAsync), never a member of the
                    // page's x:Class. Without this guard a bare value would leak here as a coincidental
                    // page-member match — e.g. "Opacity" resolving to the page's UIElement.Opacity even
                    // with no (or an unresolvable) Storyboard.TargetName target.
                    if (!attr.Name.HasPrefix &&
                        string.Equals(attr.Name.LocalName, "Storyboard.TargetProperty", StringComparison.Ordinal))
                    {
                        return null;
                    }

                    var text = attr.Value.Text.Trim();
                    return IdentifierPattern.IsMatch(text)
                        ? new MemberTarget(text, attr.Value.InnerSpan)
                        : null;
                }
            }
        }

        return null;
    }

    /// <summary>
    /// Returns the dotted path segment under <paramref name="offset"/> in an x:Bind path (e.g. "B" when
    /// the caret is on B in "A.B.C"), together with the segment names that precede it ("A"). Preceding
    /// segments let the caller walk member types so hover/F12 resolve the caret segment against the right
    /// type (String.Length, not the root's GreetingText). When the caret is inside a function binding's
    /// argument list (<c>Method(arg)</c>), the identifier path under the caret is resolved as a member of
    /// the bind root instead; otherwise the trailing <c>(...)</c> is stripped (it is not part of the path).
    /// </summary>
    private static MemberTarget? PathSegmentAt(string rawValue, TextSpan valueSpan, int offset)
    {
        // A leading '!' negates the bound boolean path ({x:Bind !IsEnabled}); the path itself starts
        // after it, so skip the '!' before locating the caret segment.
        int negation = 0;
        while (negation < rawValue.Length && rawValue[negation] == '!')
        {
            negation++;
        }

        if (negation > 0)
        {
            rawValue = rawValue.Substring(negation);
            valueSpan = new TextSpan(valueSpan.Start + negation, valueSpan.End);
            if (offset < valueSpan.Start)
            {
                return null; // caret is on the '!' itself, not a member
            }
        }

        int rel = offset - valueSpan.Start;

        // A leading '(' is a C#-style cast ((local:Type)Member) or an attached-property step
        // ((Grid.Row)) — never a function binding (whose method name precedes its '('). For a cast,
        // skip the parenthesized type and resolve the member after ')' against the cast target type
        // (carried on the returned MemberTarget). An attached-property step (inner contains a '.') has
        // no member walk and is resolved by the dedicated attached hover pipeline, so return null here.
        if (rawValue.Length > 0 && rawValue[0] == '(')
        {
            int castClose = rawValue.IndexOf(')');
            if (castClose <= 1)
            {
                return null; // '()' or an unterminated cast
            }

            string castInner = rawValue.Substring(1, castClose - 1).Trim();
            if (castInner.Length == 0 || castInner.IndexOf('.') >= 0)
            {
                return null; // empty, or an attached-property step handled elsewhere
            }

            if (rel <= castClose)
            {
                return null; // caret is on the cast type itself, not the member after it
            }

            int restStart = castClose + 1;
            var castTarget = DottedSegmentAt(rawValue.Substring(restStart), valueSpan.Start + restStart, offset);
            return castTarget == null ? null : castTarget.Value with { CastType = castInner };
        }

        // A function binding (Method(a, b.C)). If the caret sits inside the argument list, resolve the
        // identifier path under it; otherwise the path is just the method name before the '('.
        int paren = rawValue.IndexOf('(');
        if (paren >= 0 && rel > paren)
        {
            return ArgumentSegmentAt(rawValue, valueSpan, offset, paren);
        }

        string path = paren >= 0 ? rawValue.Substring(0, paren) : rawValue;
        return DottedSegmentAt(path, valueSpan.Start, offset);
    }

    /// <summary>
    /// Resolves the dotted path segment under <paramref name="offset"/> within <paramref name="path"/>,
    /// whose first character is at absolute <paramref name="pathAbsStart"/>. A trailing <c>[...]</c>
    /// indexer on the caret segment is stripped to its member name (hover targets the member itself);
    /// indexers on preceding segments are preserved so the caller can unwrap collection element types.
    /// </summary>
    private static MemberTarget? DottedSegmentAt(string path, int pathAbsStart, int offset)
    {
        // Split into dotted segments, recording each raw segment's [start,end) offset within path.
        var segments = new List<(string Raw, int Start, int End)>();
        for (int i = 0; i <= path.Length;)
        {
            int dot = path.IndexOf('.', i);
            int end = dot < 0 ? path.Length : dot;
            segments.Add((path.Substring(i, end - i), i, end));
            if (dot < 0)
            {
                break;
            }

            i = dot + 1;
        }

        // Locate the segment containing the caret; a caret past the last dot maps to the final segment.
        int rel = offset - pathAbsStart;
        int idx = segments.Count - 1;
        for (int s = 0; s < segments.Count; s++)
        {
            if (rel >= segments[s].Start && rel <= segments[s].End)
            {
                idx = s;
                break;
            }
        }

        var seg = segments[idx];
        var (name, _) = SplitIndexers(seg.Raw.Trim());
        if (!IdentifierPattern.IsMatch(name))
        {
            return null;
        }

        int lead = seg.Raw.Length - seg.Raw.TrimStart().Length;
        int absStart = pathAbsStart + seg.Start + lead;
        var span = new TextSpan(absStart, absStart + name.Length);

        var preceding = new string[idx];
        for (int s = 0; s < idx; s++)
        {
            preceding[s] = segments[s].Raw.Trim();
        }

        return new MemberTarget(name, span) { Preceding = preceding };
    }

    /// <summary>
    /// Resolves the identifier path under the caret inside a function-binding argument list
    /// (<c>{x:Bind Method(GreetingText)}</c>) so F12/hover work on the argument member. Expands the
    /// maximal path run around the caret within the parentheses and resolves it as a dotted path against
    /// the bind root. Literals (quoted strings, numbers) contain no identifier run and resolve to null.
    /// </summary>
    private static MemberTarget? ArgumentSegmentAt(string rawValue, TextSpan valueSpan, int offset, int openParen)
    {
        int rel = offset - valueSpan.Start;
        int close = rawValue.IndexOf(')', openParen + 1);
        int argsEnd = close < 0 ? rawValue.Length : close;
        if (rel <= openParen || rel > argsEnd)
        {
            return null;
        }

        int start = rel;
        while (start > openParen + 1 && IsBindPathChar(rawValue[start - 1]))
        {
            start--;
        }

        int end = rel;
        while (end < argsEnd && IsBindPathChar(rawValue[end]))
        {
            end++;
        }

        if (end <= start)
        {
            return null;
        }

        string argPath = rawValue.Substring(start, end - start);
        return DottedSegmentAt(argPath, valueSpan.Start + start, offset);
    }

    private static bool IsBindPathChar(char c) =>
        char.IsLetterOrDigit(c) || c == '_' || c == '.' || c == '[' || c == ']';

    private static ISymbol? FindMember(INamedTypeSymbol type, string name)
    {
        for (INamedTypeSymbol? t = type; t != null; t = t.BaseType)
        {
            var member = t.GetMembers(name).FirstOrDefault();
            if (member != null)
            {
                return member;
            }
        }

        return null;
    }

    private readonly record struct MemberTarget(string Name, TextSpan Span)
    {
        /// <summary>Dotted x:Bind path segments typed before <see cref="Name"/> (empty for the first segment or an event handler).</summary>
        public string[] Preceding { get; init; } = System.Array.Empty<string>();

        /// <summary>A leading x:Bind cast type (e.g. <c>local:SmokePage</c> from <c>(local:SmokePage)Member</c>);
        /// the member walk starts from this type instead of the bind root. Null when there is no cast.</summary>
        public string? CastType { get; init; } = null;
    }

    /// <summary>An x:Bind attached-property path step (<c>(Grid.Row)</c>): the owner type name, the member
    /// (attached property) name, the namespace scope that resolves the owner, and the hover span.</summary>
    private readonly record struct BindAttachedHit(string Owner, string Member, XamlNamespaceScope Scope, TextSpan Span);

    /// <summary>An <c>x:Key</c> resource declaration: the resource element's type name and nav span.</summary>
    private readonly record struct ResourceDeclaration(string TypeName, TextSpan NavSpan);

    /// <summary>
    /// A resolved named-element reference: the referenced <c>x:Name</c>, the range of the reference in the
    /// current document (for hover), the declaration location (for F12), and the declaring element's type.
    /// </summary>
    private readonly record struct NameReferenceHit(
        string Name,
        Lsp.Range ReferenceRange,
        Lsp.Location Declaration,
        string TypeName);

    /// <summary>
    /// A resolved resource-key reference: the key, the range of the reference in the current document
    /// (for hover), the declaration location (for F12), the resource element's type name, and a short
    /// label for the file the declaration lives in.
    /// </summary>
    private readonly record struct ResourceReferenceHit(
        string Key,
        Lsp.Range ReferenceRange,
        Lsp.Location Declaration,
        string TypeName,
        string FileLabel);

    private void WarmUp(string uri)
    {
        var path = UriToPath(uri);
        if (path == null)
        {
            return;
        }

        // Only warm up (which triggers project discovery + MSBuild evaluation) for documents under a
        // trusted workspace root. Out-of-root / empty-window files are served project-less.
        if (!IsPathUnderAllowedRoot(path))
        {
            return;
        }

        // Kick off project load so the first go-to-definition doesn't pay the full cold cost.
        _ = Task.Run(async () =>
        {
            try
            {
                await _resolver.ResolveAsync(path).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[winui-xaml-ls] warm-up failed: {ex.Message}");
            }
        });
    }

    // --- Helpers ------------------------------------------------------------

    /// <summary>
    /// Returns the resource key referenced by the <c>{StaticResource}</c>/<c>{ThemeResource}</c>/
    /// <c>{CustomResource}</c> markup extension whose innermost span contains the caret (with the span
    /// of the key argument), or null when the caret is not inside such a reference's key argument.
    /// </summary>
    private static (string Key, TextSpan Span)? FindResourceKeyReferenceAt(TextDocument doc, int offset)
    {
        if (doc.Parsed.Root is not { } root)
        {
            return null;
        }

        XamlMarkupExtension? extension = null;
        foreach (var node in root.DescendantNodesAndSelf())
        {
            // Pre-order walk => the last containing extension is the innermost (handles nesting).
            if (node is XamlMarkupExtension candidate && candidate.Span.ContainsInclusive(offset))
            {
                extension = candidate;
            }
        }

        if (extension?.Name is not { HasPrefix: false } name)
        {
            return null;
        }

        if (name.LocalName is not ("StaticResource" or "ThemeResource" or "CustomResource"))
        {
            return null;
        }

        foreach (var argument in extension.Arguments)
        {
            if (!argument.IsNamed && argument.Value is { Length: > 0 } key)
            {
                // Match the value token itself, not the argument's trailing whitespace, so a caret parked
                // after the key ("{StaticResource Brush1 |}") does not resolve to the key.
                var valueSpan = argument.ValueSpan ?? argument.Span;
                if (valueSpan.ContainsInclusive(offset))
                {
                    return (key, valueSpan);
                }
            }
        }

        return null;
    }

    /// <summary>
    /// Finds the element carrying <c>x:Key="key"</c> anywhere in the parsed document and returns its
    /// element type name plus the span to navigate to (the type-name span, falling back to the key
    /// value's span). Returns null when no such declaration exists.
    /// </summary>
    private static ResourceDeclaration? FindResourceDeclaration(XamlDocument parsed, string key) =>
        parsed.Root is { } root ? FindResourceDeclarationCore(root, key) : null;

    private static ResourceDeclaration? FindResourceDeclarationCore(XamlElement element, string key)
    {
        foreach (var attribute in element.Attributes)
        {
            if (!attribute.IsNamespaceDeclaration
                && attribute.Name.Prefix == "x"
                && attribute.Name.LocalName == "Key"
                && attribute.Value is { } value
                && value.Text == key)
            {
                // Navigate to (and select) the x:Key value itself, so F12 lands on "Key" rather than the
                // resource element's type name -- matching how Visual Studio highlights the key.
                string typeName = element.Name is { LocalName.Length: > 0 } elementName ? elementName.FullName : string.Empty;
                return new ResourceDeclaration(typeName, value.InnerSpan);
            }
        }

        foreach (var child in element.Content)
        {
            if (child is XamlElement childElement)
            {
                var hit = FindResourceDeclarationCore(childElement, key);
                if (hit != null)
                {
                    return hit;
                }
            }
        }

        return null;
    }

    /// <summary>Nearest <see cref="XamlElement"/> enclosing <paramref name="offset"/> (the element that owns
    /// the attribute/markup extension under the caret), or null.</summary>
    private static XamlElement? NearestEnclosingElement(TextDocument doc, int offset)
    {
        for (XamlNode? n = doc.Parsed.FindNode(offset); n != null; n = n.Parent)
        {
            if (n is XamlElement element)
            {
                return element;
            }
        }

        return null;
    }

    /// <summary>
    /// Resolves an <c>x:Key</c> resource declaration in LEXICAL SCOPE: walks up from
    /// <paramref name="reference"/> and, at each enclosing element, searches only that element's own
    /// <c>&lt;Owner.Resources&gt;</c> dictionary for the key. The nearest enclosing scope wins, so an inner
    /// <c>&lt;Grid.Resources&gt;</c> key shadows an outer <c>&lt;Page.Resources&gt;</c> key of the same name.
    /// Returns null when no enclosing scope declares the key (the caller falls back to a document-wide search
    /// and then App.xaml).
    /// </summary>
    private static ResourceDeclaration? FindResourceDeclarationScoped(XamlElement reference, string key)
    {
        for (XamlElement? scope = reference; scope != null; scope = ParentElement(scope))
        {
            foreach (var child in scope.Content)
            {
                if (child is XamlElement propertyElement
                    && propertyElement.Name is { } name
                    && name.FullName.EndsWith(".Resources", StringComparison.Ordinal))
                {
                    var hit = FindResourceDeclarationCore(propertyElement, key);
                    if (hit != null)
                    {
                        return hit;
                    }
                }
            }
        }

        return null;
    }

    /// <summary>The nearest ancestor <see cref="XamlElement"/> above <paramref name="element"/>, or null.</summary>
    private static XamlElement? ParentElement(XamlElement element)
    {
        for (XamlNode? n = element.Parent; n != null; n = n.Parent)
        {
            if (n is XamlElement parent)
            {
                return parent;
            }
        }

        return null;
    }

    private static Lsp.Location ToLspLocation(Microsoft.CodeAnalysis.Location location)
    {
        var span = location.GetLineSpan();
        return new Lsp.Location
        {
            Uri = PathToUri(span.Path),
            Range = new Lsp.Range(
                new Position(span.StartLinePosition.Line, span.StartLinePosition.Character),
                new Position(span.EndLinePosition.Line, span.EndLinePosition.Character)),
        };
    }

    /// <summary>Maps a whole <see cref="TextSpan"/> into an LSP range using the given source text.</summary>
    private static Lsp.Range SpanToRange(string text, TextSpan span) =>
        new(OffsetToPosition(text, span.Start), OffsetToPosition(text, span.End));

    /// <summary>
    /// Converts a character offset into a zero-based LSP line/character position by scanning the text.
    /// Carriage returns are ignored so CRLF documents report the same column as VS Code's UTF-16 model.
    /// </summary>
    private static Position OffsetToPosition(string text, int offset)
    {
        int limit = System.Math.Min(offset, text.Length);
        int line = 0;
        int character = 0;
        for (int i = 0; i < limit; i++)
        {
            char c = text[i];
            if (c == '\n')
            {
                line++;
                character = 0;
            }
            else if (c != '\r')
            {
                character++;
            }
        }

        return new Position(line, character);
    }

    private static int MapSeverity(XamlDiagnosticSeverity severity) => severity switch
    {
        XamlDiagnosticSeverity.Error => 1,
        XamlDiagnosticSeverity.Warning => 2,
        XamlDiagnosticSeverity.Info => 3,
        _ => 4,
    };

    private static string? UriToPath(string uri) => LspUri.ToPath(uri);

    private static string PathToUri(string path) => LspUri.FromPath(path);

    private static T Deserialize<T>(JsonElement? element) where T : new()
    {
        if (element is not { } e)
        {
            return new T();
        }

        return e.Deserialize<T>(LspJson.Options) ?? new T();
    }
}
