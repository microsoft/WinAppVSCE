using System.Collections.Generic;
using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using System.Linq;
using Microsoft.CodeAnalysis;
using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Workspace;
using WinUiXaml.Xaml;
using Diagnostic = WinUiXaml.LanguageServer.Lsp.Diagnostic;

namespace WinUiXaml.LanguageServer;

/// <summary>Per-element validation: resource references, types, attributes, attached and property elements, and namespace declarations.</summary>
internal static partial class XamlValidator
{
    private static void ValidateResourceReferences(
        XamlElement element,
        INamedTypeSymbol? elementType,
        TextDocument doc,
        XamlTypeSystem typeSystem,
        List<Diagnostic> diagnostics,
        IReadOnlySet<string> resourceKeys,
        XamlSemanticFacts.ResourceScopeIndex resourceIndex,
        bool resourceCatalogIsAuthoritative)
    {
        foreach (var attribute in element.Attributes)
        {
            if (attribute.Value is not { } value)
            {
                continue;
            }

            foreach (var extension in value.DescendantNodesAndSelf().OfType<XamlMarkupExtension>())
            {
                if (!extension.IsClosed ||
                    !XamlSemanticFacts.IsResourceReferenceExtension(
                        extension,
                        element.NamespaceScope))
                {
                    continue;
                }

                var argument = extension.Arguments.FirstOrDefault(
                    candidate => !candidate.IsNamed &&
                        candidate.NestedExtension is null &&
                        candidate.Value is { Length: > 0 });
                if (argument?.Value is not { } key ||
                    argument.ValueSpan is not { } keySpan)
                {
                    continue;
                }

                const bool allowForwardReference = true;
                var declaration = resourceIndex.FindDeclaration(
                    element,
                    key,
                    extension.Span.Start,
                    allowForwardReference);
                if (declaration is not null)
                {
                    ValidateStyleResourceApplication(
                        elementType,
                        attribute,
                        extension,
                        key,
                        keySpan,
                        declaration,
                        doc,
                        typeSystem,
                        diagnostics);
                    continue;
                }

                if (resourceKeys.Contains(key))
                {
                    continue;
                }

                var suggestion = SuggestData(
                    key,
                    resourceKeys.Concat(resourceIndex.GetVisibleKeys(
                        element,
                        extension.Span.Start,
                        allowForwardReference)));
                diagnostics.Add(Diag(
                    doc,
                    keySpan,
                    resourceCatalogIsAuthoritative ? SeverityError : SeverityWarning,
                    UnknownResourceKeyCode,
                    $"The resource '{key}' was not found.",
                    suggestion));
            }
        }
    }

    private static void ValidateStyleResourceApplication(
        INamedTypeSymbol? elementType,
        XamlAttribute attribute,
        XamlMarkupExtension extension,
        string key,
        TextSpan keySpan,
        XamlElement declaration,
        TextDocument doc,
        XamlTypeSystem typeSystem,
        List<Diagnostic> diagnostics)
    {
        if (elementType is null ||
            typeSystem.Capabilities.Style is not { } styleType ||
            typeSystem.FindMember(elementType, "Style") is not
                { Kind: XamlMemberKind.Property, Type: { } stylePropertyType } ||
            !XamlTypeSystem.IsAssignableTo(stylePropertyType, styleType) ||
            attribute.Name.HasPrefix ||
            !string.Equals(attribute.Name.LocalName, "Style", System.StringComparison.Ordinal) ||
            extension.Name is not { LocalName: "StaticResource" or "ThemeResource" } ||
            !XamlSemanticFacts.IsElement(
                declaration,
                styleType,
                typeSystem,
                allowDerived: true) ||
            XamlSemanticFacts.ResolveStyleTargetType(
                declaration,
                declaration.NamespaceScope,
                typeSystem) is not { } targetType ||
            XamlTypeSystem.IsAssignableTo(elementType, targetType))
        {
            return;
        }

        diagnostics.Add(Diag(
            doc,
            keySpan,
            SeverityError,
            InvalidStyleTargetTypeCode,
            $"The style '{key}' targets '{targetType.Name}' and cannot be applied to element type '{elementType.Name}'."));
    }

