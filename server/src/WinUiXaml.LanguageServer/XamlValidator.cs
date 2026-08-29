using System.Collections.Generic;
using System.Diagnostics.CodeAnalysis;
using System.Linq;
using Microsoft.CodeAnalysis;
using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Workspace;
using WinUiXaml.Xaml;
using Diagnostic = WinUiXaml.LanguageServer.Lsp.Diagnostic;

namespace WinUiXaml.LanguageServer;

/// <summary>Reports semantic diagnostics against the project's XAML type system.</summary>
internal static class XamlValidator
{
    /// <summary>An undeclared xmlns prefix — certain, so reported as an error.</summary>
    public const string UndeclaredPrefixCode = "WXAML0001";

    /// <summary>A type not found in a known namespace.</summary>
    public const string UnknownTypeCode = "WXAML0002";

    /// <summary>An attribute that is not a member of the element's type — heuristic, so a warning.</summary>
    public const string UnknownAttributeCode = "WXAML0003";

    /// <summary>A dotted attribute whose member is not an attached property of the owner — a warning.</summary>
    public const string UnknownAttachedPropertyCode = "WXAML0004";

    /// <summary>An <c>{x:Bind}</c> path whose first segment is not a member of the bind root — a warning.</summary>
    public const string UnknownBindMemberCode = "WXAML0005";

    /// <summary>A property element (<c>&lt;Grid.RowDefinitions&gt;</c>) whose member is not found on the owner type — a warning.</summary>
    public const string UnknownPropertyElementCode = "WXAML0006";

    /// <summary>Two elements share an <c>x:Name</c>/<c>Name</c> in the same XAML name scope — a compile error.</summary>
    public const string DuplicateNameCode = "WXAML0007";

    /// <summary>Two resources share an <c>x:Key</c> in the same <c>ResourceDictionary</c> — a compile error.</summary>
    public const string DuplicateKeyCode = "WXAML0008";

    /// <summary>A design-time directive names a type that cannot be resolved.</summary>
    public const string UnknownDirectiveTypeCode = "WXAML0009";

    /// <summary>An <c>mc:Ignorable</c> entry does not name a declared namespace prefix.</summary>
    public const string UnknownIgnorablePrefixCode = "WXAML0010";

    /// <summary>An <c>x:Bind</c> function has no overload accepting the supplied argument count.</summary>
    public const string InvalidBindFunctionCode = "WXAML0011";

    /// <summary>A literal attribute value cannot be converted to the property's primitive or enum type.</summary>
    public const string InvalidAttributeValueCode = "WXAML0012";

    /// <summary>A resource key closely resembles a known key but does not resolve.</summary>
    public const string UnknownResourceKeyCode = "WXAML0013";

    /// <summary>An x:Name value does not follow XAML identifier grammar.</summary>
    public const string InvalidNameCode = "WXAML0014";
    /// <summary>A plain event-handler name is absent from the resolved x:Class hierarchy.</summary>
    public const string MissingEventHandlerCode = "WXAML0015";
    /// <summary>More than one object is assigned to a scalar content property.</summary>
    public const string MultipleScalarChildrenCode = "WXAML0016";
    /// <summary>A Setter names no property on its resolved Style.TargetType.</summary>
    public const string InvalidSetterPropertyCode = "WXAML0017";
    /// <summary>An x:Bind in a DataTemplate has no local x:DataType.</summary>
    public const string DataTemplateDataTypeRequiredCode = "WXAML0018";
    /// <summary>An expanded attribute name occurs more than once on an element.</summary>
    public const string DuplicateAttributeCode = "WXAML0019";
    /// <summary>A resolved property-element child is not assignable to the property's item type.</summary>
    public const string InvalidPropertyElementChildCode = "WXAML0020";
    /// <summary>The resolved x:Class is not assignable to the resolved root element type.</summary>
    public const string InvalidRootClassCode = "WXAML0021";
    /// <summary>An x:Bind Mode is absent from the SDK BindingMode enum.</summary>
    public const string InvalidBindModeCode = "WXAML0022";
    /// <summary>An x:Class directive names no type in the authoritative project compilation.</summary>
    public const string UnknownRootClassCode = "WXAML0023";
    /// <summary>A named argument is not exposed by the resolved Binding type.</summary>
    public const string UnknownBindingArgumentCode = "WXAML0024";
    /// <summary>A classic Binding enum argument has an invalid value.</summary>
    public const string InvalidBindingValueCode = "WXAML0025";
    /// <summary>A RelativeSource argument or mode is invalid.</summary>
    public const string InvalidRelativeSourceCode = "WXAML0026";
    /// <summary>A Binding ElementName is absent from the applicable XAML namescope.</summary>
    public const string UnknownBindingElementNameCode = "WXAML0027";
    /// <summary>A TemplateBinding path is absent from the authoritative template target type.</summary>
    public const string InvalidTemplateBindingCode = "WXAML0028";
    /// <summary>An x:DataType names a missing type in a known namespace.</summary>
    public const string UnknownDataTypeCode = "WXAML0029";
    /// <summary>An x:Bind result is definitely not assignable to its target property.</summary>
    public const string InvalidBindAssignmentCode = "WXAML0030";
    /// <summary>An x:Bind path names an inaccessible member.</summary>
    public const string InaccessibleBindMemberCode = "WXAML0031";
    /// <summary>An event handler exists but no overload matches the event delegate.</summary>
    public const string IncompatibleEventHandlerCode = "WXAML0032";
    /// <summary>A using:/clr-namespace: declaration resolves to no usable compilation namespace.</summary>
    public const string UnknownNamespaceDeclarationCode = "WXAML0033";
    /// <summary>A local Style resource cannot be applied to the consuming element's resolved type.</summary>
    public const string InvalidStyleTargetTypeCode = "WXAML0034";
    /// <summary>Classic Binding in an untyped DataTemplate is not safe for Native AOT.</summary>
    public const string BindingDataTypeRecommendedCode = "WMC1510";

    private const int SeverityError = 1;
    private const int SeverityWarning = 2;
    private static readonly HashSet<string> ReservedPrefixes = new(System.StringComparer.Ordinal)
    {
        "xml", "xmlns",
    };

    public static List<Diagnostic> Validate(
        TextDocument doc,
        XamlTypeSystem typeSystem,
        IReadOnlyCollection<string>? projectResourceKeys = null,
        bool resourceCatalogIsAuthoritative = true)
    {
        var diagnostics = new List<Diagnostic>();
        if (doc.Parsed.Root is { } root)
        {
            var resourceKeys = new HashSet<string>(System.StringComparer.Ordinal);
            if (projectResourceKeys is not null)
            {
                foreach (var key in projectResourceKeys)
                {
                    resourceKeys.Add(key);
                }
            }

            // Unresolved binding roots remain silent to avoid false positives.
            var resourceIndex = XamlSemanticFacts.CreateResourceIndex(root, typeSystem);
            var pageClass = ResolvePageClass(root, typeSystem);
            ValidateRootClassExists(root, pageClass, doc, diagnostics);
            ValidateRootClass(root, pageClass, typeSystem, doc, diagnostics);
            Walk(root, doc, typeSystem, diagnostics, pageClass, pageClass, resourceKeys, resourceIndex, resourceCatalogIsAuthoritative, styleTargetType: null, dataTemplateNeedsDataType: false, dataTypeSuggestion: null);

            ValidateUniqueNames(root, doc, typeSystem, diagnostics);
            ValidateUniqueResourceKeys(root, doc, typeSystem, diagnostics);
        }

        return diagnostics;
    }

