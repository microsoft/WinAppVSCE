using Microsoft.CodeAnalysis;
using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Workspace;
using WinUiXaml.Xaml;
using SymbolKind = WinUiXaml.LanguageServer.Lsp.SymbolKind;

namespace WinUiXaml.LanguageServer;

internal sealed partial class XamlLanguageServer
{
    // --- Document symbols (outline) -----------------------------------------

    /// <summary>Builds the hierarchical outline (Outline view, breadcrumbs, Go to Symbol) from the parsed tree.</summary>
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
        var attr = XamlSemanticFacts.GetNameAttribute(element);
        var text = attr?.Value?.Text;
        return string.IsNullOrWhiteSpace(text) ? null : text!.Trim();
    }

    // --- Semantic navigation (definition + hover) ---------------------------

    private Task<object?> GoToDefinitionAsync(TextDocumentPositionParams p) =>
        // F12 never queues behind a cold MSBuild design-time build, matching hover. A user who pressed
        // F12, saw no result, and moved on must not have the editor jump somewhere seconds later when
        // the build finally lands. Targets that need source (event handlers, x:Bind members, app-source
        // types) therefore stay unresolved until the full context is ready.
        WithoutBlockingOnProjectLoadAsync(() => ResolveDefinitionAsync(p));

    private async Task<object?> ResolveDefinitionAsync(TextDocumentPositionParams p)
    {
        // A {StaticResource Key} value is not a type/member name, so try the resource-key pipeline first; it is cheap (no project load) when the caret is not on such a reference.
        var resource = await ResolveResourceKeyDefinitionAsync(p).ConfigureAwait(false);
        if (resource != null)
        {
            return resource;
        }

        // A named-element reference (Binding ElementName=Foo, Storyboard.TargetName="Foo") navigates to the x:Name declaration in this document. Tried before the member pipeline so TargetName does not fall through and mis-resolve to the generated x:Name backing field in the .g.i.cs.
        var nameRef = await ResolveNameReferenceAsync(p, waitForTypeSystem: true).ConfigureAwait(false);
        if (nameRef != null)
        {
            return nameRef.Value.Declaration;
        }

        var (symbol, _) = await ResolveNamedSymbolAsync(p).ConfigureAwait(false);
        var location = symbol?.Locations.FirstOrDefault(l => l.IsInSource);
        return location != null ? ToLspLocation(location) : null;
    }

    // --- Find All References (Shift+F12) ------------------------------------

    /// <summary>Handles textDocument/references (Find All References).</summary>
    private async Task<object?> FindReferencesAsync(ReferenceParams p)
    {
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc) || doc.Parsed.Root is not { } root)
        {
            return null;
        }

        int offset = doc.OffsetAt(p.Position);
        var context = await GetContextAsync(p.TextDocument.Uri).ConfigureAwait(false);
        var typeSystem = context?.TypeSystem;
        EnsureCompleteNameReferenceSemantics(doc, offset, typeSystem, "Find References");
        var occurrences = ResolveOccurrences(doc, root, offset, typeSystem);
        if (occurrences is null)
        {
            return null;
        }

        bool includeDeclaration = p.Context?.IncludeDeclaration ?? true;
        var locations = occurrences
            .Where(o => includeDeclaration || !o.IsDeclaration)
            .Select(o => new Lsp.Location { Uri = doc.Uri, Range = o.Range })
            .ToList();

        // A resource key is a PROJECT-WIDE symbol: its x:Key is typically declared in App.xaml and used across pages.
        if (DetectSymbolAt(doc, offset, typeSystem) is { Kind: XamlRenameKind.Key, Name: { Length: > 0 } key })
        {
            AddCrossFileResourceReferences(context, p.TextDocument.Uri, key, includeDeclaration, locations);
        }

        return locations;
    }

    /// <summary>Adds, to locations, every reference to the resource key in the project's OTHER XAML documents</summary>
    private void AddCrossFileResourceReferences(
        XamlProjectContext? context,
        string currentUri,
        string key,
        bool includeDeclaration,
        List<Lsp.Location> locations)
    {
        if (context == null)
        {
            return;
        }

        var currentPath = UriToPath(currentUri) is { } cp ? System.IO.Path.GetFullPath(cp) : null;
        var cancellationToken = _requestCancellation.Value;

        foreach (var file in context.Resolution.XamlFiles)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!TryGetAllowedRoot(file, out var canonicalFile, out _))
            {
                continue;
            }

            // The open document was already collected from its (possibly unsaved) buffer; skip its disk copy.
            if (currentPath != null &&
                string.Equals(canonicalFile, currentPath, System.StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            string text;
            try
            {
                text = System.IO.File.ReadAllText(canonicalFile);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (System.Exception ex)
            {
                System.Console.Error.WriteLine($"[winui-xaml-ls] xref read '{canonicalFile}': {ex.Message}");
                continue;
            }

            // Cheap literal pre-filter: only parse files that mention the key at all. The collector still matches the key EXACTLY, so this never widens results — it only skips irrelevant files.
            if (text.IndexOf(key, System.StringComparison.Ordinal) < 0)
            {
                continue;
            }

            TextDocument fileDoc;
            try
            {
                fileDoc = new TextDocument(PathToUri(canonicalFile), text);
            }
            catch (System.Exception ex)
            {
                System.Console.Error.WriteLine($"[winui-xaml-ls] xref parse '{canonicalFile}': {ex.Message}");
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

    /// <summary>Handles textDocument/documentHighlight — highlights every occurrence of the symbol under the caret in this document (the read-only sibling of Find All References).</summary>
    private async Task<object?> DocumentHighlightAsync(TextDocumentPositionParams p)
    {
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc) || doc.Parsed.Root is not { } root)
        {
            return null;
        }

        var typeSystem = await GetTypeSystemAsync(p.TextDocument.Uri).ConfigureAwait(false);
        if (RequiresCompleteNameReferenceSemantics(
                doc,
                doc.OffsetAt(p.Position),
                typeSystem))
        {
            return null;
        }

        var occurrences = ResolveOccurrences(doc, root, doc.OffsetAt(p.Position), typeSystem);
        if (occurrences is null)
        {
            return null;
        }

        return occurrences
            .Select(o => new Lsp.DocumentHighlight { Range = o.Range, Kind = o.IsDeclaration ? 3 : 2 })
            .ToList();
    }

    /// <summary>Handles textDocument/prepareRename — confirms the caret sits on a renameable symbol (an x:Name/Name or an x:Key resource key) and returns the exact editable token range plus the</summary>
    private async Task<object?> PrepareRenameAsync(TextDocumentPositionParams p)
    {
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc))
        {
            return null;
        }

        var typeSystem = await GetTypeSystemAsync(p.TextDocument.Uri).ConfigureAwait(false);
        EnsureCompleteNameRenameSemantics(doc, p.Position, typeSystem);
        return XamlRename.PrepareRename(doc, doc.OffsetAt(p.Position), typeSystem);
    }

    /// <summary>Handles textDocument/rename — renames the x:Name/Name or x:Key resource key under the caret and every reference to it in the document, returning a single-document WorkspaceEdit.</summary>
    private async Task<object?> RenameAsync(RenameParams p)
    {
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc))
        {
            return null;
        }

        var typeSystem = await GetTypeSystemAsync(p.TextDocument.Uri).ConfigureAwait(false);
        EnsureCompleteNameRenameSemantics(doc, p.Position, typeSystem);
        return XamlRename.Rename(doc, doc.OffsetAt(p.Position), p.NewName, typeSystem);
    }

    private static void EnsureCompleteNameRenameSemantics(
        TextDocument doc,
        Position position,
        XamlTypeSystem? typeSystem)
    {
        int offset = doc.OffsetAt(position);
        if (RequiresCompleteNameReferenceSemantics(doc, offset, typeSystem))
        {
            throw new RequestFailedException(
                "Rename requires complete WinUI SDK metadata so every named-element reference can " +
                "be updated safely. Restore the project, reload the window, and use " +
                "'WinApp: Show Info' to check project resolution.");
        }
    }

    private static void EnsureCompleteNameReferenceSemantics(
        TextDocument doc,
        int offset,
        XamlTypeSystem? typeSystem,
        string operation)
    {
        if (RequiresCompleteNameReferenceSemantics(doc, offset, typeSystem))
        {
            throw new RequestFailedException(
                $"{operation} requires complete WinUI SDK metadata so every named-element reference " +
                "can be reported. Restore the project, reload the window, and use " +
                "'WinApp: Show Info' to check project resolution.");
        }
    }

    private static bool RequiresCompleteNameReferenceSemantics(
        TextDocument doc,
        int offset,
        XamlTypeSystem? typeSystem) =>
        typeSystem?.Capabilities.HasCompleteNameReferenceSemantics != true &&
        (FindNameDeclarationAt(doc, offset, null) is not null ||
         IsPotentialNameReferenceAt(doc, offset));

    /// <summary>Handles textDocument/formatting (Format Document) — returns leading-indentation edits that normalize every structural line to its element-nesting depth.</summary>
    private Task<object?> FormatDocumentAsync(DocumentFormattingParams p)
    {
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc))
        {
            return Task.FromResult<object?>(null);
        }

        return Task.FromResult<object?>(XamlFormatter.Format(doc, p.Options));
    }

    /// <summary>Handles textDocument/rangeFormatting (Format Selection) — the same reindentation as FormatDocumentAsync, but only edits lines intersecting the requested range.</summary>
    private Task<object?> FormatRangeAsync(DocumentRangeFormattingParams p)
    {
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc))
        {
            return Task.FromResult<object?>(null);
        }

        return Task.FromResult<object?>(XamlFormatter.Format(doc, p.Options, p.Range));
    }

    /// <summary>Handles textDocument/onTypeFormatting.</summary>
    private Task<object?> FormatOnTypeAsync(DocumentOnTypeFormattingParams p)
    {
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc))
        {
            return Task.FromResult<object?>(null);
        }

        return Task.FromResult<object?>(
            XamlFormatter.FormatOnType(doc, p.Options, p.Position, p.Character));
    }

    private Task<object?> FoldingRangeAsync(FoldingRangeParams p)
    {
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc))
        {
            return Task.FromResult<object?>(null);
        }

        return Task.FromResult<object?>(XamlFolding.Compute(doc));
    }

    private async Task<object?> DocumentColorAsync(DocumentColorParams p)
    {
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc))
        {
            return null;
        }

        var typeSystem = await GetTypeSystemAsync(p.TextDocument.Uri).ConfigureAwait(false);
        return typeSystem is null
            ? new List<ColorInformation>()
            : XamlColor.Collect(doc, typeSystem);
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

    /// <summary>Whole-document semantic tokens: a purely syntactic classification of every name in the parse tree (element types, members, prefixes, markup-extension names/args).</summary>
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

    /// <summary>Quick fixes (textDocument/codeAction).</summary>
    private async Task<object?> CodeActionAsync(CodeActionParams p)
    {
        _documents.TryGetValue(p.TextDocument.Uri, out var doc);
        var context = await GetContextAsync(p.TextDocument.Uri).ConfigureAwait(false);
        var typeSystem = context?.TypeSystem;
        var actions = XamlCodeActions.Compute(p.TextDocument.Uri, doc, p.Context, typeSystem);

        // Event-handler generation requires the resolved code-behind class.
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

    /// <summary>Builds the "Generate event handler 'X'" quick fix, or null when it doesn't apply.</summary>
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

        // Must be an unprefixed attribute with a plain-identifier value (a handler name — not a namespace declaration, markup extension, or dotted path).
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

        // The handler must be ABSENT from the code-behind. Roslyn merges partials into one symbol, so a member of that name anywhere (any partial, any kind) means we must NOT generate — a duplicate would fail to compile.
        if (FindMember(classSymbol, handlerName) != null)
        {
            return null;
        }

        // Signature from the event delegate's Invoke method (RoutedEventHandler → object sender, RoutedEventArgs e). Minimally-qualified argument types rely on the code-behind's WinUI usings — the Use the standard WinUI page handler form.
        if (evt.Type is not INamedTypeSymbol { DelegateInvokeMethod: { } invoke })
        {
            return null;
        }

        var edit = BuildHandlerInsertionEdit(uri, classSymbol, handlerName, BuildParameterList(invoke));
        if (edit == null || edit.Changes.Keys.SingleOrDefault() is not { } codeBehindUri)
        {
            return null;
        }

        return new CodeAction
        {
            Title = $"Generate event handler '{handlerName}'",
            Kind = "quickfix",
            IsPreferred = true,
            Edit = edit,
            Command = new Command
            {
                Title = "Save generated event handler",
                Name = "winui-xaml.saveGeneratedEventHandler",
                Arguments = new object[] { codeBehindUri },
            },
        };
    }

    /// <summary>Renders a delegate's parameters as a C# parameter list, minimally qualified.</summary>
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

    /// <summary>Builds the cross-file WorkspaceEdit that inserts a handler stub into the user code-behind, or null when no user partial can be found / read.</summary>
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

    /// <summary>True for a generated code-behind (<c>*.g.cs</c>/<c>*.g.i.cs</c>) or a build-output copy (any <c>obj</c>/<c>bin</c> path segment) — files we must never write a handler stub into.</summary>
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

    /// <summary>The leading whitespace run of the line containing offset, or null when non-whitespace precedes the offset on that line (so the caller can fall back to a default indent).</summary>
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

    /// <summary>Resolves ResourceDictionary Source="..." references to clickable file links.</summary>
    private Task<object?> DocumentLinkAsync(DocumentLinkParams p)
    {
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc))
        {
            return Task.FromResult<object?>(null);
        }

        var docPath = UriToPath(p.TextDocument.Uri);
        var documentDirectory = docPath == null ? null : System.IO.Path.GetDirectoryName(docPath);
        var projectPath = docPath != null && TryGetAllowedRoot(docPath, out var canonicalPath, out var allowedRoot)
            ? XamlProjectResolver.FindOwningProject(canonicalPath, allowedRoot)
            : null;
        var projectDirectory = projectPath == null ? null : System.IO.Path.GetDirectoryName(projectPath);

        return Task.FromResult<object?>(XamlDocumentLinks.Collect(doc, documentDirectory, projectDirectory));
    }

    /// <summary>Resolves the symbol under the caret — an x:Name (declaration or an ElementName=/ Storyboard.TargetName usage) or a resource key (an x:Key declaration or a</summary>
}
