using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Workspace;
using WinUiXaml.Xaml;

namespace WinUiXaml.LanguageServer;

internal static partial class CompletionProvider
{
    // --- Element name -----------------------------------------------------------------------------

    private static CompletionList CompleteElementName(
        TextDocument doc, Context ctx, XamlNamespaceScope scope, XamlTypeSystem typeSystem, Lsp.Range replaceRange, ITypeSymbol? contentType = null)
    {
        SplitQualified(ctx.Partial, out var prefix, out var local);
        if (!scope.TryResolvePrefix(prefix, out var uri))
        {
            return new CompletionList();
        }

        int propertySeparator = local.IndexOf('.');
        if (propertySeparator >= 0)
        {
            return CompletePropertyElementName(
                doc,
                ctx,
                prefix,
                local,
                propertySeparator,
                uri,
                scope,
                typeSystem);
        }

        var items = new List<CompletionItem>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var type in typeSystem.GetTypes(uri))
        {
            if (!StartsWith(type.Name, local) || !seen.Add(type.Name))
            {
                continue;
            }

            // Collection property elements accept only assignable child types.
            if (contentType is not null && !XamlTypeSystem.IsAssignableTo(type, contentType))
            {
                continue;
            }

            var insert = prefix.Length > 0 ? prefix + ":" + type.Name : type.Name;
            items.Add(new CompletionItem
            {
                Label = type.Name,
                Kind = CompletionItemKind.Class,
                Documentation = CompletionDoc(type),
                Detail = type.ContainingNamespace?.ToDisplayString(),
                TextEdit = new TextEdit { Range = replaceRange, NewText = insert },
                FilterText = type.Name,
                SortText = type.Name,
            });
        }

        // Intrinsic aliases are language-defined and absent from CLR namespace bindings.
        if (string.Equals(uri, XamlTypeSystem.XamlLanguageNamespace, StringComparison.Ordinal))
        {
            foreach (var intrinsic in typeSystem.GetXamlIntrinsicTypes(allTypeKinds: true))
            {
                var alias = intrinsic.Key;
                if (!StartsWith(alias, local) || !seen.Add(alias))
                {
                    continue;
                }

                if (contentType is not null && !XamlTypeSystem.IsAssignableTo(intrinsic.Value, contentType))
                {
                    continue;
                }

                var aliasInsert = prefix.Length > 0 ? prefix + ":" + alias : alias;
                items.Add(new CompletionItem
                {
                    Label = alias,
                    Kind = TypeCompletionKind(intrinsic.Value),
                    Documentation = CompletionDoc(intrinsic.Value),
                    Detail = intrinsic.Value.ContainingNamespace?.ToDisplayString(),
                    TextEdit = new TextEdit { Range = replaceRange, NewText = aliasInsert },
                    FilterText = alias,
                    SortText = alias,
                });
            }
        }

        // Unprefixed referenced controls require an injected xmlns declaration.
        if (prefix.Length == 0)
        {
            AddReferencedElementTypes(doc, items, seen, local, scope, typeSystem, replaceRange, contentType);
        }