    private static void Walk(
        XamlElement element,
        TextDocument doc,
        XamlTypeSystem typeSystem,
        List<Diagnostic> diagnostics,
        INamedTypeSymbol? bindRoot,
        INamedTypeSymbol? pageClass,
        IReadOnlySet<string> resourceKeys,
        XamlSemanticFacts.ResourceScopeIndex resourceIndex,
        bool resourceCatalogIsAuthoritative,
        INamedTypeSymbol? styleTargetType,
        bool dataTemplateNeedsDataType,
        DiagnosticData? dataTypeSuggestion)
    {
        var elementType = ResolveElementType(element, typeSystem);

        // A template creates a new binding root. It must not inherit the page's x:Bind root.
        var effectiveRoot = bindRoot;
        var effectiveTemplateNeedsDataType = dataTemplateNeedsDataType;
        var effectiveDataTypeSuggestion = dataTypeSuggestion;
        if (elementType is not null &&
            typeSystem.Capabilities.DataTemplate is { } dataTemplate &&
            XamlTypeSystem.IsAssignableTo(elementType, dataTemplate))
        {
            effectiveRoot = null;
            effectiveTemplateNeedsDataType = !TryGetDirectiveValue(element, "DataType", out _);
            effectiveDataTypeSuggestion = effectiveTemplateNeedsDataType
                ? InferDataTemplateType(element, bindRoot, typeSystem, doc)
                : null;
        }

        // An unresolved x:DataType disables binding checks for its subtree.
        if (TryGetDirectiveValue(element, "DataType", out var dataTypeText))
        {
            effectiveRoot = ResolveTypeName(dataTypeText, element.NamespaceScope, typeSystem);
            effectiveTemplateNeedsDataType = false;
            effectiveDataTypeSuggestion = null;
            if (effectiveRoot is null)
            {
                ValidateDataType(element, dataTypeText, typeSystem, doc, diagnostics);
            }
        }

        var effectiveStyleTarget = styleTargetType;
        if (elementType is not null &&
            ((typeSystem.Capabilities.Style is { } styleType &&
              XamlTypeSystem.IsAssignableTo(elementType, styleType)) ||
             (typeSystem.Capabilities.ControlTemplate is { } controlTemplate &&
              XamlTypeSystem.IsAssignableTo(elementType, controlTemplate))))
        {
            effectiveStyleTarget = TryResolveTypeAttribute(element, "TargetType", typeSystem);
        }

        ValidateElement(element, elementType, doc, typeSystem, diagnostics, effectiveRoot, pageClass, effectiveStyleTarget, effectiveTemplateNeedsDataType, effectiveDataTypeSuggestion);
        ValidateResourceReferences(
            element,
            elementType,
            doc,
            typeSystem,
            diagnostics,
            resourceKeys,
            resourceIndex,
            resourceCatalogIsAuthoritative);

        foreach (var child in element.Content)
        {
            if (child is XamlElement childElement)
            {
                Walk(childElement, doc, typeSystem, diagnostics, effectiveRoot, pageClass, resourceKeys, resourceIndex, resourceCatalogIsAuthoritative, effectiveStyleTarget, effectiveTemplateNeedsDataType, effectiveDataTypeSuggestion);
            }
        }
    }

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
            string key;
            if (attribute.IsNamespaceDeclaration)
            {
                key = "xmlns:" + (attribute.DeclaredPrefix ?? string.Empty);
            }
            else if (attribute.Name.HasPrefix &&
                     element.NamespaceScope.TryResolvePrefix(attribute.Name.Prefix, out var uri))
            {
                key = "{" + uri + "}" + attribute.Name.LocalName;
            }
            else
            {
                key = attribute.Name.FullName;
            }

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

