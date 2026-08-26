using Microsoft.CodeAnalysis;
using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Workspace;
using WinUiXaml.Xaml;

namespace WinUiXaml.LanguageServer;

internal sealed partial class XamlLanguageServer
{
    internal static List<(Lsp.Range Range, bool IsDeclaration)>? ResolveOccurrences(
        TextDocument doc,
        XamlElement root,
        int offset,
        XamlTypeSystem? typeSystem = null,
        XamlSemanticFacts.ResourceScopeIndex? resourceIndex = null)
    {
        // Malformed, still-being-typed markup: stay silent when the caret sits inside an unterminated extension (self or an enclosing one).
        if (IsInsideUnterminatedExtension(root, offset))
        {
            return null;
        }

        if (DetectSymbolAt(doc, offset, typeSystem) is not { } symbol)
        {
            return null;
        }

        var occurrences = new List<(Lsp.Range Range, bool IsDeclaration)>();
        if (symbol.Kind == XamlRenameKind.Name)
        {
            if (typeSystem is null)
            {
                CollectNameOccurrences(root, symbol.Name, doc, null, occurrences, recurse: true);
            }
            else
            {
                var context = doc.Parsed.FindNode(offset);
                foreach (var element in XamlSemanticFacts.EnumerateElementsInNameScope(
                    doc,
                    context,
                    typeSystem))
                {
                    CollectNameOccurrences(
                        element,
                        symbol.Name,
                        doc,
                        typeSystem,
                        occurrences,
                        recurse: false);
                }
            }
        }
        else
        {
            resourceIndex ??= XamlSemanticFacts.CreateResourceIndex(root, typeSystem);
            var targetDeclaration = FindResourceDeclarationAt(doc, offset);
            if (targetDeclaration is null &&
                FindResourceKeyReferenceAt(doc, offset) is { } reference)
            {
                targetDeclaration = FindResourceDeclarationForReference(
                    doc,
                    reference.Span.Start,
                    symbol.Name,
                    resourceIndex);
                if (targetDeclaration is null)
                {
                    CollectResourceOccurrences(
                        root,
                        symbol.Name,
                        doc,
                        occurrences,
                        onlyUnresolvedReferences: true,
                        resourceIndex: resourceIndex);
                    return DedupeAndSort(occurrences);
                }
            }
            if (targetDeclaration is null)
            {
                return null;
            }

            CollectResourceOccurrences(
                root,
                symbol.Name,
                doc,
                occurrences,
                targetDeclaration,
                resourceIndex: resourceIndex);
        }

        return DedupeAndSort(occurrences);
    }