        return Finish(items);
    }

    private static CompletionList CompletePropertyElementName(
        TextDocument doc,
        Context ctx,
        string prefix,
        string local,
        int separator,
        string uri,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem)
    {
        if (separator == 0 || local.IndexOf('.', separator + 1) >= 0)
        {
            return new CompletionList();
        }

        var ownerName = local.Substring(0, separator);
        var propertyPartial = local.Substring(separator + 1);
        var ownerType = typeSystem.ResolveType(uri, ownerName);
        if (ownerType is null)
        {
            return new CompletionList();
        }

        var enclosingType = ResolveEnclosingElementType(doc, ctx, scope, typeSystem);
        if (enclosingType is not null && !XamlTypeSystem.IsAssignableTo(enclosingType, ownerType))
        {
            return new CompletionList();
        }

        var qualifiedOwner = prefix.Length > 0 ? prefix + ":" + ownerName : ownerName;
        var propertyReplaceRange = doc.RangeOf(
            new TextSpan(ctx.ReplaceStart + qualifiedOwner.Length + 1, ctx.ReplaceStart + ctx.Partial.Length));
        var items = new List<CompletionItem>();
        foreach (var member in typeSystem.GetPropertyElementMembers(ownerType))
        {
            if (!StartsWith(member.Name, propertyPartial))
            {
                continue;
            }

            items.Add(new CompletionItem
            {
                Label = member.Name,
                Kind = CompletionItemKind.Property,
                Documentation = CompletionDoc(member.Symbol),
                Detail = member.Type is null
                    ? $"{ownerName} property element"
                    : $"{ownerName} property element : {member.Type.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)}",
                TextEdit = new TextEdit
                {
                    Range = propertyReplaceRange,
                    NewText = member.Name,
                },
                FilterText = member.Name,
                SortText = member.Name,
            });
        }

        return Finish(items);
    }

    private static INamedTypeSymbol? ResolveEnclosingElementType(
        TextDocument doc,
        Context ctx,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem)
    {
        int ltIndex = ctx.ReplaceStart - 1;
        for (var node = doc.Parsed.FindNode(Math.Max(0, ltIndex - 1)); node != null; node = node.Parent)
        {
            if (node is not XamlElement { Name: not null } element)
            {
                continue;
            }

            if (!scope.TryResolvePrefix(element.Name.Prefix, out var enclosingUri))
            {
                return null;
            }

            return typeSystem.ResolveType(enclosingUri, element.Name.LocalName);
        }

        return null;
    }

    /// <summary>Adds third-party (referenced-assembly) element types to an UNPREFIXED element-name completion list</summary>
    private static void AddReferencedElementTypes(
        TextDocument doc, List<CompletionItem> items, HashSet<string> seen, string local,
        XamlNamespaceScope scope, XamlTypeSystem typeSystem, Lsp.Range replaceRange, ITypeSymbol? contentType)
    {
        var candidates = typeSystem.GetReferencedElementTypes();
        if (candidates.Count == 0)
        {
            return;
        }

        // Namespaces reachable through the DEFAULT xmlns (WinUI's own types) — offered unprefixed already, so excluded here. A candidate in one of these is a framework type, not a third-party control.
        var defaultReachable = new HashSet<string>(StringComparer.Ordinal);
        if (scope.TryResolvePrefix(string.Empty, out var defaultUri))
        {
            foreach (var clrNs in typeSystem.ClrNamespacesForUri(defaultUri))
            {
                defaultReachable.Add(clrNs);
            }
        }

        foreach (var type in candidates)
        {
            if (!StartsWith(type.Name, local) || seen.Contains(type.Name))
            {
                continue;
            }

            if (contentType is not null && !XamlTypeSystem.IsAssignableTo(type, contentType))
            {
                continue;
            }

            var clrNamespace = type.ContainingNamespace?.ToDisplayString();
            if (string.IsNullOrEmpty(clrNamespace) || defaultReachable.Contains(clrNamespace!))
            {
                continue;
            }

            if (!XamlNamespaceImport.TryPlan(
                    doc, scope, typeSystem, clrNamespace!, out var itemPrefix, out var declarationEdit))
            {
                // No root element to anchor the xmlns to — offering the type would produce an undeclared prefix.
                continue;
            }

            var additionalEdits = declarationEdit is null ? null : new List<TextEdit> { declarationEdit };
            seen.Add(type.Name);
            var newText = itemPrefix + ":" + type.Name;
            items.Add(new CompletionItem
            {
                Label = type.Name,
                Kind = CompletionItemKind.Class,
                Documentation = CompletionDoc(type),
                Detail = additionalEdits is null
                    ? clrNamespace
                    : $"{clrNamespace} (adds xmlns:{itemPrefix})",
                TextEdit = new TextEdit { Range = replaceRange, NewText = newText },
                AdditionalTextEdits = additionalEdits,
                FilterText = type.Name,
                SortText = "\uffff" + type.Name,
            });
        }
    }

    /// <summary>Completes an end tag (&lt;/…) with the name of the element it is closing, so typing &lt;/ inside an open &lt;Grid&gt; offers Grid and yields &lt;/Grid&gt</summary>
    private static CompletionList CompleteCloseTag(TextDocument doc, int offset, int nameStart, Lsp.Range replaceRange)
    {
        // The '<' that opened this end tag sits two chars before the name ("</").
        int lt = nameStart - 2;

        XamlElement? target = null;

        // Case 1: the caret is inside an end tag whose name already matches an open element, so the parser has attached an EndTagSpan starting exactly at this "</". Prefer that element — it is the one being closed here, even if an outer element remains unclosed.
        foreach (var node in doc.Parsed.DescendantNodesAndSelf())
        {
            if (node is XamlElement e && e.Name is not null &&
                e.EndTagSpan.HasValue && e.EndTagSpan.Value.Start == lt)
            {
                target = e;
                break;
            }
        }

        // Case 2: no matching end tag yet (empty/partial/mismatched name) — the parser left the element unclosed and absorbed the "</" into its span. Target the innermost such element at the caret.
        if (target is null)
        {
            foreach (var node in doc.Parsed.DescendantNodesAndSelf())
            {
                if (node is not XamlElement e || e.Name is null || e.IsClosed)
                {
                    continue;
                }

                // End inclusive: the caret sits at the edit point, which for the innermost unclosed element is exactly its span end (the parser absorbs the "</" into that span).
                if (offset < e.Span.Start || offset > e.Span.End)
                {
                    continue;
                }

                if (target is null || e.Span.Start > target.Span.Start)
                {
                    target = e;
                }
            }
        }

        if (target?.Name is null)
        {
            return new CompletionList();
        }

        string name = target.Name.FullName;
        // Append '>' only when the caret is not already immediately before one — VS Code's '<' auto-closing pair frequently leaves a ">" that typing "/" turns into "</>", and we should reuse it rather than produce "</Grid>>".
        bool hasClosingBracket = offset < doc.Text.Length && doc.Text[offset] == '>';
        string insert = hasClosingBracket ? name : name + ">";

        var item = new CompletionItem
        {
            Label = name,
            Kind = CompletionItemKind.Class,
            Detail = "Closing tag",
            TextEdit = new TextEdit { Range = replaceRange, NewText = insert },
            FilterText = name,
            SortText = name,
        };
        return Finish(new List<CompletionItem> { item });
    }

    /// <summary>When the caret is a child position (&lt;|) inside another element, resolves the type its children must be assignable to, limiting completion to valid child types</summary>
    private static ITypeSymbol? ResolveChildContentType(
        TextDocument doc, Context ctx, XamlNamespaceScope scope, XamlTypeSystem typeSystem)
    {
        int ltIndex = ctx.ReplaceStart - 1; // the '<' of the element being typed
        var node = doc.Parsed.FindNode(Math.Max(0, ltIndex - 1));
        XamlElement? enclosing = null;
        for (; node != null; node = node.Parent)
        {
            if (node is XamlElement { Name: not null } e)
            {
                enclosing = e;
                break;
            }
        }

        if (enclosing?.Name is null)
        {
            return null;
        }

        var contentType = enclosing.IsPropertyElement
            ? PropertyElementContentType(enclosing, typeSystem)
            : ObjectElementContentType(enclosing, scope, typeSystem);

        // Only scope when the type narrows the list to a concrete class. object / interfaces do not.
        if (contentType is null ||
            contentType.SpecialType == SpecialType.System_Object ||
            contentType.TypeKind != TypeKind.Class)
        {
            return null;
        }

        return contentType;
    }

    /// <summary>Content type accepted inside a property element (<c>&lt;Owner.Property&gt;</c>).</summary>
    private static ITypeSymbol? PropertyElementContentType(
        XamlElement propertyElement,
        XamlTypeSystem typeSystem)
    {
        var propertyType = XamlSemanticFacts.ResolvePropertyElementMember(propertyElement, typeSystem)?.PropertyType;
        return propertyType is null
            ? null
            : XamlTypeSystem.GetCollectionElementType(propertyType) ?? propertyType;
    }

    /// <summary>Content type accepted inside a plain object element, via its <c>[ContentProperty]</c>.</summary>
    private static ITypeSymbol? ObjectElementContentType(
        XamlElement element, XamlNamespaceScope scope, XamlTypeSystem typeSystem)
    {
        if (ResolveElementType(element.Name!, scope, typeSystem) is not INamedTypeSymbol elementType)
        {
            return null;
        }

        return typeSystem.GetContentPropertyType(elementType);
    }

    // --- Attribute name (properties / events / attached properties) --------------------------------

    private static CompletionList CompleteAttributeName(
        TextDocument doc,
        int offset,
        Context ctx,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem,
        Lsp.Range replaceRange)
    {
        var element = FindEnclosingElement(doc.Parsed.FindNode(Math.Max(0, offset - 1)))
            ?? FindStartTagElement(doc, offset);
        if (element?.Name is null)
        {
            return new CompletionList();
        }

        // Include quotes and replace the entire current name token.
        int nameEnd = AttributeNameTokenEnd(doc.Text, offset);
        bool appendValue = NextNonWhitespace(doc.Text, nameEnd) != '=';
        var nameReplaceRange = doc.RangeOf(new TextSpan(ctx.ReplaceStart, nameEnd));
        var elementType = ResolveElementType(element.Name, scope, typeSystem);
        if (elementType is null)
        {
            return new CompletionList();
        }

        var existing = new HashSet<string>(
            element.Attributes
                .Where(a => !a.IsNamespaceDeclaration && a.Name.LocalNameSpan.Start != ctx.ReplaceStart)
                .Select(a => a.Name.FullName),
            StringComparer.Ordinal);

        // "Owner.member" partial -> attached-property completion for the owner type.
        int dot = ctx.Partial.LastIndexOf('.');
        if (dot >= 0)
        {
            return CompleteAttachedProperty(
                ctx,
                dot,
                scope,
                elementType,
                existing,
                typeSystem,
                nameReplaceRange,
                appendValue);
        }

        int colon = ctx.Partial.IndexOf(':');
        if (colon > 0 &&
            scope.TryResolvePrefix(ctx.Partial.Substring(0, colon), out var attributeNamespace) &&
            !string.Equals(
                attributeNamespace,
                XamlTypeSystem.XamlLanguageNamespace,
                StringComparison.Ordinal))
        {
            return CompletePrefixedAttachedProperties(
                ctx.Partial.Substring(0, colon),
                ctx.Partial.Substring(colon + 1),
                attributeNamespace,
                elementType,
                existing,
                typeSystem,
                nameReplaceRange,
                appendValue);
        }
        var existingDirectives = new HashSet<string>(
            element.Attributes
                .Where(attribute =>
                    !attribute.IsNamespaceDeclaration &&
                    attribute.Name.LocalNameSpan.Start != ctx.ReplaceStart &&
                    attribute.Name.HasPrefix &&
                    scope.TryResolvePrefix(attribute.Name.Prefix, out var uri) &&
                    string.Equals(uri, XamlTypeSystem.XamlLanguageNamespace, StringComparison.Ordinal))
                .Select(attribute => attribute.Name.LocalName),
            StringComparer.Ordinal);

        var items = new List<CompletionItem>();
        foreach (var member in typeSystem.GetAttributeMembers(elementType))
        {
            if (!StartsWith(member.Name, ctx.Partial) || existing.Contains(member.Name))
            {
                continue;
            }

            items.Add(new CompletionItem
            {
                Label = member.Name,
                Kind = member.Kind == XamlMemberKind.Event ? CompletionItemKind.Event : CompletionItemKind.Property,
                Documentation = CompletionDoc(member.Symbol),
                Detail = DescribeMember(member),
                TextEdit = new TextEdit { Range = nameReplaceRange, NewText = appendValue ? member.Name + "=\"$0\"" : member.Name },
                InsertTextFormat = appendValue ? SnippetInsertFormat : null,
                Command = AttributeValueSuggestionCommand(member, typeSystem, appendValue),
                FilterText = member.Name,
                // Sort events after properties so the common case (properties) surfaces first.
                SortText = (member.Kind == XamlMemberKind.Event ? "1" : "0") + member.Name,
            });
        }

        AddXamlDirectives(
            items,
            existing,
            existingDirectives,
            ctx.Partial,
            element,
            scope,
            typeSystem,
            nameReplaceRange,
            appendValue);
        AddContainerAttachedProperties(items, element, existing, ctx.Partial, scope, typeSystem, nameReplaceRange, appendValue);
        AddAutomationProperties(items, existing, ctx.Partial, scope, typeSystem, nameReplaceRange, appendValue);

        return Finish(items);
    }

    private static XamlElement? FindStartTagElement(TextDocument doc, int offset)
    {
        int lt = doc.Text.LastIndexOf('<', Math.Max(0, offset - 1));
        if (lt < 0 || lt + 1 >= offset)
        {
            return null;
        }

        return doc.Parsed.DescendantNodesAndSelf()
            .OfType<XamlElement>()
            .Where(element => element.Name?.Span.Start == lt + 1)
            .OrderByDescending(element => element.Span.Start)
            .FirstOrDefault();
    }

    private static void AddXamlDirectives(
        List<CompletionItem> items,
        HashSet<string> existing,
        HashSet<string> existingDirectives,
        string partial,
        XamlElement element,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem,
        Lsp.Range replaceRange,
        bool appendValue)
    {
        var colon = partial.IndexOf(':');
        var typedPrefix = colon > 0 ? partial[..colon] : string.Empty;
        var xamlPrefix =
            typedPrefix.Length > 0 &&
            scope.TryResolvePrefix(typedPrefix, out var typedUri) &&
            string.Equals(typedUri, XamlTypeSystem.XamlLanguageNamespace, StringComparison.Ordinal)
                ? typedPrefix
                : scope.Declarations.FirstOrDefault(
                    declaration => string.Equals(
                        declaration.Value,
                        XamlTypeSystem.XamlLanguageNamespace,
                        StringComparison.Ordinal)).Key;
        if (string.IsNullOrEmpty(xamlPrefix))
        {
            return;
        }

        foreach (var (localName, description) in XamlDirectiveMetadata.AttributeDirectives)
        {
            if (existingDirectives.Contains(localName) ||
                !IsApplicableXamlDirective(localName, element, typeSystem))
            {
                continue;
            }

            AddSyntheticAttribute(
                items,
                existing,
                partial,
                xamlPrefix + ":" + localName,
                description,
                replaceRange,
                appendValue,
                "0");
        }
    }

    private static bool IsApplicableXamlDirective(
        string localName,
        XamlElement element,
        XamlTypeSystem typeSystem)
    {
        if (string.Equals(localName, "Class", StringComparison.Ordinal))
        {
            return element.Parent is not XamlElement;
        }

        if (string.Equals(localName, "Key", StringComparison.Ordinal))
        {
            return element.Parent is XamlElement parent &&
                (XamlSemanticFacts.IsResourceDictionaryPropertyElement(parent, typeSystem) ||
                 XamlSemanticFacts.IsResourceDictionary(parent, typeSystem));
        }

        if (string.Equals(localName, "Phase", StringComparison.Ordinal))
        {
            if (!element.Attributes.Any(attribute =>
                    XamlSemanticFacts.IsXBind(attribute, element.NamespaceScope)))
            {
                return false;
            }

            for (var current = element.Parent; current is not null; current = current.Parent)
            {
                if (current is XamlElement ancestor &&
                    XamlSemanticFacts.IsDataTemplate(ancestor, typeSystem))
                {
                    return true;
                }

            }

            return false;
        }

        if (localName is "FieldModifier" or "DeferLoadStrategy")
        {
            return XamlSemanticFacts.GetNameAttribute(element, typeSystem) is not null;
        }

        return true;
    }

    private static void AddAutomationProperties(
        List<CompletionItem> items,
        HashSet<string> existing,
        string partial,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem,
        Lsp.Range replaceRange,
        bool appendValue)
    {
        if (!scope.TryResolvePrefix(string.Empty, out var presentationUri))
        {
            return;
        }

        var owner = typeSystem.ResolveType(presentationUri, "AutomationProperties");
        if (owner is null)
        {
            return;
        }

        foreach (var member in typeSystem.GetAttachedProperties(owner))
        {
            var qualified = "AutomationProperties." + member.Name;
            if (existing.Contains(qualified) ||
                (!StartsWith(member.Name, partial) && !StartsWith(qualified, partial)))
            {
                continue;
            }

            items.Add(new CompletionItem
            {
                Label = qualified,
                Kind = CompletionItemKind.Property,
                Documentation = CompletionDoc(member.Symbol),
                Detail = "attached property" + (member.Type != null ? " : " + member.Type.ToDisplayString() : string.Empty),
                TextEdit = new TextEdit { Range = replaceRange, NewText = appendValue ? qualified + "=\"$0\"" : qualified },
                InsertTextFormat = appendValue ? SnippetInsertFormat : null,
                Command = AttributeValueSuggestionCommand(member, typeSystem, appendValue),
                FilterText = qualified,
                SortText = "2" + qualified,
            });
        }
    }

    private static void AddSyntheticAttribute(
        List<CompletionItem> items,
        HashSet<string> existing,
        string partial,
        string name,
        string detail,
        Lsp.Range replaceRange,
        bool appendValue,
        string sortGroup)
    {
        if (existing.Contains(name) || !StartsWith(name, partial))
        {
            return;
        }

        items.Add(new CompletionItem
        {
            Label = name,
            Kind = CompletionItemKind.Property,
            Detail = detail,
            TextEdit = new TextEdit { Range = replaceRange, NewText = appendValue ? name + "=\"$0\"" : name },
            InsertTextFormat = appendValue ? SnippetInsertFormat : null,
            FilterText = name,
            SortText = sortGroup + name,
        });
    }

    /// <summary>Also offers the nearest ancestor container's attached properties.</summary>
    private static void AddContainerAttachedProperties(
        List<CompletionItem> items,
        XamlElement element,
        HashSet<string> existing,
        string partial,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem,
        Lsp.Range replaceRange,
        bool appendValue)
    {
        var container = FindContainerElement(element);
        if (container?.Name is not { } containerName)
        {
            return;
        }

        var containerType = ResolveElementType(containerName, scope, typeSystem);
        if (containerType is null)
        {
            return;
        }

        var ownerPrefix = containerName.FullName; // "Grid" or "local:MyPanel"
        foreach (var member in typeSystem.GetAttachedProperties(containerType))
        {
            var qualified = ownerPrefix + "." + member.Name; // "Grid.Row"
            if (existing.Contains(qualified) ||
                (!StartsWith(member.Name, partial) && !StartsWith(qualified, partial)))
            {
                continue;
            }

            items.Add(new CompletionItem
            {
                Label = qualified,
                Kind = CompletionItemKind.Property,
                Documentation = CompletionDoc(member.Symbol),
                Detail = "attached property" + (member.Type != null ? " : " + member.Type.ToDisplayString() : string.Empty),
                TextEdit = new TextEdit { Range = replaceRange, NewText = appendValue ? qualified + "=\"$0\"" : qualified },
                InsertTextFormat = appendValue ? SnippetInsertFormat : null,
                Command = AttributeValueSuggestionCommand(member, typeSystem, appendValue),
                FilterText = qualified,
                // Rank after the element's own members (which use group "0"/"1").
                SortText = "2" + qualified,
            });
        }
    }

    /// <summary>The nearest ancestor OBJECT element of element (skipping property elements.</summary>
    private static XamlElement? FindContainerElement(XamlElement element)
    {
        for (XamlNode? n = element.Parent; n != null; n = n.Parent)
        {
            if (n is XamlElement { IsPropertyElement: false } container)
            {
                return container;
            }
        }

        return null;
    }

    private static CompletionList CompleteAttachedProperty(
        Context ctx,
        int dot,
        XamlNamespaceScope scope,
        INamedTypeSymbol elementType,
        HashSet<string> existing,
        XamlTypeSystem typeSystem,
        Lsp.Range replaceRange,
        bool appendValue = false)
        => CompleteAttachedProperty(
            ctx.Partial.Substring(0, dot),
            ctx.Partial.Substring(dot + 1),
            scope,
            typeSystem,
            replaceRange,
            appendValue,
            elementType,
            existing);

    /// <summary>Completes the members of a dotted attached-property partial (Owner.member) as Owner.Member items</summary>
    private static CompletionList CompleteAttachedProperty(
        string ownerName,
        string memberPartial,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem,
        Lsp.Range replaceRange,
        bool appendValue = false,
        INamedTypeSymbol? elementType = null,
        HashSet<string>? existing = null)
    {
        var ownerXamlName = ParseQualified(ownerName);
        var owner = ResolveElementType(ownerXamlName, scope, typeSystem);
        if (owner is null)
        {
            return new CompletionList();
        }

        var items = new List<CompletionItem>();
        foreach (var member in typeSystem.GetAttachedProperties(owner))
        {
            if (!StartsWith(member.Name, memberPartial))
            {
                continue;
            }

            var qualified = ownerName + "." + member.Name;
            if (!IsAttachedPropertyCompletionCandidate(
                    qualified,
                    member,
                    elementType,
                    existing))
            {
                continue;
            }

            items.Add(new CompletionItem
            {
                Label = qualified,
                Kind = CompletionItemKind.Property,
                Documentation = CompletionDoc(member.Symbol),
                Detail = "attached property" + (member.Type != null ? " : " + member.Type.ToDisplayString() : string.Empty),
                TextEdit = new TextEdit { Range = replaceRange, NewText = appendValue ? qualified + "=\"$0\"" : qualified },
                InsertTextFormat = appendValue ? SnippetInsertFormat : null,
                Command = AttributeValueSuggestionCommand(member, typeSystem, appendValue),
                FilterText = qualified,
                SortText = member.Name,
            });
        }

        return Finish(items);
    }

    /// <summary>Completes attached properties when only a namespace prefix or owner partial has been typed, for example <c>ui:|</c> or <c>ui:Framework|</c>.</summary>
    private static CompletionList CompletePrefixedAttachedProperties(
        string prefix,
        string ownerPartial,
        string namespaceUri,
        INamedTypeSymbol elementType,
        HashSet<string> existing,
        XamlTypeSystem typeSystem,
        Lsp.Range replaceRange,
        bool appendValue)
    {
        var items = new List<CompletionItem>();
        foreach (var owner in typeSystem.GetAllTypes(namespaceUri))
        {
            if (!StartsWith(owner.Name, ownerPartial))
            {
                continue;
            }

            foreach (var member in typeSystem.GetAttachedProperties(owner))
            {
                var qualified = prefix + ":" + owner.Name + "." + member.Name;
                if (!IsAttachedPropertyCompletionCandidate(
                        qualified,
                        member,
                        elementType,
                        existing))
                {
                    continue;
                }

                items.Add(new CompletionItem
                {
                    Label = qualified,
                    Kind = CompletionItemKind.Property,
                    Documentation = CompletionDoc(member.Symbol),
                    Detail = "attached property" + (member.Type != null ? " : " + member.Type.ToDisplayString() : string.Empty),
                    TextEdit = new TextEdit
                    {
                        Range = replaceRange,
                        NewText = appendValue ? qualified + "=\"$0\"" : qualified,
                    },
                    InsertTextFormat = appendValue ? SnippetInsertFormat : null,
                    Command = AttributeValueSuggestionCommand(member, typeSystem, appendValue),
                    FilterText = qualified,
                    SortText = owner.Name + "." + member.Name,
                });
            }
        }

        return Finish(items);
    }

    private static bool IsAttachedPropertyCompletionCandidate(
        string qualifiedName,
        XamlMemberInfo member,
        INamedTypeSymbol? elementType,
        HashSet<string>? existing) =>
        (existing is null || !existing.Contains(qualifiedName)) &&
        (elementType is null ||
         XamlTypeSystem.IsAttachedPropertyApplicable(
             member,
             elementType));

    private static Lsp.Command? AttributeValueSuggestionCommand(
        XamlMemberInfo member,
        XamlTypeSystem typeSystem,
        bool appendValue)
    {
        if (!appendValue)
        {
            return null;
        }

        if (member.Kind != XamlMemberKind.Event)
        {
            var valueType = member.Type is null ? null : UnwrapNullable(member.Type);
            if (valueType is null ||
                (valueType.TypeKind != TypeKind.Enum &&
                 valueType.SpecialType != SpecialType.System_Boolean &&
                 valueType is not INamedTypeSymbol { Name: "Type", ContainingNamespace.Name: "System" } &&
                 !XamlValueConverter.IsGridLength(valueType, typeSystem) &&
                 !XamlValueConverter.IsThickness(valueType, typeSystem) &&
                 !XamlValueConverter.IsFontFamily(valueType, typeSystem) &&
                 !XamlValueConverter.IsGridDefinitionCollection(valueType, typeSystem) &&
                 !XamlValueConverter.IsBrush(valueType, typeSystem) &&
                 !XamlValueConverter.IsColor(valueType, typeSystem) &&
                 !XamlValueConverter.IsFontWeight(valueType, typeSystem)))
            {
                return null;
            }
        }

        return new Lsp.Command
        {
            Title = "Trigger attribute value suggestions",
            Name = "editor.action.triggerSuggest",
        };
    }

    // --- Attribute value (enum members / booleans) ------------------------------------------------

    private static CompletionList CompleteAttributeValue(
        TextDocument doc,
        int offset,
        Context ctx,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem,
        INamedTypeSymbol? pageClass,
        Lsp.Range replaceRange)
    {
        // Markup extensions ({x:Bind ...}, {Binding ...}) are a separate completion domain — skip here.
        if (ctx.Partial.TrimStart().StartsWith("{", StringComparison.Ordinal) ||
            string.IsNullOrEmpty(ctx.AttributeName))
        {
            return new CompletionList();
        }

        // A scalar value completion (enum, bool, GridLength, named color) replaces the WHOLE value token — the prefix before the caret AND any suffix after it
        var valueReplaceRange = doc.RangeOf(new TextSpan(ctx.ReplaceStart, ValueTokenEnd(doc.Text, offset)));

        var element = FindEnclosingElement(doc.Parsed.FindNode(Math.Max(0, offset - 1)));
        if (element?.Name is null)
        {
            return new CompletionList();
        }

        // <Setter Property="|"> inside a Style/ControlTemplate completes the settable property names of the target type resolved from the ancestor's TargetType.
        if (XamlSemanticFacts.IsSetter(element, typeSystem) &&
            string.Equals(ctx.AttributeName, "Property", StringComparison.Ordinal))
        {
            return CompleteSetterProperty(element, ctx.Partial, scope, typeSystem, replaceRange);
        }

        // <Setter Value="|"> completes enum members / booleans typed by the sibling Property= on the enclosing TargetType because Setter.Value itself is declared 'object'.
        if (XamlSemanticFacts.IsSetter(element, typeSystem) &&
            string.Equals(ctx.AttributeName, "Value", StringComparison.Ordinal))
        {
            var setterValueType = XamlSemanticFacts.ResolveSetterValueType(element, scope, typeSystem);
            if (setterValueType is null)
            {
                return new CompletionList();
            }

            setterValueType = UnwrapNullable(setterValueType);
            return TryCompleteScalarValue(setterValueType, ctx.Partial, typeSystem, valueReplaceRange)
                ?? new CompletionList();
        }

        // VisualState <Setter Target="Element.Property"> (VSM setters use Target, not Property): the segment before the first dot lists the x:Name'd elements in scope; segments after it list that element's property members. Matches Visual Studio's VSM authoring.
        if (XamlSemanticFacts.IsSetter(element, typeSystem) &&
            string.Equals(ctx.AttributeName, "Target", StringComparison.Ordinal))
        {
            return CompleteSetterTarget(doc, ctx.Partial, scope, typeSystem, replaceRange);
        }

        // Storyboard.TargetName="Foo" references an x:Name'd element in scope (like Binding ElementName).
        if (XamlSemanticFacts.IsStoryboardAttachedProperty(
            ctx.AttributeName,
            "TargetName",
            scope,
            typeSystem))
        {
            return CompleteElementNames(doc, ctx.Partial, string.Empty, typeSystem, replaceRange);
        }

        // RelativePanel object-valued alignment targets reference named elements; the SDK
        // getter signature naturally excludes the boolean *WithPanel variants.
        if (ctx.AttributeName is { } attr &&
            XamlSemanticFacts.IsRelativePanelElementReferenceAttribute(attr, scope, typeSystem))
        {
            return CompleteElementNames(doc, ctx.Partial, string.Empty, typeSystem, replaceRange);
        }

        // Storyboard.TargetProperty="Opacity" lists the property members of the element named by the sibling Storyboard.TargetName on the same animation element.
        if (XamlSemanticFacts.IsStoryboardAttachedProperty(
            ctx.AttributeName,
            "TargetProperty",
            scope,
            typeSystem))
        {
            return CompleteStoryboardTargetProperty(doc, element, ctx.Partial, scope, typeSystem, replaceRange);
        }

        // TargetType="|" (Style, ControlTemplate, ...) completes type names, like an element-name list.
        if (XamlSemanticFacts.IsStyleOrControlTemplate(element, typeSystem) &&
            string.Equals(ctx.AttributeName, "TargetType", StringComparison.Ordinal) &&
            ctx.AttributeName!.IndexOf(':') < 0)
        {
            return CompleteTypeNameValue(
                ctx.Partial,
                scope,
                typeSystem,
                replaceRange,
                requiredBaseType: typeSystem.ResolveMetadataType(
                    "Microsoft.UI.Xaml.DependencyObject"));
        }

        // x:DataType roots binding completion and accepts any type kind.
        if (XamlSemanticFacts.IsXamlDirectiveName(
            ctx.AttributeName!,
            "DataType",
            scope))
        {
            return CompleteTypeNameValue(ctx.Partial, scope, typeSystem, replaceRange, allTypeKinds: true);
        }

        // mc:Ignorable="d …" lists the namespace prefixes a runtime XAML processor may ignore — offer the declared design-time prefixes (space-separated), the near-universal WinUI header attribute. Matched by the RESOLVED markup-compatibility URI (a custom prefix mapped to it works; a foreign one does not).
        if (IsMcIgnorableAttribute(ctx.AttributeName, scope))
        {
            return CompleteMcIgnorable(doc, offset, ctx, scope, replaceRange);
        }

        // Event attribute (Click="|") -> candidate handler methods on the x:Class code-behind. Checked before ResolveAttributeType because an event resolves to its (non-null) delegate type.
        if (ctx.AttributeName!.IndexOf(':') < 0 &&
            ResolveElementType(element.Name, scope, typeSystem) is { } eventOwner &&
            typeSystem.FindMember(eventOwner, ctx.AttributeName!) is { Kind: XamlMemberKind.Event } evt)
        {
            return CompleteEventHandler(
                evt,
                element,
                typeSystem,
                pageClass,
                ctx.Partial,
                replaceRange);
        }

        var valueType = ResolveAttributeType(ctx.AttributeName!, element, scope, typeSystem);
        if (valueType is null)
        {
            return new CompletionList();
        }

        valueType = UnwrapNullable(valueType);

        // Any System.Type-valued attribute.
        if (valueType is INamedTypeSymbol { Name: "Type", ContainingNamespace.Name: "System" })
        {
            return CompleteTypeNameValue(ctx.Partial, scope, typeSystem, replaceRange);
        }

        // Scalar (keyword/named) value completers keyed purely on the value type — enum, bool, GridLength, named color, named font weight. Shared with the Setter.Value path so both stay in lockstep.
        if (TryCompleteScalarValue(valueType, ctx.Partial, typeSystem, valueReplaceRange) is { } scalar)
        {
            return scalar;
        }

        return new CompletionList();
    }

    /// <summary>Completes a scalar attribute value from its resolved value TYPE — the set of value completers that depend only on the type: enum members, booleans, GridLength keywords (Auto/*)</summary>
    private static CompletionList? TryCompleteScalarValue(
        ITypeSymbol valueType, string partial, XamlTypeSystem typeSystem, Lsp.Range valueReplaceRange)
    {
        if (valueType.TypeKind == TypeKind.Enum)
        {
            return CompleteEnumValue(valueType, partial, valueReplaceRange);
        }

        if (valueType.SpecialType == SpecialType.System_Boolean)
        {
            return CompleteBooleanValue(partial, valueReplaceRange);
        }

        // GridLength-typed value (RowDefinition.Height / ColumnDefinition.Width) — offer the two keyword sizings VS/Blend surface (Auto, *). FrameworkElement.Width/Height are 'double' (not GridLength), so they correctly fall through to the empty list below.
        if (XamlValueConverter.IsGridLength(valueType, typeSystem))
        {
            return CompleteGridLength(partial, valueReplaceRange);
        }

        if (XamlValueConverter.IsGridDefinitionCollection(valueType, typeSystem))
        {
            var dimension =
                typeSystem.Capabilities.ColumnDefinitionCollection is { } columns &&
                SymbolEqualityComparer.Default.Equals(valueType, columns)
                    ? "columns"
                    : "rows";
            return CompleteLiteralValues(
                partial,
                valueReplaceRange,
                ("Auto,*", $"Two {dimension}: content-sized, then remaining space"),
                ("Auto,*,Auto", $"Three {dimension}: content-sized, remaining space, content-sized"),
                ("*,*", $"Two equal star-sized {dimension}"));
        }

        if (XamlValueConverter.IsThickness(valueType, typeSystem))
        {
            return CompleteLiteralValues(
                partial,
                valueReplaceRange,
                ("0", "Uniform thickness"),
                ("0,0", "Horizontal and vertical thickness"),
                ("0,0,0,0", "Left, top, right, and bottom thickness"));
        }

        if (XamlValueConverter.IsFontFamily(valueType, typeSystem))
        {
            return CompleteLiteralValues(
                partial,
                valueReplaceRange,
                ("Segoe UI", "Windows UI text font"),
                ("Segoe UI Variable", "Windows variable UI text font"),
                ("Segoe Fluent Icons", "Windows Fluent icon font"));
        }

        // Brush/Color-typed value (Foreground/Background/BorderBrush/…, SolidColorBrush.Color, GradientStop.Color) — offer the WinUI named colors (Red, CornflowerBlue, …
        if (XamlValueConverter.IsBrush(valueType, typeSystem) ||
            XamlValueConverter.IsColor(valueType, typeSystem))
        {
            return CompleteNamedColor(partial, typeSystem, valueReplaceRange);
        }

        // FontWeight-typed value (Control.FontWeight, TextBlock.FontWeight, …) — offer the named weights (Thin, Light, Normal, SemiBold, Bold, …, ExtraBlack) from Microsoft.UI.Text.FontWeights, as VS/Blend do. The numeric form (FontWeight="700") stays free-form (no named weight starts with a digit).
        if (XamlValueConverter.IsFontWeight(valueType, typeSystem))
        {
            return CompleteFontWeight(partial, typeSystem, valueReplaceRange);
        }

        return null;
    }

    private static CompletionList CompleteLiteralValues(
        string partial,
        Lsp.Range replaceRange,
        params (string Value, string Detail)[] values)
    {
        var items = new List<CompletionItem>();
        foreach (var (value, detail) in values)
        {
            if (!StartsWith(value, partial))
            {
                continue;
            }

            items.Add(new CompletionItem
            {
                Label = value,
                Kind = CompletionItemKind.Value,
                Detail = detail,
                TextEdit = new TextEdit { Range = replaceRange, NewText = value },
                FilterText = value,
                SortText = value,
            });
        }

        return Finish(items);
    }

    /// <summary>Completes type names for a type-valued attribute.</summary>
    private static CompletionList CompleteTypeNameValue(
        string partial, XamlNamespaceScope scope, XamlTypeSystem typeSystem, Lsp.Range replaceRange,
        bool allTypeKinds = false,
        INamedTypeSymbol? requiredBaseType = null)
    {
        SplitQualified(partial, out var prefix, out var local);
        if (!scope.TryResolvePrefix(prefix, out var uri))
        {
            return new CompletionList();
        }

        var items = new List<CompletionItem>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var types = allTypeKinds ? typeSystem.GetAllTypes(uri) : typeSystem.GetTypes(uri);
        foreach (var type in types)
        {
            if (!StartsWith(type.Name, local) ||
                (requiredBaseType is not null &&
                 !XamlTypeSystem.IsAssignableTo(type, requiredBaseType)) ||
                !seen.Add(type.Name))
            {
                continue;
            }

            var insert = prefix.Length > 0 ? prefix + ":" + type.Name : type.Name;
            items.Add(new CompletionItem
            {
                Label = type.Name,
                Kind = TypeCompletionKind(type),
                Documentation = CompletionDoc(type),
                Detail = type.ContainingNamespace?.ToDisplayString(),
                TextEdit = new TextEdit { Range = replaceRange, NewText = insert },
                FilterText = type.Name,
                SortText = type.Name,
            });
        }

        // The XAML language namespace has no CLR-namespace binding, so its intrinsic aliases (x:String, x:Boolean, …) are not in GetTypes/GetAllTypes above.
        if (string.Equals(uri, XamlTypeSystem.XamlLanguageNamespace, StringComparison.Ordinal))
        {
            foreach (var intrinsic in typeSystem.GetXamlIntrinsicTypes(allTypeKinds))
            {
                var alias = intrinsic.Key;
                if (!StartsWith(alias, local) ||
                    (requiredBaseType is not null &&
                     !XamlTypeSystem.IsAssignableTo(
                         intrinsic.Value,
                         requiredBaseType)) ||
                    !seen.Add(alias))
                {
                    continue;
                }

                var aliasInsert = prefix.Length > 0 ? prefix + ":" + alias : alias;
                items.Add(new CompletionItem
                {
                    Label = alias,
                    Kind = TypeCompletionKind(intrinsic.Value),
                    Documentation = CompletionDoc(intrinsic.Value),
                    Detail = intrinsic.Value.ContainingNamespace?.ToDisplayString(),
                    TextEdit = new TextEdit { Range = replaceRange, NewText = aliasInsert },
                    FilterText = alias,
                    SortText = alias,
                });
            }
        }

        return Finish(items);
    }

    private static int TypeCompletionKind(INamedTypeSymbol type) => type.TypeKind switch
    {
        TypeKind.Enum => CompletionItemKind.Enum,
        TypeKind.Struct => CompletionItemKind.Struct,
        TypeKind.Interface => CompletionItemKind.Interface,
        _ => CompletionItemKind.Class,
    };

    /// <summary> Completes <c>&lt;Setter Property="|"&gt;</c> with the settable properties of the enclosing <c>Style</c>/<c>ControlTemplate</c>'s <c>TargetType</c>.</summary>
    private static CompletionList CompleteSetterProperty(
        XamlElement setter, string partial, XamlNamespaceScope scope, XamlTypeSystem typeSystem, Lsp.Range replaceRange)
    {
        // "Owner.member" partial -> attached-property completion.
        int dot = partial.LastIndexOf('.');
        if (dot >= 0)
        {
            return CompleteAttachedProperty(partial.Substring(0, dot), partial.Substring(dot + 1), scope, typeSystem, replaceRange);
        }

        var targetType = XamlSemanticFacts.ResolveStyleTargetType(setter, scope, typeSystem);
        if (targetType is null)
        {
            return new CompletionList();
        }

        var items = new List<CompletionItem>();
        foreach (var member in typeSystem.GetMembers(targetType))
        {
            if (member.Kind != XamlMemberKind.Property || !StartsWith(member.Name, partial))
            {
                continue;
            }

            items.Add(new CompletionItem
            {
                Label = member.Name,
                Kind = CompletionItemKind.Property,
                Documentation = CompletionDoc(member.Symbol),
                Detail = DescribeMember(member),
                TextEdit = new TextEdit { Range = replaceRange, NewText = member.Name },
                FilterText = member.Name,
                SortText = member.Name,
            });
        }

        return Finish(items);
    }

    /// <summary>Walks up from a node to the nearest Style or ControlTemplate element and resolves its TargetType attribute value to a type symbol.</summary>
    internal static INamedTypeSymbol? ResolveStyleTargetType(
        XamlNode? start, XamlNamespaceScope scope, XamlTypeSystem typeSystem) =>
        XamlSemanticFacts.ResolveStyleTargetType(start, scope, typeSystem);

    /// <summary>Resolves the value type of a &lt;Setter Value="..."&gt; from its sibling Property= against the enclosing Style/ControlTemplate TargetType — the simple member's type</summary>
    /// <summary>Completes a VisualState &lt;Setter Target="Element.Property"&gt; value.</summary>
    private static CompletionList CompleteSetterTarget(
        TextDocument doc, string partial, XamlNamespaceScope scope, XamlTypeSystem typeSystem, Lsp.Range replaceRange)
    {
        int dot = partial.IndexOf('.');
        if (dot < 0)
        {
            // Still typing the element-name segment.
            return CompleteElementNames(doc, partial, string.Empty, typeSystem, replaceRange);
        }

        var elementName = partial.Substring(0, dot);
        var elementType = XamlSemanticFacts.ResolveNamedElementTypeInScope(
            doc,
            doc.Parsed.FindNode(Math.Max(0, doc.OffsetAt(replaceRange.Start) - 1)),
            elementName,
            typeSystem);
        if (elementType is null)
        {
            return new CompletionList();
        }

        return CompletePropertyPath(elementType, partial.Substring(dot + 1), elementName + ".", typeSystem, replaceRange);
    }

    /// <summary> Completes a <c>Storyboard.TargetProperty="..."</c> value with the property members of the element named by the sibling <c>Storyboard.TargetName</c>.</summary>
    private static CompletionList CompleteStoryboardTargetProperty(
        TextDocument doc, XamlElement animation, string partial,
        XamlNamespaceScope scope, XamlTypeSystem typeSystem, Lsp.Range replaceRange)
    {
        // A parenthesized (Owner.Property) qualifier names its owner type EXPLICITLY, so it is resolved independently of Storyboard.TargetName — try it before rooting at the target element.
        var qualified = TryCompleteQualifiedGroup(partial, scope, typeSystem, replaceRange);
        if (qualified is not null)
        {
            return qualified;
        }

        var targetName = animation.Attributes.FirstOrDefault(
            a => XamlSemanticFacts.IsStoryboardAttachedProperty(
                a.Name.FullName,
                "TargetName",
                animation.NamespaceScope,
                typeSystem))
            ?.Value?.Text?.Trim();
        if (string.IsNullOrEmpty(targetName))
        {
            return new CompletionList();
        }

        var targetType = XamlSemanticFacts.ResolveNamedElementTypeInScope(
            doc,
            animation,
            targetName!,
            typeSystem);
        return targetType is null
            ? new CompletionList()
            : CompletePropertyPath(targetType, partial, string.Empty, typeSystem, replaceRange);
    }

    /// <summary>When the caret sits inside an unclosed parenthesized (Owner.Property) qualifier of a Storyboard.TargetProperty path</summary>
    private static CompletionList? TryCompleteQualifiedGroup(
        string partial, XamlNamespaceScope scope, XamlTypeSystem typeSystem, Lsp.Range replaceRange)
    {
        int open = partial.LastIndexOf('(');
        if (open < 0 || partial.IndexOf(')', open) >= 0)
        {
            // No parenthesized group, or the nearest one is already closed -> not the caret's segment.
            return null;
        }

        int dot = partial.IndexOf('.', open + 1);
        if (dot < 0)
        {
            // Still typing the owner type name inside "(" -> defer rather than leak the element's members.
            return new CompletionList();
        }

        var ownerToken = partial.Substring(open + 1, dot - open - 1).Trim();
        var ownerType = ownerToken.Length == 0
            ? null
            : ResolveElementType(ParseQualified(ownerToken), scope, typeSystem);
        if (ownerType is null)
        {
            return new CompletionList();
        }

        var prefix = partial.Substring(0, dot + 1);
        var memberPartial = partial.Substring(dot + 1);

        // A further dotted sub-path ("(Owner.Sub.Member") walks instance property types (attached properties never appear past the first segment), reusing the shared property-path walker.
        if (memberPartial.IndexOf('.') >= 0)
        {
            return CompletePropertyPath(ownerType, memberPartial, prefix, typeSystem, replaceRange);
        }

        // First member after the owner dot: offer BOTH the owner's instance properties and its attached properties, both filtered by the partial, deduped, with the "(Owner." prefix preserved verbatim.
        var items = new List<CompletionItem>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var member in typeSystem.GetMembers(ownerType))
        {
            if (member.Kind != XamlMemberKind.Property || !StartsWith(member.Name, memberPartial) || !seen.Add(member.Name))
            {
                continue;
            }

            var newText = prefix + member.Name;
            items.Add(new CompletionItem
            {
                Label = member.Name,
                Kind = CompletionItemKind.Property,
                Documentation = CompletionDoc(member.Symbol),
                Detail = DescribeMember(member),
                TextEdit = new TextEdit { Range = replaceRange, NewText = newText },
                FilterText = newText,
                SortText = member.Name,
            });
        }

        foreach (var member in typeSystem.GetAttachedProperties(ownerType))
        {
            if (!StartsWith(member.Name, memberPartial) || !seen.Add(member.Name))
            {
                continue;
            }

            var newText = prefix + member.Name;
            items.Add(new CompletionItem
            {
                Label = member.Name,
                Kind = CompletionItemKind.Property,
                Documentation = CompletionDoc(member.Symbol),
                Detail = "attached property" + (member.Type != null ? " : " + member.Type.ToDisplayString() : string.Empty),
                TextEdit = new TextEdit { Range = replaceRange, NewText = newText },
                FilterText = newText,
                SortText = member.Name,
            });
        }

        return Finish(items);
    }

    /// <summary>Completes named elements in the current XAML namescope.</summary>
    private static CompletionList CompleteElementNames(
        TextDocument doc, string partial, string prefix,
        XamlTypeSystem typeSystem, Lsp.Range replaceRange)
    {
        var items = new List<CompletionItem>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var context = doc.Parsed.FindNode(Math.Max(0, doc.OffsetAt(replaceRange.Start) - 1));
        foreach (var (name, element) in XamlSemanticFacts.EnumerateNamedElementsInScope(
            doc,
            context,
            typeSystem))
        {
            if (!StartsWith(name, partial) || !seen.Add(name))
            {
                continue;
            }

            var type = XamlSemanticFacts.ResolveElementType(element, typeSystem);
            var newText = prefix + name;
            items.Add(new CompletionItem
            {
                Label = name,
                Kind = CompletionItemKind.Field,
                Detail = type is null ? "(element)" : "(element) " + type.Name,
                TextEdit = new TextEdit { Range = replaceRange, NewText = newText },
                FilterText = newText,
                SortText = name,
            });
        }

        return Finish(items);
    }

    /// <summary>Completes a dotted property path from a root type: fully resolves the segments before the last dot through their property types</summary>
    private static CompletionList CompletePropertyPath(
        INamedTypeSymbol rootType, string pathPartial, string prefix,
        XamlTypeSystem typeSystem, Lsp.Range replaceRange)
    {
        int lastDot = pathPartial.LastIndexOf('.');
        var memberPartial = lastDot < 0 ? pathPartial : pathPartial.Substring(lastDot + 1);
        var fullSegments = lastDot < 0 ? string.Empty : pathPartial.Substring(0, lastDot);

        var ownerType = rootType;
        if (fullSegments.Length > 0)
        {
            foreach (var segment in fullSegments.Split('.'))
            {
                if (segment.Length == 0 ||
                    typeSystem.FindMember(ownerType, segment)?.Type is not INamedTypeSymbol next)
                {
                    return new CompletionList();
                }

                ownerType = next;
            }
        }

        var newPrefix = prefix + (fullSegments.Length > 0 ? fullSegments + "." : string.Empty);
        var items = new List<CompletionItem>();
        foreach (var member in typeSystem.GetMembers(ownerType))
        {
            if (member.Kind != XamlMemberKind.Property || !StartsWith(member.Name, memberPartial))
            {
                continue;
            }

            var newText = newPrefix + member.Name;
            items.Add(new CompletionItem
            {
                Label = member.Name,
                Kind = CompletionItemKind.Property,
                Documentation = CompletionDoc(member.Symbol),
                Detail = DescribeMember(member),
                TextEdit = new TextEdit { Range = replaceRange, NewText = newText },
                FilterText = newText,
                SortText = member.Name,
            });
        }

        return Finish(items);
    }

    /// <summary> Completes <c>{TemplateBinding |}</c> with the readable properties of the enclosing <c>ControlTemplate</c>'s <c>TargetType</c>.</summary>
    private static CompletionList CompleteTemplateBinding(
        TextDocument doc, int offset, Context ctx, XamlNamespaceScope scope, XamlTypeSystem typeSystem, Lsp.Range replaceRange)
    {
        var targetType = ResolveStyleTargetType(doc.Parsed.FindNode(Math.Max(0, offset - 1)), scope, typeSystem);
        if (targetType is null)
        {
            return new CompletionList();
        }

        int dot = ctx.Partial.LastIndexOf('.');
        if (dot >= 0)
        {
            return CompleteAttachedProperty(
                ctx.Partial.Substring(0, dot),
                ctx.Partial.Substring(dot + 1),
                scope,
                typeSystem,
                replaceRange,
                elementType: targetType);
        }

        var items = new List<CompletionItem>();
        foreach (var property in typeSystem.GetBindableMembers(targetType).OfType<IPropertySymbol>())
        {
            if (!StartsWith(property.Name, ctx.Partial))
            {
                continue;
            }

            items.Add(new CompletionItem
            {
                Label = property.Name,
                Kind = CompletionItemKind.Property,
                Documentation = CompletionDoc(property),
                Detail = property.Type.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat),
                TextEdit = new TextEdit { Range = replaceRange, NewText = property.Name },
                FilterText = property.Name,
                SortText = property.Name,
            });
        }

        return Finish(items);
    }

    /// <summary>Completes the value of an event attribute (Click="|") with candidate handler methods on the page's x:Class code-behind</summary>
    private static CompletionList CompleteEventHandler(
        XamlMemberInfo evt,
        XamlElement element,
        XamlTypeSystem typeSystem,
        INamedTypeSymbol? pageClass,
        string partial,
        Lsp.Range replaceRange)
    {
        if (pageClass is null)
        {
            return new CompletionList();
        }

        var invoke = (evt.Type as INamedTypeSymbol)?.DelegateInvokeMethod;
        var items = new List<CompletionItem>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var existingNames = new HashSet<string>(StringComparer.Ordinal);
        foreach (var method in XamlSemanticFacts.EnumerateEventHandlerMethods(pageClass, typeSystem))
        {
            existingNames.Add(method.Name);
            if (!StartsWith(method.Name, partial) ||
                (invoke is not null
                    ? !XamlSemanticFacts.IsCompatibleEventHandler(method, invoke)
                    : method.MethodKind != MethodKind.Ordinary || method.IsStatic || !method.ReturnsVoid) ||
                !seen.Add(method.Name))
            {
                continue;
            }

            items.Add(new CompletionItem
            {
                Label = method.Name,
                Kind = CompletionItemKind.Method,
                Documentation = CompletionDoc(method),
                Detail = method.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat),
                TextEdit = new TextEdit { Range = replaceRange, NewText = method.Name },
                FilterText = method.Name,
                SortText = "0" + method.Name,
            });
        }

        if (XamlSemanticFacts.GetNameAttribute(element, typeSystem)?.Value is
                { IsMarkupExtension: false } nameValue)
        {
            string conventionalName = $"{nameValue.Text.Trim()}_{evt.Name}";
            if (SyntaxFacts.IsValidIdentifier(conventionalName) &&
                StartsWith(conventionalName, partial) &&
                !existingNames.Contains(conventionalName) &&
                seen.Add(conventionalName))
            {
                items.Add(new CompletionItem
                {
                    Label = conventionalName,
                    Kind = CompletionItemKind.Method,
                    Detail = "new event handler",
                    TextEdit = new TextEdit { Range = replaceRange, NewText = conventionalName },
                    FilterText = conventionalName,
                    SortText = "1" + conventionalName,
                });
            }
        }

        return Finish(items);
    }

    private static CompletionList CompleteEnumValue(ITypeSymbol enumType, string partial, Lsp.Range replaceRange)
    {
        var detail = enumType.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat);
        var items = new List<CompletionItem>();
        foreach (var field in enumType.GetMembers().OfType<IFieldSymbol>())
        {
            // Enum members are the constant fields; the synthetic value__ storage field is not const.
            if (!field.HasConstantValue || !StartsWith(field.Name, partial))
            {
                continue;
            }

            items.Add(new CompletionItem
            {
                Label = field.Name,
                Kind = CompletionItemKind.EnumMember,
                Documentation = CompletionDoc(field),
                Detail = detail,
                TextEdit = new TextEdit { Range = replaceRange, NewText = field.Name },
                FilterText = field.Name,
                SortText = field.Name,
            });
        }

        return Finish(items);
    }

    // --- Markup extension name (inside {|}) -------------------------------------------------------

    /// <summary>The XAML markup extensions offered when the caret is typing a name just after <c>{</c>.</summary>
}
