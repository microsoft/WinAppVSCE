using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.CodeAnalysis;
using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Workspace;
using WinUiXaml.Xaml;

namespace WinUiXaml.LanguageServer;

/// <summary>
/// Produces XAML completion items from the caret context. Classifies the caret (element-name vs
/// attribute-name vs attached-property member) with a small text scan — robust to the incomplete
/// input completion always runs on — then draws candidates from the <see cref="XamlTypeSystem"/>.
/// </summary>
internal static class CompletionProvider
{
    private enum ContextKind { None, ElementName, AttributeName, AttributeValue, BindPath, MarkupName, MarkupArg, ResourceKey, TemplateBinding, TypeName, StaticMember, CloseTag, UsingNamespace, XmlnsValue, DesignInstanceType }

    public static CompletionList Provide(TextDocument doc, int offset, XamlTypeSystem typeSystem, INamedTypeSymbol? pageClass = null, IReadOnlyCollection<string>? appResourceKeys = null)
    {
        var ctx = Classify(doc.Text, offset);
        if (ctx.Kind == ContextKind.None)
        {
            return new CompletionList();
        }

        var scope = EffectiveScope(doc.Parsed.FindNode(Math.Max(0, offset - 1)), doc.Parsed);
        var replaceRange = doc.RangeOf(new TextSpan(ctx.ReplaceStart, offset));

        return ctx.Kind switch
        {
            ContextKind.ElementName => CompleteElementName(doc, ctx, scope, typeSystem, replaceRange, ResolveChildContentType(doc, ctx, scope, typeSystem)),
            ContextKind.CloseTag => CompleteCloseTag(doc, offset, ctx.ReplaceStart, replaceRange),
            ContextKind.AttributeValue => MaybeQuoteUnquotedValues(CompleteAttributeValue(doc, offset, ctx, scope, typeSystem, pageClass, replaceRange), doc, offset, ctx),
            ContextKind.BindPath => CompleteBindPath(doc, offset, ctx, scope, typeSystem, pageClass, replaceRange),
            ContextKind.MarkupName => CompleteMarkupName(ctx, replaceRange),
            ContextKind.MarkupArg => CompleteMarkupArg(doc, ctx, typeSystem, replaceRange),
            ContextKind.ResourceKey => CompleteResourceKey(doc, offset, ctx, scope, typeSystem, appResourceKeys, replaceRange),
            ContextKind.TemplateBinding => CompleteTemplateBinding(doc, offset, ctx, scope, typeSystem, replaceRange),
            ContextKind.TypeName => CompleteTypeNameValue(ctx.Partial, scope, typeSystem, replaceRange, allTypeKinds: true),
            ContextKind.DesignInstanceType => CompleteDesignInstanceType(ctx, scope, typeSystem, replaceRange),
            ContextKind.StaticMember => CompleteStaticMember(ctx, scope, typeSystem, replaceRange),
            ContextKind.UsingNamespace => CompleteUsingNamespace(ctx, typeSystem, replaceRange),
            ContextKind.XmlnsValue => CompleteXmlnsValue(ctx, replaceRange),
            _ => CompleteAttributeName(doc, offset, ctx, scope, typeSystem, replaceRange),
        };
    }

    /// <summary>
    /// When the caret sits at an UNQUOTED attribute-value position (the user typed <c>Click=OnGo</c> with no
    /// surrounding quotes), every completed value must be wrapped in quotes to yield valid XAML — an event
    /// handler (<c>Click="OnGo_Click"</c>), an enum (<c>IsEnabled="True"</c>), a type name, a color, a
    /// GridLength, etc. are ALL invalid unquoted. Rather than thread a quoting flag through the ~10 value
    /// completers, we post-process the single dispatched result here: normalize each item's edit to replace
    /// the WHOLE value token (so any suffix after the caret is consumed, avoiding a dangling <c>Click="X"n</c>
    /// on a mid-token accept) and surround the inserted text with double quotes. A no-op for the quoted path
    /// (<see cref="Context.IsUnquoted"/> is false) and for any item that carries no <c>TextEdit</c>.
    /// </summary>
    private static CompletionList MaybeQuoteUnquotedValues(CompletionList list, TextDocument doc, int offset, Context ctx)
    {
        if (!ctx.IsUnquoted || list.Items.Count == 0)
        {
            return list;
        }

        var wholeToken = doc.RangeOf(new TextSpan(ctx.ReplaceStart, ValueTokenEnd(doc.Text, offset)));
        foreach (var item in list.Items)
        {
            if (item.TextEdit is { } edit)
            {
                edit.Range = wholeToken;
                edit.NewText = "\"" + edit.NewText + "\"";
            }
        }

        return list;
    }

    /// <summary>
    /// Test-only view of the caret classifier. Returns a compact, stable description of the context
    /// (kind, x:Bind prefix path, partial token) so hermetic tests can lock the text-scan logic —
    /// XML-comment suppression and x:Bind <c>Path=</c> handling — without a Roslyn compilation.
    /// </summary>
    internal static string ClassifyForTest(string text, int offset)
    {
        var ctx = Classify(text, offset);
        return ctx.Kind switch
        {
            ContextKind.None => "None",
            ContextKind.BindPath => (ctx.IsClassicBinding ? "ClassicBindPath" : "BindPath")
                + (string.IsNullOrEmpty(ctx.BindElementName) ? string.Empty : $"@{ctx.BindElementName}")
                + ":" + (string.IsNullOrEmpty(ctx.BindCastType)
                ? $"{ctx.BindPrefixPath}|{ctx.Partial}"
                : $"({ctx.BindCastType}){ctx.BindPrefixPath}|{ctx.Partial}"),
            ContextKind.AttributeValue => $"AttributeValue:{ctx.AttributeName}:{ctx.Partial}",
            ContextKind.StaticMember => $"StaticMember:{ctx.BindPrefixPath}:{ctx.Partial}",
            ContextKind.DesignInstanceType => $"DesignInstanceType:{ctx.BindPrefixPath}:{ctx.Partial}",
            _ => $"{ctx.Kind}:{ctx.Partial}",
        };
    }

    /// <summary>
    /// Hermetic hook for close-tag completion: exercises <see cref="CompleteCloseTag"/> end to end
    /// (classify → target resolution → item) WITHOUT a Roslyn compilation, since the close-tag path is
    /// resolved purely from the parsed AST. Returns one <c>label=&gt;newText</c> string per emitted item
    /// (empty when the context is not a close tag or no target is found).
    /// </summary>
    internal static IReadOnlyList<string> CloseTagItemsForTest(string text, int offset)
    {
        var doc = new TextDocument("test://close-tag", text);
        var ctx = Classify(doc.Text, offset);
        if (ctx.Kind != ContextKind.CloseTag)
        {
            return System.Array.Empty<string>();
        }

        var replaceRange = doc.RangeOf(new TextSpan(ctx.ReplaceStart, offset));
        var list = CompleteCloseTag(doc, offset, ctx.ReplaceStart, replaceRange);
        var result = new List<string>();
        foreach (var item in list.Items)
        {
            result.Add($"{item.Label}=>{item.TextEdit?.NewText ?? item.InsertText}");
        }

        return result;
    }

    // --- Element name -----------------------------------------------------------------------------

    private static CompletionList CompleteElementName(
        TextDocument doc, Context ctx, XamlNamespaceScope scope, XamlTypeSystem typeSystem, Lsp.Range replaceRange, ITypeSymbol? contentType = null)
    {
        SplitQualified(ctx.Partial, out var prefix, out var local);
        if (!scope.TryResolvePrefix(prefix, out var uri))
        {
            return new CompletionList();
        }

        var items = new List<CompletionItem>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var type in typeSystem.GetTypes(uri))
        {
            if (!StartsWith(type.Name, local) || !seen.Add(type.Name))
            {
                continue;
            }

            // Inside a collection property element (e.g. <Grid.RowDefinitions>) scope suggestions to
            // types assignable to the element/content type, matching Visual Studio.
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

        // The XAML language namespace has no CLR-namespace binding, so its intrinsic aliases (x:String,
        // x:Double, x:Boolean, …) are absent from GetTypes above. Offer them as ELEMENTS for any prefix
        // resolving to that URI (typically x:, but a custom prefix mapped to it is equally valid). Unlike
        // the class-only CLR element list, ALL 14 intrinsics are offered (allTypeKinds:true) — XAML has
        // first-class support for instantiating the value-type intrinsics as elements (e.g.
        // <x:Double x:Key="W">42</x:Double>), exactly as Visual Studio offers them, so we deliberately do
        // NOT mirror GetTypes' class-only policy here. The content-type assignability filter still applies
        // so a typed collection property element only offers assignable intrinsics.
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

        // Third-party (NuGet) controls: for an UNPREFIXED partial, also offer DependencyObject-derived types
        // from referenced assemblies whose namespace is NOT reachable via the default xmlns (e.g. the Windows
        // Community Toolkit's SettingsCard). Accepting one inserts a prefixed name AND auto-injects the xmlns
        // on the root via AdditionalTextEdits — the developer-experience gap VS closes but the raw type list
        // above does not. Gated to the unprefixed case (the primary VS gesture); a type already reachable via
        // a declared prefix reuses that prefix with no injection.
        if (prefix.Length == 0)
        {
            AddReferencedElementTypes(doc, items, seen, local, scope, typeSystem, replaceRange, contentType);
        }

        return Finish(items);
    }