    private static void ValidateElement(
        XamlElement element, INamedTypeSymbol? elementType, TextDocument doc, XamlTypeSystem typeSystem, List<Diagnostic> diagnostics,
        INamedTypeSymbol? bindRoot, INamedTypeSymbol? pageClass, INamedTypeSymbol? styleTargetType,
        bool dataTemplateNeedsDataType, DiagnosticData? dataTypeSuggestion)
    {
        var scope = element.NamespaceScope;
        ValidateDuplicateAttributes(element, doc, diagnostics);

        foreach (var attribute in element.Attributes)
        {
            ValidateBindMode(attribute, scope, typeSystem, doc, diagnostics);
            ValidateClassicBinding(attribute, doc, typeSystem, diagnostics);
            ValidateTemplateBinding(attribute, styleTargetType, doc, typeSystem, diagnostics);
            if (dataTemplateNeedsDataType)
            {
                ValidateUntypedTemplateBinding(
                    attribute, scope, typeSystem, doc, diagnostics, dataTypeSuggestion);
            }
            if (dataTemplateNeedsDataType && XamlSemanticFacts.IsXBind(attribute, scope))
            {
                diagnostics.Add(Diag(doc, attribute.Value!.InnerSpan, SeverityError, DataTemplateDataTypeRequiredCode,
                    "x:Bind inside a DataTemplate requires x:DataType.", dataTypeSuggestion));
            }
            if (bindRoot is not null)
            {
                ValidateBindPath(attribute, bindRoot, pageClass, scope, typeSystem, doc, diagnostics);
                ValidateBindAssignment(attribute, elementType, bindRoot, pageClass, scope, typeSystem, doc, diagnostics);
            }
        }

        // Undeclared prefixes on attributes are independent of whether the element type resolves.
        foreach (var attribute in element.Attributes)
        {
            if (!attribute.IsNamespaceDeclaration)
            {
                ReportUndeclaredPrefix(attribute.Name, scope, doc, diagnostics);
            }
        }

        ValidateDirectives(element, scope, typeSystem, doc, diagnostics);
        ValidateNamespaceDeclarations(element, typeSystem, doc, diagnostics);

        var name = element.Name;
        if (name is null)
        {
            return;
        }

        // An undeclared element prefix supersedes any type/member check (the namespace is unresolvable).
        if (name.HasPrefix && !ReservedPrefixes.Contains(name.Prefix!) &&
            !scope.TryResolvePrefix(name.Prefix, out _))
        {
            diagnostics.Add(Diag(doc, name.PrefixSpan ?? name.Span, SeverityError, UndeclaredPrefixCode,
                $"The namespace prefix '{name.Prefix}' is not declared.",
                GetUniqueNamespaceSuggestion(name.Prefix!, name.LocalName, typeSystem)));
            return;
        }

        // Out of scope: the x: language namespace (built-in primitives) and any namespace the type system cannot model (design-time, third-party).
        if (!scope.TryResolvePrefix(name.Prefix, out var uri) ||
            uri == XamlTypeSystem.XamlLanguageNamespace ||
            !typeSystem.IsKnownNamespace(uri))
        {
            return;
        }

        // A property element (<Grid.RowDefinitions>) names a member of an owner type, not an element type, so it has no element-type/attribute surface — validate the member against the owner and stop.
        var propertyElement = name.IsDotted
            ? XamlSemanticFacts.ResolvePropertyElementMember(name, uri, typeSystem)
            : null;
        if (name.IsDotted &&
            (!name.HasPrefix || propertyElement?.PropertyType is not null))
        {
            ValidatePropertyElement(element, name, uri, typeSystem, doc, diagnostics);
            return;
        }

        // StaticResource also has a compiler-defined object form for keyed resource aliases,
        // but WinUI exposes no corresponding CLR type in project metadata.
        if (XamlSemanticFacts.IsStaticResourceElement(name, uri))
        {
            return;
        }

        var resolvedElementType = typeSystem.ResolveType(uri, name.LocalName);
        if (resolvedElementType is null)
        {
            diagnostics.Add(Diag(doc, name.LocalNameSpan, SeverityError, UnknownTypeCode,
                $"The type '{name.LocalName}' was not found in the XAML namespace '{uri}'.",
                SuggestData(name.LocalName, typeSystem.GetAllTypes(uri).Select(t => t.Name))));
            return;
        }

        // The element type is known — verify its simple attributes name real members.
        foreach (var attribute in element.Attributes)
        {
            ValidateAttributeMember(attribute, resolvedElementType, scope, typeSystem, doc, diagnostics, pageClass);
        }

        ValidateNameGrammar(element, resolvedElementType, scope, typeSystem, doc, diagnostics);
        ValidateScalarContent(element, resolvedElementType, typeSystem, doc, diagnostics);
        ValidateSetterProperty(element, resolvedElementType, styleTargetType, typeSystem, doc, diagnostics);
    }

