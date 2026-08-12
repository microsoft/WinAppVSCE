using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.CodeAnalysis;
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
                typeSystem,
                replaceRange);
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
        XamlTypeSystem typeSystem,
        Lsp.Range replaceRange)
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
                    Range = replaceRange,
                    NewText = qualifiedOwner + "." + member.Name,
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

        // CLR namespace -> the prefix already declared for it, so a type in an explicitly-declared third-party namespace reuses that prefix (no duplicate xmlns injection).
        var declaredPrefixes = new HashSet<string>(scope.Declarations.Keys, StringComparer.Ordinal);
        var prefixByNamespace = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var declaration in scope.Declarations)
        {
            if (declaration.Key.Length == 0)
            {
                continue;
            }

            foreach (var clrNs in typeSystem.ClrNamespacesForUri(declaration.Value))
            {
                if (!prefixByNamespace.ContainsKey(clrNs))
                {
                    prefixByNamespace[clrNs] = declaration.Key;
                }
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

            List<TextEdit>? additionalEdits = null;
            string itemPrefix;
            if (prefixByNamespace.TryGetValue(clrNamespace!, out var existingPrefix))
            {
                itemPrefix = existingPrefix;
            }
            else
            {
                itemPrefix = GenerateXmlnsPrefix(clrNamespace!, declaredPrefixes);
                var rootEdit = BuildRootXmlnsEdit(doc, itemPrefix, clrNamespace!);
                if (rootEdit is null)
                {
                    // No root element to anchor the xmlns to — offering the type would produce an undeclared prefix, so skip it.
                    continue;
                }

                additionalEdits = new List<TextEdit> { rootEdit };
            }

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

    /// <summary>Generates a fresh xmlns prefix for a CLR namespace — the last dotted segment lowercased.</summary>
    private static string GenerateXmlnsPrefix(string clrNamespace, HashSet<string> declaredPrefixes)
    {
        var last = clrNamespace;
        var dot = clrNamespace.LastIndexOf('.');
        if (dot >= 0 && dot < clrNamespace.Length - 1)
        {
            last = clrNamespace.Substring(dot + 1);
        }

        var basePrefix = last.ToLowerInvariant();
        if (basePrefix.Length == 0)
        {
            basePrefix = "ns";
        }

        var candidate = basePrefix;
        var counter = 2;
        while (declaredPrefixes.Contains(candidate))
        {
            candidate = basePrefix + counter;
            counter++;
        }

        return candidate;
    }

    /// <summary>Builds the AdditionalTextEdits entry that declares xmlns:PREFIX="using:NAMESPACE" on the root element — grouped after any existing xmlns declarations</summary>
    private static TextEdit? BuildRootXmlnsEdit(TextDocument doc, string prefix, string clrNamespace)
    {
        var root = doc.Parsed.Root;
        if (root?.Name is null)
        {
            return null;
        }

        var insertAt = root.Name.Span.End;
        foreach (var attribute in root.Attributes)
        {
            if (attribute.IsNamespaceDeclaration && attribute.Span.End > insertAt)
            {
                insertAt = attribute.Span.End;
            }
        }

        var pos = doc.PositionAt(insertAt);
        return new TextEdit { Range = new Lsp.Range(pos, pos), NewText = $" xmlns:{prefix}=\"using:{clrNamespace}\"" };
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
            ? PropertyElementContentType(enclosing, scope, typeSystem)
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
        XamlElement propertyElement, XamlNamespaceScope scope, XamlTypeSystem typeSystem)
    {
        var local = propertyElement.Name!.LocalName; // "Grid.RowDefinitions"
        int dot = local.IndexOf('.');
        if (dot <= 0 || dot >= local.Length - 1)
        {
            return null;
        }

        if (!scope.TryResolvePrefix(string.Empty, out var uri))
        {
            return null;
        }

        var ownerType = typeSystem.ResolveType(uri, local.Substring(0, dot));
        if (ownerType is null)
        {
            return null;
        }

        var propertyType = typeSystem.GetPropertyType(ownerType, local.Substring(dot + 1));
        if (propertyType is null)
        {
            return null;
        }

        return XamlTypeSystem.GetCollectionElementType(propertyType) ?? propertyType;
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

        // "Owner.member" partial -> attached-property completion for the owner type.
        int dot = ctx.Partial.LastIndexOf('.');
        if (dot >= 0)
        {
            return CompleteAttachedProperty(ctx, dot, scope, typeSystem, nameReplaceRange, appendValue);
        }

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

        var items = new List<CompletionItem>();
        foreach (var member in typeSystem.GetMembers(elementType))
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
                FilterText = member.Name,
                // Sort events after properties so the common case (properties) surfaces first.
                SortText = (member.Kind == XamlMemberKind.Event ? "1" : "0") + member.Name,
            });
        }

        AddXamlDirectives(items, existing, ctx.Partial, scope, nameReplaceRange, appendValue);
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
        string partial,
        XamlNamespaceScope scope,
        Lsp.Range replaceRange,
        bool appendValue)
    {
        var xamlPrefix = scope.Declarations.FirstOrDefault(
            declaration => string.Equals(declaration.Value, XamlTypeSystem.XamlLanguageNamespace, StringComparison.Ordinal)).Key;
        if (string.IsNullOrEmpty(xamlPrefix))
        {
            return;
        }

        AddSyntheticAttribute(items, existing, partial, xamlPrefix + ":Name", "XAML name", replaceRange, appendValue, "0");
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
        Context ctx, int dot, XamlNamespaceScope scope, XamlTypeSystem typeSystem, Lsp.Range replaceRange, bool appendValue = false)
        => CompleteAttachedProperty(
            ctx.Partial.Substring(0, dot), ctx.Partial.Substring(dot + 1), scope, typeSystem, replaceRange, appendValue);

    /// <summary>Completes the members of a dotted attached-property partial (Owner.member) as Owner.Member items</summary>
    private static CompletionList CompleteAttachedProperty(
        string ownerName, string memberPartial, XamlNamespaceScope scope, XamlTypeSystem typeSystem, Lsp.Range replaceRange, bool appendValue = false)
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
            items.Add(new CompletionItem
            {
                Label = qualified,
                Kind = CompletionItemKind.Property,
                Documentation = CompletionDoc(member.Symbol),
                Detail = "attached property" + (member.Type != null ? " : " + member.Type.ToDisplayString() : string.Empty),
                TextEdit = new TextEdit { Range = replaceRange, NewText = appendValue ? qualified + "=\"$0\"" : qualified },
                InsertTextFormat = appendValue ? SnippetInsertFormat : null,
                FilterText = qualified,
                SortText = member.Name,
            });
        }

        return Finish(items);
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
        if (element.Name is { HasPrefix: false, LocalName: "Setter" } &&
            string.Equals(ctx.AttributeName, "Property", StringComparison.Ordinal))
        {
            return CompleteSetterProperty(element, ctx.Partial, scope, typeSystem, replaceRange);
        }

        // <Setter Value="|"> completes enum members / booleans typed by the sibling Property= on the enclosing TargetType because Setter.Value itself is declared 'object'.
        if (element.Name is { HasPrefix: false, LocalName: "Setter" } &&
            string.Equals(ctx.AttributeName, "Value", StringComparison.Ordinal))
        {
            var setterValueType = ResolveSetterValueType(element, scope, typeSystem);
            if (setterValueType is null)
            {
                return new CompletionList();
            }

            setterValueType = UnwrapNullable(setterValueType);
            return TryCompleteScalarValue(setterValueType, ctx.Partial, typeSystem, valueReplaceRange)
                ?? new CompletionList();
        }

        // VisualState <Setter Target="Element.Property"> (VSM setters use Target, not Property): the segment before the first dot lists the x:Name'd elements in scope; segments after it list that element's property members. Matches Visual Studio's VSM authoring.
        if (element.Name is { HasPrefix: false, LocalName: "Setter" } &&
            string.Equals(ctx.AttributeName, "Target", StringComparison.Ordinal))
        {
            return CompleteSetterTarget(doc, ctx.Partial, scope, typeSystem, replaceRange);
        }

        // Storyboard.TargetName="Foo" references an x:Name'd element in scope (like Binding ElementName).
        if (string.Equals(ctx.AttributeName, "Storyboard.TargetName", StringComparison.Ordinal))
        {
            return CompleteElementNames(doc, ctx.Partial, string.Empty, scope, typeSystem, replaceRange);
        }

        // RelativePanel alignment targets reference named elements; *WithPanel variants are booleans.
        if (ctx.AttributeName is { } attr && RelativePanelAlignmentTargets.Contains(attr))
        {
            return CompleteElementNames(doc, ctx.Partial, string.Empty, scope, typeSystem, replaceRange);
        }

        // Storyboard.TargetProperty="Opacity" lists the property members of the element named by the sibling Storyboard.TargetName on the same animation element.
        if (string.Equals(ctx.AttributeName, "Storyboard.TargetProperty", StringComparison.Ordinal))
        {
            return CompleteStoryboardTargetProperty(doc, element, ctx.Partial, scope, typeSystem, replaceRange);
        }

        // TargetType="|" (Style, ControlTemplate, ...) completes type names, like an element-name list.
        if (string.Equals(ctx.AttributeName, "TargetType", StringComparison.Ordinal) &&
            ctx.AttributeName!.IndexOf(':') < 0)
        {
            return CompleteTypeNameValue(ctx.Partial, scope, typeSystem, replaceRange);
        }

        // x:DataType roots binding completion and accepts any type kind.
        if (string.Equals(ctx.AttributeName, "x:DataType", StringComparison.Ordinal))
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
            return CompleteEventHandler(evt, pageClass, ctx.Partial, replaceRange);
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
        if (XamlValueConverter.IsGridLength(valueType))
        {
            return CompleteGridLength(partial, valueReplaceRange);
        }

        // Brush/Color-typed value (Foreground/Background/BorderBrush/…, SolidColorBrush.Color, GradientStop.Color) — offer the WinUI named colors (Red, CornflowerBlue, …
        if (XamlValueConverter.IsBrush(valueType) || XamlValueConverter.IsColor(valueType))
        {
            return CompleteNamedColor(partial, typeSystem, valueReplaceRange);
        }

        // FontWeight-typed value (Control.FontWeight, TextBlock.FontWeight, …) — offer the named weights (Thin, Light, Normal, SemiBold, Bold, …, ExtraBlack) from Microsoft.UI.Text.FontWeights, as VS/Blend do. The numeric form (FontWeight="700") stays free-form (no named weight starts with a digit).
        if (XamlValueConverter.IsFontWeight(valueType))
        {
            return CompleteFontWeight(partial, typeSystem, valueReplaceRange);
        }

        return null;
    }

    /// <summary>Completes type names for a type-valued attribute.</summary>
    private static CompletionList CompleteTypeNameValue(
        string partial, XamlNamespaceScope scope, XamlTypeSystem typeSystem, Lsp.Range replaceRange,
        bool allTypeKinds = false)
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
            if (!StartsWith(type.Name, local) || !seen.Add(type.Name))
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
                if (!StartsWith(alias, local) || !seen.Add(alias))
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

        var targetType = ResolveStyleTargetType(setter, scope, typeSystem);
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
        XamlNode? start, XamlNamespaceScope scope, XamlTypeSystem typeSystem)
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
            var text = targetType?.Value?.Text;
            if (string.IsNullOrWhiteSpace(text))
            {
                return null;
            }

            // TargetType may be a bare/prefixed name ("Button", "local:Foo") or the {x:Type Button} markup-extension wrapper; normalize both to a qualified name before resolving.
            var typeToken = NormalizeTypeToken(text!);
            if (typeToken is null)
            {
                return null;
            }

            return ResolveElementType(ParseQualified(typeToken), scope, typeSystem);
        }

        return null;
    }

    /// <summary>Resolves the value type of a &lt;Setter Value="..."&gt; from its sibling Property= against the enclosing Style/ControlTemplate TargetType — the simple member's type</summary>
    private static ITypeSymbol? ResolveSetterValueType(
        XamlElement setter, XamlNamespaceScope scope, XamlTypeSystem typeSystem)
    {
        var propName = setter.Attributes.FirstOrDefault(
            a => !a.Name.HasPrefix && string.Equals(a.Name.LocalName, "Property", StringComparison.Ordinal))
            ?.Value?.Text?.Trim();
        if (string.IsNullOrEmpty(propName))
        {
            return null;
        }

        int dot = propName!.IndexOf('.');
        if (dot > 0)
        {
            var owner = ResolveElementType(ParseQualified(propName.Substring(0, dot)), scope, typeSystem);
            var attachedName = propName.Substring(dot + 1);
            return owner is null
                ? null
                : typeSystem.GetAttachedProperties(owner)
                    .FirstOrDefault(m => string.Equals(m.Name, attachedName, StringComparison.Ordinal))?.Type;
        }

        var targetType = ResolveStyleTargetType(setter, scope, typeSystem);
        return targetType is null ? null : typeSystem.FindMember(targetType, propName)?.Type;
    }

    /// <summary>Completes a VisualState &lt;Setter Target="Element.Property"&gt; value.</summary>
    private static CompletionList CompleteSetterTarget(
        TextDocument doc, string partial, XamlNamespaceScope scope, XamlTypeSystem typeSystem, Lsp.Range replaceRange)
    {
        int dot = partial.IndexOf('.');
        if (dot < 0)
        {
            // Still typing the element-name segment.
            return CompleteElementNames(doc, partial, string.Empty, scope, typeSystem, replaceRange);
        }

        var elementName = partial.Substring(0, dot);
        var elementType = ResolveNamedElementType(doc.Parsed.Root, elementName, scope, typeSystem);
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
            a => !a.Name.HasPrefix && string.Equals(a.Name.LocalName, "Storyboard.TargetName", StringComparison.Ordinal))
            ?.Value?.Text?.Trim();
        if (string.IsNullOrEmpty(targetName))
        {
            return new CompletionList();
        }

        var targetType = ResolveNamedElementType(doc.Parsed.Root, targetName!, scope, typeSystem);
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

    /// <summary>Completes the x:Name'd elements declared anywhere in the document (x:Name scope is per-file), filtered by partial and emitted with prefix preserved in the inserted text.</summary>
    internal static readonly HashSet<string> RelativePanelAlignmentTargets = new(StringComparer.Ordinal)
    {
        "RelativePanel.Above",
        "RelativePanel.Below",
        "RelativePanel.LeftOf",
        "RelativePanel.RightOf",
        "RelativePanel.AlignLeftWith",
        "RelativePanel.AlignRightWith",
        "RelativePanel.AlignTopWith",
        "RelativePanel.AlignBottomWith",
        "RelativePanel.AlignHorizontalCenterWith",
        "RelativePanel.AlignVerticalCenterWith",
    };

    private static CompletionList CompleteElementNames(
        TextDocument doc, string partial, string prefix,
        XamlNamespaceScope scope, XamlTypeSystem typeSystem, Lsp.Range replaceRange)
    {
        var items = new List<CompletionItem>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        if (doc.Parsed.Root is { } root)
        {
            foreach (var (name, element) in EnumerateNamedElements(root))
            {
                if (!StartsWith(name, partial) || !seen.Add(name))
                {
                    continue;
                }

                var type = element.Name is { } typeName ? ResolveElementType(typeName, scope, typeSystem) : null;
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

    /// <summary>Resolves an x:Name reference to the declaring element's type symbol, or null when the name is not declared in the document or its type cannot be resolved.</summary>
    internal static INamedTypeSymbol? ResolveNamedElementType(
        XamlElement? root, string name, XamlNamespaceScope scope, XamlTypeSystem typeSystem)
    {
        if (root is null)
        {
            return null;
        }

        foreach (var (candidate, element) in EnumerateNamedElements(root))
        {
            if (string.Equals(candidate, name, StringComparison.Ordinal))
            {
                return element.Name is { } typeName ? ResolveElementType(typeName, scope, typeSystem) : null;
            }
        }

        return null;
    }

    /// <summary>Enumerates every element carrying an x:Name (or Name) literal, paired with its name, by walking the document tree. x:Name scope is the whole file</summary>
    private static IEnumerable<(string Name, XamlElement Element)> EnumerateNamedElements(XamlElement element)
    {
        var attr = element.GetAttribute("x:Name") ?? element.GetAttribute("Name");
        if (attr?.Value is { IsMarkupExtension: false } value)
        {
            var name = value.Text.Trim();
            if (name.Length > 0 && element.Name is { LocalName.Length: > 0 })
            {
                yield return (name, element);
            }
        }

        foreach (var child in element.Content)
        {
            if (child is XamlElement childElement)
            {
                foreach (var hit in EnumerateNamedElements(childElement))
                {
                    yield return hit;
                }
            }
        }
    }

    /// <summary> Completes <c>{TemplateBinding |}</c> with the settable properties of the enclosing <c>ControlTemplate</c>'s <c>TargetType</c>.</summary>
    private static CompletionList CompleteTemplateBinding(
        TextDocument doc, int offset, Context ctx, XamlNamespaceScope scope, XamlTypeSystem typeSystem, Lsp.Range replaceRange)
    {
        var targetType = ResolveStyleTargetType(doc.Parsed.FindNode(Math.Max(0, offset - 1)), scope, typeSystem);
        if (targetType is null)
        {
            return new CompletionList();
        }

        var items = new List<CompletionItem>();
        foreach (var member in typeSystem.GetMembers(targetType))
        {
            if (member.Kind != XamlMemberKind.Property || !StartsWith(member.Name, ctx.Partial))
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

    /// <summary>Completes the value of an event attribute (Click="|") with candidate handler methods on the page's x:Class code-behind</summary>
    private static CompletionList CompleteEventHandler(
        XamlMemberInfo evt, INamedTypeSymbol? pageClass, string partial, Lsp.Range replaceRange)
    {
        if (pageClass is null)
        {
            return new CompletionList();
        }

        var invoke = (evt.Type as INamedTypeSymbol)?.DelegateInvokeMethod;
        var items = new List<CompletionItem>();
        foreach (var method in pageClass.GetMembers().OfType<IMethodSymbol>())
        {
            if (method.MethodKind != MethodKind.Ordinary || method.IsStatic ||
                method.IsImplicitlyDeclared || method.AssociatedSymbol is not null ||
                !method.ReturnsVoid || !StartsWith(method.Name, partial))
            {
                continue;
            }

            // When the delegate signature is known, require the same arity so unrelated helper methods on the page class don't pollute the handler list.
            if (invoke is not null && method.Parameters.Length != invoke.Parameters.Length)
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
                SortText = method.Name,
            });
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
