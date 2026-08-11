using System.Text.Json;
using Microsoft.CodeAnalysis;
using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Workspace;
using WinUiXaml.Xaml;

namespace WinUiXaml.LanguageServer;

internal sealed partial class XamlLanguageServer
{
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
        var appKeys = GetAppResourceKeys(context.Resolution);
        return CompletionProvider.Provide(doc, offset, context.TypeSystem, context.Resolution.ClassSymbol, appKeys);
    }

    internal sealed record XamlProjectContext(XamlResolution Resolution, XamlTypeSystem TypeSystem);

    /// <summary> Collects the <c>x:Key</c> resource keys declared in the project's App.xaml and its reachable merged dictionaries. Returns an empty set when there is no App.xaml.</summary>
    private string[] GetAppResourceKeys(XamlResolution resolution)
    {
        try
        {
            var appXaml = FindAppXamlPath(resolution);
            if (appXaml == null)
            {
                return System.Array.Empty<string>();
            }

            var projectRoot = System.IO.Path.GetDirectoryName(resolution.ProjectPath)!;
            return ReadResourceGraph(appXaml, projectRoot)
                .SelectMany(file => file.Keys)
                .Distinct(System.StringComparer.Ordinal)
                .ToArray();
        }

        catch (System.Exception ex)
        {
            System.Console.Error.WriteLine($"[winui-xaml-ls] app resources: {ex.Message}");
            return System.Array.Empty<string>();
        }
    }

    private IReadOnlyList<XamlResourceGraph.ResourceFile> ReadResourceGraph(string rootPath, string projectRoot)
    {
        var canonicalProjectRoot = CanonicalizePath(projectRoot);
        return _resourceGraph.ReadReachable(
            rootPath,
            canonicalProjectRoot,
            path =>
            {
                if (!TryGetAllowedRoot(path, out var canonical, out _) ||
                    !string.Equals(System.IO.Path.GetExtension(canonical), ".xaml", StringComparison.OrdinalIgnoreCase) ||
                    !PathIsWithin(canonical, canonicalProjectRoot))
                {
                    return null;
                }

                return System.IO.File.Exists(canonical) || GetOpenDocumentText(canonical) is not null
                    ? canonical
                    : null;
            },
            message => System.Console.Error.WriteLine($"[winui-xaml-ls] {message}"),
            GetOpenDocumentText,
            _requestCancellation.Value);
    }

    private string? GetOpenDocumentText(string canonicalPath)
    {
        foreach (var document in _documents.Values)
        {
            var path = LspUri.ToPath(document.Uri);
            if (path is null)
            {
                continue;
            }

            try
            {
                if (string.Equals(CanonicalizePath(path), canonicalPath, StringComparison.OrdinalIgnoreCase))
                {
                    return document.Text;
                }
            }
            catch (Exception ex) when (ex is ArgumentException or System.IO.IOException or
                System.IO.PathTooLongException or UnauthorizedAccessException)
            {
                // Ignore an invalid or inaccessible open-document URI and continue with disk content.
            }
        }

        return null;
    }

    /// <summary> Returns the project's explicit <c>ApplicationDefinition</c>, falling back to conventional <c>App.xaml</c> beside the project for SDK-default item inclusion.</summary>
    private string? FindAppXamlPath(XamlResolution resolution)
    {
        var dir = System.IO.Path.GetDirectoryName(resolution.ProjectPath);
        if (string.IsNullOrEmpty(dir))
        {
            return null;
        }

        if (resolution.ApplicationDefinitionPath is { } evaluated &&
            System.IO.File.Exists(evaluated) &&
            TryGetAllowedRoot(evaluated, out var canonicalApplication, out _))
        {
            return canonicalApplication;
        }

        var appXaml = System.IO.Path.Combine(dir, "App.xaml");
        return System.IO.File.Exists(appXaml) &&
            TryGetAllowedRoot(appXaml, out var canonicalFallback, out _)
            ? canonicalFallback
            : null;
    }

    /// <summary>Resolves the document's project and returns a (cached) type-system provider for its compilation.</summary>
    private async Task<XamlTypeSystem?> GetTypeSystemAsync(string uri) =>
        (await GetContextAsync(uri).ConfigureAwait(false))?.TypeSystem;

    /// <summary> Resolves the document to its project <see cref="XamlResolution"/> (for the x:Class symbol) plus the cached <see cref="XamlTypeSystem"/> for its compilation.</summary>
    private async Task<XamlProjectContext?> GetContextAsync(string uri)
    {
        var task = GetOrStartContext(uri);
        return await task.WaitAsync(_requestCancellation.Value).ConfigureAwait(false);
    }

    private Task<XamlProjectContext?> GetOrStartContext(string uri) =>
        _contexts.GetOrStart(uri, () => LoadContextAsync(uri));

    private bool TryGetReadyContext(
        string uri,
        out XamlProjectContext context)
    {
        return _contexts.TryGetReady(uri, out context!);
    }

    private bool TryGetReadyTypeSystem(string uri, out XamlTypeSystem typeSystem)
    {
        if (TryGetReadyContext(uri, out var context))
        {
            typeSystem = context.TypeSystem;
            return true;
        }

        typeSystem = null!;
        return false;
    }

    private async Task<XamlProjectContext?> LoadContextAsync(string uri)
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
            var xamlText = _documents.TryGetValue(uri, out var document) ? document.Text : null;
            resolution = await ResolveIfAllowedAsync(path, CancellationToken.None, xamlText).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (MsBuildUnavailableException ex)
        {
            await NotifyMsBuildUnavailableAsync(ex).ConfigureAwait(false);
            return null;
        }
        catch (ProjectRestoreRequiredException ex)
        {
            await NotifyProjectRestoreRequiredAsync(ex).ConfigureAwait(false);
            return null;
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
        return new XamlProjectContext(resolution, typeSystem);
    }

    /// <summary>Shared pipeline for definition/hover: map the caret to a member name on the page's x:Class type (either an event-handler attribute value or an x:Bind path segment) and resolve it</summary>
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

        var context = await GetContextAsync(p.TextDocument.Uri).ConfigureAwait(false);
        var classSymbol = context?.Resolution.ClassSymbol;
        if (classSymbol == null)
        {
            return (null, target);
        }

        // Inside a DataTemplate the x:Bind root is the template's x:DataType, not the page's x:Class.
        var rootType = await ResolveBindRootTypeAsync(doc, offset, p.TextDocument.Uri).ConfigureAwait(false) ?? classSymbol;

        // Walk any dotted path segments typed before the caret one so the caret segment resolves against the correct type.
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

    private Task NotifyMsBuildUnavailableAsync(MsBuildUnavailableException exception)
    {
        Console.Error.WriteLine($"[winui-xaml-ls] {exception.Message}");
        return Interlocked.Exchange(ref _msbuildUnavailableNotified, 1) == 0
            ? _connection.SendNotificationAsync(
                "window/showMessage",
                new
                {
                    type = 2,
                    message = exception.Message +
                        " The language server remains available for project-independent XAML features.",
                })
            : Task.CompletedTask;
    }

    private Task NotifyProjectRestoreRequiredAsync(ProjectRestoreRequiredException exception)
    {
        Console.Error.WriteLine($"[winui-xaml-ls] restore required: {exception.ProjectPath}");
        return _restoreRequiredProjects.TryAdd(exception.ProjectPath, 0)
            ? _connection.SendNotificationAsync(
                "winui-xaml/projectRestoreRequired",
                new { projectPath = exception.ProjectPath })
            : Task.CompletedTask;
    }

    /// <summary>The named type a member evaluates to (a property/field's type or a method's return type), or null.</summary>
    private static INamedTypeSymbol? MemberResultType(ISymbol? member) => member switch
    {
        IPropertySymbol p => p.Type as INamedTypeSymbol,
        IFieldSymbol f => f.Type as INamedTypeSymbol,
        IMethodSymbol m => m.ReturnType as INamedTypeSymbol,
        _ => null,
    };

    /// <summary>Resolves one preceding {x:Bind} path segment to the type it evaluates to, unwrapping the collection element type once per trailing [...] indexer group (so Items[0] on an</summary>
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

    /// <summary>Splits an x:Bind path segment into its member name and the number of trailing <c>[...]</c> indexer groups.</summary>
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

    /// <summary>Returns the type an {x:Bind} path binds against at offset: the nearest enclosing DataTemplate's x:DataType</summary>
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

    /// <summary>Maps a caret offset to a member name on the x:Class type.</summary>
    private static MemberTarget? FindMemberTargetAt(TextDocument doc, int offset)
    {
        var node = doc.Parsed.FindNode(offset);
        for (var current = node; current != null; current = current.Parent)
        {
            switch (current)
            {
                case XamlMarkupExtensionArgument arg:
                {
                    // The bindable path of an {x:Bind ...} expression: either the first positional argument ({x:Bind Greeting}) or the value of a named "Path=" argument ({x:Bind Path=Greeting}). Other named arguments (Mode=, Converter=) are not paths.
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

                    // A Storyboard.TargetProperty value is an animation target-property path resolved against the target element (see ResolveVsmTargetMemberAsync), never a member of the page's x:Class.
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

    /// <summary>Returns the dotted path segment under offset in an x:Bind path.</summary>
    private static MemberTarget? PathSegmentAt(string rawValue, TextSpan valueSpan, int offset)
    {
        // A leading '!' negates the bound boolean path ({x:Bind !IsEnabled}); the path itself starts after it, so skip the '!' before locating the caret segment.
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

        // A leading '(' is a C#-style cast ((local:Type)Member) or an attached-property step ((Grid.Row)) — never a function binding (whose method name precedes its '(').
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

        // A function binding (Method(a, b.C)). If the caret sits inside the argument list, resolve the identifier path under it; otherwise the path is just the method name before the '('.
        int paren = rawValue.IndexOf('(');
        if (paren >= 0 && rel > paren)
        {
            return ArgumentSegmentAt(rawValue, valueSpan, offset, paren);
        }

        string path = paren >= 0 ? rawValue.Substring(0, paren) : rawValue;
        return DottedSegmentAt(path, valueSpan.Start, offset);
    }

    /// <summary>Resolves the dotted path segment under offset within path, whose first character is at absolute pathAbsStart.</summary>
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

    /// <summary>Resolves the identifier path under the caret inside a function-binding argument list ({x:Bind Method(GreetingText)}) so F12/hover work on the argument member.</summary>
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

        /// <summary>A leading x:Bind cast type.</summary>
        public string? CastType { get; init; } = null;
    }

    /// <summary>An x:Bind attached-property path step ((Grid.Row)): the owner type name, the member (attached property) name, the namespace scope that resolves the owner, and the hover span.</summary>
    private readonly record struct BindAttachedHit(string Owner, string Member, XamlNamespaceScope Scope, TextSpan Span);

    /// <summary>An <c>x:Key</c> resource declaration: the resource element's type name and nav span.</summary>
    private readonly record struct ResourceDeclaration(string TypeName, TextSpan NavSpan);

    /// <summary>A resolved named-element reference: the referenced x:Name, the range of the reference in the current document (for hover), the declaration location (for F12)</summary>
    private readonly record struct NameReferenceHit(
        string Name,
        Lsp.Range ReferenceRange,
        Lsp.Location Declaration,
        string TypeName);

    /// <summary>A resolved resource-key reference: the key, the range of the reference in the current document (for hover), the declaration location (for F12), the resource element's type name</summary>
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

        // Only warm up (which triggers project discovery + MSBuild evaluation) for documents under a trusted workspace root. Out-of-root / empty-window files are served project-less.
        if (!TryGetAllowedRoot(path, out var canonicalPath, out var allowedRoot))
        {
            return;
        }

        // Cache the complete context, not just the workspace, so all later features share one
        // compilation and type system. A short delay gives immediate editor requests priority.
        _ = Task.Run(async () =>
        {
            await Task.Delay(500).ConfigureAwait(false);
            if (_documents.ContainsKey(uri))
            {
                await GetOrStartContext(uri).ConfigureAwait(false);
            }
        });
    }

    // --- Helpers ------------------------------------------------------------

    /// <summary>Returns the resource key referenced by the {StaticResource}/{ThemeResource}/ {CustomResource} markup extension whose innermost span contains the caret (with the span of the key</summary>
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
                // Match the value token itself, not the argument's trailing whitespace, so a caret parked after the key ("{StaticResource Brush1 |}") does not resolve to the key.
                var valueSpan = argument.ValueSpan ?? argument.Span;
                if (valueSpan.ContainsInclusive(offset))
                {
                    return (key, valueSpan);
                }
            }
        }

        return null;
    }

    /// <summary>Finds the element carrying x:Key="key" anywhere in the parsed document and returns its element type name plus the span to navigate to (the type-name span</summary>
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
                // Navigate to (and select) the x:Key value itself, so F12 lands on "Key" rather than the resource element's type name -- matching how Visual Studio highlights the key.
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

    /// <summary>Nearest <see cref="XamlElement"/> enclosing <paramref name="offset"/> (the element that owns the attribute/markup extension under the caret), or null.</summary>
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

    /// <summary>Resolves an x:Key resource declaration in LEXICAL SCOPE: walks up from reference and, at each enclosing element, searches only that element's own &lt;Owner.Resources&gt</summary>
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

    /// <summary>Converts a character offset into a zero-based LSP line/character position by scanning the text.</summary>
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