    private static void ValidateAttributeMember(
        XamlAttribute attribute,
        INamedTypeSymbol elementType,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics,
        INamedTypeSymbol? pageClass)
    {
        var name = attribute.Name;

        if (attribute.IsNamespaceDeclaration || name.LocalName.Length == 0)
        {
            return;
        }

        // Attached property (Owner.Member): validate the member against the OWNER type, not the element.
        if (name.IsDotted)
        {
            ValidateAttachedProperty(attribute, elementType, scope, typeSystem, doc, diagnostics);
            return;
        }

        // Language/foreign directives (x:, d:, mc:) need dedicated handling and are left for future work.
        if (name.HasPrefix)
        {
            return;
        }

        var member = typeSystem.FindAttributeMember(elementType, name.LocalName);
        if (member is null)
        {
            diagnostics.Add(Diag(doc, name.LocalNameSpan, SeverityWarning, UnknownAttributeCode,
                $"'{name.LocalName}' is not a property or event of '{elementType.Name}'.",
                SuggestData(name.LocalName, typeSystem.GetAttributeCandidateNames(elementType))));
            return;
        }

        if (member.Kind == XamlMemberKind.Property && member.Type is not null)
        {
            ValidateLiteralAttributeValue(attribute, member.Type, typeSystem, doc, diagnostics);
        }
        else if (member.Kind == XamlMemberKind.Event &&
                 pageClass is not null &&
                 attribute.Value is { IsMarkupExtension: false } eventValue &&
                 eventValue.Text.Trim() is { Length: > 0 } handler)
        {
            var methods = XamlSemanticFacts
                .EnumerateEventHandlerMethods(pageClass, handler, typeSystem)
                .ToArray();
            if (methods.Length == 0)
            {
                diagnostics.Add(Diag(doc, eventValue.InnerSpan, SeverityError, MissingEventHandlerCode,
                   $"The event handler '{handler}' was not found on '{pageClass.Name}' or its base types."));
            }
            else if (member.Type is INamedTypeSymbol { DelegateInvokeMethod: { } invoke } &&
                    !methods.Any(method =>
                        XamlSemanticFacts.IsCompatibleEventHandler(method, invoke)))
            {
                diagnostics.Add(Diag(doc, eventValue.InnerSpan, SeverityError, IncompatibleEventHandlerCode,
                   $"No overload of event handler '{handler}' is compatible with '{member.Type.Name}'."));
            }
        }
    }

    private static void ValidateLiteralAttributeValue(
        XamlAttribute attribute,
        ITypeSymbol memberType,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        var value = attribute.Value;
        if (value is null ||
            value.IsMarkupExtension ||
            value.Quote is null)
        {
            return;
        }

        var targetType = XamlValueConverter.UnwrapNullable(memberType);
        if (!XamlValueConverter.TryValidate(value.Text, targetType, typeSystem, out var isValid) || isValid)
        {
            return;
        }

        diagnostics.Add(Diag(
            doc,
            value.InnerSpan,
            SeverityError,
            InvalidAttributeValueCode,
            $"'{value.Text}' is not a valid value for '{attribute.Name.FullName}' ({targetType.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)}).",
            targetType.TypeKind == TypeKind.Enum
                ? SuggestData(
                    value.Text,
                    targetType.GetMembers().OfType<IFieldSymbol>()
                        .Where(field => field.HasConstantValue)
                        .Select(field => field.Name))
                : null));
    }

