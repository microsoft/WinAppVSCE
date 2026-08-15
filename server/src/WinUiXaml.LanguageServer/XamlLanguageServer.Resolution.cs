using Microsoft.CodeAnalysis;
using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Workspace;
using WinUiXaml.Xaml;

namespace WinUiXaml.LanguageServer;

internal sealed partial class XamlLanguageServer
{
    private async Task<object?> HoverAsync(TextDocumentPositionParams p)
    {
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var document))
        {
            return null;
        }

        var offset = document.OffsetAt(p.Position);
        if (XamlDirectiveMetadata.Resolve(document, offset) is { } directive)
        {
            return new Hover
            {
                Contents = new MarkupContent { Kind = "markdown", Value = directive.Markdown },
                Range = directive.Range,
            };
        }

        // didOpen eagerly starts the trusted project context, but a cold MSBuild design-time build
        // takes seconds. Never queue project-independent quick info behind it.
        if (!TryGetReadyContext(p.TextDocument.Uri, out _))
        {
            // An invalidation clears ready contexts while the document remains open. Ensure the
            // existing trusted, single-flight warm-up is running before returning immediate prose.
            WarmUp(document.Uri);

            var nameReference = await ResolveNameReferenceHoverAsync(p).ConfigureAwait(false);
            if (nameReference is not null)
            {
                return nameReference;
            }

            if (FindResourceKeyReferenceAt(document, offset) is { } resource)
            {
                return new Hover
                {
                    Contents = new MarkupContent
                    {
                        Kind = "markdown",
                        Value = $"```xaml\n(resource) {resource.Key}\n```\n\nReferences a XAML resource by key.",
                    },
                    Range = document.RangeOf(resource.Span),
                };
            }

            if (ResolveProjectIndependentMarkupHover(document, offset) is { } markup)
            {
                return markup;
            }

            return ResolveSyntacticHover(document, offset);
        }

        var resourceHover = await ResolveResourceKeyHoverAsync(p).ConfigureAwait(false);
        if (resourceHover != null)
        {
            return resourceHover;
        }

        // Named-element reference (Binding ElementName=Foo / Storyboard.TargetName="Foo") -> the element it points at. Before the symbol pipeline so TargetName does not render the generated field.
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

        // Markup-extension names ({x:Bind}, {StaticResource}) and enum attribute/argument values ("Center", Mode=OneWay) are not resolvable to a single navigable symbol the way an x:Class member is, so they get their own hover resolver ahead of the symbol pipeline.
        var valueHover = await ResolveValueHoverAsync(p).ConfigureAwait(false);
        if (valueHover != null)
        {
            return valueHover;
        }

        // An x:Bind attached-property path step ({x:Bind (Grid.Row)}): resolved like the attribute-form attached-property hover. Before the symbol pipeline (the member walk does not model it).
        var bindAttachedHover = await ResolveBindAttachedHoverAsync(p).ConfigureAwait(false);
        if (bindAttachedHover != null)
        {
            return bindAttachedHover;
        }

        // A parenthesized (Owner.AttachedProperty) inside Storyboard.TargetProperty ((Canvas.Left)) renders with the attached-property framing. Instance members and the owner-type caret fall through to the symbol pipeline (which renders "T Owner.Member" / the type). Before the symbol pipeline for the same reason.
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

        TryGetReadyTypeSystem(p.TextDocument.Uri, out var hoverTypeSystem);
        return new Hover
        {
            Contents = new MarkupContent
            {
                Kind = "markdown",
                Value = HoverMarkdown(DescribeForHover(symbol), symbol, typeSystem: hoverTypeSystem),
            },
            Range = _documents.TryGetValue(p.TextDocument.Uri, out var doc) ? doc.RangeOf(span.Value) : null,
        };
    }

    /// <summary>Hover for markup-extension NAMES (a curated description of {x:Bind}, {StaticResource}</summary>
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
            XamlTypeSystem? typeSystem = null;
            if (extension.Name is { } exName && exName.Span.ContainsInclusive(offset))
            {
                var extensionScope = NearestElementScope(extension);
                if (NormalizeProjectIndependentMarkupName(
                        exName,
                        extensionScope) is { } normalizedName &&
                    DescribeMarkupExtension(normalizedName) is { } description)
                {
                    return new Hover
                    {
                        Contents = new MarkupContent { Kind = "markdown", Value = description },
                        Range = doc.RangeOf(exName.Span),
                    };
                }

                typeSystem = await GetTypeSystemAsync(p.TextDocument.Uri).ConfigureAwait(false);
                var scope = extensionScope;
                var extensionType = typeSystem is null || scope is null
                    ? null
                    : XamlSemanticFacts.ResolveMarkupExtensionType(
                        exName.FullName,
                        scope,
                        typeSystem);
                if (extensionType is not null)
                {
                    var frameworkDescription =
                        SymbolEqualityComparer.Default.Equals(
                            extensionType,
                            typeSystem!.Capabilities.Binding) ||
                        SymbolEqualityComparer.Default.Equals(
                            extensionType,
                            typeSystem.Capabilities.RelativeSource)
                            ? DescribeMarkupExtension(exName.FullName)
                            : null;
                    return new Hover
                    {
                        Contents = new MarkupContent
                        {
                            Kind = "markdown",
                            Value = frameworkDescription ??
                                HoverMarkdown(
                                    DescribeForHover(extensionType),
                                    extensionType,
                                    typeSystem: typeSystem),
                        },
                        Range = doc.RangeOf(exName.Span),
                    };
                }
            }

            typeSystem ??= await GetTypeSystemAsync(p.TextDocument.Uri).ConfigureAwait(false);
            var argHover = typeSystem is null ? null : ResolveMarkupArgumentEnumHover(extension, offset, typeSystem, doc);
            if (argHover is not null)
            {
                return argHover;
            }
        }

        // 2) Enum value typed directly as an attribute value (HorizontalAlignment="Center").
        // Do not request project metadata unless the caret is actually inside a plain attribute
        // value. Previously every element/attribute hover paid this await before symbol dispatch.
        var valueAttribute = FindPlainValueAttributeAt(doc, offset);
        if (valueAttribute is null)
        {
            return null;
        }

        var ts = await GetTypeSystemAsync(p.TextDocument.Uri).ConfigureAwait(false);
        return ts is null ? null : ResolveAttributeEnumHover(doc, offset, ts);
    }

    private static XamlAttribute? FindPlainValueAttributeAt(TextDocument document, int offset)
    {
        for (var current = document.Parsed.FindNode(offset); current is not null; current = current.Parent)
        {
            if (current is XamlAttribute attribute)
            {
                return !attribute.IsNamespaceDeclaration &&
                    attribute.Value is { IsMarkupExtension: false } value &&
                    value.InnerSpan.ContainsInclusive(offset)
                    ? attribute
                    : null;
            }

            if (current is XamlElement)
            {
                return null;
            }
        }

        return null;
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

    /// <summary>Curated hover markdown for a known markup extension name (by full name.</summary>
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
            "```xaml\n{RelativeSource}\n```\nSpecifies a binding source relative to the target (`Self` or `TemplatedParent`).",
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

    internal static string? NormalizeProjectIndependentMarkupName(
        XamlName name,
        XamlNamespaceScope? scope)
    {
        if (name.HasPrefix)
        {
            return scope is not null &&
                scope.TryResolvePrefix(name.Prefix, out var xamlNamespace) &&
                string.Equals(
                    xamlNamespace,
                    XamlTypeSystem.XamlLanguageNamespace,
                    StringComparison.Ordinal)
                        ? "x:" + name.LocalName
                        : null;
        }

        return scope is null ||
            !scope.TryResolvePrefix(string.Empty, out var namespaceUri) ||
            string.Equals(
                namespaceUri,
                XamlTypeSystem.PresentationNamespace,
                StringComparison.Ordinal)
                    ? name.LocalName
                    : null;
    }

    private static Hover? ResolveProjectIndependentMarkupHover(TextDocument document, int offset)
    {
        if (document.Parsed.Root is not { } root ||
            InnermostMarkupExtensionAt(root, offset) is not { } extension ||
            extension.Name is not { } name ||
            !name.Span.ContainsInclusive(offset) ||
            NormalizeProjectIndependentMarkupName(
                name,
                NearestElementScope(extension)) is not { } normalizedName ||
            DescribeMarkupExtension(normalizedName) is not { } description)
        {
            return null;
        }

        return new Hover
        {
            Contents = new MarkupContent { Kind = "markdown", Value = description },
            Range = document.RangeOf(name.Span),
        };
    }

    internal static Hover? ResolveSyntacticHover(TextDocument document, int offset)
    {
        for (var node = document.Parsed.FindNode(offset); node is not null; node = node.Parent)
        {
            if (node is XamlAttribute attribute && attribute.Parent is XamlElement owner)
            {
                if (!attribute.IsNamespaceDeclaration && attribute.Name.Span.ContainsInclusive(offset))
                {
                    var ownerName = owner.Name?.FullName ?? "the containing element";
                    var literal = attribute.Value is { IsMarkupExtension: false } attributeValue
                        ? $" The current literal value is `{EscapeMarkdownCode(attributeValue.Text)}`."
                        : string.Empty;
                    return PlainXamlHover(
                        $"attribute {attribute.Name.FullName}",
                        $"XAML attribute `{attribute.Name.FullName}` on the `{ownerName}` element.{literal}",
                        document.RangeOf(attribute.Name.Span));
                }

                if (!attribute.IsNamespaceDeclaration &&
                    attribute.Value is { } value &&
                    value.InnerSpan.ContainsInclusive(offset))
                {
                    var ownerName = owner.Name?.FullName ?? "the containing element";
                    var valueDescription = value.IsMarkupExtension
                        ? $"XAML markup expression `{EscapeMarkdownCode(value.Text)}` assigned to the `{attribute.Name.FullName}` attribute on the `{ownerName}` element."
                        : $"Literal value `{EscapeMarkdownCode(value.Text)}` assigned to the `{attribute.Name.FullName}` attribute on the `{ownerName}` element.";
                    return PlainXamlHover(
                        $"value for {attribute.Name.FullName}",
                        valueDescription,
                        document.RangeOf(value.InnerSpan));
                }
            }

            if (node is XamlElement element &&
                element.Name is { } name &&
                name.Span.ContainsInclusive(offset))
            {
                var namespaceText = element.NamespaceScope.TryResolvePrefix(name.Prefix, out var namespaceUri)
                    ? $" in the `{EscapeMarkdownCode(namespaceUri)}` namespace"
                    : string.Empty;
                return PlainXamlHover(
                    $"element {name.FullName}",
                    $"XAML element `{name.FullName}`{namespaceText}.",
                    document.RangeOf(name.Span));
            }
        }

        return null;
    }

    private static string EscapeMarkdownCode(string text) => text.Replace("`", "\\`", StringComparison.Ordinal);

    private static Hover PlainXamlHover(string signature, string description, Lsp.Range range) =>
        new()
        {
            Contents = new MarkupContent
            {
                Kind = "markdown",
                Value = $"```xaml\n({signature})\n```\n\n{description}",
            },
            Range = range,
        };

    /// <summary>Hover for an enum value inside a markup-extension named argument.</summary>
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

            var scope = NearestElementScope(extension);
            var argType = scope is null
                ? null
                : XamlSemanticFacts.ResolveMarkupArgumentType(
                    extension,
                    scope,
                    argName.LocalName,
                    typeSystem);
            if (argType is { TypeKind: TypeKind.Enum } &&
                FindEnumMember(argType, valueText) is { } member)
            {
                return new Hover
                {
                    Contents = new MarkupContent
                    {
                        Kind = "markdown",
                        Value = HoverMarkdown(DescribeForHover(member), member, typeSystem: typeSystem),
                    },
                    Range = doc.RangeOf(valueSpan),
                };
            }
        }

        return null;
    }

    /// <summary>Hover for an enum value typed directly as an attribute value (HorizontalAlignment="Center"): resolves the attribute's member type on the owner element and</summary>
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
            Contents = new MarkupContent
            {
                Kind = "markdown",
                Value = HoverMarkdown(DescribeForHover(member), member, typeSystem: typeSystem),
            },
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

    /// <summary>Resolves the symbol under the caret for hover/definition, trying two pipelines in order</summary>
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

    /// <summary>Resolves the positional argument of an {x:Type TypeName} or {x:Static Owner.Member} markup extension to a symbol: the referenced type</summary>
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
            var type = XamlSemanticFacts.ResolveTypeName(value, scope, typeSystem);
            return type == null ? (null, null) : (type, valueSpan);
        }

        // {x:Static Owner.Member}: split on the last dot into the owner type and the static member.
        var owner = XamlSemanticFacts.ResolveTypeName(
            value.Substring(0, dot),
            scope,
            typeSystem);
        if (owner == null)
        {
            return (null, null);
        }

        // Caret on the owner segment or the dot -> resolve the owner type, never the member the caret is not on. valueSpan.Start is the first char of the (trimmed) value, so value indices map directly.
        int memberStart = valueSpan.Start + dot + 1;
        if (offset < memberStart)
        {
            return (owner, new TextSpan(valueSpan.Start, valueSpan.Start + dot));
        }

        var member = FindStaticMember(owner, value.Substring(dot + 1));
        return member == null ? (null, null) : (member, new TextSpan(memberStart, valueSpan.End));
    }

    /// <summary>Resolves the property named by a {TemplateBinding Property} argument to the member on the enclosing ControlTemplate/Style TargetType (the templated parent), for F12/hover.</summary>
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

    /// <summary>The first public static field/property named name on the type or a base type (enum members and constants are static fields), or null.</summary>
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

    /// <summary>Walks up the parent chain to the nearest enclosing <see cref="XamlElement"/>'s namespace scope (so a markup extension inside an attribute value can resolve prefixes), or null.</summary>
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

    /// <summary>Resolves an element name (open or end tag) to its type symbol, a no-prefix &lt;Owner.Member&gt; property element to the Member property symbol on the owner type</summary>
    private async Task<(ISymbol? Symbol, TextSpan? Span)> ResolveTypeSymbolAtAsync(TextDocumentPositionParams p)
    {
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc))
        {
            return (null, null);
        }

        int offset = doc.OffsetAt(p.Position);
        var node = doc.Parsed.FindNode(offset);

        // Type-valued / Setter.Property attribute values (TargetType="...", <Setter Property="...">) resolve to the referenced type or the target type's member — before the generic pipelines, so they take precedence over the page-member fallback (which would mis-resolve Property="Content").
        var styleValue = await ResolveStyleAttributeValueAsync(p.TextDocument.Uri, offset, node).ConfigureAwait(false);
        if (styleValue.Symbol != null)
        {
            return styleValue;
        }

        // The MEMBER segment of a VSM value, or a bare Storyboard.TargetProperty="Property" value — the property on the target element's type.
        var vsmMember = await ResolveVsmTargetMemberAsync(p.TextDocument.Uri, offset, node).ConfigureAwait(false);
        if (vsmMember.Symbol != null)
        {
            return vsmMember;
        }

        // Framework members support hover but have no source location for F12.
        var qualifiedTarget = await ResolveQualifiedTargetPropertyMemberAsync(p.TextDocument.Uri, offset).ConfigureAwait(false);
        if (qualifiedTarget.Symbol != null)
        {
            return qualifiedTarget;
        }

        // {x:Type TypeName} / {x:Static Owner.Member} arguments resolve to the referenced type or static member. Checked before the name switch since the caret sits inside a markup-extension argument.
        var xReference = await ResolveXReferenceSymbolAsync(p.TextDocument.Uri, offset).ConfigureAwait(false);
        if (xReference.Symbol != null)
        {
            return xReference;
        }

        // {TemplateBinding Property} — the bound property on the enclosing ControlTemplate's TargetType (the templated parent). Powers F12/hover on the property, symmetric with the completion. Framework members resolve for hover but have no source location, so F12 returns null there.
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
                // F12/hover on a no-prefix property element.
                var peName = NameHitInElement(propertyElement, offset);
                if (peName == null)
                {
                    return (null, null);
                }

                var typeSystem = await GetTypeSystemAsync(p.TextDocument.Uri).ConfigureAwait(false);
                if (typeSystem == null ||
                    XamlSemanticFacts.ResolvePropertyElementMember(propertyElement, typeSystem) is not
                        { Owner: { } ownerType } resolved)
                {
                    return (null, null);
                }

                // Only resolve the member when the caret is actually on the Member part (past the dot); otherwise the caret is on the Owner segment, so resolve the Owner type instead of letting the member masquerade under a caret that is not on it.
                int memberStart = peName.LocalNameSpan.Start + resolved.OwnerName.Length + 1;
                if (offset < memberStart)
                {
                    var ownerSpan = new TextSpan(
                        peName.LocalNameSpan.Start,
                        peName.LocalNameSpan.Start + resolved.OwnerName.Length);
                    return (ownerType, ownerSpan);
                }

                var member = FindMember(ownerType, resolved.MemberName);
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

    /// <summary>Resolves a type-valued attribute value (TargetType="Foo") to its type symbol, or a &lt;Setter Property="Bar"&gt</summary>
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
            attr.Parent is not XamlElement owner)
        {
            return (null, null);
        }

        var typeSystem = await GetTypeSystemAsync(uri).ConfigureAwait(false);
        if (typeSystem == null)
        {
            return (null, null);
        }

        // Type-valued attributes we navigate/hover from: unprefixed TargetType, and x:DataType on a template.
        bool isTargetType = XamlSemanticFacts.IsStyleOrControlTemplate(owner, typeSystem) &&
            !attr.Name.HasPrefix &&
            string.Equals(attr.Name.LocalName, "TargetType", StringComparison.Ordinal);
        bool isDataType = XamlSemanticFacts.IsXamlDirective(
            attr,
            "DataType",
            owner.NamespaceScope);
        bool isSetterProperty = !attr.Name.HasPrefix &&
            XamlSemanticFacts.IsSetter(owner, typeSystem) &&
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

        // TargetType="Foo" / x:DataType="Foo" -> the referenced type (F12 to user-type source, hover describes it).
        if (isTargetType || isDataType)
        {
            var type = XamlSemanticFacts.ResolveTypeName(
                text,
                owner.NamespaceScope,
                typeSystem);
            return type == null ? (null, null) : (type, value.InnerSpan);
        }

        // <Setter Property="Bar"> -> the Bar member on the enclosing TargetType (attached if dotted).
        {
            int dot = text.IndexOf('.');
            if (dot > 0)
            {
                var attachedOwner = XamlSemanticFacts.ResolveTypeName(
                    text.Substring(0, dot),
                    owner.NamespaceScope,
                    typeSystem);
                var attached = attachedOwner == null ? null : FindMember(attachedOwner, text.Substring(dot + 1));
                return attached == null ? (null, null) : (attached, value.InnerSpan);
            }

            var targetType = XamlSemanticFacts.ResolveStyleTargetType(
                owner,
                owner.NamespaceScope,
                typeSystem);
            var member = targetType == null ? null : FindMember(targetType, text);
            return member == null ? (null, null) : (member, value.InnerSpan);
        }
    }

    /// <summary>Resolves the MEMBER segment of a VSM &lt;Setter Target="Element.Property"&gt; value (the property AFTER the first dot</summary>
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

        if (attr is null ||
            attr.Value is not { IsMarkupExtension: false } value ||
            !value.Span.ContainsInclusive(offset) ||
            attr.Parent is not XamlElement owner)
        {
            return (null, null);
        }

        var text = value.Text;
        var typeSystem = await GetTypeSystemAsync(uri).ConfigureAwait(false);
        if (typeSystem == null)
        {
            return (null, null);
        }

        string? elementName;
        int memStart;
        int memEnd;

        if (!attr.Name.HasPrefix &&
            string.Equals(attr.Name.LocalName, "Target", StringComparison.Ordinal) &&
            XamlSemanticFacts.IsSetter(owner, typeSystem))
        {
            // <Setter Target="Element.Property"> — the member is the single segment after the first dot.
            int dot = text.IndexOf('.');
            if (dot < 0 || text.IndexOf('.', dot + 1) >= 0)
            {
                // Defer element-only and multi-segment paths.
                return (null, null);
            }

            elementName = text.Substring(0, dot).Trim();
            memStart = dot + 1;
            memEnd = text.Length;
        }
        else if (XamlSemanticFacts.IsStoryboardAttachedProperty(
            attr.Name.FullName,
            "TargetProperty",
            owner.NamespaceScope,
            typeSystem))
        {
            // Storyboard.TargetProperty="Property" — a bare single-segment member rooted at the sibling Storyboard.TargetName. Parenthesized/dotted/attached target paths are deferred.
            if (text.IndexOf('.') >= 0 || text.IndexOf('(') >= 0)
            {
                return (null, null);
            }

            elementName = owner.Attributes.FirstOrDefault(
                a => XamlSemanticFacts.IsStoryboardAttachedProperty(
                    a.Name.FullName,
                    "TargetName",
                    owner.NamespaceScope,
                    typeSystem))
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

        var targetElement = XamlSemanticFacts.FindNamedElementInScope(
            doc,
            owner,
            elementName!,
            typeSystem);
        var elementType = targetElement is null
            ? null
            : XamlSemanticFacts.ResolveElementType(targetElement, typeSystem);
        if (elementType == null)
        {
            return (null, null);
        }

        var memberSymbol = FindMember(elementType, text.Substring(memStart, memEnd - memStart));
        return memberSymbol == null ? (null, null) : (memberSymbol, new TextSpan(absStart, absEnd));
    }

    /// <summary>A parenthesized (Owner.Member) qualifier group under the caret inside a Storyboard.TargetProperty value: the explicitly named owner-type token + span</summary>
    private readonly record struct QualifiedTargetHit(
        string OwnerToken, TextSpan OwnerSpan,
        string? MemberToken, TextSpan MemberSpan,
        bool CaretOnMember, XamlNamespaceScope Scope);

    /// <summary>Locates a parenthesized (Owner.Member) qualifier group (as used by Storyboard.TargetProperty PropertyPaths — (Canvas.Left), (UIElement.Opacity)</summary>
    private static QualifiedTargetHit? FindQualifiedTargetPropertyAt(
        TextDocument doc,
        int offset,
        XamlTypeSystem typeSystem)
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

        if (attr is null ||
            attr.Value is not { IsMarkupExtension: false } value ||
            !value.Span.ContainsInclusive(offset) ||
            attr.Parent is not XamlElement owner ||
            !XamlSemanticFacts.IsStoryboardAttachedProperty(
                attr.Name.FullName,
                "TargetProperty",
                owner.NamespaceScope,
                typeSystem))
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

        // Find the group whose parens enclose the caret: scan back from the caret — a ')' first means the caret is outside any open group; a '(' first opens the caret's group.
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

    /// <summary>Resolves a parenthesized (Owner.Member) qualifier inside Storyboard.TargetProperty to its symbol for F12/hover.</summary>
    private async Task<(ISymbol? Symbol, TextSpan? Span)> ResolveQualifiedTargetPropertyMemberAsync(string uri, int offset)
    {
        if (!_documents.TryGetValue(uri, out var doc))
        {
            return (null, null);
        }

        var typeSystem = await GetTypeSystemAsync(uri).ConfigureAwait(false);
        if (typeSystem == null)
        {
            return (null, null);
        }

        if (FindQualifiedTargetPropertyAt(doc, offset, typeSystem) is not { } hit)
        {
            return (null, null);
        }

        var ownerType = XamlSemanticFacts.ResolveTypeName(
            hit.OwnerToken,
            hit.Scope,
            typeSystem);
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

    /// <summary>Hover for the caret on an ATTACHED-property member of a parenthesized (Owner.Member) qualifier in Storyboard.TargetProperty.</summary>
    private async Task<Hover?> ResolveQualifiedTargetPropertyHoverAsync(TextDocumentPositionParams p)
    {
        if (!_documents.TryGetValue(p.TextDocument.Uri, out var doc))
        {
            return null;
        }

        int offset = doc.OffsetAt(p.Position);
        var typeSystem = await GetTypeSystemAsync(p.TextDocument.Uri).ConfigureAwait(false);
        if (typeSystem == null)
        {
            return null;
        }

        if (FindQualifiedTargetPropertyAt(doc, offset, typeSystem) is not { CaretOnMember: true } hit)
        {
            return null;
        }

        var ownerType = XamlSemanticFacts.ResolveTypeName(
            hit.OwnerToken,
            hit.Scope,
            typeSystem);
        if (ownerType == null)
        {
            return null;
        }

        // Only ATTACHED members get the dedicated framing here; an instance member of the same name (rare) wins and falls through so hover and F12 agree on the instance property.
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
                Value = HoverMarkdown(
                    $"(attached property) {valueType} {ownerType.Name}.{attached.Name}",
                    attached.Symbol,
                    methodDetails: false,
                    typeSystem: typeSystem),
            },
            Range = doc.RangeOf(hit.MemberSpan),
        };
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

    /// <summary>Builds hover markdown for a symbol: the C# signature in a fenced code block, followed by the symbol's XML-doc &lt;summary&gt</summary>
    private static string HoverMarkdown(
        string signature,
        ISymbol? symbol,
        bool methodDetails = true,
        XamlTypeSystem? typeSystem = null)
    {
        var documentationXml = symbol is null
            ? null
            : typeSystem?.GetDocumentationCommentXml(symbol) ?? symbol.GetDocumentationCommentXml();
        var doc = XmlDocSummary.ExtractQuickInfo(documentationXml);
        var sb = new System.Text.StringBuilder();
        sb.Append("```csharp\n").Append(signature).Append("\n```");

        if (doc.Summary is not null)
        {
            sb.Append("\n\n").Append(doc.Summary);
        }
        else if (symbol is not null)
        {
            sb.Append("\n\n").Append(MetadataDescription(symbol));
        }

        // Gated to IMethodSymbol so property/field/type/event hovers (whose docs carry no returns/params anyway) stay byte-identical to the summary-only behavior.
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

    private static string MetadataDescription(ISymbol symbol) => symbol switch
    {
        INamedTypeSymbol type =>
            $"XAML type `{type.ToDisplayString()}` ({type.TypeKind.ToString().ToLowerInvariant()}).",
        IPropertySymbol property =>
            $"Property `{property.Name}` declared by `{property.ContainingType?.ToDisplayString()}` with value type `{property.Type.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)}`.",
        IEventSymbol @event =>
            $"Event `{@event.Name}` declared by `{@event.ContainingType?.ToDisplayString()}`.",
        IFieldSymbol field =>
            $"Field `{field.Name}` declared by `{field.ContainingType?.ToDisplayString()}` with value type `{field.Type.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)}`.",
        IMethodSymbol method =>
            $"Method `{method.Name}` declared by `{method.ContainingType?.ToDisplayString()}`.",
        _ => $"XAML symbol `{symbol.Name}` ({symbol.Kind.ToString().ToLowerInvariant()}).",
    };

    private static string TypeKeyword(INamedTypeSymbol type) => type.TypeKind switch
    {
        TypeKind.Interface => "interface",
        TypeKind.Struct => "struct",
        TypeKind.Enum => "enum",
        TypeKind.Delegate => "delegate",
        _ => "class",
    };

    // --- Completion (IntelliSense) ------------------------------------------

}