    /// <summary>
    /// Adds third-party (referenced-assembly) element types to an UNPREFIXED element-name completion list,
    /// each carrying an <see cref="CompletionItem.AdditionalTextEdits"/> that declares the required xmlns on
    /// the root when the type's namespace isn't already declared. Skips types reachable via the default
    /// xmlns (WinUI's own types, already offered above) and honors the collection content-type filter.
    /// </summary>
    private static void AddReferencedElementTypes(
        TextDocument doc, List<CompletionItem> items, HashSet<string> seen, string local,
        XamlNamespaceScope scope, XamlTypeSystem typeSystem, Lsp.Range replaceRange, ITypeSymbol? contentType)
    {
        var candidates = typeSystem.GetReferencedElementTypes();
        if (candidates.Count == 0)
        {
            return;
        }

        // Namespaces reachable through the DEFAULT xmlns (WinUI's own types) — offered unprefixed already, so
        // excluded here. A candidate in one of these is a framework type, not a third-party control.
        var defaultReachable = new HashSet<string>(StringComparer.Ordinal);
        if (scope.TryResolvePrefix(string.Empty, out var defaultUri))
        {
            foreach (var clrNs in typeSystem.ClrNamespacesForUri(defaultUri))
            {
                defaultReachable.Add(clrNs);
            }
        }

        // CLR namespace -> the prefix already declared for it, so a type in an explicitly-declared third-party
        // namespace reuses that prefix (no duplicate xmlns injection).
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
                    // No root element to anchor the xmlns to — offering the type would produce an
                    // undeclared prefix, so skip it.
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

    /// <summary>
    /// Generates a fresh xmlns prefix for a CLR namespace — the last dotted segment lowercased (e.g.
    /// <c>CommunityToolkit.WinUI.Controls</c> → <c>controls</c>), with a numeric suffix on collision with an
    /// already-declared prefix so the injected declaration is unambiguous.
    /// </summary>
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

    /// <summary>
    /// Builds the <c>AdditionalTextEdits</c> entry that declares <c>xmlns:PREFIX="using:NAMESPACE"</c> on the
    /// root element — grouped after any existing xmlns declarations, otherwise right after the root name (a
    /// single zero-width insertion, so existing formatting is untouched). Mirrors
    /// <c>XamlCodeActions.TryGetRootXmlnsInsertion</c>. Null when the document has no root element to anchor to.
    /// </summary>
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

    /// <summary>
    /// Completes an end tag (<c>&lt;/…</c>) with the name of the element it is closing, so typing
    /// <c>&lt;/</c> inside an open <c>&lt;Grid&gt;</c> offers <c>Grid</c> and yields <c>&lt;/Grid&gt;</c>
    /// (VS-style close-tag completion). The target is resolved purely from the AST via two cases:
    /// <list type="number">
    /// <item>The name typed after <c>&lt;/</c> is already a complete match for an open element, so the
    /// tolerant parser has recorded a terminated-or-unterminated end tag whose span starts at this exact
    /// <c>&lt;</c>. That element is the target — even when an <em>outer</em> element is still unclosed
    /// (e.g. <c>&lt;Outer&gt;&lt;Grid&gt;&lt;/Grid|</c> completes <c>Grid</c>, not <c>Outer</c>). This
    /// keeps the suggestion stable through the last keystroke of the name and appends the missing
    /// <c>&gt;</c> (or reuses one already present).</item>
    /// <item>Otherwise (empty, partial, or mismatched name) the parser leaves the element unclosed and
    /// absorbs the half-typed <c>&lt;/</c> into its span, so the target is the innermost element whose
    /// span contains the caret and which is neither self-closing nor already matched by an end tag.</item>
    /// </list>
    /// Self-closed siblings and already-closed ancestors are skipped automatically; when nothing needs
    /// closing (every enclosing element is already closed and this <c>&lt;/</c> matches none of them) no
    /// suggestion is offered — the completion never guesses a name that would not actually balance the
    /// markup. Prefixed (<c>local:Foo</c>) and dotted property-element (<c>Grid.RowDefinitions</c>) names
    /// are offered whole.
    /// </summary>
    private static CompletionList CompleteCloseTag(TextDocument doc, int offset, int nameStart, Lsp.Range replaceRange)
    {
        // The '<' that opened this end tag sits two chars before the name ("</").
        int lt = nameStart - 2;

        XamlElement? target = null;

        // Case 1: the caret is inside an end tag whose name already matches an open element, so the
        // parser has attached an EndTagSpan starting exactly at this "</". Prefer that element — it is
        // the one being closed here, even if an outer element remains unclosed.
        foreach (var node in doc.Parsed.DescendantNodesAndSelf())
        {
            if (node is XamlElement e && e.Name is not null &&
                e.EndTagSpan.HasValue && e.EndTagSpan.Value.Start == lt)
            {
                target = e;
                break;
            }
        }

        // Case 2: no matching end tag yet (empty/partial/mismatched name) — the parser left the element
        // unclosed and absorbed the "</" into its span. Target the innermost such element at the caret.
        if (target is null)
        {
            foreach (var node in doc.Parsed.DescendantNodesAndSelf())
            {
                if (node is not XamlElement e || e.Name is null || e.IsClosed)
                {
                    continue;
                }

                // End inclusive: the caret sits at the edit point, which for the innermost unclosed
                // element is exactly its span end (the parser absorbs the "</" into that span).
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
        // Append '>' only when the caret is not already immediately before one — VS Code's '<'
        // auto-closing pair frequently leaves a ">" that typing "/" turns into "</>", and we should
        // reuse it rather than produce "</Grid>>".
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

    /// <summary>
    /// When the caret is a child position (<c>&lt;|</c>) inside another element, resolves the type its
    /// children must be assignable to, so element-name completion offers only valid child types (VS parity):
    /// <list type="bullet">
    /// <item>Inside a <b>property element</b> (<c>&lt;Grid.RowDefinitions&gt;</c>) — the element type of the
    /// collection property (<c>RowDefinition</c>), otherwise the property's own type.</item>
    /// <item>Inside a plain <b>object element</b> (<c>&lt;Grid&gt;</c>, <c>&lt;StackPanel&gt;</c>) — the
    /// element type of the element's <c>[ContentProperty]</c>, so a panel narrows its children to
    /// <c>UIElement</c> (filtering out non-visual types like EventArgs / managers / VisualSources).</item>
    /// </list>
    /// Returns null when there is no enclosing element, the type cannot be resolved, or it does not
    /// meaningfully narrow the set (an <c>object</c> content property such as <c>ContentControl.Content</c>,
    /// or a non-class content type), leaving the full list.
    /// </summary>
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
        var element = FindEnclosingElement(doc.Parsed.FindNode(Math.Max(0, offset - 1)));
        if (element?.Name is null)
        {
            return new CompletionList();
        }

        // When the completed name is not already followed by '=', append a ="$0" snippet so accepting an
        // attribute name lands the caret inside freshly-inserted quotes (VS parity). The name range extends
        // to the end of the current name token so a mid-name accept replaces the whole token, not just the
        // text before the caret.
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

        AddContainerAttachedProperties(items, element, existing, ctx.Partial, scope, typeSystem, nameReplaceRange, appendValue);

        return Finish(items);
    }

    /// <summary>
    /// Also offers the nearest ancestor container's attached properties (e.g. <c>Grid.Row</c>/<c>Grid.Column</c>
    /// on a child of a <c>&lt;Grid&gt;</c>) in a child's attribute-name list — VS/Blend surface the parent
    /// panel's attached properties directly so the author need not remember the owner type. Items are qualified
    /// (<c>Owner.Member</c>) and ranked AFTER the element's own members. Matches the typed partial against the
    /// member name OR the qualified name so both "type Row" and "type Grid" surface the item; deduped against
    /// attributes already present and self-limiting (a container with no attached properties adds nothing).
    /// </summary>
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

    /// <summary>
    /// The nearest ancestor OBJECT element of <paramref name="element"/> (skipping property elements such as
    /// <c>&lt;Grid.RowDefinitions&gt;</c>) — i.e. the containing panel/control whose attached properties may
    /// be set on <paramref name="element"/>. Null for the document root (no container).
    /// </summary>
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

    /// <summary>
    /// Completes the members of a dotted attached-property partial (<c>Owner.member</c>) as
    /// <c>Owner.Member</c> items — shared by attribute-name completion (which passes
    /// <paramref name="appendValue"/> to append a <c>="$0"</c> snippet) and the <c>Setter Property="Owner."</c>
    /// value context (which keeps the default <c>false</c> since the name goes inside an existing quote).
    /// </summary>
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

        // A scalar value completion (enum, bool, GridLength, named color) replaces the WHOLE value token —
        // the prefix before the caret AND any suffix after it — so accepting one mid-token (Corn|silk ->
        // Cornsilk) never leaves a dangling tail. At an end-of-token caret the token end equals the caret,
        // so this is identical to replaceRange there; only mid-token accepts differ. Element/type/name-valued
        // completions keep the prefix-only replaceRange (their reference pattern is unchanged).
        var valueReplaceRange = doc.RangeOf(new TextSpan(ctx.ReplaceStart, ValueTokenEnd(doc.Text, offset)));

        var element = FindEnclosingElement(doc.Parsed.FindNode(Math.Max(0, offset - 1)));
        if (element?.Name is null)
        {
            return new CompletionList();
        }

        // <Setter Property="|"> inside a Style/ControlTemplate completes the settable property names
        // of the target type (VS parity), resolved from the ancestor's TargetType.
        if (element.Name is { HasPrefix: false, LocalName: "Setter" } &&
            string.Equals(ctx.AttributeName, "Property", StringComparison.Ordinal))
        {
            return CompleteSetterProperty(element, ctx.Partial, scope, typeSystem, replaceRange);
        }

        // <Setter Value="|"> completes enum members / booleans typed by the sibling Property= on the
        // enclosing TargetType (VS parity) — Setter.Value itself is declared 'object'.
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

        // VisualState <Setter Target="Element.Property"> (VSM setters use Target, not Property): the
        // segment before the first dot lists the x:Name'd elements in scope; segments after it list that
        // element's property members. Matches Visual Studio's VSM authoring.
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

        // RelativePanel.RightOf="Foo" (and the sibling alignment attached properties) each reference an
        // x:Name'd element in the same panel, exactly like Storyboard.TargetName — VS completes them with
        // the in-scope names. The boolean *WithPanel variants (AlignLeftWithPanel, ...) are NOT element
        // references, so they are deliberately excluded and fall through to ordinary bool/enum completion.
        if (ctx.AttributeName is { } attr && RelativePanelAlignmentTargets.Contains(attr))
        {
            return CompleteElementNames(doc, ctx.Partial, string.Empty, scope, typeSystem, replaceRange);
        }

        // Storyboard.TargetProperty="Opacity" lists the property members of the element named by the
        // sibling Storyboard.TargetName on the same animation element.
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

        // x:DataType="|" (on a DataTemplate) completes type names — the design-time item type that
        // roots {x:Bind}/{Binding} member completion inside the template (VS parity). It is an x:
        // directive, so ResolveAttributeType rejects it as a non-CLR member below; match it by name
        // here, requiring the reserved x prefix exactly as the round-53 rooting recognition does.
        // allTypeKinds: an item type may be any type (class/struct/enum/interface, incl. x:String).
        if (string.Equals(ctx.AttributeName, "x:DataType", StringComparison.Ordinal))
        {
            return CompleteTypeNameValue(ctx.Partial, scope, typeSystem, replaceRange, allTypeKinds: true);
        }

        // mc:Ignorable="d …" lists the namespace prefixes a runtime XAML processor may ignore — offer the
        // declared design-time prefixes (space-separated), the near-universal WinUI header attribute. Matched
        // by the RESOLVED markup-compatibility URI (a custom prefix mapped to it works; a foreign one does not).
        if (IsMcIgnorableAttribute(ctx.AttributeName, scope))
        {
            return CompleteMcIgnorable(doc, offset, ctx, scope, replaceRange);
        }

        // Event attribute (Click="|") -> candidate handler methods on the x:Class code-behind. Checked
        // before ResolveAttributeType because an event resolves to its (non-null) delegate type.
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

        // Any System.Type-valued attribute (e.g. TargetType on custom types) completes type names.
        if (valueType is INamedTypeSymbol { Name: "Type", ContainingNamespace.Name: "System" })
        {
            return CompleteTypeNameValue(ctx.Partial, scope, typeSystem, replaceRange);
        }

        // Scalar (keyword/named) value completers keyed purely on the value type — enum, bool, GridLength,
        // named color, named font weight. Shared with the Setter.Value path so both stay in lockstep.
        if (TryCompleteScalarValue(valueType, ctx.Partial, typeSystem, valueReplaceRange) is { } scalar)
        {
            return scalar;
        }

        return new CompletionList();
    }

    /// <summary>
    /// Completes a scalar attribute value from its resolved value TYPE — the set of value completers that
    /// depend only on the type: enum members, booleans, <c>GridLength</c> keywords (Auto/*), the WinUI
    /// named colors (for <c>Brush</c>/<c>Color</c>), and the WinUI named font weights (for
    /// <c>FontWeight</c>). Shared by ordinary attribute-value completion and <c>&lt;Setter Value="…"&gt;</c>
    /// (whose value type comes from the sibling <c>Property=</c> on the enclosing <c>TargetType</c>), so a
    /// property completes identically whether it's set directly or through a Style setter — matching Visual
    /// Studio. Returns <see langword="null"/> when the type isn't one this handles, so the caller falls
    /// through to its own default (an empty list). The caller passes an already-nullable-unwrapped type and
    /// the whole-token <paramref name="valueReplaceRange"/> (so mid-token accepts stay clean).
    /// </summary>
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

        // GridLength-typed value (RowDefinition.Height / ColumnDefinition.Width) — offer the two keyword
        // sizings VS/Blend surface (Auto, *). FrameworkElement.Width/Height are 'double' (not GridLength),
        // so they correctly fall through to the empty list below.
        if (IsGridLength(valueType))
        {
            return CompleteGridLength(partial, valueReplaceRange);
        }

        // Brush/Color-typed value (Foreground/Background/BorderBrush/…, SolidColorBrush.Color, GradientStop.Color)
        // — offer the WinUI named colors (Red, CornflowerBlue, …, Transparent) with a swatch, as VS/Blend do.
        // {StaticResource}/{Binding}/… markup values route to the markup classifiers, never here; a hex like
        // #FF0000 stays free-form (no named color starts with '#').
        if (IsBrush(valueType) || IsColor(valueType))
        {
            return CompleteNamedColor(partial, typeSystem, valueReplaceRange);
        }

        // FontWeight-typed value (Control.FontWeight, TextBlock.FontWeight, …) — offer the named weights
        // (Thin, Light, Normal, SemiBold, Bold, …, ExtraBlack) from Microsoft.UI.Text.FontWeights, as VS/Blend
        // do. The numeric form (FontWeight="700") stays free-form (no named weight starts with a digit).
        if (IsFontWeight(valueType))
        {
            return CompleteFontWeight(partial, typeSystem, valueReplaceRange);
        }

        return null;
    }

    /// <summary>
    /// Completes type names for a type-valued attribute (e.g. <c>Style.TargetType</c>). Mirrors
    /// element-name completion — split an optional prefix, resolve it, and offer the namespace's types —
    /// but emits the bare (or <c>prefix:</c>-qualified) type name suitable for an attribute value.
    /// </summary>
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

        // The XAML language namespace has no CLR-namespace binding, so its intrinsic aliases (x:String,
        // x:Boolean, …) are not in GetTypes/GetAllTypes above. Offer them for any reference whose prefix
        // resolves to that URI (typically x:, but a custom prefix mapped to the same URI is equally valid).
        // Pass allTypeKinds so intrinsics are kind-filtered identically to the CLR types above — a
        // class-only site (TargetType) offers Object/String/Uri/Type but not value-type aliases (x:Int32).
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

    /// <summary>
    /// Completes <c>&lt;Setter Property="|"&gt;</c> with the settable properties of the enclosing
    /// <c>Style</c>/<c>ControlTemplate</c>'s <c>TargetType</c>, matching Visual Studio.
    /// </summary>
    private static CompletionList CompleteSetterProperty(
        XamlElement setter, string partial, XamlNamespaceScope scope, XamlTypeSystem typeSystem, Lsp.Range replaceRange)
    {
        // "Owner.member" partial -> attached-property completion (e.g. Property="Grid.Row"). Attached
        // properties are settable regardless of the Style's TargetType, so this is independent of it.
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

    /// <summary>
    /// Walks up from a node to the nearest <c>Style</c> or <c>ControlTemplate</c> element and resolves
    /// its <c>TargetType</c> attribute value to a type symbol. Returns null when absent or unresolvable.
    /// </summary>
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

            // TargetType may be a bare/prefixed name ("Button", "local:Foo") or the {x:Type Button}
            // markup-extension wrapper; normalize both to a qualified name before resolving.
            var typeToken = NormalizeTypeToken(text!);
            if (typeToken is null)
            {
                return null;
            }

            return ResolveElementType(ParseQualified(typeToken), scope, typeSystem);
        }

        return null;
    }

    /// <summary>
    /// Resolves the value type of a <c>&lt;Setter Value="..."&gt;</c> from its sibling <c>Property=</c>
    /// against the enclosing <c>Style</c>/<c>ControlTemplate</c> <c>TargetType</c> — the simple member's
    /// type, or an attached property's type for a dotted <c>Owner.Member</c> Property. Null when unknown.
    /// </summary>
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

    /// <summary>
    /// Completes a VisualState <c>&lt;Setter Target="Element.Property"&gt;</c> value. Before the first dot
    /// the segment lists the x:Name'd elements in scope; after it, the referenced element's property
    /// members (walking further dotted segments through their property types). VS parity for VSM setters.
    /// </summary>
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