    /// <summary>Validates an Owner.Member attached-property attribute: resolves the owner type through the attribute's namespace and checks it actually exposes the member.</summary>
    private static void ValidateAttachedProperty(
        XamlAttribute attribute,
        INamedTypeSymbol elementType,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        var name = attribute.Name;
        int dot = name.LocalName.LastIndexOf('.');
        if (dot <= 0 || dot >= name.LocalName.Length - 1)
        {
            return; // malformed dotted name — leave it to the parser
        }

        var ownerLocal = name.LocalName.Substring(0, dot);
        var memberName = name.LocalName.Substring(dot + 1);

        // Resolve the owner's namespace via the attribute prefix (null prefix = the default/presentation ns).
        if (!scope.TryResolvePrefix(name.Prefix, out var uri) ||
            uri == XamlTypeSystem.XamlLanguageNamespace ||
            !typeSystem.IsKnownNamespace(uri))
        {
            return;
        }

        var owner = typeSystem.ResolveType(uri, ownerLocal);
        if (owner is null)
        {
            var ownerSpan = new TextSpan(name.LocalNameSpan.Start, name.LocalNameSpan.Start + dot);
            diagnostics.Add(Diag(
                doc,
                ownerSpan,
                SeverityError,
                UnknownTypeCode,
                $"The attached-property owner '{ownerLocal}' was not found in the XAML namespace '{uri}'.",
                SuggestData(ownerLocal, typeSystem.GetAllTypes(uri).Select(type => type.Name))));
            return;
        }

        // Owner.Property is also legal for an ordinary property when Owner is the
        // element's own type (or one of its bases), for example Grid.ColumnDefinitions.
        if (XamlTypeSystem.IsAssignableTo(elementType, owner) &&
            typeSystem.FindAttributeMember(elementType, memberName) is { Kind: XamlMemberKind.Property, Type: { } ordinaryType })
        {
            ValidateLiteralAttributeValue(attribute, ordinaryType, typeSystem, doc, diagnostics);
            return;
        }

        var memberType = typeSystem.GetAttachedMemberType(
            owner,
            memberName,
            elementType);
        if (memberType is not null)
        {
            ValidateLiteralAttributeValue(attribute, memberType, typeSystem, doc, diagnostics);
            return;
        }

        // Underline just the member part, past "Owner.".
        var memberSpan = new TextSpan(name.LocalNameSpan.Start + dot + 1, name.LocalNameSpan.End);
        diagnostics.Add(Diag(doc, memberSpan, SeverityWarning, UnknownAttachedPropertyCode,
            $"'{memberName}' is not an attached property of '{owner.Name}'.",
            SuggestData(memberName, typeSystem.GetAttachedProperties(owner).Select(m => m.Name))));
    }

    /// <summary>Validates a property element (&lt;Grid.RowDefinitions&gt;): the dotted name references a member of an owner type</summary>
    private static void ValidatePropertyElement(
        XamlElement element,
        XamlName name,
        string uri,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        var resolved = XamlSemanticFacts.ResolvePropertyElementMember(name, uri, typeSystem);
        if (resolved is null)
        {
            return; // malformed dotted name — leave it to the parser
        }

        var (ownerLocal, memberName, owner, propertyType, isAttached) = resolved.Value;
        if (owner is null)
        {
            // The enclosing namespace is already known/trusted (the caller gated on IsKnownNamespace), so a property element whose OWNER type does not resolve is a genuine unknown type
            var ownerSpan = new TextSpan(
                name.LocalNameSpan.Start,
                name.LocalNameSpan.Start + ownerLocal.Length);
            diagnostics.Add(Diag(doc, ownerSpan, SeverityError, UnknownTypeCode,
                $"The type '{ownerLocal}' was not found in the XAML namespace '{uri}'.",
                SuggestData(ownerLocal, typeSystem.GetAllTypes(uri).Select(t => t.Name))));
            return;
        }

        if (propertyType is not null)
        {
            if (!isAttached)
            {
                if (element.Parent is not XamlElement parent ||
                    ResolveElementType(parent, typeSystem) is not { } parentType)
                {
                    return;
                }

                if (!XamlTypeSystem.IsAssignableTo(parentType, owner))
                {
                    var mismatchedMemberSpan = new TextSpan(
                        name.LocalNameSpan.Start + ownerLocal.Length + 1,
                        name.LocalNameSpan.End);
                    diagnostics.Add(Diag(
                        doc,
                        mismatchedMemberSpan,
                        SeverityWarning,
                        UnknownPropertyElementCode,
                        $"The property '{memberName}' is not a member of the enclosing type '{parentType.Name}'."));
                    return;
                }
            }

            ValidatePropertyElementChildren(element, propertyType, typeSystem, doc, diagnostics);
            return; // a real settable property / attached member used in element form
        }

        // Underline just the member part, past "Owner.". An event exists as a member but cannot be set through property-element syntax (it needs an attribute), so it gets a distinct message.
        var memberSpan = new TextSpan(
            name.LocalNameSpan.Start + ownerLocal.Length + 1,
            name.LocalNameSpan.End);
        bool isEvent = typeSystem.HasMember(owner, memberName);
        var message = isEvent
            ? $"'{memberName}' is an event and cannot be set using property-element syntax."
            : $"The property '{memberName}' was not found in the type '{owner.Name}'.";
        var data = isEvent ? null : SuggestData(memberName, typeSystem.GetPropertyElementCandidateNames(owner));
        diagnostics.Add(Diag(doc, memberSpan, SeverityWarning, UnknownPropertyElementCode, message, data));
    }