    /// <summary>Classifies the renameable/referenceable symbol the caret sits on: an x:Name/Name (whether the caret is on the declaration or a usage) or an x:Key resource key.</summary>
    internal static (XamlRenameKind Kind, string Name)? DetectSymbolAt(
        TextDocument doc,
        int offset,
        XamlTypeSystem? typeSystem = null)
    {
        // x:Name: the caret is on a usage (ElementName=/Storyboard.TargetName) or on the declaration itself.
        var reference = FindNameReferenceAt(doc, offset, typeSystem);
        var name = reference?.Name ?? FindNameDeclarationAt(doc, offset, typeSystem);
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

    /// <summary>True when the caret sits inside a markup extension that is not closed (or whose enclosing extension is not closed).</summary>
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

    /// <summary>The x:Name/bare Name literal the caret sits inside (the declaration), or null.</summary>
    private static string? FindNameDeclarationAt(
        TextDocument doc,
        int offset,
        XamlTypeSystem? typeSystem) =>
        DeclarationValueAt(doc, offset, (attribute, owner) =>
            typeSystem is null
                ? XamlSemanticFacts.IsXamlDirective(attribute, "Name", owner.NamespaceScope) ||
                    !attribute.Name.HasPrefix &&
                    string.Equals(attribute.Name.LocalName, "Name", StringComparison.Ordinal)
                : ReferenceEquals(
                    XamlSemanticFacts.GetNameAttribute(owner, typeSystem),
                    attribute));

    /// <summary>The XAML key-directive literal the caret sits inside (the declaration), or null.</summary>
    private static string? FindKeyDeclarationAt(TextDocument doc, int offset) =>
        DeclarationValueAt(doc, offset, static (attribute, owner) =>
            XamlSemanticFacts.IsXamlDirective(attribute, "Key", owner.NamespaceScope));

    private static XamlElement? FindResourceDeclarationAt(TextDocument doc, int offset)
    {
        for (var current = doc.Parsed.FindNode(offset); current is not null; current = current.Parent)
        {
            if (current is XamlAttribute attribute &&
                attribute.Value is { IsMarkupExtension: false } value &&
                value.InnerSpan.ContainsInclusive(offset) &&
                attribute.Parent is XamlElement owner &&
                XamlSemanticFacts.IsXamlDirective(attribute, "Key", owner.NamespaceScope))
            {
                return owner;
            }

            if (current is XamlElement)
            {
                break;
            }
        }

        return null;
    }

    private static XamlElement? FindResourceDeclarationForReference(
        TextDocument doc,
        int referenceOffset,
        string key,
        XamlSemanticFacts.ResourceScopeIndex resourceIndex) =>
        NearestEnclosingElement(doc, referenceOffset) is { } referenceElement
            ? XamlSemanticFacts.FindResourceDeclarationInScope(
                resourceIndex,
                referenceElement,
                key)
            : null;

    /// <summary>The trimmed value of a non-markup attribute whose name matches nameMatches and whose value literal contains the caret — used to start a reference search from the declaration.</summary>
    private static string? DeclarationValueAt(
        TextDocument doc,
        int offset,
        Func<XamlAttribute, XamlElement, bool> attributeMatches)
    {
        for (var current = doc.Parsed.FindNode(offset); current != null; current = current.Parent)
        {
            if (current is XamlAttribute attr && !attr.IsNamespaceDeclaration &&
                attr.Value is { IsMarkupExtension: false } value && value.InnerSpan.ContainsInclusive(offset) &&
                attr.Parent is XamlElement owner &&
                attributeMatches(attr, owner))
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

    /// <summary>The span of an attribute value's inner text with surrounding whitespace stripped</summary>
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

    /// <summary>Collects, into results, the x:Name/bare Name declaration literal (flagged as declaration) plus every named-element usage of name in the subtree</summary>
    private static void CollectNameOccurrences(
        XamlElement element,
        string name,
        TextDocument doc,
        XamlTypeSystem? typeSystem,
        List<(Lsp.Range Range, bool IsDeclaration)> results,
        bool recurse)
    {
        var nameAttribute = typeSystem is null
            ? XamlSemanticFacts.GetNameAttribute(element)
            : XamlSemanticFacts.GetNameAttribute(element, typeSystem);
        if (nameAttribute is { Value: { IsMarkupExtension: false } declValue } &&
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
            if (attr.Value is { IsMarkupExtension: false } plain &&
                IsNameReferenceAttribute(attr, typeSystem) &&
                string.Equals(plain.Text.Trim(), name, StringComparison.Ordinal))
            {
                results.Add((doc.RangeOf(TrimmedValueSpan(plain)), false));
            }

            // VSM <Setter Target="Element.Property"> — only the element-name segment (before the first dot) names an x:Name'd element; the ".Property" tail is a member on that element.
            if (typeSystem is not null &&
                XamlSemanticFacts.IsSetter(element, typeSystem) &&
                !attr.Name.HasPrefix && string.Equals(attr.Name.LocalName, "Target", StringComparison.Ordinal) &&
                SetterTargetElementSpan(attr.Value) is { } target &&
                string.Equals(target.Element, name, StringComparison.Ordinal))
            {
                results.Add((doc.RangeOf(target.Span), false));
            }

            // {Binding ElementName=Foo}.
            if (attr.Value?.MarkupExtension is { } ext)
            {
                ForEachExtension(ext, e =>
                {
                    if (typeSystem is null ||
                        !XamlSemanticFacts.IsBindingMarkupExtension(e, element.NamespaceScope, typeSystem))
                    {
                        return;
                    }

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

        if (!recurse)
        {
            return;
        }

        foreach (var child in element.Content)
        {
            if (child is XamlElement childElement)
            {
                CollectNameOccurrences(childElement, name, doc, typeSystem, results, recurse: true);
            }
        }
    }

    /// <summary>Collects, into results, the x:Key declaration literal (flagged as declaration) plus every {StaticResource}/{ThemeResource}/{CustomResource} usage of key in the subtree (including</summary>
    private static void CollectResourceOccurrences(
        XamlElement element,
        string key,
        TextDocument doc,
        List<(Lsp.Range Range, bool IsDeclaration)> results,
        XamlElement? targetDeclaration = null,
        bool onlyUnresolvedReferences = false,
        XamlSemanticFacts.ResourceScopeIndex? resourceIndex = null)
    {
        if (XamlSemanticFacts.GetKeyAttribute(element) is { Value: { IsMarkupExtension: false } keyValue } &&
            string.Equals(keyValue.Text.Trim(), key, StringComparison.Ordinal) &&
            !onlyUnresolvedReferences &&
            (targetDeclaration is null || ReferenceEquals(element, targetDeclaration)))
        {
            results.Add((doc.RangeOf(TrimmedValueSpan(keyValue)), true));
        }

        foreach (var attr in element.Attributes)
        {
            if (attr.Value?.MarkupExtension is { } ext)
            {
                ForEachExtension(ext, e =>
                {
                    if (!XamlSemanticFacts.IsResourceReferenceExtension(
                        e,
                        element.NamespaceScope))
                    {
                        return;
                    }

                    foreach (var arg in e.Arguments)
                    {
                        if (!arg.IsNamed && arg.Value is { Length: > 0 } v &&
                            string.Equals(v.Trim(), key, StringComparison.Ordinal))
                        {
                            var resolvedDeclaration = resourceIndex is null
                                ? null
                                : XamlSemanticFacts.FindResourceDeclarationInScope(
                                    resourceIndex,
                                    element,
                                    key);
                            if ((onlyUnresolvedReferences && resolvedDeclaration is null) ||
                                (!onlyUnresolvedReferences &&
                                 (targetDeclaration is null ||
                                  ReferenceEquals(resolvedDeclaration, targetDeclaration))))
                            {
                                results.Add((doc.RangeOf(arg.ValueSpan ?? arg.Span), false));
                            }
                        }
                    }
                });
            }
        }

        foreach (var child in element.Content)
        {
            if (child is XamlElement childElement)
            {
                CollectResourceOccurrences(
                    childElement,
                    key,
                    doc,
                    results,
                    targetDeclaration,
                    onlyUnresolvedReferences,
                    resourceIndex);
            }
        }
    }

    /// <summary>Invokes action on extension and each nested extension, but prunes any unterminated (malformed / still-being-typed) extension subtree</summary>
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

    /// <summary>F12 on a {StaticResource Key} / {ThemeResource Key} / {CustomResource Key} value: navigates to the matching x:Key declaration in the current document</summary>
    private async Task<object?> ResolveResourceKeyDefinitionAsync(TextDocumentPositionParams p) =>
        (await ResolveResourceReferenceAsync(p).ConfigureAwait(false))?.Declaration;

    /// <summary>Hover over a resource-key reference: shows the referenced resource's element type and where it is declared (this file or App.xaml).</summary>
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

    /// <summary>Shared resolver for resource-key definition and hover: detects a resource reference under the caret</summary>
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

        // 1) The current document, resolved in lexical scope (nearest resource dictionary wins).
        var referenceElement = NearestEnclosingElement(doc, offset);
        var context = TryGetAcceptedContext(doc, out var acceptedContext)
            ? acceptedContext
            : await GetContextAsync(p.TextDocument.Uri).ConfigureAwait(false);
        var resourceIndex = doc.Parsed.Root is { } root
            ? XamlSemanticFacts.CreateResourceIndex(root, context?.TypeSystem)
            : null;
        var localElement = referenceElement is null
            ? null
            : resourceIndex is null
                ? null
                : XamlSemanticFacts.FindResourceDeclarationInScope(
                    resourceIndex,
                    referenceElement,
                    key);

        var local = localElement is null
            ? null
            : ToResourceDeclaration(localElement);
        if (local != null)
        {
            return new ResourceReferenceHit(
                key,
                referenceRange,
                new Lsp.Location { Uri = doc.Uri, Range = doc.RangeOf(local.Value.NavSpan) },
                local.Value.TypeName,
                "this file");
        }

        // 2) The project's App.xaml and every reachable merged ResourceDictionary.
        if (context == null)
        {
            return null;
        }

        var appXaml = FindAppXamlPath(context.Resolution);
        if (appXaml == null)
        {
            return null;
        }

        var projectRoot = System.IO.Path.GetDirectoryName(context.Resolution.ProjectPath)!;
        foreach (var resourceFile in ReadResourceGraph(appXaml, projectRoot, context.TypeSystem))
        {
            var declaration = resourceFile.Parsed.Root is { } resourceRoot
                ? ToResourceDeclaration(
                    XamlSemanticFacts.FindResourceDeclarationInScope(
                        XamlSemanticFacts.CreateResourceIndex(resourceRoot, context.TypeSystem),
                        resourceRoot,
                        key))
                : null;
            if (declaration is null)
            {
                continue;
            }

            return new ResourceReferenceHit(
                key,
                referenceRange,
                new Lsp.Location
                {
                    Uri = PathToUri(resourceFile.Path),
                    Range = SpanToRange(resourceFile.Text, declaration.Value.NavSpan),
                },
                declaration.Value.TypeName,
                System.IO.Path.GetFileName(resourceFile.Path));
        }

        return null;
    }

    private static ResourceDeclaration? ToResourceDeclaration(XamlElement? element)
    {
        if (element is null ||
            XamlSemanticFacts.GetKeyAttribute(element)?.Value is not { } value)
        {
            return null;
        }

        var typeName = element.Name is { LocalName.Length: > 0 } elementName
            ? elementName.FullName
            : string.Empty;
        return new ResourceDeclaration(typeName, value.InnerSpan);
    }

    // --- Named-element references (ElementName / Storyboard.TargetName) ------

    /// <summary>F12/hover shared resolver for a named-element reference under the caret: a classic {Binding ElementName=Foo} argument or a Storyboard.TargetName="Foo" attribute value.</summary>
    private async Task<NameReferenceHit?> ResolveNameReferenceAsync(
        TextDocumentPositionParams p,
        bool waitForTypeSystem = false)
    {
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc) || doc.Parsed.Root is null)
        {
            return null;
        }

        int offset = doc.OffsetAt(p.Position);
        XamlTypeSystem? typeSystem;
        if (!TryGetReadyTypeSystem(p.TextDocument.Uri, out var readyTypeSystem))
        {
            typeSystem = waitForTypeSystem
                ? (await GetContextAsync(p.TextDocument.Uri).ConfigureAwait(false))?.TypeSystem
                : null;
        }
        else
        {
            typeSystem = readyTypeSystem;
        }

        if (typeSystem is null)
        {
            return null;
        }

        var reference = FindNameReferenceAt(doc, offset, typeSystem);
        if (reference == null)
        {
            return null;
        }

        var (name, referenceSpan) = reference.Value;
        var declarationElement = XamlSemanticFacts.FindNamedElementInScope(
            doc,
            doc.Parsed.FindNode(referenceSpan.Start),
            name,
            typeSystem);
        var declaration = declarationElement is null
            ? null
            : FindNameDeclaration(declarationElement, typeSystem);
        if (declaration is null)
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

    /// <summary>Detects a named-element reference at offset: the value of a {Binding (or other) ElementName= named argument, or a Storyboard.TargetName="..." attribute value.</summary>
    private static (string Name, TextSpan Span)? FindNameReferenceAt(
        TextDocument doc,
        int offset,
        XamlTypeSystem? typeSystem = null)
    {
        if (doc.Parsed.Root is not { } root)
        {
            return null;
        }

        // 1) A Binding ElementName argument.
        var extension = InnermostMarkupExtensionAt(root, offset);
        if (extension is not null &&
            typeSystem is not null &&
            NearestEnclosingElement(doc, offset) is { } extensionElement &&
            XamlSemanticFacts.IsBindingMarkupExtension(
                extension,
                extensionElement.NamespaceScope,
                typeSystem))
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
                IsNameReferenceAttribute(attr, typeSystem))
            {
                var text = value.Text.Trim();
                return text.Length > 0 ? (text, value.InnerSpan) : ((string, TextSpan)?)null;
            }

            // A VSM <Setter Target="Element.Property"> value: only the element-name segment (before the first dot) is a name reference; a caret in the ".Property" tail falls through (not a name).
            if (current is XamlAttribute setterAttr &&
                typeSystem is not null &&
                setterAttr.Parent is XamlElement setter &&
                XamlSemanticFacts.IsSetter(setter, typeSystem) &&
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

    private static bool IsPotentialNameReferenceAt(TextDocument doc, int offset)
    {
        if (doc.Parsed.Root is not { } root)
        {
            return false;
        }

        var extension = InnermostMarkupExtensionAt(root, offset);
        if (extension is not null)
        {
            foreach (var argument in extension.Arguments)
            {
                if (argument.IsNamed &&
                    string.Equals(argument.Name?.LocalName, "ElementName", StringComparison.Ordinal) &&
                    argument.ValueSpan is { } valueSpan &&
                    valueSpan.ContainsInclusive(offset))
                {
                    return true;
                }
            }
        }

        for (var current = doc.Parsed.FindNode(offset); current != null; current = current.Parent)
        {
            if (current is XamlAttribute attribute &&
                !attribute.IsNamespaceDeclaration &&
                attribute.Value is { IsMarkupExtension: false } value &&
                value.Span.ContainsInclusive(offset))
            {
                if (attribute.Name.IsDotted && value.Text.Trim().Length > 0)
                {
                    return true;
                }

                if (string.Equals(attribute.Name.LocalName, "Target", StringComparison.Ordinal) &&
                    SetterTargetElementSpan(value) is { } target &&
                    target.Span.ContainsInclusive(offset))
                {
                    return true;
                }
            }

            if (current is XamlElement)
            {
                break;
            }
        }

        return false;
    }

    /// <summary>The element-name segment of a VSM &lt;Setter Target="Element.Property"&gt; value — the token before the first dot with surrounding whitespace stripped — plus its span</summary>
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

    /// <summary>True when a bare attribute value is an element x:Name reference rather than a CLR member or type.</summary>
    private static bool IsNameReferenceAttribute(XamlAttribute attribute, XamlTypeSystem? typeSystem)
    {
        var name = attribute.Name;

        if (typeSystem is not null &&
            attribute.Parent is XamlElement storyboardOwner &&
            XamlSemanticFacts.IsStoryboardAttachedProperty(
                name.FullName,
                "TargetName",
                storyboardOwner.NamespaceScope,
                typeSystem))
        {
            return true;
        }

        return typeSystem is not null &&
            attribute.Parent is XamlElement element &&
            XamlSemanticFacts.IsRelativePanelElementReferenceAttribute(
                name.FullName,
                element.NamespaceScope,
                typeSystem);
    }

    private static (string TypeName, TextSpan NavSpan)? FindNameDeclaration(
        XamlElement element,
        XamlTypeSystem typeSystem)
    {
        var attribute = XamlSemanticFacts.GetNameAttribute(element, typeSystem);
        return attribute?.Value is { IsMarkupExtension: false } value
            ? (element.Name?.FullName ?? string.Empty, value.InnerSpan)
            : null;
    }

    // --- Attached-property hover --------------------------------------------

    /// <summary>Hover for an attached property referenced by an attribute name (Grid.Row="1") or by a &lt;Setter Property="Grid.Row"&gt; value.</summary>
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
            attr.Parent is not XamlElement ownerElement)
        {
            return null;
        }

        var typeSystem = await GetTypeSystemAsync(p.TextDocument.Uri).ConfigureAwait(false);
        if (typeSystem == null)
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
                 XamlSemanticFacts.IsSetter(ownerElement, typeSystem) &&
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

        var ownerType = XamlSemanticFacts.ResolveTypeName(
            ownerName,
            ownerElement.NamespaceScope,
            typeSystem);
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
                Value = HoverMarkdown(
                    $"(attached property) {valueType} {ownerType.Name}.{attached.Name}",
                    attached.Symbol,
                    methodDetails: false,
                    typeSystem: typeSystem),
            },
            Range = doc.RangeOf(hoverSpan),
        };
    }

    /// <summary>Hover for an x:Bind attached-property path step ({x:Bind (Grid.Row)}): resolves the parenthesized Owner.Member to an attached property on the owner type and renders it exactly</summary>
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

        var ownerType = XamlSemanticFacts.ResolveTypeName(
            hit.Owner,
            hit.Scope,
            typeSystem);
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
                Value = HoverMarkdown(
                    $"(attached property) {valueType} {ownerType.Name}.{attached.Name}",
                    attached.Symbol,
                    methodDetails: false,
                    typeSystem: typeSystem),
            },
            Range = doc.RangeOf(hit.Span),
        };
    }

    /// <summary>Locates an x:Bind attached-property path step ((Owner.Member)) under offset: the caret must sit inside the parentheses of the first positional (or Path=) argument of an {x:Bind}</summary>
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

            // The caret must sit on the Member portion (after the dot) -- hovering the Owner type or the dot itself is not the attached property, so it must not render the attached-property hover.
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

}