    /// <summary>
    /// Completes a <c>Storyboard.TargetProperty="..."</c> value with the property members of the element
    /// named by the sibling <c>Storyboard.TargetName</c> on the same animation element. VS parity.
    /// </summary>
    private static CompletionList CompleteStoryboardTargetProperty(
        TextDocument doc, XamlElement animation, string partial,
        XamlNamespaceScope scope, XamlTypeSystem typeSystem, Lsp.Range replaceRange)
    {
        // A parenthesized (Owner.Property) qualifier names its owner type EXPLICITLY, so it is resolved
        // independently of Storyboard.TargetName — try it before rooting at the target element.
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

    /// <summary>
    /// When the caret sits inside an unclosed parenthesized <c>(Owner.Property)</c> qualifier of a
    /// <c>Storyboard.TargetProperty</c> path, completes the members of the EXPLICITLY named owner type
    /// (resolved through the namespace scope), independently of the <c>Storyboard.TargetName</c> element —
    /// VS parity for attached/qualified animation targets such as <c>(Canvas.Left)</c>, <c>(UIElement.Opacity)</c>
    /// or a chained <c>(UIElement.RenderTransform).(CompositeTransform.TranslateX)</c>. Both the owner's
    /// instance dependency properties AND its attached properties are offered (either form is valid). Returns
    /// <c>null</c> when the caret is not inside such a group (the caller then roots at the target element); an
    /// EMPTY list — never the element's members — while the owner type is still being typed or unresolvable.
    /// </summary>
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

        // A further dotted sub-path ("(Owner.Sub.Member") walks instance property types (attached
        // properties never appear past the first segment), reusing the shared property-path walker.
        if (memberPartial.IndexOf('.') >= 0)
        {
            return CompletePropertyPath(ownerType, memberPartial, prefix, typeSystem, replaceRange);
        }

        // First member after the owner dot: offer BOTH the owner's instance properties and its attached
        // properties, both filtered by the partial, deduped, with the "(Owner." prefix preserved verbatim.
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

    /// <summary>
    /// Completes the x:Name'd elements declared anywhere in the document (x:Name scope is per-file),
    /// filtered by <paramref name="partial"/> and emitted with <paramref name="prefix"/> preserved in the
    /// inserted text. Used by element-name references (Storyboard.TargetName, VSM Setter Target).
    /// </summary>
    /// <summary>
    /// The RelativePanel attached properties whose value is a reference to an x:Name'd sibling element
    /// (as opposed to the boolean <c>*WithPanel</c> variants). Each completes with the in-scope element
    /// names, mirroring <c>Storyboard.TargetName</c> / <c>Binding.ElementName</c>.
    /// </summary>
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

    /// <summary>
    /// Completes a dotted property path from a root type: fully resolves the segments before the last dot
    /// through their property types, then offers the property members of the resulting owner type matching
    /// the final partial. Each item's inserted text preserves <paramref name="prefix"/> plus the resolved
    /// intermediate segments so replacement over the whole value stays consistent.
    /// </summary>
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

    /// <summary>
    /// Resolves an x:Name reference to the declaring element's type symbol, or null when the name is not
    /// declared in the document or its type cannot be resolved. Internal so the language server can root
    /// VSM Setter.Target / Storyboard.TargetProperty member F12/hover at the referenced element's type.
    /// </summary>
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

    /// <summary>
    /// Enumerates every element carrying an <c>x:Name</c> (or <c>Name</c>) literal, paired with its name,
    /// by walking the document tree. x:Name scope is the whole file, so enumeration starts at the root.
    /// </summary>
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

    /// <summary>
    /// Completes <c>{TemplateBinding |}</c> with the settable properties of the enclosing
    /// <c>ControlTemplate</c>'s <c>TargetType</c> (the templated parent), matching Visual Studio.
    /// </summary>
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

    /// <summary>
    /// Completes the value of an event attribute (<c>Click="|"</c>) with candidate handler methods on
    /// the page's <c>x:Class</c> code-behind — ordinary methods whose signature matches the event's
    /// delegate (same parameter count, <c>void</c>-returning), matching Visual Studio's handler picker.
    /// </summary>
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

            // When the delegate signature is known, require the same arity so unrelated helper methods
            // on the page class don't pollute the handler list.
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
    private static readonly (string Name, string Detail)[] MarkupExtensions =
    {
        ("x:Bind", "Compiled binding to a field/property (page x:Class or template x:DataType)"),
        ("Binding", "Runtime binding through the element's DataContext"),
        ("StaticResource", "Resource reference resolved once at load time"),
        ("ThemeResource", "Resource reference re-evaluated when the theme changes"),
        ("TemplateBinding", "Binds to a property on the templated parent"),
        ("RelativeSource", "Source relative to the target (Self / TemplatedParent)"),
        ("x:Static", "References a static field, property, or constant"),
        ("x:Type", "A System.Type reference for the named type"),
        ("x:Null", "The null value"),
    };

    private static CompletionList CompleteMarkupName(Context ctx, Lsp.Range replaceRange)
    {
        var items = new List<CompletionItem>();
        foreach (var (name, detail) in MarkupExtensions)
        {
            if (!StartsWith(name, ctx.Partial))
            {
                continue;
            }

            items.Add(new CompletionItem
            {
                Label = name,
                Kind = CompletionItemKind.Keyword,
                Detail = detail,
                TextEdit = new TextEdit { Range = replaceRange, NewText = name },
                FilterText = name,
                SortText = name,
            });
        }

        return Finish(items);
    }

    /// <summary>
    /// Completes a markup extension's named arguments: the argument NAMES when no <c>=</c> has been typed
    /// (e.g. <c>{RelativeSource |}</c> -> Mode), or an enum/bool VALUE after <c>Name=</c>. The value's type
    /// is resolved from the argument on the extension's own type, so <c>RelativeSource.Mode</c> offers
    /// <c>RelativeSourceMode</c> while <c>Binding.Mode</c>/<c>x:Bind Mode</c> offer <c>BindingMode</c>.
    /// </summary>
    private static CompletionList CompleteMarkupArg(TextDocument doc, Context ctx, XamlTypeSystem typeSystem, Lsp.Range replaceRange)
    {
        var extensionType = ResolveMarkupExtensionType(ctx.MarkupExtension, typeSystem);

        // Argument-name completion: offer the extension type's settable property names.
        if (string.IsNullOrEmpty(ctx.AttributeName))
        {
            // x:Bind/Bind is compiled and has no runtime extension type to reflect over, so offer its
            // curated named arguments (Mode, Converter, FallbackValue, ...) directly.
            if (IsBindExtension(ctx.MarkupExtension))
            {
                var bindNames = new List<CompletionItem>();
                var bindingType = typeSystem.ResolveMetadataType(BindingMetadataName);
                foreach (var name in XBindArgumentNames)
                {
                    if (!StartsWith(name, ctx.Partial))
                    {
                        continue;
                    }

                    var bindingMember = bindingType is null ? null : typeSystem.FindMember(bindingType, name);
                    bindNames.Add(new CompletionItem
                    {
                        Label = name,
                        Kind = CompletionItemKind.Property,
                        Detail = XBindArgumentDetail(name, bindingMember),
                        Documentation = XBindArgumentDoc(name, bindingMember),
                        TextEdit = new TextEdit { Range = replaceRange, NewText = name },
                        FilterText = name,
                        SortText = name,
                    });
                }

                return Finish(bindNames);
            }

            if (extensionType is null)
            {
                return new CompletionList();
            }

            var names = new List<CompletionItem>();
            foreach (var member in typeSystem.GetMembers(extensionType))
            {
                if (member.Kind != XamlMemberKind.Property || !StartsWith(member.Name, ctx.Partial))
                {
                    continue;
                }

                names.Add(new CompletionItem
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

            return Finish(names);
        }

        // Argument-value completion: resolve the argument's type on the extension, complete enum members.

        // ElementName=<caret> (classic {Binding ElementName=...}) completes the x:Name'd elements in the doc.
        if (string.Equals(ctx.AttributeName, "ElementName", StringComparison.OrdinalIgnoreCase))
        {
            return CompleteNamedElements(doc, ctx.Partial, replaceRange);
        }

        var argType = extensionType is null
            ? null
            : typeSystem.FindMember(extensionType, ctx.AttributeName!)?.Type;

        // {x:Bind}/{Bind} is compiled and has no reflectable runtime extension type, so its enum-typed
        // named arguments (Mode, UpdateSourceTrigger — the ones offered by XBindArgumentNames) resolve to
        // null above; fall back to the curated CLR enum for the argument so its value still completes. GATED
        // to the compiled-binding extensions: a classic {Binding} resolves these through its extension type
        // (argType already non-null), and a non-binding extension ({StaticResource}, {TemplateBinding},
        // {x:Null}, …) must NOT borrow the binding enums for a bogus same-named argument.
        if (argType is null &&
            IsBindExtension(ctx.MarkupExtension) &&
            ctx.AttributeName is { } argName &&
            BindEnumArgumentTypes.TryGetValue(argName, out var enumMetadataName))
        {
            argType = typeSystem.ResolveMetadataType(enumMetadataName);
        }

        if (argType is { TypeKind: TypeKind.Enum })
        {
            return CompleteEnumValue(argType, ctx.Partial, replaceRange);
        }

        if (argType is { SpecialType: SpecialType.System_Boolean })
        {
            return CompleteBooleanValue(ctx.Partial, replaceRange);
        }

        return new CompletionList();
    }

    /// <summary>Completes the <c>x:Name</c>'d elements declared in the document (for <c>ElementName=</c>).</summary>
    private static CompletionList CompleteNamedElements(TextDocument doc, string partial, Lsp.Range replaceRange)
    {
        var items = new List<CompletionItem>();
        if (doc.Parsed.Root is { } root)
        {
            foreach (var (name, typeName) in CollectNamedElements(root))
            {
                if (!StartsWith(name, partial))
                {
                    continue;
                }

                items.Add(new CompletionItem
                {
                    Label = name,
                    Kind = CompletionItemKind.Field,
                    Detail = typeName,
                    TextEdit = new TextEdit { Range = replaceRange, NewText = name },
                    FilterText = name,
                    SortText = name,
                });
            }
        }

        return Finish(items);
    }

    /// <summary>Walks the AST yielding each element's <c>x:Name</c>/<c>Name</c> value and its element type name.</summary>
    private static IEnumerable<(string Name, string TypeName)> CollectNamedElements(XamlElement element)
    {
        var attr = element.GetAttribute("x:Name") ?? element.GetAttribute("Name");
        var text = attr?.Value?.Text?.Trim();
        if (!string.IsNullOrEmpty(text) && attr?.Value is { IsMarkupExtension: false })
        {
            yield return (text!, element.Name is { LocalName.Length: > 0 } n ? n.FullName : string.Empty);
        }

        foreach (var child in element.Content)
        {
            if (child is XamlElement childElement)
            {
                foreach (var hit in CollectNamedElements(childElement))
                {
                    yield return hit;
                }
            }
        }
    }

    /// <summary>Resolves a markup extension name to its CLR type (for named-argument completion). Null for x:Bind.</summary>
    private static INamedTypeSymbol? ResolveMarkupExtensionType(string? extension, XamlTypeSystem typeSystem)
    {
        if (string.IsNullOrEmpty(extension))
        {
            return null;
        }

        return extension switch
        {
            "RelativeSource" => typeSystem.ResolveMetadataType("Microsoft.UI.Xaml.Data.RelativeSource"),
            "Binding" => typeSystem.ResolveMetadataType("Microsoft.UI.Xaml.Data.Binding"),
            _ => null,
        };
    }

    /// <summary>The named arguments of a compiled <c>{x:Bind}</c> expression, offered for arg-name completion.</summary>
    private static readonly string[] XBindArgumentNames =
    {
        "Mode",
        "Converter",
        "ConverterParameter",
        "ConverterLanguage",
        "FallbackValue",
        "TargetNullValue",
        "BindBack",
        "UpdateSourceTrigger",
    };

    /// <summary>Metadata name of the classic binding type whose properties back the curated x:Bind arg names.</summary>
    private const string BindingMetadataName = "Microsoft.UI.Xaml.Data.Binding";

    /// <summary>
    /// Documentation for the x:Bind-only <c>BindBack</c> argument, which has no classic <c>Binding</c>
    /// property to borrow a <c>&lt;summary&gt;</c> from (compiled two-way bindings write the value back
    /// through this function rather than a reflected setter).
    /// </summary>
    private static readonly MarkupContent BindBackDoc = new()
    {
        Value = "Specifies the function called to write the value back to the source in a TwoWay compiled binding.",
    };

    /// <summary>
    /// The completion Detail (popup type-hint header) for the x:Bind-only <c>BindBack</c> argument. The other
    /// curated names borrow the classic <c>Binding</c> property's <c>property : Type</c> detail via
    /// <see cref="DescribeMember"/>; BindBack takes a write-back method rather than a typed property.
    /// </summary>
    private const string BindBackDetail = "method";

    /// <summary>
    /// The documentation flyout for a curated <c>{x:Bind}</c> named argument. All but <c>BindBack</c> mirror a
    /// property on the classic <c>Binding</c> type, so their <c>&lt;summary&gt;</c> is reused verbatim (the
    /// <paramref name="bindingMember"/> the caller already resolved) — completion reads identically to the
    /// classic <c>{Binding}</c> arg-name flyout. Returns null when the member could not be resolved (purely
    /// additive — the item's documentation is simply omitted).
    /// </summary>
    private static MarkupContent? XBindArgumentDoc(string argName, XamlMemberInfo? bindingMember) =>
        string.Equals(argName, "BindBack", StringComparison.Ordinal)
            ? BindBackDoc
            : CompletionDoc(bindingMember?.Symbol);

    /// <summary>
    /// The completion Detail (the dimmed type-hint header beside the popup) for a curated <c>{x:Bind}</c>
    /// named argument — the same <c>property : Type</c> string the classic <c>{Binding}</c> arg name shows,
    /// off the SAME resolved <paramref name="bindingMember"/>, so x:Bind reaches Detail parity with Binding.
    /// <c>BindBack</c> (x:Bind-only, no Binding property) gets a small curated detail. Returns null when the
    /// member could not be resolved (purely additive — the item's detail is simply omitted).
    /// </summary>
    private static string? XBindArgumentDetail(string argName, XamlMemberInfo? bindingMember) =>
        string.Equals(argName, "BindBack", StringComparison.Ordinal)
            ? BindBackDetail
            : bindingMember is null ? null : DescribeMember(bindingMember);

    /// <summary>
    /// The enum-typed <c>{x:Bind}</c> named arguments mapped to their CLR enum metadata name. Compiled
    /// bindings have no reflectable extension type, so <see cref="CompleteMarkupArg"/> uses this to complete
    /// the argument VALUE (e.g. <c>UpdateSourceTrigger=|</c> -&gt; Default/PropertyChanged/Explicit/LostFocus)
    /// after <see cref="XBindArgumentNames"/> offers the argument NAME. Keyed case-insensitively to mirror the
    /// argument-name match. Only enum-typed args belong here; object/string/method args have no value list.
    /// </summary>
    private static readonly Dictionary<string, string> BindEnumArgumentTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Mode"] = "Microsoft.UI.Xaml.Data.BindingMode",
        ["UpdateSourceTrigger"] = "Microsoft.UI.Xaml.Data.UpdateSourceTrigger",
    };

    /// <summary>True for the compiled-binding extension in either its prefixed (<c>x:Bind</c>) or bare (<c>Bind</c>) form.</summary>
    private static bool IsBindExtension(string? extension) =>
        string.Equals(extension, "x:Bind", StringComparison.Ordinal) ||
        string.Equals(extension, "Bind", StringComparison.Ordinal);

    // --- Resource keys ({StaticResource | ThemeResource key}) -------------------------------------

    /// <summary>
    /// Completes the key of a <c>{StaticResource}</c>/<c>{ThemeResource}</c> reference from the
    /// <c>x:Key</c>d resources defined in this document plus the project's App.xaml (passed in). App-wide
    /// resource dictionaries beyond App.xaml and framework theme resources are future work.
    /// </summary>
    private static CompletionList CompleteResourceKey(
        TextDocument doc,
        int offset,
        Context ctx,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem,
        IReadOnlyCollection<string>? appResourceKeys,
        Lsp.Range replaceRange)
    {
        var projectKeys = new SortedSet<string>(StringComparer.Ordinal);
        if (doc.Parsed.Root is { } root)
        {
            CollectResourceKeysCore(root, projectKeys);
        }

        if (appResourceKeys != null)
        {
            foreach (var key in appResourceKeys)
            {
                projectKeys.Add(key);
            }
        }

        // The property the reference feeds, so framework theme keys of an incompatible type are hidden
        // (VS parity). Null => offer every key (nested reference, unresolved property, or an 'object'
        // property such as Tag/Setter.Value where any resource is valid).
        var targetType = ResolveResourceTargetType(doc, offset, ctx, scope, typeSystem);

        // The document-local keys mapped to their declaring element, so an author key of a definitely
        // incompatible type is scoped away too (VS parity). App.xaml keys carry no element here, so they
        // stay always-offered — no author key is ever hidden on a mere absence of type information.
        var docLocalDecls = doc.Parsed.Root is { } declRoot
            ? CollectDocLocalKeyDeclarations(declRoot)
            : new Dictionary<string, XamlElement>(StringComparer.Ordinal);

        var items = new List<CompletionItem>();

        // Project-defined resources first (document-local + App.xaml); the "0" sort group keeps them
        // above the framework keys, which are grouped under "1". A document-local author key is offered
        // unless its declaring element's type is KNOWN and definitely incompatible with the target; App.xaml
        // keys (no declaring element) and any un-resolvable/ambiguous declaration are ALWAYS offered.
        foreach (var key in projectKeys)
        {
            if (!StartsWith(key, ctx.Partial))
            {
                continue;
            }

            if (docLocalDecls.TryGetValue(key, out var decl) &&
                (appResourceKeys is null || !appResourceKeys.Contains(key)) &&
                !AuthorKeyMatchesTarget(decl, targetType, scope, typeSystem))
            {
                continue;
            }

            items.Add(ResourceKeyItem(key, "resource", "0", replaceRange));
        }

        // Common WinUI theme resources, skipping any the project already redefines under the same key,
        // and any whose (suffix-inferred) type is definitely not assignable to the target property.
        foreach (var key in WinUiThemeResources.Keys)
        {
            if (!projectKeys.Contains(key) && StartsWith(key, ctx.Partial) &&
                ThemeKeyMatchesTarget(key, targetType, typeSystem))
            {
                items.Add(ResourceKeyItem(key, "theme resource", "1", replaceRange));
            }
        }

        return Finish(items);
    }

    /// <summary>
    /// Resolves the CLR type of the property a resource reference feeds, used to scope framework theme
    /// keys. Returns <c>null</c> (meaning "offer every key") when the reference is nested in another
    /// markup extension (no attribute captured — see <see cref="ResourceTargetAttribute"/>), the
    /// enclosing element/attribute can't be resolved, or the property is typed <c>object</c> (e.g.
    /// <c>Tag</c>, an unresolvable <c>Setter.Value</c>) where any resource is valid. <c>Nullable&lt;T&gt;</c>
    /// is unwrapped. A <c>&lt;Setter Value="…"&gt;</c> is declared <c>object</c> but VS scopes it to the
    /// property named by the sibling <c>Property=</c> on the enclosing <c>TargetType</c>, so it is resolved
    /// through the same <see cref="ResolveSetterValueType"/> the scalar Setter.Value path uses.
    /// </summary>
    private static ITypeSymbol? ResolveResourceTargetType(
        TextDocument doc, int offset, Context ctx, XamlNamespaceScope scope, XamlTypeSystem typeSystem)
    {
        if (string.IsNullOrEmpty(ctx.AttributeName))
        {
            return null;
        }

        var element = FindEnclosingElement(doc.Parsed.FindNode(Math.Max(0, offset - 1)));
        if (element?.Name is null)
        {
            return null;
        }

        var type = element.Name is { HasPrefix: false, LocalName: "Setter" } &&
                   string.Equals(ctx.AttributeName, "Value", StringComparison.Ordinal)
            ? ResolveSetterValueType(element, scope, typeSystem)
            : ResolveAttributeType(ctx.AttributeName!, element, scope, typeSystem);

        if (type is null || type.SpecialType == SpecialType.System_Object)
        {
            return null;
        }

        return UnwrapNullable(type);
    }

    /// <summary>
    /// True when a curated theme resource key should be offered for the given target property type.
    /// CONSERVATIVE: offers the key unless its inferred resource type is KNOWN and definitely NOT
    /// assignable to the target (checked in both directions so a more-derived target type — e.g. a
    /// <c>SolidColorBrush</c>-typed property vs a <c>Brush</c>-inferred key — still matches). A null
    /// target (unresolved / <c>object</c> / nested reference), an un-inferable key suffix, or a key
    /// type the SDK can't resolve all mean "always offer" — the key is never wrongly hidden.
    /// </summary>
    private static bool ThemeKeyMatchesTarget(string key, ITypeSymbol? targetType, XamlTypeSystem typeSystem)
    {
        if (targetType is null)
        {
            return true;
        }

        var metadataName = WinUiThemeResources.InferTypeMetadataName(key);
        if (metadataName is null)
        {
            return true;
        }

        var keyType = typeSystem.ResolveMetadataType(metadataName);
        if (keyType is null)
        {
            return true;
        }

        return XamlTypeSystem.IsAssignableTo(keyType, targetType) ||
               XamlTypeSystem.IsAssignableTo(targetType, keyType);
    }

    private static CompletionItem ResourceKeyItem(string key, string detail, string sortGroup, Lsp.Range replaceRange) => new()
    {
        Label = key,
        Kind = CompletionItemKind.Value,
        Detail = detail,
        TextEdit = new TextEdit { Range = replaceRange, NewText = key },
        FilterText = key,
        SortText = sortGroup + key,
    };

    /// <summary>Gathers every <c>x:Key</c> value declared anywhere in <paramref name="document"/>.</summary>
    public static List<string> CollectResourceKeys(XamlDocument document)
    {
        var keys = new HashSet<string>(StringComparer.Ordinal);
        if (document.Root is { } root)
        {
            CollectResourceKeysCore(root, keys);
        }

        return keys.ToList();
    }

    private static void CollectResourceKeysCore(XamlElement element, ISet<string> into)
    {
        foreach (var attribute in element.Attributes)
        {
            if (!attribute.IsNamespaceDeclaration &&
                attribute.Name.Prefix == "x" && attribute.Name.LocalName == "Key" &&
                attribute.Value is { } value && value.Text.Length > 0)
            {
                into.Add(value.Text);
            }
        }

        foreach (var child in element.Content)
        {
            if (child is XamlElement childElement)
            {
                CollectResourceKeysCore(childElement, into);
            }
        }
    }

    /// <summary>
    /// Maps each document-local <c>x:Key</c> value to the element that DECLARES it (the resource object
    /// element carrying the <c>x:Key</c>), so its type can be resolved to conservatively type-scope the
    /// key in resource-key completion (VS parity — the round-74 follow-on for the project's own keys). The
    /// first declaration of a name wins (a duplicate <c>x:Key</c> is itself an authoring error).
    /// </summary>
    private static Dictionary<string, XamlElement> CollectDocLocalKeyDeclarations(XamlElement root)
    {
        var map = new Dictionary<string, XamlElement>(StringComparer.Ordinal);
        CollectKeyDeclarationsCore(root, map);
        return map;
    }

    private static void CollectKeyDeclarationsCore(XamlElement element, Dictionary<string, XamlElement> into)
    {
        foreach (var attribute in element.Attributes)
        {
            if (!attribute.IsNamespaceDeclaration &&
                attribute.Name.Prefix == "x" && attribute.Name.LocalName == "Key" &&
                attribute.Value is { } value && value.Text.Length > 0)
            {
                if (!into.ContainsKey(value.Text))
                {
                    into.Add(value.Text, element);
                }
            }
        }

        foreach (var child in element.Content)
        {
            if (child is XamlElement childElement)
            {
                CollectKeyDeclarationsCore(childElement, into);
            }
        }
    }

    /// <summary>
    /// CONSERVATIVE type-scoping for the project's OWN document-local author keys (VS parity, the round-74
    /// follow-on). Offers the key unless its DECLARING element resolves to a concrete type that is KNOWN and
    /// definitely NOT assignable — checked BIDIRECTIONALLY, mirroring <see cref="ThemeKeyMatchesTarget"/> — to
    /// the target property type. A null target (unresolved / <c>object</c> / nested reference), a declaring
    /// element whose type can't be resolved (e.g. an <c>x:Double</c>/<c>x:String</c> intrinsic or an unknown
    /// type), or any doubt all mean "offer": an author's own key is NEVER wrongly hidden.
    /// </summary>
    private static bool AuthorKeyMatchesTarget(
        XamlElement declaringElement, ITypeSymbol? targetType, XamlNamespaceScope scope, XamlTypeSystem typeSystem)
    {
        if (targetType is null || declaringElement.Name is not { } name)
        {
            return true;
        }

        var keyType = ResolveElementType(name, scope, typeSystem);
        if (keyType is null)
        {
            return true;
        }

        return XamlTypeSystem.IsAssignableTo(keyType, targetType) ||
               XamlTypeSystem.IsAssignableTo(targetType, keyType);
    }


    private static CompletionList CompleteBooleanValue(string partial, Lsp.Range replaceRange)
    {
        var items = new List<CompletionItem>();
        foreach (var value in new[] { "True", "False" })
        {
            if (!StartsWith(value, partial))
            {
                continue;
            }

            items.Add(new CompletionItem
            {
                Label = value,
                Kind = CompletionItemKind.Value,
                Detail = "bool",
                TextEdit = new TextEdit { Range = replaceRange, NewText = value },
                FilterText = value,
                SortText = value,
            });
        }

        return Finish(items);
    }

    /// <summary>
    /// The end offset of the value token the caret sits in — the caret plus any trailing value characters
    /// up to the closing quote / whitespace / attribute delimiter. Scalar value completions replace the
    /// WHOLE token (see <c>valueReplaceRange</c> in <see cref="CompleteAttributeValue"/>), so a mid-token
    /// accept leaves no dangling suffix. At an end-of-token caret this returns the caret unchanged.
    /// </summary>
    private static int ValueTokenEnd(string text, int caret)
    {
        int i = caret;
        while (i < text.Length && !IsValueDelimiter(text[i]))
        {
            i++;
        }

        return i;
    }

    /// <summary>Characters that terminate an attribute value token (quotes, whitespace, XML/markup punctuation).</summary>
    private static bool IsValueDelimiter(char c) =>
        c is '"' or '\'' or '<' or '>' or '{' or '}' or '=' or '/' || char.IsWhiteSpace(c);

    /// <summary>LSP <c>InsertTextFormat.Snippet</c> — the value uses <c>$0</c>/<c>${n}</c> tab-stop syntax.</summary>
    private const int SnippetInsertFormat = 2;

    /// <summary>Index just past the attribute-name token starting/continuing at <paramref name="caret"/>.</summary>
    private static int AttributeNameTokenEnd(string text, int caret)
    {
        int i = caret;
        while (i < text.Length && IsNameChar(text[i]))
        {
            i++;
        }

        return i;
    }

    /// <summary>The first non-whitespace char at or after <paramref name="index"/>, or <c>'\0'</c> at end.</summary>
    private static char NextNonWhitespace(string text, int index)
    {
        for (int i = index; i < text.Length; i++)
        {
            if (!char.IsWhiteSpace(text[i]))
            {
                return text[i];
            }
        }

        return '\0';
    }

    /// <summary>The two keyword <c>GridLength</c> sizings VS/Blend offer; numeric px/star values stay free-form.</summary>
    private static readonly (string Value, string Detail)[] GridLengthKeywords =
    {
        ("Auto", "GridLength — size to content"),
        ("*", "GridLength — star sizing (one share of the remaining space)"),
    };

    /// <summary>True when the resolved value type is <c>Microsoft.UI.Xaml.GridLength</c> (WinUI, not WPF).</summary>
    private static bool IsGridLength(ITypeSymbol type) =>
        type is INamedTypeSymbol
        {
            Name: "GridLength",
            ContainingNamespace:
            {
                Name: "Xaml",
                ContainingNamespace: { Name: "UI", ContainingNamespace.Name: "Microsoft" }
            }
        };

    /// <summary>
    /// Completes a <c>GridLength</c>-typed attribute value (e.g. <c>&lt;RowDefinition Height="|"&gt;</c>,
    /// <c>&lt;ColumnDefinition Width="|"&gt;</c>) with the two keyword sizings Visual Studio/Blend offer:
    /// <c>Auto</c> (size to content) and <c>*</c> (star sizing). Numeric pixel/star values remain free-form.
    /// </summary>
    private static CompletionList CompleteGridLength(string partial, Lsp.Range replaceRange)
    {
        var items = new List<CompletionItem>();
        foreach (var (value, detail) in GridLengthKeywords)
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

    /// <summary>
    /// True when the resolved value type is (or derives from) <c>Microsoft.UI.Xaml.Media.Brush</c> — most brush
    /// properties are declared exactly <c>Brush</c> (Foreground/Background/BorderBrush/Fill/Stroke), but a
    /// <c>SolidColorBrush</c>-typed property is covered by walking the base chain. WinUI-only (namespace-matched),
    /// so a user's own unrelated <c>Brush</c> type is never mistaken for it.
    /// </summary>
    private static bool IsBrush(ITypeSymbol type)
    {
        for (ITypeSymbol? cur = type; cur is not null; cur = cur.BaseType)
        {
            if (cur is INamedTypeSymbol
                {
                    Name: "Brush",
                    ContainingNamespace:
                    {
                        Name: "Media",
                        ContainingNamespace:
                        {
                            Name: "Xaml",
                            ContainingNamespace: { Name: "UI", ContainingNamespace.Name: "Microsoft" }
                        }
                    }
                })
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// True when the resolved value type is <c>Windows.UI.Color</c> (the WinUI 3 color struct, e.g.
    /// <c>SolidColorBrush.Color</c>, <c>GradientStop.Color</c>). Namespace-matched so a user's own
    /// <c>Color</c> type is never mistaken for it.
    /// </summary>
    private static bool IsColor(ITypeSymbol type) =>
        type is INamedTypeSymbol
        {
            Name: "Color",
            ContainingNamespace:
            {
                Name: "UI",
                ContainingNamespace: { Name: "Windows", ContainingNamespace.IsGlobalNamespace: true }
            }
        };

    /// <summary>
    /// Completes a <c>Brush</c>/<c>Color</c>-typed attribute value with the WinUI named colors
    /// (<c>Microsoft.UI.Colors</c> — Red, CornflowerBlue, …, Transparent), matching Visual Studio/Blend.
    /// Names come from the live SDK (zero drift); each item is a <c>Color</c>-kind suggestion whose
    /// <c>Detail</c> is the color's hex (<see cref="WinUiNamedColors.HexByName"/>) so VS Code renders a swatch
    /// — a name absent from the hex map is still offered (without a swatch), so the feature degrades
    /// gracefully. Numeric/hex literals (<c>#FF0000</c>) stay free-form.
    /// </summary>
    private static CompletionList CompleteNamedColor(string partial, XamlTypeSystem typeSystem, Lsp.Range replaceRange)
    {
        var items = new List<CompletionItem>();
        foreach (var name in typeSystem.GetNamedColors())
        {
            if (!StartsWith(name, partial))
            {
                continue;
            }

            items.Add(new CompletionItem
            {
                Label = name,
                Kind = CompletionItemKind.Color,
                Detail = WinUiNamedColors.HexByName.TryGetValue(name, out var hex) ? hex : "named color",
                TextEdit = new TextEdit { Range = replaceRange, NewText = name },
                FilterText = name,
                SortText = name,
            });
        }

        return Finish(items);
    }

    /// <summary>
    /// True when the resolved value type is <c>Windows.UI.Text.FontWeight</c> (the WinUI 3 font-weight struct,
    /// e.g. <c>Control.FontWeight</c>, <c>TextBlock.FontWeight</c>). Namespace-matched so a user's own
    /// <c>FontWeight</c> type is never mistaken for it.
    /// </summary>
    private static bool IsFontWeight(ITypeSymbol type) =>
        type is INamedTypeSymbol
        {
            Name: "FontWeight",
            ContainingNamespace:
            {
                Name: "Text",
                ContainingNamespace:
                {
                    Name: "UI",
                    ContainingNamespace: { Name: "Windows", ContainingNamespace.IsGlobalNamespace: true }
                }
            }
        };

    /// <summary>
    /// Completes a <c>FontWeight</c>-typed attribute value with the WinUI named weights
    /// (<c>Microsoft.UI.Text.FontWeights</c> — Thin, Light, Normal, SemiBold, Bold, …), matching Visual
    /// Studio/Blend. Names come from the live SDK (zero drift); each item's <c>Detail</c> is the numeric
    /// weight (<see cref="WinUiFontWeights.WeightByName"/>, e.g. Bold ⇒ 700) — a name absent from that map is
    /// still offered (with a generic detail), so the feature degrades gracefully. The numeric literal form
    /// (<c>FontWeight="700"</c>) stays free-form.
    /// </summary>
    private static CompletionList CompleteFontWeight(string partial, XamlTypeSystem typeSystem, Lsp.Range replaceRange)
    {
        var items = new List<CompletionItem>();
        foreach (var name in typeSystem.GetFontWeights())
        {
            if (!StartsWith(name, partial))
            {
                continue;
            }

            items.Add(new CompletionItem
            {
                Label = name,
                Kind = CompletionItemKind.Value,
                Detail = WinUiFontWeights.WeightByName.TryGetValue(name, out var weight) ? weight : "font weight",
                TextEdit = new TextEdit { Range = replaceRange, NewText = name },
                FilterText = name,
                SortText = name,
            });
        }

        return Finish(items);
    }
    private static ITypeSymbol? ResolveAttributeType(
        string attributeName, XamlElement element, XamlNamespaceScope scope, XamlTypeSystem typeSystem)
    {
        int dot = attributeName.IndexOf('.');
        if (dot >= 0)
        {
            var ownerName = attributeName.Substring(0, dot);
            var memberName = attributeName.Substring(dot + 1);
            var owner = ResolveElementType(ParseQualified(ownerName), scope, typeSystem);
            if (owner is null)
            {
                return null;
            }

            return typeSystem.GetAttachedProperties(owner)
                .FirstOrDefault(m => string.Equals(m.Name, memberName, StringComparison.Ordinal))?.Type;
        }

        // A prefixed attribute (e.g. x:Name, x:Uid) is a language directive, not a CLR member.
        if (attributeName.IndexOf(':') >= 0 || element.Name is null)
        {
            return null;
        }

        var elementType = ResolveElementType(element.Name, scope, typeSystem);
        return elementType is null ? null : typeSystem.FindMember(elementType, attributeName)?.Type;
    }

    private static ITypeSymbol UnwrapNullable(ITypeSymbol type) =>
        type is INamedTypeSymbol { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T } named &&
        named.TypeArguments.Length == 1
            ? named.TypeArguments[0]
            : type;

    // --- x:Bind member path (compiled binding) ----------------------------------------------------

    /// <summary>
    /// Completes a member of an <c>{x:Bind path}</c> expression. The root type is the enclosing
    /// <c>DataTemplate</c>'s <c>x:DataType</c> when inside one, otherwise the page's x:Class type.
    /// Any already-typed leading path segments (before the last dot) are walked to reach the type
    /// whose members are offered.
    /// </summary>
    private static CompletionList CompleteBindPath(
        TextDocument doc,
        int offset,
        Context ctx,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem,
        INamedTypeSymbol? pageClass,
        Lsp.Range replaceRange)
    {
        var root = string.IsNullOrEmpty(ctx.BindCastType)
            ? (string.IsNullOrEmpty(ctx.BindElementName)
                ? ResolveBindRoot(doc, offset, scope, typeSystem, pageClass, ctx.IsClassicBinding)
                : ResolveNamedElementType(doc.Parsed.Root, ctx.BindElementName!, scope, typeSystem))
            : ResolveElementType(ParseQualified(ctx.BindCastType!), scope, typeSystem);
        if (root is null)
        {
            return new CompletionList();
        }

        // Walk the segments already typed before the last dot (e.g. "Customer" in "Customer.Na").
        ITypeSymbol current = root;
        bool atRoot = true;
        if (!string.IsNullOrEmpty(ctx.BindPrefixPath))
        {
            foreach (var segment in ctx.BindPrefixPath!.Split('.'))
            {
                if (segment.Length == 0)
                {
                    return new CompletionList();
                }

                var resolved = ResolveBindSegmentType(typeSystem, current, segment, atRoot);
                if (resolved is null)
                {
                    return new CompletionList();
                }

                current = resolved;
                atRoot = false;
            }
        }

        var items = new List<CompletionItem>();
        foreach (var member in typeSystem.GetBindableMembers(current, includeRootNonPublic: atRoot))
        {
            if (!StartsWith(member.Name, ctx.Partial) || IsBindCompletionNoise(member))
            {
                continue;
            }

            items.Add(new CompletionItem
            {
                Label = member.Name,
                Kind = BindMemberKind(member),
                Documentation = CompletionDoc(member),
                Detail = DescribeBindMember(member),
                TextEdit = new TextEdit { Range = replaceRange, NewText = member.Name },
                FilterText = member.Name,
                // Properties and fields before methods; the common bind target is a property.
                SortText = (member is IMethodSymbol ? "1" : "0") + member.Name,
            });
        }

        return Finish(items);
    }

    /// <summary>
    /// Resolves one <c>{x:Bind}</c> path segment to the type it evaluates to, handling indexer suffixes:
    /// a segment like <c>Items[0]</c> resolves the <c>Items</c> member, then unwraps the collection
    /// element type once per <c>[...]</c> group (e.g. <c>IReadOnlyList&lt;string&gt;</c> -&gt; <c>string</c>),
    /// so completion after the indexer offers the element type's members. Returns null when the base
    /// member or an element type can't be resolved.
    /// </summary>
    internal static ITypeSymbol? ResolveBindSegmentType(
        XamlTypeSystem typeSystem, ITypeSymbol current, string segment, bool atRoot)
    {
        int bracket = segment.IndexOf('[');
        string name = (bracket < 0 ? segment : segment.Substring(0, bracket)).Trim();
        if (name.Length == 0)
        {
            return null;
        }

        var member = typeSystem.GetBindableMembers(current, includeRootNonPublic: atRoot)
            .FirstOrDefault(m => string.Equals(m.Name, name, StringComparison.Ordinal));
        var type = member is null ? null : XamlTypeSystem.GetMemberType(member);
        if (type is null)
        {
            return null;
        }

        for (int i = bracket; bracket >= 0 && i < segment.Length; i++)
        {
            if (segment[i] != '[')
            {
                continue;
            }

            type = XamlTypeSystem.GetCollectionElementType(type);
            if (type is null)
            {
                return null;
            }
        }

        return type;
    }

    /// <summary>
    /// True when a bindable member should be hidden from <c>{x:Bind}</c> completion because it is noise
    /// rather than a real authoring target: XAML-compiler plumbing generated into <c>*.g.cs</c>
    /// (<c>InitializeComponent</c>, <c>_contentLoaded</c>) or an inherited framework method with no
    /// source (<c>FindName</c>, <c>ApplyTemplate</c>, ...). Source members — including private event
    /// handlers — and inherited/metadata properties and fields stay, matching Visual Studio.
    /// </summary>
    private static bool IsBindCompletionNoise(ISymbol member)
    {
        var declarations = member.DeclaringSyntaxReferences;

        // Generated code-behind plumbing: every declaration lives in a generated file.
        if (declarations.Length > 0 && declarations.All(r => IsGeneratedDocumentPath(r.SyntaxTree.FilePath)))
        {
            return true;
        }

        // Inherited framework methods (defined only in metadata) flood the list and are rarely bound.
        return member is IMethodSymbol && declarations.IsEmpty;
    }

    private static bool IsGeneratedDocumentPath(string? path) =>
        !string.IsNullOrEmpty(path) &&
        (path!.EndsWith(".g.cs", StringComparison.OrdinalIgnoreCase) ||
         path.EndsWith(".g.i.cs", StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// Determines the type a binding path binds against at the caret. For <c>{x:Bind}</c> this is the
    /// nearest enclosing <c>DataTemplate</c>'s resolved <c>x:DataType</c>, or the page's x:Class when not
    /// inside a template. For a classic <c>{Binding}</c> (<paramref name="classic"/>) the DataContext type
    /// is only statically known from a design-time hint, so the nearest ancestor's
    /// <c>d:DataContext="{d:DesignInstance …}"</c> supplies the root (a <c>DataTemplate</c> x:DataType still
    /// wins when nearer); with no hint a classic page-level binding has no root. Returns null wherever the
    /// root cannot be resolved, so members are never offered where they would be wrong.
    /// </summary>
    private static ITypeSymbol? ResolveBindRoot(
        TextDocument doc, int offset, XamlNamespaceScope scope, XamlTypeSystem typeSystem,
        INamedTypeSymbol? pageClass, bool classic)
    {
        for (var node = doc.Parsed.FindNode(Math.Max(0, offset - 1)); node != null; node = node.Parent)
        {
            if (node is not XamlElement element)
            {
                continue;
            }

            // A DataTemplate re-roots BOTH compiled and classic bindings to its x:DataType (the templated
            // item), so it always wins at its scope; an empty/unresolvable x:DataType yields no root. The
            // directive is recognized only under the reserved "x" prefix — matching the F12/hover, template
            // resolution, and validator sites — so a foreign-prefix foo:DataType is NOT treated as x:DataType.
            if (element.Name?.LocalName == "DataTemplate")
            {
                var dataType = element.Attributes.FirstOrDefault(a =>
                    !a.IsNamespaceDeclaration && a.Name.Prefix == "x" && a.Name.LocalName == "DataType");
                var typeName = dataType?.Value?.Text?.Trim();
                return string.IsNullOrEmpty(typeName)
                    ? null
                    : ResolveElementType(ParseQualified(typeName!), scope, typeSystem);
            }

            // Classic {Binding} binds to the runtime DataContext, whose type is only statically known when a
            // design-time hint declares it: d:DataContext="{d:DesignInstance Type=local:Foo}". The nearest
            // ancestor carrying d:DataContext defines the scope's DataContext, so resolution stops there —
            // an unresolved/typed-away hint yields no root rather than leaking an outer scope's type.
            if (classic)
            {
                var designContext = element.Attributes.FirstOrDefault(a =>
                    !a.IsNamespaceDeclaration && a.Name.HasPrefix && a.Name.LocalName == "DataContext"
                    && scope.TryResolvePrefix(a.Name.Prefix, out var uri) && IsDesignTimeNamespace(uri));
                if (designContext is not null)
                {
                    var value = designContext.Value?.Text;

                    // The value must ALSO be a design-time DesignInstance extension: its prefix has to
                    // resolve to a design-time namespace, exactly like the d:DataContext attribute above.
                    // A foreign/undeclared prefix (e.g. {zzz:DesignInstance …}) is not the DesignInstance
                    // extension and must not root the binding — yet this ancestor is still TERMINAL, so we
                    // yield no root rather than leaking an outer scope.
                    if (!IsDesignInstanceExtension(value, scope))
                    {
                        return null;
                    }

                    var typeName = ParseDesignInstanceType(value);
                    return typeName is null
                        ? null
                        : ResolveElementType(ParseQualified(typeName), scope, typeSystem);
                }
            }
        }

        return classic ? null : pageClass;
    }

    private const string DesignTimeNamespace2008 = "http://schemas.microsoft.com/expression/blend/2008";
    private const string DesignTimeNamespace2006 = "http://schemas.microsoft.com/expression/blend/2006";
    private const string MarkupCompatibilityNamespace = "http://schemas.openxmlformats.org/markup-compatibility/2006";

    private static bool IsDesignTimeNamespace(string? uri) =>
        uri == DesignTimeNamespace2008 || uri == DesignTimeNamespace2006;

    /// <summary>
    /// True when <paramref name="attributeName"/> is the <c>mc:Ignorable</c> markup-compatibility directive —
    /// matched by the RESOLVED namespace URI (so a custom prefix mapped to the markup-compatibility URI works,
    /// and a foreign/undeclared prefix does not) and the local name <c>Ignorable</c>.
    /// </summary>
    private static bool IsMcIgnorableAttribute(string? attributeName, XamlNamespaceScope scope)
    {
        if (attributeName is null)
        {
            return false;
        }

        int colon = attributeName.IndexOf(':');
        if (colon < 0)
        {
            return false; // Ignorable must be prefixed with the markup-compatibility prefix
        }

        return string.Equals(attributeName.Substring(colon + 1), "Ignorable", StringComparison.Ordinal)
            && scope.TryResolvePrefix(attributeName.Substring(0, colon), out var uri)
            && string.Equals(uri, MarkupCompatibilityNamespace, StringComparison.Ordinal);
    }

    /// <summary>
    /// Completes the space-separated <c>mc:Ignorable="d …"</c> value with the DECLARED prefixes that map to a
    /// design-time namespace (blend/2008 or /2006) — the prefixes whose markup a runtime XAML processor may
    /// ignore. Only the CURRENT whitespace-delimited token is replaced/filtered; prefixes already listed in the
    /// value and the default xmlns (no prefix token) are excluded. Purely additive VS/Blend-parity authoring aid.
    /// </summary>
    private static CompletionList CompleteMcIgnorable(
        TextDocument doc, int offset, Context ctx, XamlNamespaceScope scope, Lsp.Range replaceRange)
    {
        var value = ctx.Partial; // opening-quote .. caret (may hold earlier space-separated prefixes)
        int lastWs = -1;
        for (int i = 0; i < value.Length; i++)
        {
            if (char.IsWhiteSpace(value[i]))
            {
                lastWs = i;
            }
        }

        var currentToken = value.Substring(lastWs + 1);
        var listed = new HashSet<string>(
            value.Substring(0, lastWs + 1).Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries),
            StringComparer.Ordinal);

        // Replace ONLY the current token (after the last whitespace), not the whole multi-prefix value.
        var tokenRange = lastWs < 0
            ? replaceRange
            : doc.RangeOf(new TextSpan(ctx.ReplaceStart + lastWs + 1, offset));

        var items = new List<CompletionItem>();
        foreach (var declaration in scope.Declarations)
        {
            var prefix = declaration.Key;
            if (string.IsNullOrEmpty(prefix) ||
                !IsDesignTimeNamespace(declaration.Value) ||
                listed.Contains(prefix) ||
                !StartsWith(prefix, currentToken))
            {
                continue;
            }

            items.Add(new CompletionItem
            {
                Label = prefix,
                Kind = CompletionItemKind.Value,
                Detail = "Ignorable design-time prefix",
                TextEdit = new TextEdit { Range = tokenRange, NewText = prefix },
                FilterText = prefix,
                SortText = prefix,
            });
        }

        return Finish(items);
    }

    /// <summary>
    /// Extracts the design-time DataContext type name from a <c>d:DataContext</c> value shaped like
    /// <c>{d:DesignInstance Type=local:Foo, IsDesignTimeCreatable=True}</c>, the positional
    /// <c>{d:DesignInstance local:Foo}</c>, or the wrapped <c>{d:DesignInstance {x:Type local:Foo}}</c>.
    /// Returns null when the value is not a <c>DesignInstance</c> extension or names no type — so an
    /// unrelated markup extension (e.g. <c>{StaticResource …}</c>) never yields a spurious root.
    /// </summary>
    internal static string? ParseDesignInstanceType(string? value)
    {
        var text = value?.Trim();
        if (string.IsNullOrEmpty(text) || text![0] != '{')
        {
            return null;
        }

        int i = 1;
        while (i < text.Length && char.IsWhiteSpace(text[i]))
        {
            i++;
        }

        int nameStart = i;
        while (i < text.Length && (char.IsLetterOrDigit(text[i]) || text[i] == ':'))
        {
            i++;
        }

        if (LocalPart(text.Substring(nameStart, i - nameStart)) != "DesignInstance")
        {
            return null;
        }

        // Bound the argument list to the extension's matching '}'.
        int end = i;
        int braceDepth = 1;
        while (end < text.Length)
        {
            char ch = text[end];
            if (ch == '{')
            {
                braceDepth++;
            }
            else if (ch == '}')
            {
                braceDepth--;
                if (braceDepth == 0)
                {
                    break;
                }
            }

            end++;
        }

        // Split the args on TOP-LEVEL commas; prefer an explicit Type=, else the first positional value.
        string? positional = null;
        int argStart = i;
        int depth = 0;
        for (int j = i; j <= end; j++)
        {
            bool boundary = j >= end;
            char ch = boundary ? ',' : text[j];
            if (!boundary && ch is '(' or '{' or '[')
            {
                depth++;
            }
            else if (!boundary && ch is ')' or '}' or ']')
            {
                if (depth > 0)
                {
                    depth--;
                }
            }
            else if (ch == ',' && depth == 0)
            {
                var (name, val) = SplitMarkupArg(text, argStart, j);
                if (name == "Type")
                {
                    return NormalizeTypeToken(val);
                }

                if (name is null && positional is null && val.Length > 0)
                {
                    positional = NormalizeTypeToken(val);
                }

                argStart = j + 1;
            }

            if (boundary)
            {
                break;
            }
        }

        return positional;
    }

    /// <summary>The local part of a possibly-prefixed markup name (<c>d:DesignInstance</c> → <c>DesignInstance</c>).</summary>
    private static string LocalPart(string name)
    {
        int colon = name.IndexOf(':');
        return colon >= 0 ? name.Substring(colon + 1) : name;
    }

    /// <summary>The prefix of a possibly-prefixed markup name (<c>d:DesignInstance</c> → <c>d</c>; empty when none).</summary>
    private static string PrefixPart(string name)
    {
        int colon = name.IndexOf(':');
        return colon >= 0 ? name.Substring(0, colon) : string.Empty;
    }

    /// <summary>Reads the leading markup-extension name from a value like <c>{d:DesignInstance …}</c> →
    /// <c>d:DesignInstance</c>. Returns null when the value is not a braced extension or names nothing.</summary>
    private static string? ReadExtensionName(string? value)
    {
        var text = value?.Trim();
        if (string.IsNullOrEmpty(text) || text![0] != '{')
        {
            return null;
        }

        int i = 1;
        while (i < text.Length && char.IsWhiteSpace(text[i]))
        {
            i++;
        }

        int start = i;
        while (i < text.Length && (char.IsLetterOrDigit(text[i]) || text[i] == ':'))
        {
            i++;
        }

        var name = text.Substring(start, i - start);
        return name.Length > 0 ? name : null;
    }

    /// <summary>True when <paramref name="value"/> is a <c>DesignInstance</c> markup extension whose PREFIX
    /// resolves to a design-time namespace — mirroring the <c>d:DataContext</c> attribute check, not merely
    /// matching the extension's local name. Guards against a foreign/undeclared prefix such as
    /// <c>{zzz:DesignInstance …}</c>, which is not the design-time extension and must not root a binding.</summary>
    private static bool IsDesignInstanceExtension(string? value, XamlNamespaceScope scope)
    {
        var name = ReadExtensionName(value);
        if (name is null || LocalPart(name) != "DesignInstance")
        {
            return false;
        }

        var prefix = PrefixPart(name);
        return prefix.Length > 0
            && scope.TryResolvePrefix(prefix, out var uri)
            && IsDesignTimeNamespace(uri);
    }

    /// <summary>Splits a markup-extension argument into (name, value) on its first TOP-LEVEL <c>=</c>;
    /// a positional argument (no <c>=</c>) returns a null name and the whole trimmed token as the value.</summary>
    private static (string? name, string val) SplitMarkupArg(string text, int start, int endExclusive)
    {
        int eq = -1;
        int depth = 0;
        for (int j = start; j < endExclusive; j++)
        {
            char ch = text[j];
            if (ch is '(' or '{' or '[')
            {
                depth++;
            }
            else if (ch is ')' or '}' or ']')
            {
                if (depth > 0)
                {
                    depth--;
                }
            }
            else if (ch == '=' && depth == 0)
            {
                eq = j;
                break;
            }
        }

        return eq >= 0
            ? (text.Substring(start, eq - start).Trim(), text.Substring(eq + 1, endExclusive - eq - 1).Trim())
            : (null, text.Substring(start, endExclusive - start).Trim());
    }

    /// <summary>Normalizes a type token that may be a bare/prefixed name or an <c>{x:Type ...}</c> wrapper —
    /// used by both design-instance types and <c>Style</c>/<c>ControlTemplate</c> <c>TargetType</c>. Unwraps
    /// <c>{x:Type local:Foo}</c> to <c>local:Foo</c>, passes a bare <c>prefix:Local</c> token through, and
    /// returns <c>null</c> for an empty value or a non-<c>x:Type</c> markup extension.</summary>
    private static string? NormalizeTypeToken(string value)
    {
        var v = value.Trim();
        if (v.Length == 0)
        {
            return null;
        }

        if (v[0] == '{')
        {
            int k = 1;
            while (k < v.Length && char.IsWhiteSpace(v[k]))
            {
                k++;
            }

            int ns = k;
            while (k < v.Length && (char.IsLetterOrDigit(v[k]) || v[k] == ':'))
            {
                k++;
            }

            if (LocalPart(v.Substring(ns, k - ns)) != "Type")
            {
                return null;
            }

            while (k < v.Length && char.IsWhiteSpace(v[k]))
            {
                k++;
            }

            int ts = k;
            while (k < v.Length && (char.IsLetterOrDigit(v[k]) || v[k] == ':' || v[k] == '.'))
            {
                k++;
            }

            var wrapped = v.Substring(ts, k - ts).Trim();
            return wrapped.Length > 0 ? wrapped : null;
        }

        v = v.TrimEnd('}').Trim();
        return v.Length > 0 ? v : null;
    }


    private static int BindMemberKind(ISymbol member) => member switch
    {
        IMethodSymbol => CompletionItemKind.Method,
        IFieldSymbol => CompletionItemKind.Field,
        _ => CompletionItemKind.Property,
    };

    private static string DescribeBindMember(ISymbol member)
    {
        var type = XamlTypeSystem.GetMemberType(member);
        var typeName = type?.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat) ?? "?";
        var kind = member switch
        {
            IMethodSymbol => "method",
            IFieldSymbol => "field",
            _ => "property",
        };
        return $"{kind} : {typeName}";
    }

    // --- Context classification -------------------------------------------------------------------

    private readonly struct Context
    {
        public Context(ContextKind kind, string partial, int replaceStart, string? attributeName = null, string? bindPrefixPath = null, string? markupExtension = null, string? bindCastType = null, bool isClassicBinding = false, string? bindElementName = null, bool isUnquoted = false)
        {
            Kind = kind;
            Partial = partial;
            ReplaceStart = replaceStart;
            AttributeName = attributeName;
            BindPrefixPath = bindPrefixPath;
            MarkupExtension = markupExtension;
            BindCastType = bindCastType;
            IsClassicBinding = isClassicBinding;
            BindElementName = bindElementName;
            IsUnquoted = isUnquoted;
        }

        public ContextKind Kind { get; }
        public string Partial { get; }
        public int ReplaceStart { get; }

        /// <summary>For <see cref="ContextKind.AttributeValue"/>: the attribute whose value is completed.</summary>
        public string? AttributeName { get; }

        /// <summary>For <see cref="ContextKind.BindPath"/>: the dotted path segments already typed before the member being completed.</summary>
        public string? BindPrefixPath { get; }

        /// <summary>For <see cref="ContextKind.MarkupArg"/>: the markup extension name (e.g. <c>RelativeSource</c>, <c>Binding</c>) the argument belongs to.</summary>
        public string? MarkupExtension { get; }

        /// <summary>For <see cref="ContextKind.BindPath"/>: a leading cast type (<c>local:SmokePage</c> from
        /// <c>{x:Bind (local:SmokePage)Member}</c>); completion binds against this type instead of the bind root.</summary>
        public string? BindCastType { get; }

        /// <summary>For <see cref="ContextKind.BindPath"/>: true when the path belongs to a classic
        /// <c>{Binding}</c> (design-time DataContext = the enclosing template's <c>x:DataType</c>) rather than a
        /// compiled <c>{x:Bind}</c> (rooted at the page x:Class). Governs the root-resolution rule.</summary>
        public bool IsClassicBinding { get; }

        /// <summary>For <see cref="ContextKind.BindPath"/>: the <c>x:Name</c> a classic
        /// <c>{Binding ElementName=Foo, Path=…}</c> roots its path at; completion binds against that element's
        /// type instead of the DataContext. Null for compiled bindings and DataContext-rooted classic ones.</summary>
        public string? BindElementName { get; }

        /// <summary>For <see cref="ContextKind.AttributeValue"/>: true when the value position has NO surrounding
        /// quotes (the user typed <c>Click=OnGo</c> without <c>"…"</c>). Every completed value must then be wrapped
        /// in quotes to produce valid XAML; see the post-processing at the <see cref="Provide"/> dispatch.</summary>
        public bool IsUnquoted { get; }

        public static readonly Context None = new(ContextKind.None, string.Empty, 0);
    }

    /// <summary>
    /// Classifies the caret using the raw text: are we typing an element name just after <c>&lt;</c>,
    /// an attribute name later in a start tag, or a value inside a quoted attribute? Inside element
    /// content (outside any start tag) we return None.
    /// </summary>
    private static Context Classify(string text, int offset)
    {
        if (offset <= 0 || offset > text.Length)
        {
            return Context.None;
        }

        // Suppress completions when the caret sits inside an XML comment or a CDATA section: an
        // unclosed "<!--" (or "<![CDATA[") precedes the caret with no matching close. Without this,
        // the nearest-'<' heuristic below latches onto a '<' typed inside the comment/CDATA body
        // (e.g. "<!-- <But| -->" or "<![CDATA[ <But| ]]>") and offers element names.
        var beforeCaret = text.Substring(0, offset);
        if (beforeCaret.LastIndexOf("<!--", StringComparison.Ordinal) >
                beforeCaret.LastIndexOf("-->", StringComparison.Ordinal) ||
            beforeCaret.LastIndexOf("<![CDATA[", StringComparison.Ordinal) >
                beforeCaret.LastIndexOf("]]>", StringComparison.Ordinal))
        {
            return Context.None;
        }

        int lt = text.LastIndexOf('<', offset - 1);
        int gt = text.LastIndexOf('>', offset - 1);
        if (lt < 0 || gt > lt)
        {
            return Context.None; // in element content, not inside a start tag
        }

        char after = lt + 1 < text.Length ? text[lt + 1] : '\0';
        if (after == '/')
        {
            // End tag "</partial": offer the nearest unclosed enclosing element's name so the
            // caret at "</" completes to "</Grid>". The target element is resolved from the AST
            // at completion time (CompleteCloseTag); here we only capture the partial name token
            // and its start so the replace range covers exactly what has been typed after "</".
            int endNameStart = lt + 2;
            if (endNameStart > offset)
            {
                return Context.None; // caret sits between '<' and '/'
            }

            string endPartial = text.Substring(endNameStart, offset - endNameStart);
            foreach (var c in endPartial)
            {
                if (!IsNameChar(c))
                {
                    return Context.None; // past the name token (whitespace, '>', etc.)
                }
            }

            return new Context(ContextKind.CloseTag, endPartial, endNameStart);
        }

        if (after is '!' or '?')
        {
            return Context.None; // comment, CDATA, or processing instruction
        }

        string tag = text.Substring(lt + 1, offset - lt - 1);
        int ws = IndexOfWhitespace(tag);
        if (ws < 0)
        {
            // Still inside the element-name token.
            return new Context(ContextKind.ElementName, tag, lt + 1);
        }

        // Past the element name: attribute area — unless the caret sits inside a quoted value.
        var value = TryClassifyValue(text, lt, offset);
        if (value.HasValue)
        {
            return value.Value;
        }

        int wordStart = offset;
        while (wordStart > lt + 1 && IsNameChar(text[wordStart - 1]))
        {
            wordStart--;
        }

        return new Context(ContextKind.AttributeName, text.Substring(wordStart, offset - wordStart), wordStart);
    }

    /// <summary>
    /// If the caret sits inside a quoted attribute value within the start tag opened at
    /// <paramref name="ltIndex"/>, returns an <see cref="ContextKind.AttributeValue"/> context carrying
    /// the attribute name and the value text typed so far; otherwise null.
    /// </summary>
    private static Context? TryClassifyValue(string text, int ltIndex, int offset)
    {
        char quote = '\0';
        int valueStart = -1; // index just after the opening quote we're currently inside
        for (int i = ltIndex + 1; i < offset; i++)
        {
            char c = text[i];
            if (quote == '\0')
            {
                if (c is '"' or '\'')
                {
                    quote = c;
                    valueStart = i + 1;
                }
            }
            else if (c == quote)
            {
                quote = '\0';
                valueStart = -1;
            }
        }

        if (quote == '\0' || valueStart < 0)
        {
            return TryClassifyUnquotedValue(text, ltIndex, offset); // e.g. IsEnabled=| before quotes are typed
        }

        // Walk back from the opening quote over "= <ws>" to read the attribute name.
        int j = valueStart - 2; // char before the opening quote
        while (j > ltIndex && char.IsWhiteSpace(text[j]))
        {
            j--;
        }

        if (j <= ltIndex || text[j] != '=')
        {
            return null; // malformed: not an attribute value
        }

        j--;
        while (j > ltIndex && char.IsWhiteSpace(text[j]))
        {
            j--;
        }

        int nameEnd = j + 1;
        int nameStart = nameEnd;
        while (nameStart > ltIndex + 1 && IsNameChar(text[nameStart - 1]))
        {
            nameStart--;
        }

        if (nameStart >= nameEnd)
        {
            return null;
        }

        var attributeName = text.Substring(nameStart, nameEnd - nameStart);

        // Re-root the markup classifiers on the innermost markup extension still open at the caret so
        // nested extensions classify correctly (e.g. the {StaticResource |} inside
        // {Binding Source={StaticResource |}}). For non-nested values this is just the sole '{'.
        int markupStart = InnermostOpenBrace(text, valueStart, offset);

        var markup = TryClassifyMarkupName(text, markupStart, offset);
        if (markup.HasValue)
        {
            return markup;
        }

        var bind = TryClassifyBind(text, markupStart, offset);
        if (bind.HasValue)
        {
            return bind;
        }

        var resource = TryClassifyResource(text, markupStart, offset, ResourceTargetAttribute(text, valueStart, markupStart, attributeName));
        if (resource.HasValue)
        {
            return resource;
        }

        var xReference = TryClassifyXReference(text, markupStart, offset);
        if (xReference.HasValue)
        {
            return xReference;
        }

        // {d:DesignInstance local:Foo|} / {d:DesignInstance Type=local:Foo|} — the design-time DataContext
        // hint's TYPE argument completes type names (authoring counterpart to round 52's rooting). Checked
        // before the generic markup-arg classifiers so the Type= value is a type reference, not a plain arg.
        var designInstance = TryClassifyDesignInstanceType(text, markupStart, offset);
        if (designInstance.HasValue)
        {
            return designInstance;
        }

        var templateBinding = TryClassifyTemplateBinding(text, markupStart, offset);
        if (templateBinding.HasValue)
        {
            return templateBinding;
        }

        var markupArg = TryClassifyMarkupArg(text, markupStart, offset);
        if (markupArg.HasValue)
        {
            return markupArg;
        }

        var markupArgName = TryClassifyMarkupArgName(text, markupStart, offset);
        if (markupArgName.HasValue)
        {
            return markupArgName;
        }

        // xmlns:foo="using:Clr.Namespace" — a namespace DECLARATION value (not a markup value), so it is
        // classified here on the raw attribute name/value rather than through a markup brace. Offers the
        // project's CLR namespaces once the "using:" scheme prefix is present.
        var usingNamespace = TryClassifyUsingNamespace(text, valueStart, offset, attributeName);
        if (usingNamespace.HasValue)
        {
            return usingNamespace;
        }

        // Any OTHER xmlns declaration value (empty, a partial well-known URI, or the "using:" scheme still
        // being typed) offers the standard framework namespace URIs plus the using: scheme — VS parity for
        // authoring a namespace declaration. Reached only after the using: classifier declined, so the two
        // are mutually exclusive (that one owns the post-"using:" CLR-namespace token).
        var xmlnsValue = TryClassifyXmlnsValue(text, valueStart, offset, attributeName);
        if (xmlnsValue.HasValue)
        {
            return xmlnsValue;
        }

        var partial = text.Substring(valueStart, offset - valueStart);
        return new Context(ContextKind.AttributeValue, partial, valueStart, attributeName);
    }

    /// <summary>The XAML scheme prefix that maps an xmlns value to a CLR namespace.</summary>
    private const string UsingScheme = "using:";

    /// <summary>
    /// Classifies the caret inside a namespace-declaration value that opens with the <c>using:</c> scheme
    /// (<c>xmlns:local="using:|"</c> or <c>xmlns="using:Foo.|"</c>). Returns a
    /// <see cref="ContextKind.UsingNamespace"/> context whose <c>ReplaceStart</c> is positioned just after
    /// <c>using:</c> so the whole CLR-namespace token (dots included) is the replace/filter span, and whose
    /// <c>Partial</c> is the namespace text typed so far. Returns null when the attribute is not an xmlns
    /// declaration, the value has not yet reached the <c>using:</c> scheme, or the caret sits within the
    /// scheme word itself (nothing to complete there).
    /// </summary>
    private static Context? TryClassifyUsingNamespace(string text, int valueStart, int offset, string attributeName)
    {
        // Only xmlns declarations carry a using: target: the default xmlns ("xmlns") or a prefixed one
        // ("xmlns:local"). A same-named ordinary attribute cannot exist on an element, so this is exact.
        if (!(string.Equals(attributeName, "xmlns", StringComparison.Ordinal) ||
              attributeName.StartsWith("xmlns:", StringComparison.Ordinal)))
        {
            return null;
        }

        int nsStart = valueStart + UsingScheme.Length;
        if (offset < nsStart)
        {
            return null; // caret is still within the "using:" scheme text — nothing to complete yet
        }

        // The value must literally open with the using: scheme (ordinal — XAML's scheme is lowercase).
        if (string.CompareOrdinal(text, valueStart, UsingScheme, 0, UsingScheme.Length) != 0)
        {
            return null;
        }

        var partial = text.Substring(nsStart, offset - nsStart);
        return new Context(ContextKind.UsingNamespace, partial, nsStart);
    }

    /// <summary>
    /// Completes the CLR-namespace token of a <c>using:</c> xmlns value. Offers the project's own source
    /// namespaces first (<see cref="XamlTypeSystem.GetUsingNamespaces"/>, sort group <c>0</c>), then the
    /// referenced-assembly namespaces (<see cref="XamlTypeSystem.GetReferencedUsingNamespaces"/>, sort group
    /// <c>1</c>) so a control library reached only through <c>using:</c> is completable, matching Visual
    /// Studio. The two sets are disjoint (the referenced set excludes source namespaces). The full namespace
    /// replaces the typed token (the replace range starts right after <c>using:</c>, so VS Code filters on the
    /// whole dotted prefix rather than just the segment after the last dot).
    /// </summary>
    private static CompletionList CompleteUsingNamespace(Context ctx, XamlTypeSystem typeSystem, Lsp.Range replaceRange)
    {
        var items = new List<CompletionItem>();
        AddUsingNamespaceItems(items, typeSystem.GetUsingNamespaces(), ctx.Partial, replaceRange, "0", "CLR namespace");
        AddUsingNamespaceItems(items, typeSystem.GetReferencedUsingNamespaces(), ctx.Partial, replaceRange, "1", "CLR namespace (referenced)");
        return Finish(items);
    }

    /// <summary>
    /// Adds one completion item per namespace in <paramref name="namespaces"/> that starts with the typed
    /// partial. <paramref name="sortGroup"/> prefixes the sort text so source namespaces (group <c>0</c>)
    /// rank above referenced ones (group <c>1</c>); <paramref name="detail"/> distinguishes the two in the UI.
    /// </summary>
    private static void AddUsingNamespaceItems(
        List<CompletionItem> items, IReadOnlyList<string> namespaces, string partial, Lsp.Range replaceRange, string sortGroup, string detail)
    {
        foreach (var ns in namespaces)
        {
            if (!StartsWith(ns, partial))
            {
                continue;
            }

            items.Add(new CompletionItem
            {
                Label = ns,
                Kind = CompletionItemKind.Module,
                Detail = detail,
                TextEdit = new TextEdit { Range = replaceRange, NewText = ns },
                FilterText = ns,
                SortText = sortGroup + ns,
            });
        }
    }

    /// <summary>The standard framework namespace URIs offered when completing an xmlns declaration value,
    /// in rank order (the WinUI presentation default first). Paired with a human-readable detail.</summary>
    private static readonly (string Value, string Detail)[] WellKnownXmlnsValues =
    {
        (XamlTypeSystem.PresentationNamespace, "WinUI presentation namespace"),
        (XamlTypeSystem.XamlLanguageNamespace, "XAML language namespace (x:)"),
        (DesignTimeNamespace2008, "Design-time namespace (d:)"),
        (MarkupCompatibilityNamespace, "Markup compatibility namespace (mc:)"),
    };

    /// <summary>
    /// Classifies the caret inside an xmlns declaration value that has NOT yet reached a completable
    /// <c>using:</c> CLR-namespace token — i.e. an empty value (<c>xmlns:foo="|"</c>), a partial well-known
    /// URI (<c>xmlns:foo="http|"</c>), or the <c>using:</c> scheme still being typed (<c>xmlns:foo="usin|"</c>).
    /// Returns a <see cref="ContextKind.XmlnsValue"/> whose <c>ReplaceStart</c> is the value start so the WHOLE
    /// value is replaced/filtered. Only fires for xmlns declarations; returns null otherwise. Must be tried
    /// AFTER <see cref="TryClassifyUsingNamespace"/> (which owns the post-<c>using:</c> namespace token).
    /// </summary>
    private static Context? TryClassifyXmlnsValue(string text, int valueStart, int offset, string attributeName)
    {
        if (!(string.Equals(attributeName, "xmlns", StringComparison.Ordinal) ||
              attributeName.StartsWith("xmlns:", StringComparison.Ordinal)))
        {
            return null;
        }

        var partial = text.Substring(valueStart, offset - valueStart);
        return new Context(ContextKind.XmlnsValue, partial, valueStart);
    }

    /// <summary>
    /// Completes an xmlns declaration value with the well-known framework namespace URIs
    /// (<see cref="WellKnownXmlnsValues"/>) and the <c>using:</c> scheme, each filtered by the typed value
    /// and replacing the WHOLE value. The <c>using:</c> item, once accepted, hands off to
    /// <see cref="CompleteUsingNamespace"/> for CLR-namespace completion. Purely additive VS-parity authoring
    /// aid (no project/type-system dependency).
    /// </summary>
    private static CompletionList CompleteXmlnsValue(Context ctx, Lsp.Range replaceRange)
    {
        var items = new List<CompletionItem>();
        int rank = 0;
        foreach (var (value, detail) in WellKnownXmlnsValues)
        {
            if (StartsWith(value, ctx.Partial))
            {
                items.Add(MakeXmlnsValueItem(value, detail, replaceRange, rank));
            }

            rank++;
        }

        // The using: scheme ranks after the standard URIs; accepting it opens CLR-namespace completion.
        if (StartsWith(UsingScheme, ctx.Partial))
        {
            items.Add(MakeXmlnsValueItem(UsingScheme, "CLR namespace reference", replaceRange, rank));
        }

        return Finish(items);
    }

    private static CompletionItem MakeXmlnsValueItem(string value, string detail, Lsp.Range replaceRange, int rank) =>
        new CompletionItem
        {
            Label = value,
            Kind = CompletionItemKind.Value,
            Detail = detail,
            TextEdit = new TextEdit { Range = replaceRange, NewText = value },
            FilterText = value,
            SortText = ((char)('0' + rank)).ToString(),
        };

    /// <summary>
    /// Classifies the caret at an unquoted attribute-value position (<c>IsEnabled=|</c>) — a state XAML
    /// tolerates while the value is being typed before quotes are added. Returns an
    /// <see cref="ContextKind.AttributeValue"/> context so enum/bool value completion still fires, or
    /// null when the caret is not immediately after an attribute's <c>=</c>.
    /// </summary>
    private static Context? TryClassifyUnquotedValue(string text, int ltIndex, int offset)
    {
        // Trailing run of value characters already typed (empty when the caret is right after '=').
        int valueStart = offset;
        while (valueStart > ltIndex && IsUnquotedValueChar(text[valueStart - 1]))
        {
            valueStart--;
        }

        // The value token must be immediately preceded by '=' (allowing surrounding whitespace).
        int j = valueStart - 1;
        while (j > ltIndex && char.IsWhiteSpace(text[j]))
        {
            j--;
        }

        if (j <= ltIndex || text[j] != '=')
        {
            return null;
        }

        j--;
        while (j > ltIndex && char.IsWhiteSpace(text[j]))
        {
            j--;
        }

        int nameEnd = j + 1;
        int nameStart = nameEnd;
        while (nameStart > ltIndex + 1 && IsNameChar(text[nameStart - 1]))
        {
            nameStart--;
        }

        if (nameStart >= nameEnd)
        {
            return null;
        }

        var attributeName = text.Substring(nameStart, nameEnd - nameStart);
        var partial = text.Substring(valueStart, offset - valueStart);
        return new Context(ContextKind.AttributeValue, partial, valueStart, attributeName, isUnquoted: true);
    }

    private static bool IsUnquotedValueChar(char c) =>
        char.IsLetterOrDigit(c) || c is '_' or '.' or '-' or ':' or '+';

    /// <summary>
    /// Returns the index of the innermost markup-extension <c>{</c> that is still open at
    /// <paramref name="offset"/> (matching <c>}</c> not yet seen), or <paramref name="valueStart"/>
    /// when the caret is not inside any brace. Lets the markup classifiers operate on the extension
    /// the caret actually sits in rather than the outermost one.
    /// </summary>
    private static int InnermostOpenBrace(string text, int valueStart, int offset)
    {
        var open = new Stack<int>();
        for (int i = valueStart; i < offset; i++)
        {
            if (text[i] == '{')
            {
                open.Push(i);
            }
            else if (text[i] == '}' && open.Count > 0)
            {
                open.Pop();
            }
        }

        return open.Count > 0 ? open.Peek() : valueStart;
    }

    /// <summary>
    /// If the attribute value beginning at <paramref name="valueStart"/> is a <c>{StaticResource ...}</c>,
    /// <c>{ThemeResource ...}</c> or <c>{CustomResource ...}</c> reference and the caret sits in its key
    /// (first positional) argument, returns a <see cref="ContextKind.ResourceKey"/> context with the
    /// partial key. Returns null once the key token has ended (a delimiter or whitespace was typed).
    /// </summary>
    private static Context? TryClassifyResource(string text, int valueStart, int offset, string? targetAttribute = null)
    {
        int i = valueStart;
        while (i < offset && char.IsWhiteSpace(text[i]))
        {
            i++;
        }

        if (i >= offset || text[i] != '{')
        {
            return null;
        }

        i++; // past '{'
        while (i < offset && char.IsWhiteSpace(text[i]))
        {
            i++;
        }

        int nameStart = i;
        while (i < offset && (char.IsLetterOrDigit(text[i]) || text[i] == ':'))
        {
            i++;
        }

        var extName = text.Substring(nameStart, i - nameStart);
        if (extName != "StaticResource" && extName != "ThemeResource" && extName != "CustomResource")
        {
            return null;
        }

        // A space must separate the name from the key (so "{StaticResource" alone is name completion).
        if (i >= offset || !char.IsWhiteSpace(text[i]))
        {
            return null;
        }

        while (i < offset && char.IsWhiteSpace(text[i]))
        {
            i++;
        }

        // The key is the first positional argument: any delimiter/whitespace means it has ended.
        var keySoFar = text.Substring(i, offset - i);
        foreach (var ch in keySoFar)
        {
            if (ch is '}' or ',' or '=' || char.IsWhiteSpace(ch))
            {
                return null;
            }
        }

        return new Context(ContextKind.ResourceKey, keySoFar, i, attributeName: targetAttribute);
    }

    /// <summary>
    /// The attribute name whose property type should scope resource-key completion, or <c>null</c> to
    /// offer every key. The type applies only when the <c>{StaticResource}</c>/<c>{ThemeResource}</c> is
    /// the attribute's DIRECT value; when it is nested inside another markup extension (e.g. the inner
    /// reference in <c>{Binding Source={StaticResource |}}</c>) the key feeds that extension's argument,
    /// not the attribute, so no property type applies — detected by any earlier <c>{</c> between the
    /// value start and the resource's own brace.
    /// </summary>
    private static string? ResourceTargetAttribute(string text, int valueStart, int markupStart, string attributeName)
    {
        for (int k = valueStart; k < markupStart; k++)
        {
            if (text[k] == '{')
            {
                return null;
            }
        }

        return attributeName;
    }

    /// <summary>
    /// If the attribute value is an <c>{x:Type ...}</c> or <c>{x:Static ...}</c> reference and the caret
    /// sits in its (first positional) argument, classifies it. <c>{x:Type}</c> and the owner part of
    /// <c>{x:Static Owner}</c> (before a dot) complete type names (<see cref="ContextKind.TypeName"/>);
    /// the member part of <c>{x:Static Owner.member}</c> completes the owner's static members
    /// (<see cref="ContextKind.StaticMember"/>, with the owner carried in <c>BindPrefixPath</c>). Returns
    /// null once the token has ended (a delimiter or whitespace was typed).
    /// </summary>
    private static Context? TryClassifyXReference(string text, int valueStart, int offset)
    {
        int i = valueStart;
        while (i < offset && char.IsWhiteSpace(text[i]))
        {
            i++;
        }

        if (i >= offset || text[i] != '{')
        {
            return null;
        }

        i++; // past '{'
        while (i < offset && char.IsWhiteSpace(text[i]))
        {
            i++;
        }

        int nameStart = i;
        while (i < offset && (char.IsLetterOrDigit(text[i]) || text[i] == ':'))
        {
            i++;
        }

        var extName = text.Substring(nameStart, i - nameStart);
        bool isType = extName == "x:Type";
        bool isStatic = extName == "x:Static";
        if (!isType && !isStatic)
        {
            return null;
        }

        // A space must separate the name from the argument (so "{x:Type" alone is name completion).
        if (i >= offset || !char.IsWhiteSpace(text[i]))
        {
            return null;
        }

        while (i < offset && char.IsWhiteSpace(text[i]))
        {
            i++;
        }

        // The reference is the first positional argument: any delimiter/whitespace means it has ended.
        int argStart = i;
        var argSoFar = text.Substring(argStart, offset - argStart);
        foreach (var ch in argSoFar)
        {
            if (ch is '}' or ',' or '=' || char.IsWhiteSpace(ch))
            {
                return null;
            }
        }

        // {x:Static Owner.member}: once a dot is typed, complete the owner type's static members.
        if (isStatic)
        {
            int dot = argSoFar.LastIndexOf('.');
            if (dot >= 0)
            {
                var owner = argSoFar.Substring(0, dot);
                var memberPartial = argSoFar.Substring(dot + 1);
                return new Context(ContextKind.StaticMember, memberPartial, argStart + dot + 1, bindPrefixPath: owner);
            }
        }

        // {x:Type TypeName} or {x:Static Owner} (no dot yet): complete type names.
        return new Context(ContextKind.TypeName, argSoFar, argStart);
    }

    /// <summary>
    /// If the value is a <c>{d:DesignInstance …}</c> extension (a design-time DataContext hint) and the
    /// caret sits in its TYPE argument — the first positional token (<c>{d:DesignInstance local:Foo|}</c>)
    /// or the value of a <c>Type=</c> named arg (<c>{d:DesignInstance Type=local:Foo|}</c>, possibly after
    /// other args like <c>IsDesignTimeCreatable=True</c>) — classifies it as a type reference
    /// (<see cref="ContextKind.DesignInstanceType"/>). The extension PREFIX is carried in
    /// <c>BindPrefixPath</c> so completion can require it to resolve to a design-time namespace (a foreign
    /// <c>{zzz:DesignInstance …}</c> then offers nothing, mirroring round 52's rooting gate). Other named
    /// args (e.g. <c>IsDesignTimeCreatable=</c>) and an already-ended token yield null. The wrapped
    /// <c>{d:DesignInstance {x:Type local:Foo|}}</c> form is handled by the inner <c>{x:Type}</c> classifier
    /// via innermost-brace re-rooting, so it is not (re)handled here.
    /// </summary>
    private static Context? TryClassifyDesignInstanceType(string text, int valueStart, int offset)
    {
        int i = valueStart;
        while (i < offset && char.IsWhiteSpace(text[i]))
        {
            i++;
        }

        if (i >= offset || text[i] != '{')
        {
            return null;
        }

        i++; // past '{'
        while (i < offset && char.IsWhiteSpace(text[i]))
        {
            i++;
        }

        int nameStart = i;
        while (i < offset && (char.IsLetterOrDigit(text[i]) || text[i] == ':'))
        {
            i++;
        }

        var extName = text.Substring(nameStart, i - nameStart);
        if (LocalPart(extName) != "DesignInstance")
        {
            return null;
        }

        // DesignInstance is always prefixed (its prefix is a design-time namespace); an unprefixed
        // {DesignInstance …} is not the extension we complete.
        var extPrefix = PrefixPart(extName);
        if (extPrefix.Length == 0)
        {
            return null;
        }

        // A space must separate the name from its arguments (so "{d:DesignInstance" alone is name completion).
        if (i >= offset || !char.IsWhiteSpace(text[i]))
        {
            return null;
        }

        // Walk the top-level (depth-0) comma-separated arguments between the name and the caret; the caret
        // lies in the last segment. A depth-0 '}' means the extension closed before the caret.
        int segStart = i;
        int argIndex = 0;
        int depth = 0;
        for (int j = i; j < offset; j++)
        {
            char ch = text[j];
            if (ch is '(' or '{' or '[')
            {
                depth++;
            }
            else if (ch is ')' or ']')
            {
                if (depth > 0)
                {
                    depth--;
                }
            }
            else if (ch == '}')
            {
                if (depth > 0)
                {
                    depth--;
                }
                else
                {
                    return null;
                }
            }
            else if (ch == ',' && depth == 0)
            {
                segStart = j + 1;
                argIndex++;
            }
        }

        // The current segment (text[segStart..offset)) is either a Name=value named arg or a positional one.
        int s = segStart;
        while (s < offset && char.IsWhiteSpace(text[s]))
        {
            s++;
        }

        int eq = -1;
        int eqDepth = 0;
        for (int j = s; j < offset; j++)
        {
            char ch = text[j];
            if (ch is '(' or '{' or '[')
            {
                eqDepth++;
            }
            else if (ch is ')' or '}' or ']')
            {
                if (eqDepth > 0)
                {
                    eqDepth--;
                }
            }
            else if (ch == '=' && eqDepth == 0)
            {
                eq = j;
                break;
            }
        }

        int typeStart;
        if (eq >= 0)
        {
            // Named argument: only Type= carries the type; IsDesignTimeCreatable= etc. are not type refs.
            if (text.Substring(s, eq - s).Trim() != "Type")
            {
                return null;
            }

            typeStart = eq + 1;
            while (typeStart < offset && char.IsWhiteSpace(text[typeStart]))
            {
                typeStart++;
            }
        }
        else
        {
            // Positional: only the FIRST argument is the type (positional args precede named ones in XAML).
            if (argIndex != 0)
            {
                return null;
            }

            typeStart = s;
        }

        // The type token runs to the caret and must not have ended (a delimiter/whitespace/nested brace).
        var partial = text.Substring(typeStart, offset - typeStart);
        foreach (var ch in partial)
        {
            if (ch is '}' or ',' or '=' or '{' || char.IsWhiteSpace(ch))
            {
                return null;
            }
        }

        return new Context(ContextKind.DesignInstanceType, partial, typeStart, bindPrefixPath: extPrefix);
    }

    /// <summary>
    /// Completes the type argument of a <c>{d:DesignInstance …}</c> hint. Gates on the extension prefix
    /// (carried in <c>ctx.BindPrefixPath</c>) resolving to a design-time namespace — mirroring round 52's
    /// <see cref="IsDesignInstanceExtension"/> — so a foreign/undeclared <c>{zzz:DesignInstance …}</c>
    /// offers nothing; otherwise delegates to the shared type-name completer (all kinds, like <c>{x:Type}</c>).
    /// </summary>
    private static CompletionList CompleteDesignInstanceType(
        Context ctx, XamlNamespaceScope scope, XamlTypeSystem typeSystem, Lsp.Range replaceRange)
    {
        if (string.IsNullOrEmpty(ctx.BindPrefixPath) ||
            !scope.TryResolvePrefix(ctx.BindPrefixPath!, out var uri) ||
            !IsDesignTimeNamespace(uri))
        {
            return new CompletionList();
        }

        return CompleteTypeNameValue(ctx.Partial, scope, typeSystem, replaceRange, allTypeKinds: true);
    }

    /// <summary>
    /// Completes the static members (fields, properties, constants, enum members) of the owner type of an
    /// <c>{x:Static Owner.|}</c> reference. The owner is carried in <c>ctx.BindPrefixPath</c>; only public
    /// static fields/properties are offered, base-walked so inherited statics appear.
    /// </summary>
    private static CompletionList CompleteStaticMember(
        Context ctx, XamlNamespaceScope scope, XamlTypeSystem typeSystem, Lsp.Range replaceRange)
    {
        if (string.IsNullOrEmpty(ctx.BindPrefixPath))
        {
            return new CompletionList();
        }

        SplitQualified(ctx.BindPrefixPath!, out var prefix, out var local);
        if (!scope.TryResolvePrefix(prefix, out var uri))
        {
            return new CompletionList();
        }

        var owner = typeSystem.ResolveType(uri, local);
        if (owner is null)
        {
            return new CompletionList();
        }

        var items = new List<CompletionItem>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (INamedTypeSymbol? t = owner; t != null; t = t.BaseType)
        {
            foreach (var member in t.GetMembers())
            {
                if (!member.IsStatic ||
                    member.DeclaredAccessibility != Accessibility.Public ||
                    member is not (IFieldSymbol or IPropertySymbol) ||
                    !StartsWith(member.Name, ctx.Partial) ||
                    !seen.Add(member.Name))
                {
                    continue;
                }

                var isEnumMember = member is IFieldSymbol { ContainingType.TypeKind: TypeKind.Enum };
                items.Add(new CompletionItem
                {
                    Label = member.Name,
                    Kind = isEnumMember ? CompletionItemKind.EnumMember
                        : member is IPropertySymbol ? CompletionItemKind.Property : CompletionItemKind.Field,
                    Documentation = CompletionDoc(member),
                    Detail = member.ContainingType?.Name,
                    TextEdit = new TextEdit { Range = replaceRange, NewText = member.Name },
                    FilterText = member.Name,
                    SortText = member.Name,
                });
            }
        }

        return Finish(items);
    }

    /// <summary>
    /// If the attribute value is a <c>{TemplateBinding ...}</c> and the caret sits in its property
    /// (first positional) argument, returns a <see cref="ContextKind.TemplateBinding"/> context with the
    /// partial property name. Returns null once the token has ended (a delimiter or whitespace was typed).
    /// </summary>
    private static Context? TryClassifyTemplateBinding(string text, int valueStart, int offset)
    {
        int i = valueStart;
        while (i < offset && char.IsWhiteSpace(text[i]))
        {
            i++;
        }

        if (i >= offset || text[i] != '{')
        {
            return null;
        }

        i++; // past '{'
        while (i < offset && char.IsWhiteSpace(text[i]))
        {
            i++;
        }

        int nameStart = i;
        while (i < offset && (char.IsLetterOrDigit(text[i]) || text[i] == ':'))
        {
            i++;
        }

        if (text.Substring(nameStart, i - nameStart) != "TemplateBinding")
        {
            return null;
        }

        // A space must separate the name from the property (so "{TemplateBinding" alone is name completion).
        if (i >= offset || !char.IsWhiteSpace(text[i]))
        {
            return null;
        }

        while (i < offset && char.IsWhiteSpace(text[i]))
        {
            i++;
        }

        var propSoFar = text.Substring(i, offset - i);
        foreach (var ch in propSoFar)
        {
            if (ch is '}' or ',' or '=' || char.IsWhiteSpace(ch))
            {
                return null;
            }
        }

        return new Context(ContextKind.TemplateBinding, propSoFar, i);
    }

    /// <summary>
    /// If the caret sits in a <c>Name=value</c> named argument of a markup extension (the attribute
    /// value opens with <c>{</c>), returns a <see cref="ContextKind.MarkupArg"/> context carrying the
    /// argument name (in <see cref="Context.AttributeName"/>) and the partial value typed after <c>=</c>.
    /// Only enum-valued arguments are completed today (Mode -> BindingMode).
    /// </summary>
    private static Context? TryClassifyMarkupArg(string text, int valueStart, int offset)
    {
        int open = valueStart;
        while (open < offset && char.IsWhiteSpace(text[open]))
        {
            open++;
        }

        if (open >= offset || text[open] != '{')
        {
            return null; // not a markup extension
        }

        var extension = ReadExtensionName(text, open, offset);

        // The partial value is the run of value chars immediately before the caret.
        int v = offset;
        while (v > open && (char.IsLetterOrDigit(text[v - 1]) || text[v - 1] == '_'))
        {
            v--;
        }

        // Immediately before the partial we require '=' (allowing surrounding whitespace).
        int e = v;
        while (e > open && char.IsWhiteSpace(text[e - 1]))
        {
            e--;
        }

        if (e <= open || text[e - 1] != '=')
        {
            return null;
        }

        // Read the argument name preceding '='.
        int nameEnd = e - 1;
        while (nameEnd > open && char.IsWhiteSpace(text[nameEnd - 1]))
        {
            nameEnd--;
        }

        int nameStart = nameEnd;
        while (nameStart > open && (char.IsLetterOrDigit(text[nameStart - 1]) || text[nameStart - 1] == '_'))
        {
            nameStart--;
        }

        if (nameStart >= nameEnd)
        {
            return null;
        }

        var argName = text.Substring(nameStart, nameEnd - nameStart);
        var partial = text.Substring(v, offset - v);
        return new Context(ContextKind.MarkupArg, partial, v, attributeName: argName, markupExtension: extension);
    }

    /// <summary>Reads the extension name token immediately after the opening <c>{</c> at <paramref name="open"/>.</summary>
    private static string ReadExtensionName(string text, int open, int limit)
    {
        int i = open + 1;
        while (i < limit && char.IsWhiteSpace(text[i]))
        {
            i++;
        }

        int start = i;
        while (i < limit && (char.IsLetterOrDigit(text[i]) || text[i] is '_' or ':'))
        {
            i++;
        }

        return text.Substring(start, i - start);
    }

    /// <summary>
    /// If the caret sits where a markup extension ARGUMENT NAME would be typed (just after the extension
    /// name or after a <c>,</c> separator, with no <c>=</c> yet), returns a <see cref="ContextKind.MarkupArg"/>
    /// context with a null argument name signalling name completion (e.g. <c>{RelativeSource |}</c> -> Mode).
    /// Runs after <see cref="TryClassifyMarkupArg"/> so <c>Name=value</c> still classifies as a value.
    /// </summary>
    private static Context? TryClassifyMarkupArgName(string text, int valueStart, int offset)
    {
        int open = valueStart;
        while (open < offset && char.IsWhiteSpace(text[open]))
        {
            open++;
        }

        if (open >= offset || text[open] != '{')
        {
            return null;
        }

        int nameStartIdx = open + 1;
        while (nameStartIdx < offset && char.IsWhiteSpace(text[nameStartIdx]))
        {
            nameStartIdx++;
        }

        int nameEndIdx = nameStartIdx;
        while (nameEndIdx < offset && (char.IsLetterOrDigit(text[nameEndIdx]) || text[nameEndIdx] is '_' or ':'))
        {
            nameEndIdx++;
        }

        var extension = text.Substring(nameStartIdx, nameEndIdx - nameStartIdx);
        if (extension.Length == 0 || nameEndIdx >= offset)
        {
            return null; // still typing the name itself, or empty — handled by TryClassifyMarkupName
        }

        // The current token (argument-name partial) run immediately before the caret.
        int p = offset;
        while (p > nameEndIdx && (char.IsLetterOrDigit(text[p - 1]) || text[p - 1] == '_'))
        {
            p--;
        }

        // Skip whitespace back to the boundary that precedes the partial.
        int b = p;
        while (b > nameEndIdx && char.IsWhiteSpace(text[b - 1]))
        {
            b--;
        }

        // Valid name position: right after the extension name, or after an argument separator ','.
        bool afterName = b == nameEndIdx && p > nameEndIdx;
        bool afterComma = b > nameEndIdx && text[b - 1] == ',';
        if (!afterName && !afterComma)
        {
            return null;
        }

        var partial = text.Substring(p, offset - p);
        return new Context(ContextKind.MarkupArg, partial, p, attributeName: null, markupExtension: extension);
    }

    /// <summary>
    /// If the attribute value beginning at <paramref name="valueStart"/> opens a markup extension
    /// (<c>{</c>) and the caret is still inside the extension's NAME token (no whitespace or argument
    /// separator typed yet), returns a <see cref="ContextKind.MarkupName"/> context carrying the partial
    /// name. Runs before <see cref="TryClassifyBind"/> so typing <c>{x:B</c> completes the name rather
    /// than eagerly listing bind members.
    /// </summary>
    private static Context? TryClassifyMarkupName(string text, int valueStart, int offset)
    {
        int i = valueStart;
        while (i < offset && char.IsWhiteSpace(text[i]))
        {
            i++;
        }

        if (i >= offset || text[i] != '{')
        {
            return null;
        }

        i++; // past '{'
        while (i < offset && char.IsWhiteSpace(text[i]))
        {
            i++;
        }

        int nameStart = i;
        while (i < offset && (char.IsLetterOrDigit(text[i]) || text[i] is '_' or ':'))
        {
            i++;
        }

        // The caret must sit at the end of the name token. Anything after it (space, '=', ',', '}',
        // '(') means the user has moved past the name into the extension's arguments.
        if (i != offset)
        {
            return null;
        }

        var partial = text.Substring(nameStart, offset - nameStart);
        return new Context(ContextKind.MarkupName, partial, nameStart);
    }

    /// <summary>
    /// If the attribute value beginning at <paramref name="valueStart"/> is an <c>{x:Bind ...}</c> or a
    /// classic <c>{Binding ...}</c> expression and the caret sits in its first positional (path) argument or
    /// its <c>Path=</c> named argument, returns a <see cref="ContextKind.BindPath"/> context carrying the
    /// member partial being typed and any leading dotted path. Classic <c>{Binding}</c> is flagged
    /// <see cref="Context.IsClassicBinding"/> (its root is the enclosing template's <c>x:DataType</c>) and is
    /// declined when the binding redirects its source (<c>Source=</c>/<c>ElementName=</c>/<c>RelativeSource=</c>),
    /// since the path then targets that source, not the DataContext. Returns null for other markup extensions,
    /// named arguments, or once the path token has ended — deliberately robust to the unterminated input
    /// completion runs on.
    /// </summary>
    private static Context? TryClassifyBind(string text, int valueStart, int offset)
    {
        int i = valueStart;
        while (i < offset && char.IsWhiteSpace(text[i]))
        {
            i++;
        }

        if (i >= offset || text[i] != '{')
        {
            return null;
        }

        int braceIndex = i;
        i++; // past '{'
        while (i < offset && char.IsWhiteSpace(text[i]))
        {
            i++;
        }

        int nameStart = i;
        while (i < offset && (char.IsLetterOrDigit(text[i]) || text[i] == ':'))
        {
            i++;
        }

        var extName = text.Substring(nameStart, i - nameStart);
        if (extName != "x:Bind" && extName != "Bind" && extName != "Binding")
        {
            return null; // only compiled bindings and classic {Binding} offer a statically typed path
        }

        bool isClassic = extName == "Binding";

        // A classic {Binding} roots its path away from the DataContext when its source is redirected. An
        // ElementName=Foo redirect roots the path at that named element's TYPE (resolved in CompleteBindPath);
        // a Source=/RelativeSource= redirect targets an object whose type isn't statically known here, so those
        // still decline. (x:Bind never carries these — it roots at the page x:Class / template x:DataType.)
        string? bindElementName = null;
        if (isClassic)
        {
            var redirect = ClassifyBindingSource(text, i, braceIndex, out var elementName);
            if (redirect == ClassicBindingRoot.Other)
            {
                return null;
            }

            if (redirect == ClassicBindingRoot.ElementName)
            {
                bindElementName = elementName;
            }
        }

        while (i < offset && char.IsWhiteSpace(text[i]))
        {
            i++;
        }

        // Locate the argument the caret sits in and whether it is the first. The bindable path is
        // either the first positional argument ({x:Bind Greeting}) or the value of a named "Path="
        // argument ({x:Bind Path=Greeting}); every other named argument (Mode=, Converter=) is not a
        // statically typed path and is handled by the markup-argument classifier instead.
        int argStart = i;
        bool firstArg = true;
        int depth = 0;
        for (int j = i; j < offset; j++)
        {
            char c = text[j];
            if (c is '(' or '{')
            {
                depth++;
            }
            else if (c is ')' or '}')
            {
                if (depth > 0)
                {
                    depth--;
                }
            }
            else if (c == ',' && depth == 0)
            {
                argStart = j + 1;
                firstArg = false;
            }
        }

        int p = argStart;
        while (p < offset && char.IsWhiteSpace(text[p]))
        {
            p++;
        }

        // A top-level '=' in this argument marks it named (Name=value).
        int eq = -1;
        int nameDepth = 0;
        for (int j = p; j < offset; j++)
        {
            char c = text[j];
            if (c is '(' or '{')
            {
                nameDepth++;
            }
            else if (c is ')' or '}')
            {
                if (nameDepth > 0)
                {
                    nameDepth--;
                }
            }
            else if (c == '=' && nameDepth == 0)
            {
                eq = j;
                break;
            }
        }

        int pathStart;
        if (eq >= 0)
        {
            if (text.Substring(p, eq - p).Trim() != "Path")
            {
                return null; // Mode=, Converter=, etc. — not a statically typed path
            }

            pathStart = eq + 1;
            while (pathStart < offset && char.IsWhiteSpace(text[pathStart]))
            {
                pathStart++;
            }
        }
        else
        {
            if (!firstArg)
            {
                return null; // only the first argument may be a bare positional path
            }

            pathStart = p;
        }

        // Everything from the path start to the caret is the path typed so far. Any non path-char
        // (comma, '=', '}', whitespace, parens) means the caret has moved past the path token.
        // Square brackets are path chars so indexer segments (Items[0].Member) keep completing.
        // A leading '!' negates the bound boolean path; completion targets the member after it.
        while (pathStart < offset && (text[pathStart] == '!' || char.IsWhiteSpace(text[pathStart])))
        {
            pathStart++;
        }

        // A leading cast ((local:Type)Member) rebinds the completion root to the named type; skip the
        // parenthesized type so the members typed after ')' complete against the cast target. Only a
        // dot-less inner (a real cast) is handled; an attached-property step ((Owner.Member)) is not
        // completed here. While the caret is still inside the '(...)' there is no member to complete.
        string? bindCastType = null;
        if (pathStart < offset && text[pathStart] == '(')
        {
            int close = text.IndexOf(')', pathStart + 1);
            if (close < 0 || close >= offset)
            {
                return null;
            }

            string inner = text.Substring(pathStart + 1, close - pathStart - 1).Trim();
            if (inner.Length == 0 || inner.IndexOf('.') >= 0)
            {
                return null;
            }

            bindCastType = inner;
            pathStart = close + 1;
            while (pathStart < offset && char.IsWhiteSpace(text[pathStart]))
            {
                pathStart++;
            }
        }

        // A function binding (Method(arg, arg)) roots each ARGUMENT against the bind root. If the caret sits
        // inside the argument list, re-root the path scan to the current argument so its members complete
        // (rather than bailing on the '(' below). The current argument starts after the enclosing '(' or the
        // last top-level comma within it.
        int argDepth = 0;
        int currentArgStart = pathStart;
        bool insideFunctionArgs = false;
        for (int j = pathStart; j < offset; j++)
        {
            char c = text[j];
            if (c == '(')
            {
                argDepth++;
                if (argDepth == 1)
                {
                    currentArgStart = j + 1;
                    insideFunctionArgs = true;
                }
            }
            else if (c == ')')
            {
                if (argDepth > 0)
                {
                    argDepth--;
                }

                if (argDepth == 0)
                {
                    insideFunctionArgs = false;
                }
            }
            else if (c == ',' && argDepth == 1)
            {
                currentArgStart = j + 1;
            }
        }

        if (insideFunctionArgs)
        {
            pathStart = currentArgStart;
            while (pathStart < offset && char.IsWhiteSpace(text[pathStart]))
            {
                pathStart++;
            }

            bindCastType = null; // a cast inside a function argument is not modelled for completion
        }

        var pathSoFar = text.Substring(pathStart, offset - pathStart);
        foreach (var ch in pathSoFar)
        {
            if (!char.IsLetterOrDigit(ch) && ch != '_' && ch != '.' && ch != '[' && ch != ']')
            {
                return null;
            }
        }

        int dot = pathSoFar.LastIndexOf('.');
        if (dot < 0)
        {
            return new Context(ContextKind.BindPath, pathSoFar, pathStart, bindPrefixPath: string.Empty, bindCastType: bindCastType, isClassicBinding: isClassic, bindElementName: bindElementName);
        }

        var prefixPath = pathSoFar.Substring(0, dot);
        var memberPartial = pathSoFar.Substring(dot + 1);
        return new Context(ContextKind.BindPath, memberPartial, pathStart + dot + 1, bindPrefixPath: prefixPath, bindCastType: bindCastType, isClassicBinding: isClassic, bindElementName: bindElementName);
    }

    /// <summary>How a classic <c>{Binding}</c> roots the path being completed.</summary>
    private enum ClassicBindingRoot { DataContext, ElementName, Other }

    /// <summary>
    /// Classifies how a classic <c>{Binding}</c> roots its path by inspecting its TOP-LEVEL arguments. A
    /// <c>Source=</c>/<c>RelativeSource=</c> argument targets an object whose type is not statically known here
    /// → <see cref="ClassicBindingRoot.Other"/> (a hard redirect, which wins). An <c>ElementName=Foo</c>
    /// argument roots the path at the named element's type → <see cref="ClassicBindingRoot.ElementName"/> with
    /// <paramref name="elementName"/> set to <c>Foo</c>. Otherwise the path is DataContext-rooted →
    /// <see cref="ClassicBindingRoot.DataContext"/>. Each argument's NAME is the token before its first
    /// top-level <c>=</c> (via <see cref="SplitMarkupArg"/>), so a path member literally named
    /// <c>Source</c>/<c>ElementName</c> (a positional value) never trips it. Bounds the scan to the extension's
    /// matching <c>}</c> or the attribute-value/line edge (completion text is frequently unterminated).
    /// </summary>
    private static ClassicBindingRoot ClassifyBindingSource(string text, int nameEnd, int braceIndex, out string? elementName)
    {
        elementName = null;

        int end = braceIndex + 1;
        int depth = 1;
        while (end < text.Length)
        {
            char c = text[end];
            if (c == '{')
            {
                depth++;
            }
            else if (c == '}')
            {
                depth--;
                if (depth == 0)
                {
                    break;
                }
            }
            else if (c is '"' or '\'' or '\n')
            {
                break;
            }

            end++;
        }

        var root = ClassicBindingRoot.DataContext;
        int argStart = nameEnd;
        int d = 0;
        for (int j = nameEnd; j <= end; j++)
        {
            bool boundary = j >= end || j >= text.Length;
            char c = boundary ? ',' : text[j];
            if (!boundary && c is '(' or '{' or '[')
            {
                d++;
            }
            else if (!boundary && c is ')' or '}' or ']')
            {
                if (d > 0)
                {
                    d--;
                }
            }
            else if (c == ',' && d == 0)
            {
                var (name, val) = SplitMarkupArg(text, argStart, j);
                if (name is "Source" or "RelativeSource")
                {
                    return ClassicBindingRoot.Other; // a hard redirect wins immediately
                }

                if (name == "ElementName")
                {
                    root = ClassicBindingRoot.ElementName;
                    elementName = val;
                }

                argStart = j + 1;
            }

            if (boundary)
            {
                break;
            }
        }

        return root;
    }

    // --- Symbol helpers ---------------------------------------------------------------------------

    private static INamedTypeSymbol? ResolveElementType(
        XamlName name, XamlNamespaceScope scope, XamlTypeSystem typeSystem)
    {
        if (!scope.TryResolvePrefix(name.Prefix, out var uri))
        {
            return null;
        }

        return typeSystem.ResolveType(uri, name.LocalName);
    }

    private static XamlName ParseQualified(string qualified)
    {
        SplitQualified(qualified, out var prefix, out var local);
        var empty = TextSpan.Empty(0);
        return new XamlName(prefix.Length > 0 ? prefix : null, local, empty, null, empty);
    }

    private static void SplitQualified(string name, out string prefix, out string local)
    {
        int colon = name.IndexOf(':');
        if (colon >= 0)
        {
            prefix = name.Substring(0, colon);
            local = name.Substring(colon + 1);
        }
        else
        {
            prefix = string.Empty;
            local = name;
        }
    }

    private static XamlElement? FindEnclosingElement(XamlNode? node)
    {
        for (var current = node; current != null; current = current.Parent)
        {
            if (current is XamlElement element)
            {
                return element;
            }
        }

        return null;
    }

    private static XamlNamespaceScope EffectiveScope(XamlNode? node, XamlDocument document)
    {
        for (var current = node; current != null; current = current.Parent)
        {
            if (current is XamlElement element && element.NamespaceScope.Declarations.Count > 0)
            {
                return element.NamespaceScope;
            }
        }

        return document.Root?.NamespaceScope ?? XamlNamespaceScope.Empty;
    }

    private static string DescribeMember(XamlMemberInfo member)
    {
        var typeName = member.Type?.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat) ?? "?";
        var kind = member.Kind == XamlMemberKind.Event ? "event" : "property";
        return $"{kind} : {typeName}";
    }

    /// <summary>
    /// The symbol's XML-doc <c>&lt;summary&gt;</c> as a completion documentation flyout (VS quick-info
    /// parity), or null when the symbol is null or carries no doc / summary. Reuses the round-66
    /// <see cref="XmlDocSummary"/> engine — which flattens inline doc tags (<c>&lt;see cref&gt;</c>, etc.)
    /// and strips DocFX/HTML authoring markup — so a completion item's documentation reads identically to
    /// the hover quick-info for the same member. Eager is safe: warm <c>GetDocumentationCommentXml</c>
    /// reads are effectively free (Roslyn caches the documentation provider on the metadata reference), and
    /// the one-time cold provider-init cost already exists in the hover path.
    /// </summary>
    private static MarkupContent? CompletionDoc(ISymbol? symbol)
    {
        var summary = symbol is null ? null : XmlDocSummary.Extract(symbol.GetDocumentationCommentXml());
        return summary is null ? null : new MarkupContent { Value = summary };
    }

    private static bool StartsWith(string candidate, string partial) =>
        partial.Length == 0 || candidate.StartsWith(partial, StringComparison.OrdinalIgnoreCase);

    private static bool IsNameChar(char c) =>
        char.IsLetterOrDigit(c) || c is '_' or ':' or '.';

    private static int IndexOfWhitespace(string s)
    {
        for (int i = 0; i < s.Length; i++)
        {
            if (char.IsWhiteSpace(s[i]))
            {
                return i;
            }
        }

        return -1;
    }

    private const int MaxItems = 2000;

    private static CompletionList Finish(List<CompletionItem> items)
    {
        bool incomplete = items.Count > MaxItems;
        if (incomplete)
        {
            items = items.GetRange(0, MaxItems);
        }

        return new CompletionList { IsIncomplete = incomplete, Items = items };
    }
}