    private static INamedTypeSymbol? ResolveElementType(XamlElement element, XamlTypeSystem typeSystem) =>
        element.Name is { IsDotted: false }
            ? XamlSemanticFacts.ResolveElementType(element, typeSystem)
            : null;

    private static void ValidateDuplicateAttributes(
        XamlElement element, TextDocument doc, List<Diagnostic> diagnostics)
    {
        var seen = new HashSet<string>(System.StringComparer.Ordinal);
        foreach (var attribute in element.Attributes)
        {
            string key = XamlSemanticFacts.GetExpandedAttributeName(element, attribute);
            if (!seen.Add(key))
            {
                diagnostics.Add(Diag(doc, attribute.Name.Span, SeverityError, DuplicateAttributeCode,
                    $"The attribute '{attribute.Name.FullName}' is specified more than once."));
            }
        }
    }

    private static void ValidateNameGrammar(
        XamlElement element,
        INamedTypeSymbol elementType,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        foreach (var attribute in element.Attributes)
        {
            if (XamlSemanticFacts.IsNameAttribute(
                    attribute,
                    elementType,
                    scope,
                    typeSystem) &&
                attribute.Value is { IsMarkupExtension: false } value &&
                !IsIdentifier(value.Text))
            {
                diagnostics.Add(Diag(doc, value.InnerSpan, SeverityError, InvalidNameCode,
                    $"'{value.Text}' is not a valid XAML name."));
            }
        }
    }

    private static void ValidateScalarContent(
        XamlElement element,
        INamedTypeSymbol elementType,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        var contentType = typeSystem.GetContentPropertyDeclaredType(elementType);
        if (contentType is null || XamlTypeSystem.GetCollectionElementType(contentType) is not null)
        {
            return;
        }

        var children = element.Content.OfType<XamlElement>().Where(child => !child.IsPropertyElement).ToArray();
        for (int i = 1; i < children.Length; i++)
        {
            diagnostics.Add(Diag(doc, children[i].Name?.Span ?? children[i].Span, SeverityError,
                MultipleScalarChildrenCode,
                $"The scalar content property of '{elementType.Name}' can only contain one object."));
        }
    }