            diagnostics.Add(Diag(doc, value.InnerSpan, SeverityWarning, UnknownNamespaceDeclarationCode,
                $"The XAML namespace '{value.Text}' contains no usable types in the project compilation."));
        }
    }

    private static void ValidateClassicBinding(
        XamlAttribute attribute, TextDocument doc, XamlTypeSystem typeSystem,
        List<Diagnostic> diagnostics)
    {
        var element = FindParentElement(attribute);
        if (element is null ||
            attribute.Value?.MarkupExtension is not { IsClosed: true } extension ||
            !XamlSemanticFacts.IsBindingMarkupExtension(extension, element.NamespaceScope, typeSystem) ||
            XamlSemanticFacts.ResolveMarkupExtensionType(
                extension.Name?.FullName, element.NamespaceScope, typeSystem) is not { } bindingType)
        {
            return;
        }

        foreach (var argument in extension.Arguments.Where(argument => argument.IsNamed))
        {
            var name = argument.Name?.LocalName;
            if (string.IsNullOrEmpty(name))
            {
                continue;
            }

            var member = typeSystem.FindMember(bindingType, name);
            if (member is null)
            {
                diagnostics.Add(Diag(doc, argument.Name?.LocalNameSpan ?? extension.Span,
                    SeverityError, UnknownBindingArgumentCode,
                    $"'{name}' is not a named argument of '{bindingType.Name}'.",
                    SuggestData(name, typeSystem.GetAttributeCandidateNames(bindingType))));
                continue;
            }

            ValidateBindingEnumValue(argument, member.Type, $"Binding.{name}",
                InvalidBindingValueCode, typeSystem, doc, diagnostics);

            if (name == "ElementName" &&
                argument.Value is { Length: > 0 } rawElementName &&
                argument.ValueSpan is { } elementNameSpan &&
                rawElementName.Trim() is { Length: > 0 } elementName &&
                XamlSemanticFacts.FindNamedElementInScope(
                    doc, attribute.Parent, elementName, typeSystem) is null)
            {
                diagnostics.Add(Diag(doc, elementNameSpan, SeverityError, UnknownBindingElementNameCode,
                    $"No element named '{elementName}' is visible in this XAML namescope."));
            }
        }

        foreach (var nested in extension.DescendantNodesAndSelf()
                     .OfType<XamlMarkupExtension>()
                     .Where(candidate => !ReferenceEquals(candidate, extension) &&
                         candidate.Name?.LocalName == "RelativeSource"))
        {
            ValidateRelativeSource(nested, element.NamespaceScope, typeSystem, doc, diagnostics);
        }
    }

    private static void ValidateBindingEnumValue(
        XamlMarkupExtensionArgument argument, ITypeSymbol? type, string displayName, string code,
        XamlTypeSystem typeSystem, TextDocument doc, List<Diagnostic> diagnostics)
    {
        if (type is not { TypeKind: TypeKind.Enum } enumType ||
            argument.Value is not { } value ||
            argument.ValueSpan is not { } span ||
            !XamlValueConverter.TryValidate(value, enumType, typeSystem, out var valid) ||
            valid)
        {
            return;
        }

        diagnostics.Add(Diag(doc, span, SeverityError, code,
            $"'{value}' is not a valid value for {displayName}.",
            SuggestData(value, enumType.GetMembers().OfType<IFieldSymbol>()
                .Where(field => field.HasConstantValue).Select(field => field.Name))));
    }

    private static void ValidateRelativeSource(
        XamlMarkupExtension extension, XamlNamespaceScope scope, XamlTypeSystem typeSystem,
        TextDocument doc, List<Diagnostic> diagnostics)
    {
        var type = XamlSemanticFacts.ResolveMarkupExtensionType(
            extension.Name?.FullName, scope, typeSystem);
        if (type is null)
        {
            return;
        }

        foreach (var argument in extension.Arguments)
        {
            var name = argument.IsNamed ? argument.Name?.LocalName : "Mode";
            if (string.IsNullOrEmpty(name))
            {
                continue;
            }

            var member = typeSystem.FindMember(type, name);
            if (member is null)
            {
                diagnostics.Add(Diag(doc, argument.Name?.LocalNameSpan ??
                    argument.ValueSpan ?? extension.Span, SeverityError,
                    InvalidRelativeSourceCode,
                    $"'{name}' is not an argument of '{type.Name}'."));
                continue;
            }

            ValidateBindingEnumValue(argument, member.Type, $"RelativeSource.{name}",
                InvalidRelativeSourceCode, typeSystem, doc, diagnostics);
        }
    }

    private static XamlElement? FindParentElement(XamlNode? node)
    {
        for (var current = node?.Parent; current is not null; current = current.Parent)
        {
            if (current is XamlElement element)
            {
                return element;
            }
        }

        return null;
    }

    private static void ValidateTemplateBinding(
        XamlAttribute attribute, INamedTypeSymbol? templateTargetType,
        TextDocument doc, XamlTypeSystem typeSystem, List<Diagnostic> diagnostics)
    {
        var element = FindParentElement(attribute);
        if (templateTargetType is null ||
            element is null ||
            attribute.Value?.MarkupExtension is not
                { IsClosed: true, Name.LocalName: "TemplateBinding" } extension)
        {
            return;
        }

        if (extension.Name!.HasPrefix &&
            (!element.NamespaceScope.TryResolvePrefix(extension.Name.Prefix, out var uri) ||
             !XamlSemanticFacts.IsPresentationNamespace(uri)))
        {
            return;
        }

        var pathArgument = extension.Arguments.FirstOrDefault(argument =>
            (!argument.IsNamed || argument.Name?.LocalName == "Property") &&
            argument.Value is not null);
        if (pathArgument?.Value is not { } path || pathArgument.ValueSpan is not { } span)
        {
            return;
        }

        var memberName = path.Trim();
        int dot = memberName.IndexOf('.');
        if (dot > 0 && dot < memberName.Length - 1)
        {
            var ownerName = memberName[..dot];
            var attachedMemberName = memberName[(dot + 1)..];
            var owner = ResolveTypeName(ownerName, element.NamespaceScope, typeSystem);
            var attached = owner is null
                ? null
                : typeSystem.GetAttachedProperties(owner)
                    .FirstOrDefault(member =>
                        string.Equals(member.Name, attachedMemberName, StringComparison.Ordinal));
            if (attached is not null &&
                XamlTypeSystem.IsAttachedPropertyApplicable(attached, templateTargetType))
            {
                return;
            }

            var message = owner is null
                ? $"'{ownerName}' is not a known attached-property owner."
                : attached is null
                    ? $"'{attachedMemberName}' is not an attached property of '{owner.Name}'."
                    : $"The attached property '{memberName}' cannot be read from template target type '{templateTargetType.Name}'.";
            diagnostics.Add(Diag(
                doc,
                span,
                SeverityError,
                InvalidTemplateBindingCode,
                message,
                owner is null
                    ? null
                    : SuggestData(
                        attachedMemberName,
                        typeSystem.GetAttachedProperties(owner).Select(member => member.Name))));
            return;
        }

        if (IsIdentifier(memberName) &&
            !typeSystem.GetBindableMembers(templateTargetType)
                .OfType<IPropertySymbol>()
                .Any(property => string.Equals(property.Name, memberName, StringComparison.Ordinal)))
        {
            diagnostics.Add(Diag(doc, span, SeverityError, InvalidTemplateBindingCode,
                $"'{memberName}' is not a member of template target type '{templateTargetType.Name}'.",
                SuggestData(
                    memberName,
                    typeSystem.GetBindableMembers(templateTargetType)
                        .OfType<IPropertySymbol>()
                        .Select(property => property.Name))));
        }
    }

    private static void ValidateBindMode(
        XamlAttribute attribute,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        if (!XamlSemanticFacts.IsXBind(attribute, scope) ||
            attribute.Value!.MarkupExtension is not { } extension ||
            XamlSemanticFacts.ResolveMarkupArgumentType(
                extension,
                scope,
                "Mode",
                typeSystem) is not { TypeKind: TypeKind.Enum } bindingMode ||
            extension.Arguments.FirstOrDefault(argument =>
                argument.IsNamed && argument.Name?.LocalName == "Mode") is not { Value: { } mode, ValueSpan: { } span })
        {
            return;
        }

        var names = bindingMode.GetMembers().OfType<IFieldSymbol>()
            .Where(field => field.HasConstantValue)
            .Select(field => field.Name)
            .ToArray();
        if (XamlValueConverter.TryValidate(mode, bindingMode, typeSystem, out var isValid) && !isValid)
        {
            diagnostics.Add(Diag(doc, span, SeverityError, InvalidBindModeCode,
                $"'{mode}' is not a valid x:Bind mode.", SuggestData(mode, names)));
        }
    }

    private static void ValidateBindAssignment(
        XamlAttribute attribute,
        INamedTypeSymbol? elementType,
        INamedTypeSymbol bindRoot,
        INamedTypeSymbol? pageClass,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        if (elementType is null ||
            attribute.Name.HasPrefix ||
            attribute.Name.IsDotted ||
            typeSystem.FindAttributeMember(elementType, attribute.Name.LocalName) is not
                { Kind: XamlMemberKind.Property, Type: { } targetType } ||
            attribute.Value?.MarkupExtension is not { IsClosed: true } extension ||
            !XamlSemanticFacts.IsXBind(extension, scope) ||
            extension.Arguments.Any(argument =>
                argument.IsNamed &&
                argument.Name?.LocalName is "Converter" or "ConverterParameter") ||
            extension.Arguments.FirstOrDefault(argument =>
                (!argument.IsNamed || argument.Name?.LocalName == "Path") &&
                argument.Value is not null) is not { Value: { } path, ValueSpan: { } span } ||
            path.IndexOf('(') >= 0 ||
            !TryResolveBindResultType(
                path, attribute, bindRoot, pageClass, scope, typeSystem, doc, out var resultType) ||
            IsImplicitlyAssignable(resultType, targetType, typeSystem) ||
            HasBuiltInBindingConversion(resultType, targetType))
        {
            return;
        }

        diagnostics.Add(Diag(doc, span, SeverityError, InvalidBindAssignmentCode,
            $"The x:Bind result type '{resultType.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)}' " +
            $"is not assignable to '{targetType.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)}'."));
    }

    private static bool TryResolveBindResultType(
        string path,
        XamlAttribute attribute,
        INamedTypeSymbol bindRoot,
        INamedTypeSymbol? pageClass,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        [NotNullWhen(true)] out ITypeSymbol? resultType)
    {
        resultType = null;
        var text = path.Trim();
        if (text.StartsWith("!", System.StringComparison.Ordinal))
        {
            if (!TryResolveBindResultType(
                    text.Substring(1),
                    attribute,
                    bindRoot,
                    pageClass,
                    scope,
                    typeSystem,
                    doc,
                    out _))
            {
                return false;
            }

            resultType = typeSystem.ResolveMetadataType("System.Boolean");
            return resultType is not null;
        }

        ITypeSymbol current = bindRoot;
        bool firstStatic = false;
        bool allowFirstNonPublic =
            pageClass is not null &&
            SymbolEqualityComparer.Default.Equals(bindRoot, pageClass);
        string chain = text;
        if (TryGetCastPath(text, out var castName, out var castMembers, out _) &&
            ResolveTypeName(castName, scope, typeSystem) is { } castType)
        {
            current = castType;
            chain = castMembers.TrimStart('.');
            allowFirstNonPublic = false;
        }
        else if (TryGetStaticBindRoot(
                     text, scope, typeSystem, out var staticType, out var staticMembers, out _))
        {
            current = staticType;
            chain = staticMembers;
            firstStatic = true;
            allowFirstNonPublic = false;
        }
        else
        {
            var firstName = chain.Split('.')[0];
            if (XamlSemanticFacts.ResolveNamedElementTypeInScope(
                    doc, attribute.Parent, firstName, typeSystem) is { } namedType)
            {
                current = namedType;
                chain = chain.Length == firstName.Length
                    ? string.Empty
                    : chain[(firstName.Length + 1)..];
                allowFirstNonPublic = false;
            }
        }

        if (chain.Length == 0)
        {
            resultType = current;
            return true;
        }

        bool first = true;
        foreach (var rawSegment in chain.Split('.'))
        {
            var bracket = rawSegment.IndexOf('[');
            var name = (bracket < 0 ? rawSegment : rawSegment[..bracket]).Trim();
            if (!IsIdentifier(name))
            {
                return false;
            }

            ITypeSymbol? next;
            if (first && firstStatic)
            {
                var symbol = typeSystem.GetBindableStaticMembers(current, pageClass)
                    .FirstOrDefault(candidate =>
                        candidate.Name == name &&
                        candidate is IPropertySymbol or IFieldSymbol);
                next = symbol is null ? null : GetSymbolType(symbol);
                for (int i = bracket; next is not null && bracket >= 0 && i < rawSegment.Length; i++)
                {
                    if (rawSegment[i] == '[')
                    {
                        next = XamlTypeSystem.GetCollectionElementType(next);
                    }
                }
            }
            else
            {
                next = CompletionProvider.ResolveBindSegmentType(
                    typeSystem,
                    current,
                    rawSegment,
                    first && allowFirstNonPublic,
                    pageClass);
            }

            if (next is null)
            {
                return false;
            }

            current = next;
            first = false;
        }

        resultType = current;
        return true;
    }

    private static bool IsImplicitlyAssignable(
        ITypeSymbol source,
        ITypeSymbol target,
        XamlTypeSystem typeSystem)
    {
        bool sourceNullable = IsNullableType(source);
        bool targetNullable = IsNullableType(target);
        if (sourceNullable && !targetNullable)
        {
            return false;
        }

        source = XamlValueConverter.UnwrapNullable(source);
        target = XamlValueConverter.UnwrapNullable(target);
        if (SymbolEqualityComparer.Default.Equals(source, target) ||
            XamlTypeSystem.IsAssignableTo(source, target))
        {
            return true;
        }

        return typeSystem.HasImplicitConversion(source, target);
    }

    private static bool HasBuiltInBindingConversion(ITypeSymbol source, ITypeSymbol target)
    {
        source = XamlValueConverter.UnwrapNullable(source);
        target = XamlValueConverter.UnwrapNullable(target);
        if (target.SpecialType == SpecialType.System_String)
        {
            return true;
        }

        if (source.SpecialType == SpecialType.System_String &&
            (target.Name == "Uri" &&
             target.ContainingNamespace?.ToDisplayString() == "System" ||
             target.Name == "ImageSource" &&
             target.ContainingNamespace?.ToDisplayString() is
                 "Microsoft.UI.Xaml.Media" or "Windows.UI.Xaml.Media"))
        {
            return true;
        }

        return source.SpecialType == SpecialType.System_Boolean &&
            target.Name == "Visibility" &&
            target.ContainingNamespace?.ToDisplayString() is
                "Microsoft.UI.Xaml" or "Windows.UI.Xaml";
    }

    private static bool IsNullableType(ITypeSymbol type) =>
        type is INamedTypeSymbol named &&
        named.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T;

    private static void ValidateUntypedTemplateBinding(
        XamlAttribute attribute,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics,
        DiagnosticData? dataTypeSuggestion)
    {
        if (attribute.Value?.MarkupExtension is not { IsClosed: true } extension ||
            !XamlSemanticFacts.IsBindingMarkupExtension(extension, scope, typeSystem))
        {
            return;
        }

        diagnostics.Add(Diag(
            doc,
            extension.Name?.Span ?? extension.Span,
            SeverityWarning,
            BindingDataTypeRecommendedCode,
            "Binding inside a DataTemplate without x:DataType is not safe for Native AOT.",
            dataTypeSuggestion));
    }

    private static void ValidateRootClassExists(
        XamlElement root,
        INamedTypeSymbol? pageClass,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        if (pageClass is not null ||
            XamlSemanticFacts.GetDirectiveAttribute(root, "Class")?.Value is not { } value)
        {
            return;
        }

        var className = value.Text.Trim();
        if (className.Length > 0)
        {
            diagnostics.Add(Diag(
                doc,
                value.InnerSpan,
                SeverityError,
                UnknownRootClassCode,
                $"The x:Class type '{className}' was not found in the project compilation."));
        }
    }

    private static void ValidateRootClass(
        XamlElement root,
        INamedTypeSymbol? pageClass,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        if (pageClass is null || ResolveElementType(root, typeSystem) is not { } rootType ||
            XamlTypeSystem.IsAssignableTo(pageClass, rootType))
        {
            return;
        }

        var classAttribute = XamlSemanticFacts.GetDirectiveAttribute(root, "Class");
        if (classAttribute?.Value is { } value)
        {
            diagnostics.Add(Diag(doc, value.InnerSpan, SeverityError, InvalidRootClassCode,
                $"The x:Class type '{pageClass.ToDisplayString()}' is not assignable to the root element type '{rootType.ToDisplayString()}'."));
        }
    }

    private static void ReportUndeclaredPrefix(
        XamlName name, XamlNamespaceScope scope, TextDocument doc, List<Diagnostic> diagnostics)
    {
        if (name.HasPrefix && !ReservedPrefixes.Contains(name.Prefix!) &&
            !scope.TryResolvePrefix(name.Prefix, out _))
        {
            diagnostics.Add(Diag(doc, name.PrefixSpan ?? name.Span, SeverityError, UndeclaredPrefixCode,
                $"The namespace prefix '{name.Prefix}' is not declared.",
                GetUniqueNamespaceSuggestion(name.Prefix!, string.Empty, typeSystem: null)));
        }
    }

    private static DiagnosticData? GetUniqueNamespaceSuggestion(
        string prefix,
        string localTypeName,
        XamlTypeSystem? typeSystem)
    {
        var standardNamespace = prefix switch
        {
            "x" => XamlTypeSystem.XamlLanguageNamespace,
            "d" => "http://schemas.microsoft.com/expression/blend/2008",
            "mc" => "http://schemas.openxmlformats.org/markup-compatibility/2006",
            _ => null,
        };
        if (standardNamespace is not null)
        {
            return new DiagnosticData
            {
                Bad = prefix,
                Suggestions = [standardNamespace],
            };
        }

        if (typeSystem is null)
        {
            return null;
        }

        var namespaces = typeSystem.FindNamespacesForTypeName(localTypeName);
        return namespaces.Count == 1
            ? new DiagnosticData
            {
                Bad = prefix,
                Suggestions = [$"using:{namespaces[0]}"],
            }
            : null;
    }

    private static Diagnostic Diag(TextDocument doc, TextSpan span, int severity, string code, string message) =>
        new()
        {
            Range = doc.RangeOf(span),
            Severity = severity,
            Code = code,
            Message = message,
        };

    private static Diagnostic Diag(TextDocument doc, TextSpan span, int severity, string code, string message, DiagnosticData? data) =>
        new()
        {
            Range = doc.RangeOf(span),
            Severity = severity,
            Code = code,
            Message = message,
            Data = data,
        };

    /// <summary>Builds the DiagnosticData spelling-suggestion payload for a mistyped bad name against the valid candidates, or null when nothing is close enough</summary>
    private static DiagnosticData? SuggestData(string bad, IEnumerable<string> candidates)
    {
        var nearest = XamlSuggestions.Nearest(bad, candidates);
        return nearest.Count == 0 ? null : new DiagnosticData { Bad = bad, Suggestions = nearest.ToArray() };
    }

    /// <summary>Reports an {x:Bind} path segment that is not a member of the type produced by the segment before it (the first segment is checked against bindRoot</summary>
    private static void ValidateBindPath(
        XamlAttribute attribute,
        INamedTypeSymbol bindRoot,
        INamedTypeSymbol? pageClass,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        if (!XamlSemanticFacts.IsXBind(attribute, scope) ||
            attribute.Value?.MarkupExtension is not { IsClosed: true } ext)
        {
            return;
        }

        var pathArg = ext.Arguments.FirstOrDefault(
            a => (!a.IsNamed && a.NestedExtension is null && a.Value is not null) ||
                 (a.IsNamed && a.Name?.LocalName == "Path" && a.Value is not null));
        if (pathArg?.Value is not { } path || pathArg.ValueSpan is not { } valueSpan)
        {
            return;
        }

        bool allowRootNonPublic =
            pageClass is not null &&
            SymbolEqualityComparer.Default.Equals(bindRoot, pageClass);

        if (ValidateLeadingAttachedBindPath(
                path, valueSpan, pageClass, scope, typeSystem, doc, diagnostics))
        {
            return;
        }

        // Validate cast paths only when the target type is unambiguous.
        if (TryGetCastPath(path, out var castTypeName, out var castMembers, out var castMemberOffset))
        {
            if (ResolveTypeName(castTypeName, scope, typeSystem) is { } castType)
            {
                ValidateMemberChain(
                    castType, castMembers.Split('.'), castMemberOffset, valueSpan,
                    skipFirst: false, includeRootNonPublic: false, pageClass,
                    typeSystem, doc, diagnostics);
            }

            return; // a cast path is fully handled here (reported or safely skipped) — never falls through.
        }

        if (TryGetStaticBindRoot(path, scope, typeSystem, out var staticType, out var staticMembers, out var staticOffset))
        {
            if (staticMembers.IndexOf('(') >= 0)
            {
                ValidateBindFunctionArgs(
                    staticMembers,
                    new TextSpan(valueSpan.Start + staticOffset, valueSpan.End),
                    bindRoot,
                    pageClass,
                    allowRootNonPublic,
                    typeSystem,
                    doc,
                    diagnostics,
                    staticType);
            }
            else
            {
                ValidateStaticMemberChain(
                    staticType,
                    staticMembers,
                    staticOffset,
                    valueSpan,
                    pageClass,
                    typeSystem,
                    doc,
                    diagnostics);
            }
            return;
        }

        if (!TryFirstBindSegment(path, out var segment))
        {
            return;
        }

        if (typeSystem.GetBindableMembers(
                bindRoot,
                includeRootNonPublic: allowRootNonPublic,
                accessWithin: pageClass)
            .Any(m => string.Equals(m.Name, segment, System.StringComparison.Ordinal)))
        {
            // The first segment is valid — validate any remaining dotted segments too, so a bad non-first member (GreetingText.Nope, Items[0].Nope) is caught rather than silently accepted.
            ValidateBindPathTail(
                path, valueSpan, bindRoot, pageClass, allowRootNonPublic,
                typeSystem, doc, diagnostics);

            // For a function binding (Method(arg, arg)) each argument is itself a path bound against the root, so a bogus argument member is flagged the same as a bogus root path.
            ValidateBindFunctionArgs(
                path, valueSpan, bindRoot, pageClass, allowRootNonPublic,
                typeSystem, doc, diagnostics);
            return;
        }

        if (FindInaccessibleMember(bindRoot, segment, pageClass, typeSystem) is not null)
        {
            diagnostics.Add(Diag(doc, valueSpan, SeverityError, InaccessibleBindMemberCode,
                $"'{segment}' is not accessible to x:Bind."));
            return;
        }

        if (XamlSemanticFacts.ResolveNamedElementTypeInScope(
                doc,
                attribute.Parent,
                segment,
                typeSystem) is { } namedElementType)
        {
            ValidateNamedElementBindPathTail(
                path,
                valueSpan,
                namedElementType,
                pageClass,
                typeSystem,
                doc,
                diagnostics);
            return;
        }

        diagnostics.Add(Diag(doc, valueSpan, SeverityWarning, UnknownBindMemberCode,
            $"'{segment}' is not a member of '{bindRoot.Name}' bound by x:Bind.",
            SuggestData(
                segment,
                typeSystem.GetBindableMembers(
                        bindRoot,
                        includeRootNonPublic: allowRootNonPublic,
                        accessWithin: pageClass)
                    .Select(m => m.Name))));
    }

    private static bool TryGetStaticBindRoot(
        string path, XamlNamespaceScope scope, XamlTypeSystem typeSystem,
        [NotNullWhen(true)] out INamedTypeSymbol? type,
        out string memberChain, out int memberOffset)
    {
        type = null;
        memberChain = string.Empty;
        memberOffset = 0;
        var trimmed = path.TrimStart();
        int leading = path.Length - trimmed.Length;
        int dot = trimmed.IndexOf('.');
        if (dot <= 0 || trimmed[..dot].IndexOf(':') <= 0 ||
            ResolveTypeName(trimmed[..dot], scope, typeSystem) is not { } resolved)
        {
            return false;
        }

        type = resolved;
        memberChain = trimmed[(dot + 1)..];
        memberOffset = leading + dot + 1;
        return true;
    }

    private static void ValidateStaticMemberChain(
        INamedTypeSymbol type, string chain, int chainOffset, TextSpan valueSpan,
        INamedTypeSymbol? accessWithin,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        ITypeSymbol current = type;
        int offset = chainOffset;
        bool first = true;
        foreach (var segment in chain.Split('.'))
        {
            var trimmed = segment.Trim();
            int bracket = trimmed.IndexOf('[');
            var name = bracket < 0 ? trimmed : trimmed[..bracket];
            ITypeSymbol? next;
            if (first)
            {
                var symbol = typeSystem.GetBindableStaticMembers(current, accessWithin)
                    .FirstOrDefault(member =>
                        member.Name == name &&
                        member is IPropertySymbol or IFieldSymbol);
                next = symbol is null ? null : GetSymbolType(symbol);
                for (int i = bracket; next is not null && bracket >= 0 && i < trimmed.Length; i++)
                {
                    if (trimmed[i] == '[')
                    {
                        next = XamlTypeSystem.GetCollectionElementType(next);
                    }
                }
            }
            else
            {
                next = CompletionProvider.ResolveBindSegmentType(
                    typeSystem, current, trimmed, false, accessWithin);
            }

            if (next is null)
            {
                diagnostics.Add(Diag(doc,
                    new TextSpan(valueSpan.Start + offset, valueSpan.Start + offset + name.Length),
                    SeverityWarning, UnknownBindMemberCode,
                    $"'{name}' is not a bindable member of '{current.Name}'."));
                return;
            }

            current = next;
            offset += segment.Length + 1;
            first = false;
        }
    }

    private static ISymbol? FindInaccessibleMember(
        ITypeSymbol type,
        string name,
        ISymbol? accessWithin,
        XamlTypeSystem typeSystem)
    {
        for (var current = type as INamedTypeSymbol; current is not null; current = current.BaseType)
        {
            var member = current.GetMembers(name).FirstOrDefault(candidate =>
            {
                var accessibilitySymbol = candidate is IPropertySymbol { GetMethod: { } getter }
                    ? getter
                    : candidate;
                return !candidate.IsStatic &&
                       (accessWithin is null ||
                        !typeSystem.IsSymbolAccessibleWithin(accessibilitySymbol, accessWithin, type)) &&
                       candidate is IPropertySymbol or IFieldSymbol or IMethodSymbol;
            });
            if (member is not null)
            {
                return member;
            }
        }

        return null;
    }

    private static ITypeSymbol? GetSymbolType(ISymbol symbol) => symbol switch
    {
        IPropertySymbol property => property.Type,
        IFieldSymbol field => field.Type,
        IMethodSymbol method => method.ReturnType,
        _ => null,
    };

    /// <summary>Validates a leading attached-property binding step.</summary>
    private static bool ValidateLeadingAttachedBindPath(
        string path,
        TextSpan valueSpan,
        INamedTypeSymbol? accessWithin,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        int open = 0;
        while (open < path.Length && (path[open] == '!' || char.IsWhiteSpace(path[open])))
        {
            open++;
        }

        if (open >= path.Length || path[open] != '(')
        {
            return false;
        }

        int close = path.IndexOf(')', open + 1);
        if (close < 0)
        {
            return true;
        }

        var inner = path.Substring(open + 1, close - open - 1).Trim();
        int dot = inner.LastIndexOf('.');
        if (dot <= 0 || dot >= inner.Length - 1)
        {
            return false; // a cast, not an attached-property step
        }

        var ownerName = inner.Substring(0, dot).Trim();
        var memberName = inner.Substring(dot + 1).Trim();
        if (!IsIdentifier(memberName))
        {
            return true;
        }

        var owner = ResolveTypeName(ownerName, scope, typeSystem);
        if (owner is null)
        {
            return true;
        }

        var memberType = typeSystem.GetAttachedMemberType(owner, memberName);
        if (memberType is null)
        {
            int memberOffset = path.IndexOf(memberName, open + 1, System.StringComparison.Ordinal);
            var memberSpan = memberOffset >= 0
                ? new TextSpan(valueSpan.Start + memberOffset, valueSpan.Start + memberOffset + memberName.Length)
                : valueSpan;
            diagnostics.Add(Diag(doc, memberSpan, SeverityWarning, UnknownAttachedPropertyCode,
                $"'{memberName}' is not an attached property of '{owner.Name}'.",
                SuggestData(memberName, typeSystem.GetAttachedProperties(owner).Select(m => m.Name))));
            return true;
        }

        int tailStart = close + 1;
        while (tailStart < path.Length && char.IsWhiteSpace(path[tailStart]))
        {
            tailStart++;
        }

        if (tailStart >= path.Length)
        {
            return true;
        }

        if (path[tailStart] != '.')
        {
            return true;
        }

        tailStart++;
        while (tailStart < path.Length && char.IsWhiteSpace(path[tailStart]))
        {
            tailStart++;
        }

        if (tailStart < path.Length)
        {
            ValidateMemberChain(
                memberType,
                path.Substring(tailStart).Split('.'),
                tailStart,
                valueSpan,
                skipFirst: false,
                includeRootNonPublic: false,
                accessWithin,
                typeSystem,
                doc,
                diagnostics);
        }

        return true;
    }

    /// <summary>Walks the dotted segments of an {x:Bind} path after the first (which the caller has already validated)</summary>
    private static void ValidateBindPathTail(
        string path,
        TextSpan valueSpan,
        INamedTypeSymbol bindRoot,
        INamedTypeSymbol? accessWithin,
        bool includeRootNonPublic,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        // Skip the leading '!' negation run (and whitespace), keeping the offset so segment spans stay aligned with the document text.
        int start = 0;
        while (start < path.Length && (path[start] == '!' || char.IsWhiteSpace(path[start])))
        {
            start++;
        }

        var body = path.Substring(start);

        // A function binding (Method(...)) or a cast ((ns:Type)Member) is not a plain member chain the tail walk can verify — the first-segment check already covered what it safely can.
        if (body.IndexOf('(') >= 0)
        {
            return;
        }

        var segments = body.Split('.');
        if (segments.Length < 2)
        {
            return; // only one segment — already validated by the caller.
        }

        ValidateMemberChain(
            bindRoot,
            segments,
            start,
            valueSpan,
            skipFirst: true,
            includeRootNonPublic,
            accessWithin,
            typeSystem,
            doc,
            diagnostics);
    }

    private static void ValidateNamedElementBindPathTail(
        string path,
        TextSpan valueSpan,
        INamedTypeSymbol namedElementType,
        INamedTypeSymbol? accessWithin,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        int start = 0;
        while (start < path.Length && (path[start] == '!' || char.IsWhiteSpace(path[start])))
        {
            start++;
        }

        var body = path.Substring(start);
        if (body.IndexOf('(') >= 0)
        {
            return;
        }

        var segments = body.Split('.');
        if (segments.Length < 2)
        {
            return;
        }

        int tailStart = start + segments[0].Length + 1;
        ValidateMemberChain(
            namedElementType,
            segments.Skip(1).ToArray(),
            tailStart,
            valueSpan,
            skipFirst: false,
            includeRootNonPublic: false,
            accessWithin,
            typeSystem,
            doc,
            diagnostics);
    }

    /// <summary>Walks a dotted member chain against a starting type, flagging the FIRST segment that is not a member of the type produced by the preceding segment.</summary>
    private static void ValidateMemberChain(
        ITypeSymbol rootType,
        string[] segments,
        int chainStart,
        TextSpan valueSpan,
        bool skipFirst,
        bool includeRootNonPublic,
        ISymbol? accessWithin,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        ITypeSymbol current = rootType;
        bool atRoot = true;
        int segStart = chainStart;

        for (int i = 0; i < segments.Length; i++)
        {
            var seg = segments[i];

            // The member name is the segment without any trailing indexer (Items[0] -> Items).
            int bracket = seg.IndexOf('[');
            var baseName = (bracket < 0 ? seg : seg.Substring(0, bracket)).Trim();

            if (baseName.Length == 0 || !IsIdentifier(baseName))
            {
                return; // an empty or non-identifier segment (nested cast/call, malformed) — stay silent.
            }

            var member = typeSystem.GetBindableMembers(
                    current,
                    includeRootNonPublic: atRoot && includeRootNonPublic,
                    accessWithin)
                .FirstOrDefault(m => string.Equals(m.Name, baseName, System.StringComparison.Ordinal));

            if (member is null)
            {
                if (skipFirst && i == 0)
                {
                    return; // the first segment is the caller's responsibility.
                }

                // Underline just the offending member name within the path value.
                int lead = seg.Length - seg.TrimStart().Length;
                int badStart = valueSpan.Start + segStart + lead;
                int badEnd = badStart + baseName.Length;
                var badSpan = badEnd <= valueSpan.End ? new TextSpan(badStart, badEnd) : valueSpan;
                if (FindInaccessibleMember(
                        current, baseName, accessWithin, typeSystem) is not null)
                {
                    diagnostics.Add(Diag(doc, badSpan, SeverityError, InaccessibleBindMemberCode,
                        $"'{baseName}' is not accessible to x:Bind."));
                }
                else
                {
                    diagnostics.Add(Diag(doc, badSpan, SeverityWarning, UnknownBindMemberCode,
                        $"'{baseName}' is not a member of '{current.Name}' bound by x:Bind.",
                        SuggestData(
                            baseName,
                            typeSystem.GetBindableMembers(
                                    current,
                                    includeRootNonPublic: atRoot,
                                    accessWithin)
                                .Select(m => m.Name))));
                }
                return;
            }

            var next = CompletionProvider.ResolveBindSegmentType(
                typeSystem, current, seg, atRoot, accessWithin);
            if (next is null)
            {
                return; // the chain leads to a type we cannot model further — stop without reporting.
            }

            current = next;
            atRoot = false;
            segStart += seg.Length + 1; // advance past the segment and its trailing '.'
        }
    }

    /// <summary>Splits an unambiguous leading x:Bind cast from its member path.</summary>
    private static bool TryGetCastPath(string path, out string castType, out string memberChain, out int memberOffset)
    {
        castType = string.Empty;
        memberChain = string.Empty;
        memberOffset = 0;

        int i = 0;
        while (i < path.Length && (path[i] == '!' || char.IsWhiteSpace(path[i])))
        {
            i++;
        }

        if (i >= path.Length || path[i] != '(')
        {
            return false;
        }

        int open = i;
        int close = path.IndexOf(')', open + 1);
        if (close < 0)
        {
            return false; // unterminated cast — leave it to the tolerant parser.
        }

        var inner = path.Substring(open + 1, close - open - 1).Trim();
        if (inner.Length == 0 || inner.IndexOf('.') >= 0)
        {
            return false; // empty, or an attached-property step (Owner.Member) — not a cast.
        }

        castType = inner;
        memberChain = path.Substring(close + 1);
        memberOffset = close + 1;
        return true;
    }

    /// <summary>Validates unambiguous member paths in x:Bind function arguments.</summary>
    private static void ValidateBindFunctionArgs(
        string path,
        TextSpan valueSpan,
        INamedTypeSymbol bindRoot,
        INamedTypeSymbol? accessWithin,
        bool includeRootNonPublic,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics,
        INamedTypeSymbol? staticReceiverType = null)
    {
        int start = 0;
        while (start < path.Length && (path[start] == '!' || char.IsWhiteSpace(path[start])))
        {
            start++;
        }

        int open = path.IndexOf('(', start);
        if (open <= start)
        {
            return; // no method name before '(' — a cast or non-function path, not our concern here.
        }

        // Find the matching close paren for the argument list.
        int depth = 0;
        int close = -1;
        char closeScanQuote = '\0';
        for (int j = open; j < path.Length; j++)
        {
            char c = path[j];
            if (closeScanQuote != '\0')
            {
                if (c == '\\')
                {
                    j++;
                }
                else if (c == closeScanQuote)
                {
                    closeScanQuote = '\0';
                }

                continue;
            }

            if (c is '\'' or '"')
            {
                closeScanQuote = c;
            }
            else if (c == '(')
            {
                depth++;
            }
            else if (c == ')')
            {
                depth--;
                if (depth == 0)
                {
                    close = j;
                    break;
                }
            }
        }

        if (close < 0)
        {
            return; // unbalanced parentheses — stay silent.
        }

        // Split the argument list on top-level commas (nested parens/indexers do not split).
        var argumentRanges = new List<(int Start, int End)>();
        int argStart = open + 1;
        int d = 0;
        char quote = '\0';
        for (int j = open + 1; j < close; j++)
        {
            char c = path[j];
            if (quote != '\0')
            {
                if (c == '\\')
                {
                    j++;
                }
                else if (c == quote)
                {
                    quote = '\0';
                }

                continue;
            }

            if (c is '\'' or '"')
            {
                quote = c;
                continue;
            }

            if (c is '(' or '[')
            {
                d++;
            }
            else if (c is ')' or ']')
            {
                if (d > 0)
                {
                    d--;
                }
            }
            else if (c == ',' && d == 0)
            {
                argumentRanges.Add((argStart, j));
                argStart = j + 1;
            }
        }

        if (ContainsNonWhitespace(path, argStart, close) || argumentRanges.Count > 0)
        {
            argumentRanges.Add((argStart, close));
        }

        var functionPath = path.Substring(start, open - start).Trim();
        var functionName = functionPath;
        ITypeSymbol receiverType = staticReceiverType ?? bindRoot;
        bool includeReceiverNonPublic = staticReceiverType is null && includeRootNonPublic;
        bool atStaticReceiverRoot = staticReceiverType is not null;
        int receiverSeparator = functionPath.LastIndexOf('.');
        if (receiverSeparator >= 0)
        {
            var receiverSegments = functionPath.Substring(0, receiverSeparator).Split('.');
            if (staticReceiverType is null)
            {
                ValidateMemberChain(
                    bindRoot,
                    receiverSegments,
                    start,
                    valueSpan,
                    skipFirst: false,
                    includeRootNonPublic,
                    accessWithin,
                    typeSystem,
                    doc,
                    diagnostics);
            }
            foreach (var receiverSegment in receiverSegments)
            {
                ITypeSymbol? next;
                if (atStaticReceiverRoot)
                {
                    next = CompletionProvider.ResolveStaticBindSegmentType(
                        typeSystem, receiverType, receiverSegment, accessWithin);
                }
                else
                {
                    next = CompletionProvider.ResolveBindSegmentType(
                        typeSystem,
                        receiverType,
                        receiverSegment,
                        includeReceiverNonPublic,
                        accessWithin);
                }
                if (next is null)
                {
                    return;
                }

                receiverType = next;
                includeReceiverNonPublic = false;
                atStaticReceiverRoot = false;
            }

            functionName = functionPath.Substring(receiverSeparator + 1);
        }

        bool callIsStatic = staticReceiverType is not null && receiverSeparator < 0;
        var overloads = (!callIsStatic
                ? typeSystem.GetBindableMethods(
                    receiverType,
                    includeReceiverNonPublic,
                    accessWithin)
                : typeSystem.GetBindableStaticMembers(receiverType, accessWithin)
                    .OfType<IMethodSymbol>())
            .Where(m => string.Equals(m.Name, functionName, System.StringComparison.Ordinal))
            .ToList();
        if (overloads.Count == 0)
        {
            var functionSpan = new TextSpan(valueSpan.Start + start, valueSpan.Start + open);
            diagnostics.Add(Diag(doc, functionSpan, SeverityWarning, InvalidBindFunctionCode,
                $"'{functionName}' is not a callable method on '{receiverType.Name}'."));
        }
        else if (!overloads.Any(m => AcceptsArgumentCount(m, argumentRanges.Count)))
        {
            var functionSpan = new TextSpan(valueSpan.Start + start, valueSpan.Start + open);
            diagnostics.Add(Diag(doc, functionSpan, SeverityWarning, InvalidBindFunctionCode,
                $"No overload of '{functionName}' accepts {argumentRanges.Count} argument(s)."));
        }

        foreach (var (argumentStart, argumentEnd) in argumentRanges)
        {
            ValidateBindFunctionArg(
                path, argumentStart, argumentEnd, valueSpan, bindRoot,
                accessWithin, includeRootNonPublic, typeSystem, doc, diagnostics);
        }
    }

    private static bool AcceptsArgumentCount(IMethodSymbol method, int argumentCount)
    {
        int required = method.Parameters.Count(p => !p.IsOptional && !p.IsParams);
        if (argumentCount < required)
        {
            return false;
        }

        return method.Parameters.Any(p => p.IsParams) || argumentCount <= method.Parameters.Length;
    }

    private static bool ContainsNonWhitespace(string value, int start, int end)
    {
        for (int i = start; i < end; i++)
        {
            if (!char.IsWhiteSpace(value[i]))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>Validates a single function-binding argument spanning <c>[from, to)</c> of <paramref name="path"/> when — and only when — it is a plain member path; anything else is skipped.</summary>
    private static void ValidateBindFunctionArg(
        string path,
        int from,
        int to,
        TextSpan valueSpan,
        INamedTypeSymbol bindRoot,
        INamedTypeSymbol? accessWithin,
        bool includeRootNonPublic,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        int s = from;
        while (s < to && char.IsWhiteSpace(path[s]))
        {
            s++;
        }

        int e = to;
        while (e > s && char.IsWhiteSpace(path[e - 1]))
        {
            e--;
        }

        if (e <= s)
        {
            return; // empty argument.
        }

        var arg = path.Substring(s, e - s);

        // Only a plain member path is validatable. Skip literals (numbers/strings), prefixed names (x:Null / x:Static), nested markup ('{'), nested calls ('('), and anything with a ':' or quote.
        if (!(char.IsLetter(arg[0]) || arg[0] == '_'))
        {
            return;
        }

        foreach (char c in arg)
        {
            if (!(char.IsLetterOrDigit(c) || c == '_' || c == '.' || c == '[' || c == ']'))
            {
                return;
            }
        }

        int argAbsStart = valueSpan.Start + s;
        ITypeSymbol current = bindRoot;
        bool atRoot = true;
        int segStart = 0;
        var segments = arg.Split('.');
        for (int i = 0; i < segments.Length; i++)
        {
            var seg = segments[i];
            int bracket = seg.IndexOf('[');
            var baseName = (bracket < 0 ? seg : seg.Substring(0, bracket)).Trim();
            if (baseName.Length == 0 || !IsIdentifier(baseName))
            {
                return; // cannot verify (an unexpected shape) — stay silent.
            }

            var member = typeSystem.GetBindableMembers(
                    current,
                    includeRootNonPublic: atRoot && includeRootNonPublic,
                    accessWithin)
                .FirstOrDefault(m => string.Equals(m.Name, baseName, System.StringComparison.Ordinal));
            if (member is null)
            {
                int badStart = argAbsStart + segStart;
                int badEnd = badStart + baseName.Length;
                var badSpan = badEnd <= valueSpan.End ? new TextSpan(badStart, badEnd) : valueSpan;
                diagnostics.Add(Diag(doc, badSpan, SeverityWarning, UnknownBindMemberCode,
                    $"'{baseName}' is not a member of '{current.Name}' bound by x:Bind.",
                    SuggestData(
                        baseName,
                        typeSystem.GetBindableMembers(
                                current,
                                includeRootNonPublic: atRoot && includeRootNonPublic,
                                accessWithin)
                            .Select(m => m.Name))));
                return;
            }

            var next = CompletionProvider.ResolveBindSegmentType(
                typeSystem, current, seg, atRoot && includeRootNonPublic, accessWithin);
            if (next is null)
            {
                return;
            }

            current = next;
            atRoot = false;
            segStart += seg.Length + 1;
        }
    }

    /// <summary>Extracts the first identifier segment of an x:Bind path, or false when it is not a plain member name we can check (empty, a cast (ns:Type), or a function-arg reference).</summary>
    private static bool TryFirstBindSegment(string path, out string segment)
    {
        segment = string.Empty;
        var trimmed = path.Trim();

        // A leading '!' negates a boolean path ({x:Bind !IsEnabled}); validate the member after it.
        while (trimmed.StartsWith("!", System.StringComparison.Ordinal))
        {
            trimmed = trimmed.Substring(1).TrimStart();
        }

        int paren = trimmed.IndexOf('(');
        if (paren == 0)
        {
            return false; // leading '(' — a cast or a function whose first token is an argument path.
        }

        if (paren > 0)
        {
            trimmed = trimmed.Substring(0, paren); // function binding: check the method name before '('.
        }

        int dot = trimmed.IndexOf('.');
        var first = (dot >= 0 ? trimmed.Substring(0, dot) : trimmed).Trim();

        // Strip a trailing indexer (Items[0]) and validate the base member name; a non-identifier base (cast, empty) is skipped so only genuine unknown members are reported.
        int bracket = first.IndexOf('[');
        if (bracket >= 0)
        {
            first = first.Substring(0, bracket);
        }

        if (first.Length == 0 || !IsIdentifier(first))
        {
            return false;
        }

        segment = first;
        return true;
    }

    private static bool IsIdentifier(string text)
    {
        if (text.Length == 0 || !(char.IsLetter(text[0]) || text[0] == '_'))
        {
            return false;
        }

        foreach (var c in text)
        {
            if (!(char.IsLetterOrDigit(c) || c == '_'))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>Resolves the page's x:Class code-behind type from the root element, or null.</summary>
    private static INamedTypeSymbol? ResolvePageClass(XamlElement root, XamlTypeSystem typeSystem) =>
        TryGetDirectiveValue(root, "Class", out var className)
            ? typeSystem.ResolveMetadataType(className.Trim())
            : null;

    /// <summary>Reads a XAML-language directive value.</summary>
    private static bool TryGetDirectiveValue(XamlElement element, string localName, out string value)
    {
        if (XamlSemanticFacts.GetDirectiveAttribute(element, localName)?.Value is
            { Text.Length: > 0 } attributeValue)
        {
            value = attributeValue.Text;
            return true;
        }

        value = string.Empty;
        return false;
    }

    /// <summary>Resolves a XAML type reference (<c>local:Page2</c> or a metadata name) to a symbol, or null.</summary>
    private static INamedTypeSymbol? ResolveTypeName(string text, XamlNamespaceScope scope, XamlTypeSystem typeSystem)
        => XamlSemanticFacts.ResolveTypeName(
            text,
            scope,
            typeSystem,
            allowMetadataNameFallback: true);

    private static void ValidateDirectives(
        XamlElement element,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        foreach (var attribute in element.Attributes)
        {
            if (attribute.IsNamespaceDeclaration ||
                !attribute.Name.HasPrefix ||
                !scope.TryResolvePrefix(attribute.Name.Prefix, out var attributeUri))
            {
                continue;
            }

            if (XamlNamespaces.IsDesignTime(attributeUri) &&
                attribute.Name.LocalName == "DataContext" &&
                attribute.Value is { } designValue &&
                designValue.MarkupExtension is { Name.LocalName: "DesignInstance" } extension &&
                extension.Name.HasPrefix &&
                scope.TryResolvePrefix(extension.Name.Prefix, out var extensionUri) &&
                XamlNamespaces.IsDesignTime(extensionUri))
            {
                var typeName = CompletionProvider.ParseDesignInstanceType(designValue.Text);
                if (!string.IsNullOrWhiteSpace(typeName) &&
                    ResolveTypeName(typeName, scope, typeSystem) is null)
                {
                    int relative = designValue.Text.IndexOf(typeName, System.StringComparison.Ordinal);
                    var span = relative >= 0
                        ? new TextSpan(designValue.InnerSpan.Start + relative, designValue.InnerSpan.Start + relative + typeName.Length)
                        : designValue.InnerSpan;
                    diagnostics.Add(Diag(doc, span, SeverityWarning, UnknownDirectiveTypeCode,
                        $"The design-time type '{typeName}' could not be resolved."));
                }
            }

            if (attributeUri == XamlNamespaces.MarkupCompatibility &&
                attribute.Name.LocalName == "Ignorable" &&
                attribute.Value is { MarkupExtension: null } ignorableValue)
            {
                ValidateIgnorablePrefixes(ignorableValue.Text, ignorableValue.InnerSpan, scope, doc, diagnostics);
            }
        }
    }

    private static void ValidateIgnorablePrefixes(
        string value,
        TextSpan valueSpan,
        XamlNamespaceScope scope,
        TextDocument doc,
        List<Diagnostic> diagnostics)
    {
        int i = 0;
        while (i < value.Length)
        {
            while (i < value.Length && char.IsWhiteSpace(value[i]))
            {
                i++;
            }

            int start = i;
            while (i < value.Length && !char.IsWhiteSpace(value[i]))
            {
                i++;
            }

            if (start < i)
            {
                var prefix = value.Substring(start, i - start);
                if (!ReservedPrefixes.Contains(prefix) && !scope.TryResolvePrefix(prefix, out _))
                {
                    diagnostics.Add(Diag(
                        doc,
                        new TextSpan(valueSpan.Start + start, valueSpan.Start + i),
                        SeverityWarning,
                        UnknownIgnorablePrefixCode,
                        $"The namespace prefix '{prefix}' listed in mc:Ignorable is not declared."));
                }
            }
        }
    }

    // --- Structural uniqueness: duplicate x:Name / x:Key --------------------------------------------

    /// <summary>Reports duplicate x:Name/Name declarations within the same XAML name scope (WXAML0007, an error — the XAML compiler rejects it).</summary>
    private static void ValidateUniqueNames(
        XamlElement root,
        TextDocument doc,
        XamlTypeSystem typeSystem,
        List<Diagnostic> diagnostics)
    {
        if (typeSystem.Capabilities.FrameworkTemplate is null)
        {
            return;
        }

        foreach (var nameScope in XamlSemanticFacts.GetNameScopes(root, typeSystem))
        {
            var seen = new HashSet<string>(System.StringComparer.Ordinal);
            foreach (var (name, attribute) in nameScope)
            {
                if (!seen.Add(name))
                {
                    diagnostics.Add(Diag(
                        doc,
                        attribute.Value!.InnerSpan,
                        SeverityError,
                        DuplicateNameCode,
                        $"The name '{name}' already exists in the current name scope."));
                }
            }
        }
    }

    /// <summary>Reports duplicate x:Key declarations within the same ResourceDictionary (WXAML0008, an error).</summary>
    private static void ValidateUniqueResourceKeys(
        XamlElement root,
        TextDocument doc,
        XamlTypeSystem typeSystem,
        List<Diagnostic> diagnostics)
    {
        FindResourceScopes(root, doc, typeSystem, diagnostics);
    }

    /// <summary>Walks outside any dictionary looking for dictionary boundaries to validate as scopes.</summary>
    private static void FindResourceScopes(
        XamlElement element,
        TextDocument doc,
        XamlTypeSystem typeSystem,
        List<Diagnostic> diagnostics)
    {
        if (IsResourceScopeBoundary(element, typeSystem))
        {
            ProcessDictionaryScope(element, doc, typeSystem, diagnostics);
            return;
        }

        foreach (var child in element.Content)
        {
            if (child is XamlElement childElement)
            {
                FindResourceScopes(childElement, doc, typeSystem, diagnostics);
            }
        }
    }

    /// <summary>Collects the keys of a single dictionary's direct entry children into one scope; nested dictionaries (explicit, or under merged/theme property elements) recurse as separate scopes.</summary>
    private static void ProcessDictionaryScope(
        XamlElement boundary,
        TextDocument doc,
        XamlTypeSystem typeSystem,
        List<Diagnostic> diagnostics)
    {
        var scope = new HashSet<string>(System.StringComparer.Ordinal);
        foreach (var child in boundary.Content)
        {
            if (child is not XamlElement entry)
            {
                continue;
            }

            // A structural property element (MergedDictionaries/ThemeDictionaries) is not a keyed entry; its subtree holds nested dictionaries, each their own scope.
            if (entry.IsPropertyElement ||
                XamlSemanticFacts.ResolvePropertyElementMember(entry, typeSystem) is not null)
            {
                if (IsThemeDictionariesPropertyElement(entry, typeSystem))
                {
                    var themeKeys = new HashSet<string>(StringComparer.Ordinal);
                    foreach (var dictionary in entry.Content.OfType<XamlElement>())
                    {
                        if (TryGetResourceKey(
                                dictionary,
                                typeSystem,
                                out var themeKey,
                                out var themeKeySpan) &&
                            !themeKeys.Add(themeKey))
                        {
                            diagnostics.Add(Diag(
                                doc,
                                themeKeySpan,
                                SeverityError,
                                DuplicateKeyCode,
                                "An item with the same key has already been added."));
                        }

                        FindResourceScopes(dictionary, doc, typeSystem, diagnostics);
                    }
                }
                else
                {
                    FindResourceScopes(entry, doc, typeSystem, diagnostics);
                }
                continue;
            }

            // An explicit nested <ResourceDictionary>.
            if (IsResourceScopeBoundary(entry, typeSystem))
            {
                ProcessDictionaryScope(entry, doc, typeSystem, diagnostics);
                continue;
            }

            // A keyed resource entry: its x:Key must be unique within THIS dictionary. Both a plain string key and an {x:Type Foo} implicit-style key are tracked (in separate key-spaces).
            if (TryGetResourceKey(entry, typeSystem, out var canonicalKey, out var keySpan) &&
                !scope.Add(canonicalKey))
            {
                diagnostics.Add(Diag(doc, keySpan, SeverityError, DuplicateKeyCode,
                    "An item with the same key has already been added."));
            }

            // The entry's own subtree may nest further dictionaries (rare) — validate them independently.
            FindResourceScopes(entry, doc, typeSystem, diagnostics);
        }
    }

    private static bool IsThemeDictionariesPropertyElement(
        XamlElement element,
        XamlTypeSystem typeSystem)
    {
        var resolved = XamlSemanticFacts.ResolvePropertyElementMember(element, typeSystem);
        return resolved?.Owner is { } owner &&
            typeSystem.Capabilities.ResourceDictionary is { } resourceDictionary &&
            XamlTypeSystem.IsAssignableTo(owner, resourceDictionary) &&
            string.Equals(resolved.Value.MemberName, "ThemeDictionaries", StringComparison.Ordinal);
    }

    private static bool IsResourceScopeBoundary(XamlElement element, XamlTypeSystem typeSystem)
    {
        if (element.Name is not { } n)
        {
            return false;
        }

        // An explicit dictionary element.
        if (!n.IsDotted)
        {
            return XamlSemanticFacts.IsResourceDictionary(element, typeSystem);
        }

        return XamlSemanticFacts.IsResourceDictionaryPropertyElement(element, typeSystem);
    }

    /// <summary>Reads an entry's x:Key or resource x:Name as a canonical, scope-comparable key.</summary>
    private static bool TryGetResourceKey(
        XamlElement entry,
        XamlTypeSystem typeSystem,
        out string canonicalKey,
        out TextSpan keySpan)
    {
        canonicalKey = string.Empty;
        keySpan = default;

        if (XamlSemanticFacts.GetResourceKeyAttribute(entry)?.Value is not { } value)
        {
            return false;
        }

        // Plain string key: its literal text is the key (namespaced so it never aliases a type key).
        if (!value.IsMarkupExtension)
        {
            var text = value.Text?.Trim();
            if (string.IsNullOrEmpty(text))
            {
                return false;
            }

            canonicalKey = "s:" + text;
            keySpan = value.InnerSpan;
            return true;
        }

        // {x:Type Foo} implicit-style key: canonicalize by the (trimmed) type argument text so two {x:Type Foo} entries in the same dictionary are a duplicate, matching the XAML compiler.
        if (value.MarkupExtension is { IsClosed: true, Name: { } typeName } ext &&
            XamlSemanticFacts.IsXamlLanguageName(typeName, "Type", entry.NamespaceScope))
        {
            var typeArg = ext.Arguments.FirstOrDefault(
                a => !a.IsNamed && a.NestedExtension is null && a.Value is { Length: > 0 });
            var argText = typeArg?.Value?.Trim();
            if (!string.IsNullOrEmpty(argText))
            {
                var type = ResolveTypeName(argText, entry.NamespaceScope, typeSystem);
                canonicalKey = "t:" + (type?.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat) ?? argText);
                keySpan = typeArg!.ValueSpan ?? value.InnerSpan;
                return true;
            }
        }

        return false; // other markup-extension key forms — skip conservatively.
    }

    /// <summary>Reads a static (non-markup-extension, non-empty) directive value off an element, trying primary then optional fallback.</summary>
    private static bool TryGetStaticValue(
        XamlElement element, string primary, string? fallback,
        [NotNullWhen(true)] out XamlAttribute? attr, out string text)
    {
        attr = element.GetAttribute(primary) ?? (fallback is null ? null : element.GetAttribute(fallback));
        if (attr?.Value is { IsMarkupExtension: false } value)
        {
            var trimmed = value.Text?.Trim();
            if (!string.IsNullOrEmpty(trimmed))
            {
                text = trimmed!;
                return true;
            }
        }

        attr = null;
        text = string.Empty;
        return false;
    }
}
