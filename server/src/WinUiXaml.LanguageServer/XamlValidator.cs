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

    /// <summary>A type not found in a known namespace — heuristic, so reported as a warning.</summary>
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

    private const int SeverityError = 1;
    private const int SeverityWarning = 2;
    private static readonly HashSet<string> ReservedPrefixes = new(System.StringComparer.Ordinal)
    {
        "xml", "xmlns",
    };

    public static List<Diagnostic> Validate(
        TextDocument doc,
        XamlTypeSystem typeSystem,
        IReadOnlyCollection<string>? projectResourceKeys = null)
    {
        var diagnostics = new List<Diagnostic>();
        if (doc.Parsed.Root is { } root)
        {
            var resourceKeys = new HashSet<string>(System.StringComparer.Ordinal);
            foreach (var key in CompletionProvider.CollectResourceKeys(doc.Parsed))
            {
                resourceKeys.Add(key);
            }

            if (projectResourceKeys is not null)
            {
                foreach (var key in projectResourceKeys)
                {
                    resourceKeys.Add(key);
                }
            }

            // Unresolved binding roots remain silent to avoid false positives.
            var pageClass = ResolvePageClass(root, typeSystem);
            ValidateRootClass(root, pageClass, typeSystem, doc, diagnostics);
            Walk(root, doc, typeSystem, diagnostics, pageClass, pageClass, resourceKeys, styleTargetType: null, dataTemplateNeedsDataType: false);

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
        INamedTypeSymbol? styleTargetType,
        bool dataTemplateNeedsDataType)
    {
        var elementType = ResolveElementType(element, typeSystem);

        // A template creates a new binding root. It must not inherit the page's x:Bind root.
        var effectiveRoot = bindRoot;
        var effectiveTemplateNeedsDataType = dataTemplateNeedsDataType;
        if (elementType is not null &&
            typeSystem.Capabilities.DataTemplate is { } dataTemplate &&
            XamlTypeSystem.IsAssignableTo(elementType, dataTemplate))
        {
            effectiveRoot = null;
            effectiveTemplateNeedsDataType = !TryGetDirectiveValue(element, "DataType", out _);
        }

        // An unresolved x:DataType disables binding checks for its subtree.
        if (TryGetDirectiveValue(element, "DataType", out var dataTypeText))
        {
            effectiveRoot = ResolveTypeName(dataTypeText, element.NamespaceScope, typeSystem);
            effectiveTemplateNeedsDataType = false;
        }

        var effectiveStyleTarget = styleTargetType;
        if (elementType is not null &&
            typeSystem.Capabilities.Style is { } styleType &&
            XamlTypeSystem.IsAssignableTo(elementType, styleType))
        {
            effectiveStyleTarget = TryResolveTypeAttribute(element, "TargetType", typeSystem);
        }

        ValidateElement(element, doc, typeSystem, diagnostics, effectiveRoot, pageClass, effectiveStyleTarget, effectiveTemplateNeedsDataType);
        ValidateResourceReferences(element, doc, diagnostics, resourceKeys);

        foreach (var child in element.Content)
        {
            if (child is XamlElement childElement)
            {
                Walk(childElement, doc, typeSystem, diagnostics, effectiveRoot, pageClass, resourceKeys, effectiveStyleTarget, effectiveTemplateNeedsDataType);
            }
        }
    }

    private static void ValidateResourceReferences(
        XamlElement element,
        TextDocument doc,
        List<Diagnostic> diagnostics,
        IReadOnlySet<string> resourceKeys)
    {
        if (resourceKeys.Count == 0)
        {
            return;
        }

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
                    argument.ValueSpan is not { } keySpan ||
                    resourceKeys.Contains(key))
                {
                    continue;
                }

                var suggestion = SuggestData(key, resourceKeys);
                if (suggestion is null)
                {
                    // Referenced assemblies can contribute resources that are not visible in the
                    // project or SDK catalogs. Only diagnose high-confidence spelling mistakes.
                    continue;
                }

                diagnostics.Add(Diag(
                    doc,
                    keySpan,
                    SeverityError,
                    UnknownResourceKeyCode,
                    $"The resource '{key}' was not found.",
                    suggestion));
            }
        }
    }

    private static void ValidateElement(
        XamlElement element, TextDocument doc, XamlTypeSystem typeSystem, List<Diagnostic> diagnostics,
        INamedTypeSymbol? bindRoot, INamedTypeSymbol? pageClass, INamedTypeSymbol? styleTargetType,
        bool dataTemplateNeedsDataType)
    {
        var scope = element.NamespaceScope;
        ValidateDuplicateAttributes(element, doc, diagnostics);

        foreach (var attribute in element.Attributes)
        {
            ValidateBindMode(attribute, scope, typeSystem, doc, diagnostics);
            if (dataTemplateNeedsDataType && XamlSemanticFacts.IsXBind(attribute, scope))
            {
                diagnostics.Add(Diag(doc, attribute.Value!.InnerSpan, SeverityError, DataTemplateDataTypeRequiredCode,
                    "x:Bind inside a DataTemplate requires x:DataType."));
            }
            if (bindRoot is not null)
            {
                ValidateBindPath(attribute, bindRoot, scope, typeSystem, doc, diagnostics);
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
                $"The namespace prefix '{name.Prefix}' is not declared."));
            return;
        }

        // Out of scope: the x: language namespace (built-in primitives) and any namespace the type system cannot model (design-time, third-party). A property element carries no prefix, so it resolves through the default namespace like any other element here.
        if (!scope.TryResolvePrefix(name.Prefix, out var uri) ||
            uri == XamlTypeSystem.XamlLanguageNamespace ||
            !typeSystem.IsKnownNamespace(uri))
        {
            return;
        }

        // A property element (<Grid.RowDefinitions>) names a member of an owner type, not an element type, so it has no element-type/attribute surface — validate the member against the owner and stop.
        if (name.IsDotted)
        {
            ValidatePropertyElement(element, name, uri, typeSystem, doc, diagnostics);
            return;
        }

        var elementType = typeSystem.ResolveType(uri, name.LocalName);
        if (elementType is null)
        {
            diagnostics.Add(Diag(doc, name.LocalNameSpan, SeverityWarning, UnknownTypeCode,
                $"The type '{name.LocalName}' was not found in the XAML namespace '{uri}'.",
                SuggestData(name.LocalName, typeSystem.GetAllTypes(uri).Select(t => t.Name))));
            return;
        }

        // The element type is known — verify its simple attributes name real members.
        foreach (var attribute in element.Attributes)
        {
            ValidateAttributeMember(attribute, elementType, scope, typeSystem, doc, diagnostics, pageClass);
        }

        ValidateNameGrammar(element, elementType, scope, typeSystem, doc, diagnostics);
        ValidateScalarContent(element, elementType, typeSystem, doc, diagnostics);
        ValidateSetterProperty(element, elementType, styleTargetType, typeSystem, doc, diagnostics);
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
            ValidateAttachedProperty(attribute, scope, typeSystem, doc, diagnostics);
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
                 eventValue.Text.Trim() is { Length: > 0 } handler &&
                 !HasMethod(pageClass, handler))
        {
            diagnostics.Add(Diag(doc, eventValue.InnerSpan, SeverityError, MissingEventHandlerCode,
                $"The event handler '{handler}' was not found on '{pageClass.Name}' or its base types."));
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
            $"'{value.Text}' is not a valid value for '{attribute.Name.FullName}' ({targetType.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)})."));
    }

    /// <summary>Validates an Owner.Member attached-property attribute: resolves the owner type through the attribute's namespace and checks it actually exposes the member.</summary>
    private static void ValidateAttachedProperty(
        XamlAttribute attribute,
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
            return; // unknown owner: stay silent
        }

        var memberType = typeSystem.GetAttachedMemberType(owner, memberName);
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
            diagnostics.Add(Diag(doc, ownerSpan, SeverityWarning, UnknownTypeCode,
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

    private static bool HasMethod(INamedTypeSymbol type, string methodName)
    {
        for (INamedTypeSymbol? current = type; current is not null; current = current.BaseType)
        {
            if (current.GetMembers(methodName).OfType<IMethodSymbol>().Any())
            {
                return true;
            }
        }

        return false;
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
            if (childType is not null && !XamlTypeSystem.IsAssignableTo(childType, expectedType))
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
                $"The namespace prefix '{name.Prefix}' is not declared."));
        }
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

        if (ValidateLeadingAttachedBindPath(path, valueSpan, scope, typeSystem, doc, diagnostics))
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
                    skipFirst: false, typeSystem, doc, diagnostics);
            }

            return; // a cast path is fully handled here (reported or safely skipped) — never falls through.
        }

        if (!TryFirstBindSegment(path, out var segment))
        {
            return;
        }

        if (typeSystem.GetBindableMembers(bindRoot, includeRootNonPublic: true)
            .Any(m => string.Equals(m.Name, segment, System.StringComparison.Ordinal)))
        {
            // The first segment is valid — validate any remaining dotted segments too, so a bad non-first member (GreetingText.Nope, Items[0].Nope) is caught rather than silently accepted.
            ValidateBindPathTail(path, valueSpan, bindRoot, typeSystem, doc, diagnostics);

            // For a function binding (Method(arg, arg)) each argument is itself a path bound against the root, so a bogus argument member is flagged the same as a bogus root path.
            ValidateBindFunctionArgs(path, valueSpan, bindRoot, typeSystem, doc, diagnostics);
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
                typeSystem,
                doc,
                diagnostics);
            return;
        }

        diagnostics.Add(Diag(doc, valueSpan, SeverityWarning, UnknownBindMemberCode,
            $"'{segment}' is not a member of '{bindRoot.Name}' bound by x:Bind.",
            SuggestData(segment, typeSystem.GetBindableMembers(bindRoot, includeRootNonPublic: true).Select(m => m.Name))));
    }

    /// <summary>Validates a leading attached-property binding step.</summary>
    private static bool ValidateLeadingAttachedBindPath(
        string path,
        TextSpan valueSpan,
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

        ValidateMemberChain(bindRoot, segments, start, valueSpan, skipFirst: true, typeSystem, doc, diagnostics);
    }

    private static void ValidateNamedElementBindPathTail(
        string path,
        TextSpan valueSpan,
        INamedTypeSymbol namedElementType,
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

            var member = typeSystem.GetBindableMembers(current, includeRootNonPublic: atRoot)
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
                diagnostics.Add(Diag(doc, badSpan, SeverityWarning, UnknownBindMemberCode,
                    $"'{baseName}' is not a member of '{current.Name}' bound by x:Bind.",
                    SuggestData(baseName, typeSystem.GetBindableMembers(current, includeRootNonPublic: atRoot).Select(m => m.Name))));
                return;
            }

            var next = CompletionProvider.ResolveBindSegmentType(typeSystem, current, seg, atRoot);
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
        XamlTypeSystem typeSystem,
        TextDocument doc,
        List<Diagnostic> diagnostics)
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
        ITypeSymbol receiverType = bindRoot;
        bool includeReceiverNonPublic = true;
        int receiverSeparator = functionPath.LastIndexOf('.');
        if (receiverSeparator >= 0)
        {
            var receiverSegments = functionPath.Substring(0, receiverSeparator).Split('.');
            ValidateMemberChain(
                bindRoot,
                receiverSegments,
                start,
                valueSpan,
                skipFirst: false,
                typeSystem,
                doc,
                diagnostics);
            foreach (var receiverSegment in receiverSegments)
            {
                var next = CompletionProvider.ResolveBindSegmentType(
                    typeSystem,
                    receiverType,
                    receiverSegment,
                    includeReceiverNonPublic);
                if (next is null)
                {
                    return;
                }

                receiverType = next;
                includeReceiverNonPublic = false;
            }

            functionName = functionPath.Substring(receiverSeparator + 1);
        }

        var overloads = typeSystem.GetBindableMethods(receiverType, includeReceiverNonPublic)
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
                path, argumentStart, argumentEnd, valueSpan, bindRoot, typeSystem, doc, diagnostics);
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

            var member = typeSystem.GetBindableMembers(current, includeRootNonPublic: atRoot)
                .FirstOrDefault(m => string.Equals(m.Name, baseName, System.StringComparison.Ordinal));
            if (member is null)
            {
                int badStart = argAbsStart + segStart;
                int badEnd = badStart + baseName.Length;
                var badSpan = badEnd <= valueSpan.End ? new TextSpan(badStart, badEnd) : valueSpan;
                diagnostics.Add(Diag(doc, badSpan, SeverityWarning, UnknownBindMemberCode,
                    $"'{baseName}' is not a member of '{current.Name}' bound by x:Bind.",
                    SuggestData(baseName, typeSystem.GetBindableMembers(current, includeRootNonPublic: atRoot).Select(m => m.Name))));
                return;
            }

            var next = CompletionProvider.ResolveBindSegmentType(typeSystem, current, seg, atRoot);
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

    /// <summary>Reads an entry's x:Key as a canonical, scope-comparable key.</summary>
    private static bool TryGetResourceKey(
        XamlElement entry,
        XamlTypeSystem typeSystem,
        out string canonicalKey,
        out TextSpan keySpan)
    {
        canonicalKey = string.Empty;
        keySpan = default;

        if (XamlSemanticFacts.GetKeyAttribute(entry)?.Value is not { } value)
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