    private static void ValidatePropertyElementChildren(
        XamlElement propertyElement,
        ITypeSymbol propertyType,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        if (propertyType is INamedTypeSymbol namedPropertyType &&
            typeSystem.Capabilities.ResourceDictionary is { } resourceDictionary &&
            XamlTypeSystem.IsAssignableTo(namedPropertyType, resourceDictionary))
        {
            // ResourceDictionary implements IDictionary, whose CLR element type is KeyValuePair.
            // XAML dictionary children are the keyed values themselves, not KeyValuePair objects.
            return;
        }

        var expectedType = XamlTypeSystem.GetCollectionElementType(propertyType) ?? propertyType;
        var children = propertyElement.Content.OfType<XamlElement>()
            .Where(child => !child.IsPropertyElement)
            .ToArray();

        if (XamlTypeSystem.GetCollectionElementType(propertyType) is null)
        {
            for (int i = 1; i < children.Length; i++)
            {
                diagnostics.Add(Diag(doc, children[i].Name?.Span ?? children[i].Span, SeverityError,
                    MultipleScalarChildrenCode, "A scalar property element can only contain one object."));
            }
        }

        foreach (var child in children)
        {
            var childType = ResolveElementType(child, typeSystem);
            if (childType is not null &&
                !XamlTypeSystem.IsAssignableTo(childType, propertyType) &&
                !XamlTypeSystem.IsAssignableTo(childType, expectedType))
            {
                diagnostics.Add(Diag(doc, child.Name?.Span ?? child.Span, SeverityError,
                    InvalidPropertyElementChildCode,
                    $"'{childType.Name}' is not assignable to '{expectedType.Name}' for this property."));
            }
        }
    }

    private static void ValidateSetterProperty(
        XamlElement element,
        INamedTypeSymbol elementType,
        INamedTypeSymbol? styleTargetType,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        if (styleTargetType is null ||
            typeSystem.Capabilities.Setter is not { } setter ||
            !XamlTypeSystem.IsAssignableTo(elementType, setter) ||
            element.GetAttribute("Property")?.Value is not { IsMarkupExtension: false } value)
        {
            return;
        }

        var propertyName = value.Text.Trim();
        int dot = propertyName.IndexOf('.');
        if (dot > 0 && dot < propertyName.Length - 1)
        {
            var ownerName = propertyName.Substring(0, dot);
            var memberName = propertyName.Substring(dot + 1);
            var owner = ResolveTypeName(ownerName, element.NamespaceScope, typeSystem);
            if (owner is null)
            {
                var colon = ownerName.IndexOf(':');
                var prefix = colon >= 0 ? ownerName[..colon] : string.Empty;
                var localName = colon >= 0 ? ownerName[(colon + 1)..] : ownerName;
                var suggestions =
                    element.NamespaceScope.TryResolvePrefix(prefix, out var uri)
                        ? typeSystem.GetAllTypes(uri).Select(type => type.Name)
                        : Enumerable.Empty<string>();
                diagnostics.Add(Diag(doc, value.InnerSpan, SeverityError, InvalidSetterPropertyCode,
                    $"The attached-property owner '{ownerName}' was not found.",
                    SuggestData(localName, suggestions)));
                return;
            }

            if (typeSystem.GetAttachedMemberType(owner, memberName) is not null)
            {
                return;
            }

            diagnostics.Add(Diag(doc, value.InnerSpan, SeverityError, InvalidSetterPropertyCode,
                $"The attached property '{memberName}' was not found on '{owner.Name}'.",
                SuggestData(memberName, typeSystem.GetAttachedProperties(owner).Select(member => member.Name))));
            return;
        }

        if (!IsIdentifier(propertyName) || typeSystem.HasProperty(styleTargetType, propertyName))
        {
            return;
        }

        diagnostics.Add(Diag(doc, value.InnerSpan, SeverityError, InvalidSetterPropertyCode,
            $"The property '{propertyName}' was not found on the style target type '{styleTargetType.Name}'.",
            SuggestData(propertyName, typeSystem.GetPropertyElementCandidateNames(styleTargetType))));
    }

    private static INamedTypeSymbol? TryResolveTypeAttribute(
        XamlElement element, string attributeName, XamlTypeSystem typeSystem)
    {
        if (element.GetAttribute(attributeName)?.Value is not { } value)
        {
            return null;
        }

        string? text = null;
        if (!value.IsMarkupExtension)
        {
            text = value.Text;
        }
        else if (value.MarkupExtension is { IsClosed: true, Name: { } name } extension &&
            XamlSemanticFacts.IsXamlLanguageName(name, "Type", element.NamespaceScope))
        {
            text = extension.Arguments.FirstOrDefault(argument =>
                !argument.IsNamed && argument.NestedExtension is null)?.Value;
        }

        return text is null ? null : ResolveTypeName(text, element.NamespaceScope, typeSystem);
    }

    private static void ValidateDataType(
        XamlElement element, string text, XamlTypeSystem typeSystem,
        TextDocument doc, List<Diagnostic> diagnostics)
    {
        var value = XamlSemanticFacts.GetDirectiveAttribute(element, "DataType")?.Value;
        var trimmed = text.Trim();
        int colon = trimmed.IndexOf(':');
        var prefix = colon < 0 ? string.Empty : trimmed[..colon];
        if (value is not null &&
            element.NamespaceScope.TryResolvePrefix(prefix, out var uri) &&
            typeSystem.IsKnownNamespace(uri))
        {
            diagnostics.Add(Diag(doc, value.InnerSpan, SeverityError, UnknownDataTypeCode,
                $"The x:DataType '{trimmed}' was not found in the XAML namespace '{uri}'."));
        }
    }

    private static DiagnosticData? InferDataTemplateType(
        XamlElement dataTemplate,
        INamedTypeSymbol? outerBindRoot,
        XamlTypeSystem typeSystem,
        TextDocument doc)
    {
        if (outerBindRoot is null ||
            FindParentElement(dataTemplate) is not { Name: { IsDotted: true } } propertyElement ||
            !propertyElement.Name.LocalName.EndsWith(
                ".ItemTemplate", System.StringComparison.Ordinal) ||
            FindParentElement(propertyElement) is not { } itemsOwner ||
            itemsOwner.GetAttribute("ItemsSource") is not { } itemsSource ||
            itemsSource.Value?.MarkupExtension is not { IsClosed: true } extension ||
            !XamlSemanticFacts.IsXBind(extension, itemsOwner.NamespaceScope) ||
            extension.Arguments.FirstOrDefault(argument =>
                (!argument.IsNamed || argument.Name?.LocalName == "Path") &&
                argument.Value is not null) is not { Value: { } path } ||
            path.IndexOf('(') >= 0 ||
            !TryResolveBindResultType(
                path,
                itemsSource,
                outerBindRoot,
                outerBindRoot,
                itemsOwner.NamespaceScope,
                typeSystem,
                doc,
                out var collectionType) ||
            XamlTypeSystem.GetCollectionElementType(collectionType) is not
                INamedTypeSymbol { Arity: 0, ContainingType: null } itemType ||
            itemType.ContainingNamespace.IsGlobalNamespace)
        {
            return null;
        }

        var namespaceUri = $"using:{itemType.ContainingNamespace.ToDisplayString()}";
        var prefixes = dataTemplate.NamespaceScope.Declarations
            .Where(declaration =>
                string.Equals(declaration.Value, namespaceUri, System.StringComparison.Ordinal))
            .Select(declaration => declaration.Key)
            .Distinct(System.StringComparer.Ordinal)
            .ToArray();
        if (prefixes.Length != 1)
        {
            return null;
        }

        var xamlTypeName = prefixes[0].Length == 0
            ? itemType.Name
            : $"{prefixes[0]}:{itemType.Name}";
        return new DiagnosticData
        {
            Bad = namespaceUri,
            Suggestions = [xamlTypeName],
        };
    }

    private static void ValidateNamespaceDeclarations(
        XamlElement element, XamlTypeSystem typeSystem,
        TextDocument doc, List<Diagnostic> diagnostics)
    {
        foreach (var attribute in element.Attributes)
        {
            if (!attribute.IsNamespaceDeclaration ||
                attribute.Value is not { } value ||
                !(value.Text.StartsWith("using:", System.StringComparison.Ordinal) ||
                  value.Text.StartsWith("clr-namespace:", System.StringComparison.Ordinal)) ||
                XamlSemanticFacts.IsPresentationNamespace(value.Text) ||
                typeSystem.IsKnownNamespace(value.Text))
            {
                continue;
            }

            diagnostics.Add(Diag(
                doc,
                value.InnerSpan,
                SeverityWarning,
                UnknownNamespaceDeclarationCode,
                $"The XAML namespace '{value.Text}' contains no usable types in the project compilation.",
                SuggestNamespaceData(value.Text, typeSystem.GetUsingNamespaces())));
        }
    }
}
