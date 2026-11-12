using System.Collections.Generic;
using System.Linq;
using Microsoft.CodeAnalysis;
using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Workspace;
using WinUiXaml.Xaml;
using Diagnostic = WinUiXaml.LanguageServer.Lsp.Diagnostic;

namespace WinUiXaml.LanguageServer;

/// <summary>Structural validation: element construction, content, property assignment, and style/resource wiring.</summary>
internal static partial class XamlValidator
{
    private static void ValidateStructure(
        XamlElement root,
        TextDocument doc,
        XamlTypeSystem typeSystem,
        XamlSemanticFacts.ResourceScopeIndex resourceIndex,
        List<Diagnostic> diagnostics)
    {
        var pending = new Stack<XamlElement>();
        pending.Push(root);
        while (pending.TryPop(out var element))
        {
            // The compiler strips design-time elements together with their content.
            if (element.Name is { } elementName && IsIgnorableName(elementName, element))
            {
                continue;
            }

            foreach (var child in element.Content.OfType<XamlElement>())
            {
                pending.Push(child);
            }

            ValidateUnsupportedMarkupExtensions(element, doc, typeSystem, diagnostics);
            ValidateLoadRequiresName(element, typeSystem, doc, diagnostics);
            if (element.Name is not { IsDotted: false } ||
                ResolveElementType(element, typeSystem) is not { } elementType)
            {
                continue;
            }

            ValidateConstructible(element, elementType, root, doc, diagnostics);
            ValidateConflictingNames(element, elementType, typeSystem, doc, diagnostics);
            ValidateTextContent(element, elementType, typeSystem, doc, diagnostics);
            ValidateDuplicatePropertyAssignment(element, elementType, typeSystem, doc, diagnostics);
            ValidateStyleTargetTypeExists(element, typeSystem, doc, diagnostics);
            ValidateBasedOn(element, typeSystem, resourceIndex, doc, diagnostics);
        }
    }

    /// <summary>True for names in the design-time namespace; the compiler strips them.</summary>
    private static bool IsIgnorableName(XamlName name, XamlElement element) =>
        name.HasPrefix &&
        element.NamespaceScope.TryResolvePrefix(name.Prefix, out var uri) &&
        XamlNamespaces.IsDesignTime(uri);

    private static void ValidateUnsupportedMarkupExtensions(
        XamlElement element, TextDocument doc, XamlTypeSystem typeSystem, List<Diagnostic> diagnostics)
    {
        var scope = element.NamespaceScope;
        foreach (var attribute in element.Attributes)
        {
            if (attribute.Value is not { IsMarkupExtension: true } value ||
                IsIgnorableName(attribute.Name, element))
            {
                continue;
            }

            foreach (var extension in value.DescendantNodesAndSelf().OfType<XamlMarkupExtension>())
            {
                if (extension.Name is not { } name)
                {
                    continue;
                }

                bool unsupported =
                    (name.LocalName is "Static" or "Type" && XamlSemanticFacts.IsXamlLanguageName(name, name.LocalName, scope)) ||
                    (name.LocalName == "DynamicResource" &&
                     (scope.TryResolvePrefix(name.Prefix, out var uri) ? XamlSemanticFacts.IsPresentationNamespace(uri) : !name.HasPrefix) &&
                     XamlSemanticFacts.ResolveMarkupExtensionType(name.FullName, scope, typeSystem) is null);
                if (unsupported)
                {
                    var replacement = name.LocalName switch
                    {
                        "DynamicResource" => " Use ThemeResource or StaticResource instead.",
                        "Type" => " Use the type name directly instead.",
                        _ => string.Empty,
                    };
                    diagnostics.Add(Diag(doc, name.Span, SeverityError, UnsupportedMarkupExtensionCode,
                        $"The markup extension '{name.FullName}' is not supported by WinUI XAML.{replacement}"));
                }
            }
        }
    }

    private static void ValidateLoadRequiresName(
        XamlElement element, XamlTypeSystem typeSystem, TextDocument doc, List<Diagnostic> diagnostics)
    {
        var load = XamlSemanticFacts.GetDirectiveAttribute(element, "Load") ??
            XamlSemanticFacts.GetDirectiveAttribute(element, "DeferLoadStrategy");
        if (load is not null && XamlSemanticFacts.GetNameAttribute(element) is null)
        {
            diagnostics.Add(Diag(doc, load.Name.Span, SeverityError, LoadRequiresNameCode,
                $"'{load.Name.FullName}' requires the element to have an x:Name."));
        }
    }

    private static void ValidateConstructible(
        XamlElement element, INamedTypeSymbol elementType, XamlElement root,
        TextDocument doc, List<Diagnostic> diagnostics)
    {
        // The root of an x:Class document instantiates the code-behind class, not the root type.
        if (ReferenceEquals(element, root) && XamlSemanticFacts.GetDirectiveAttribute(root, "Class") is not null)
        {
            return;
        }

        if (!XamlTypeSystem.IsXamlConstructible(elementType))
        {
            diagnostics.Add(Diag(doc, element.Name!.LocalNameSpan, SeverityError, NonConstructibleElementCode,
                $"'{elementType.Name}' cannot be created in XAML because it is abstract or has no parameterless constructor."));
        }
    }

    private static void ValidateConflictingNames(
        XamlElement element, INamedTypeSymbol elementType, XamlTypeSystem typeSystem,
        TextDocument doc, List<Diagnostic> diagnostics)
    {
        // Name aliases x:Name only on FrameworkElement; elsewhere it is an ordinary property.
        if (typeSystem.Capabilities.FrameworkElement is { } frameworkElement &&
            XamlTypeSystem.IsAssignableTo(elementType, frameworkElement) &&
            XamlSemanticFacts.GetDirectiveAttribute(element, "Name") is not null &&
            element.Attributes.FirstOrDefault(attribute =>
                !attribute.IsNamespaceDeclaration &&
                !attribute.Name.HasPrefix &&
                attribute.Name.LocalName == "Name") is { } plainName)
        {
            diagnostics.Add(Diag(doc, plainName.Name.Span, SeverityError, ConflictingNameCode,
                "An element cannot set both x:Name and Name."));
        }
    }

    private static void ValidateTextContent(
        XamlElement element, INamedTypeSymbol elementType, XamlTypeSystem typeSystem,
        TextDocument doc, List<Diagnostic> diagnostics)
    {
        var text = element.Content.FirstOrDefault(node =>
            node is XamlText { IsWhitespace: false } || node is XamlCData);
        if (text is null ||
            typeSystem.Capabilities.UIElement is not { } uiElement ||
            !XamlTypeSystem.IsAssignableTo(elementType, uiElement))
        {
            return;
        }

        // Only UIElement content provably rejects text; the compiler special-cases some types without a content property.
        if (typeSystem.GetContentPropertyType(elementType) is { } contentType &&
            XamlTypeSystem.IsAssignableTo(contentType, uiElement))
        {
            diagnostics.Add(Diag(doc, text.Span, SeverityError, InvalidTextContentCode,
                $"'{elementType.Name}' does not accept text content."));
        }
    }

    private static void ValidateDuplicatePropertyAssignment(
        XamlElement element, INamedTypeSymbol elementType, XamlTypeSystem typeSystem,
        TextDocument doc, List<Diagnostic> diagnostics)
    {
        var assigned = new HashSet<string>(System.StringComparer.Ordinal);
        foreach (var attribute in element.Attributes)
        {
            if (!attribute.IsNamespaceDeclaration && !attribute.Name.HasPrefix && !attribute.Name.IsDotted)
            {
                assigned.Add(attribute.Name.LocalName);
            }
        }

        foreach (var child in element.Content.OfType<XamlElement>().Where(child => child.IsPropertyElement))
        {
            var member = XamlSemanticFacts.ResolvePropertyElementMember(child, typeSystem);
            if (member is not { Owner: { } owner, PropertyType: not null, IsAttached: false } ||
                !XamlTypeSystem.IsAssignableTo(elementType, owner))
            {
                continue;
            }

            if (!assigned.Add(member.Value.MemberName))
            {
                diagnostics.Add(Diag(doc, child.Name!.Span, SeverityError, DuplicatePropertyAssignmentCode,
                    $"The property '{member.Value.MemberName}' is set more than once."));
            }
        }

        if (typeSystem.GetContentPropertyName(elementType) is { } contentName &&
            assigned.Contains(contentName) &&
            element.Content.FirstOrDefault(node =>
                (node is XamlElement { IsPropertyElement: false, Name: { } childName } child &&
                 !IsIgnorableName(childName, child)) ||
                node is XamlText { IsWhitespace: false }) is { } content)
        {
            diagnostics.Add(Diag(doc, content is XamlElement { Name: { } contentElementName } ? contentElementName.Span : content.Span,
                SeverityError, DuplicatePropertyAssignmentCode,
                $"The property '{contentName}' is set more than once."));
        }
    }

    private static void ValidateStyleTargetTypeExists(
        XamlElement element, XamlTypeSystem typeSystem, TextDocument doc, List<Diagnostic> diagnostics)
    {
        if (!IsStyleOrTemplate(element, typeSystem) ||
            element.GetAttribute("TargetType")?.Value is not { IsMarkupExtension: false } value ||
            value.Text.Trim() is not { Length: > 0 } text ||
            ResolveTypeName(text, element.NamespaceScope, typeSystem) is not null)
        {
            return;
        }

        int colon = text.IndexOf(':');
        var prefix = colon < 0 ? string.Empty : text[..colon];
        var localName = colon < 0 ? text : text[(colon + 1)..];
        if (element.NamespaceScope.TryResolvePrefix(prefix, out var uri) &&
            uri != XamlTypeSystem.XamlLanguageNamespace &&
            typeSystem.IsKnownNamespace(uri))
        {
            diagnostics.Add(Diag(doc, value.InnerSpan, SeverityError, UnknownTypeCode,
                $"The TargetType '{text}' was not found in the XAML namespace '{uri}'.",
                SuggestData(localName, typeSystem.GetAllTypes(uri).Select(type => type.Name))));
        }
    }

    private static bool IsStyleOrTemplate(XamlElement element, XamlTypeSystem typeSystem) =>
        XamlSemanticFacts.IsElement(element, typeSystem.Capabilities.Style, typeSystem, allowDerived: true) ||
        XamlSemanticFacts.IsElement(element, typeSystem.Capabilities.ControlTemplate, typeSystem, allowDerived: true);

    private static void ValidateBasedOn(
        XamlElement style, XamlTypeSystem typeSystem, XamlSemanticFacts.ResourceScopeIndex resourceIndex,
        TextDocument doc, List<Diagnostic> diagnostics)
    {
        if (!XamlSemanticFacts.IsElement(style, typeSystem.Capabilities.Style, typeSystem, allowDerived: true) ||
            TryGetBasedOnReference(style, resourceIndex, typeSystem) is not { } reference)
        {
            return;
        }

        var (key, span, target) = reference;
        if (ReferenceEquals(target, style))
        {
            diagnostics.Add(Diag(doc, span, SeverityError, InvalidBasedOnCode,
                $"The style '{key}' cannot be based on itself."));
            return;
        }

        var visited = new HashSet<XamlElement> { style };
        for (var current = target; current is not null && visited.Add(current);)
        {
            current = TryGetBasedOnReference(current, resourceIndex, typeSystem)?.Target;
            if (ReferenceEquals(current, style))
            {
                diagnostics.Add(Diag(doc, span, SeverityError, InvalidBasedOnCode,
                    $"The BasedOn chain through '{key}' is circular."));
                return;
            }
        }

        if (XamlSemanticFacts.ResolveStyleTargetType(style, style.NamespaceScope, typeSystem) is { } derivedTarget &&
            XamlSemanticFacts.ResolveStyleTargetType(target, target.NamespaceScope, typeSystem) is { } baseTarget &&
            !XamlTypeSystem.IsAssignableTo(derivedTarget, baseTarget))
        {
            diagnostics.Add(Diag(doc, span, SeverityError, InvalidBasedOnCode,
                $"The TargetType '{derivedTarget.Name}' is not compatible with the BasedOn style TargetType '{baseTarget.Name}'."));
        }
    }

    private static (string Key, TextSpan Span, XamlElement Target)? TryGetBasedOnReference(
        XamlElement style, XamlSemanticFacts.ResourceScopeIndex resourceIndex, XamlTypeSystem typeSystem)
    {
        if (style.GetAttribute("BasedOn")?.Value?.MarkupExtension is not { IsClosed: true } extension ||
            extension.Name?.LocalName != "StaticResource" ||
            !XamlSemanticFacts.IsResourceReferenceExtension(extension, style.NamespaceScope) ||
            extension.Arguments.FirstOrDefault(argument => !argument.IsNamed && argument.Value is { Length: > 0 })
                is not { Value: { } key, ValueSpan: { } span })
        {
            return null;
        }

        var target = resourceIndex.FindDeclaration(style, key, extension.Span.Start, allowForwardReference: true);
        return target is null ? null : (key, span, target);
    }

    private static void ValidateResourceValueType(
        INamedTypeSymbol? elementType, XamlAttribute attribute, XamlMarkupExtension extension,
        string key, TextSpan keySpan, XamlElement declaration,
        TextDocument doc, XamlTypeSystem typeSystem, List<Diagnostic> diagnostics)
    {
        if (elementType is null ||
            attribute.Name.HasPrefix ||
            attribute.Name.IsDotted ||
            extension.Name?.LocalName != "StaticResource" ||
            !ReferenceEquals(attribute.Value?.MarkupExtension, extension) ||
            typeSystem.FindAttributeMember(elementType, attribute.Name.LocalName) is not
                { Kind: XamlMemberKind.Property, Type: { } propertyType } ||
            ResolveElementType(declaration, typeSystem) is not { } resourceType ||
            typeSystem.IsMarkupExtensionType(resourceType))
        {
            return;
        }

        // Primitive values go through WinUI's runtime value conversion (a Double becomes a Thickness or GridLength).
        var target = XamlValueConverter.UnwrapNullable(propertyType);
        if (resourceType.SpecialType != SpecialType.None ||
            target.SpecialType == SpecialType.System_String ||
            XamlTypeSystem.IsAssignableTo(resourceType, target) ||
            typeSystem.HasImplicitConversion(resourceType, target))
        {
            return;
        }

        diagnostics.Add(Diag(doc, keySpan, SeverityError, InvalidResourceTypeCode,
            $"The resource '{key}' of type '{resourceType.Name}' cannot be assigned to '{attribute.Name.LocalName}' ({target.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)})."));
    }

    private static void ValidateBindTargetMember(
        XamlAttribute attribute, INamedTypeSymbol? elementType, INamedTypeSymbol bindRoot,
        INamedTypeSymbol? pageClass, XamlNamespaceScope scope, XamlTypeSystem typeSystem,
        TextDocument doc, List<Diagnostic> diagnostics)
    {
        // Any non-event attribute can host the property-only checks; event attributes bind methods legitimately.
        if (elementType is null ||
            attribute.Name.HasPrefix ||
            typeSystem.FindAttributeMember(elementType, attribute.Name.LocalName) is { Kind: XamlMemberKind.Event } ||
            attribute.Value?.MarkupExtension is not { IsClosed: true } extension ||
            !XamlSemanticFacts.IsXBind(extension, scope) ||
            extension.Arguments.FirstOrDefault(argument =>
                (!argument.IsNamed || argument.Name?.LocalName == "Path") &&
                argument.NestedExtension is null && argument.Value is not null)
                is not { Value: { } path, ValueSpan: { } span } ||
            path.IndexOfAny(['(', ')', '[', '!']) >= 0 ||
            ResolveBindPathSymbol(path, attribute, bindRoot, pageClass, scope, typeSystem, doc) is not { } symbol)
        {
            return;
        }

        if (symbol is IMethodSymbol)
        {
            diagnostics.Add(Diag(doc, span, SeverityError, BindMethodWithoutCallCode,
                $"'{symbol.Name}' is a method. Call it with parentheses to bind its result."));
            return;
        }

        bool twoWay = extension.Arguments.Any(argument =>
            argument.IsNamed && argument.Name?.LocalName == "Mode" &&
            string.Equals(argument.Value?.Trim(), "TwoWay", System.StringComparison.Ordinal));
        bool hasBindBack = extension.Arguments.Any(argument =>
            argument.IsNamed && argument.Name?.LocalName == "BindBack");
        bool writable = symbol switch
        {
            IPropertySymbol { SetMethod: { } setter } =>
                setter.DeclaredAccessibility == Accessibility.Public ||
                (pageClass is not null && typeSystem.IsSymbolAccessibleWithin(setter, pageClass)),
            IFieldSymbol field => !field.IsReadOnly && !field.IsConst,
            _ => false,
        };
        if (twoWay && !hasBindBack && !writable)
        {
            diagnostics.Add(Diag(doc, span, SeverityError, ReadOnlyTwoWayBindCode,
                $"'{symbol.Name}' is read-only and cannot be the source of a TwoWay x:Bind."));
        }
    }

    /// <summary>Resolves the final member of a plain dotted x:Bind path, or null when any step is uncertain.</summary>
    private static ISymbol? ResolveBindPathSymbol(
        string path, XamlAttribute attribute, INamedTypeSymbol bindRoot, INamedTypeSymbol? pageClass,
        XamlNamespaceScope scope, XamlTypeSystem typeSystem, TextDocument doc)
    {
        path = path.Trim();
        if (path.Length == 0)
        {
            return null;
        }

        ITypeSymbol? current;
        ISymbol? symbol = null;
        string[] segments;
        if (TryGetStaticBindRoot(path, scope, typeSystem, out var staticType, out var chain, out _))
        {
            segments = chain.Split('.');
            symbol = typeSystem.GetBindableStaticMembers(staticType, pageClass)
                .FirstOrDefault(member => member.Name == segments[0].Trim());
            current = symbol is null or IMethodSymbol ? null : GetSymbolType(symbol);
        }
        else
        {
            segments = path.Split('.');
            var first = segments[0].Trim();
            symbol = typeSystem.GetBindableMembers(
                    bindRoot,
                    includeRootNonPublic: SymbolEqualityComparer.Default.Equals(bindRoot, pageClass),
                    accessWithin: pageClass)
                .FirstOrDefault(member => member.Name == first);
            current = symbol is null
                ? XamlSemanticFacts.ResolveNamedElementTypeInScope(doc, attribute.Parent, first, typeSystem)
                : symbol is IMethodSymbol ? null : GetSymbolType(symbol);
        }

        for (int i = 1; i < segments.Length; i++)
        {
            if (current is null)
            {
                return null;
            }

            var name = segments[i].Trim();
            symbol = typeSystem.GetBindableMembers(current, false, pageClass)
                .FirstOrDefault(member => member.Name == name);
            current = symbol is null or IMethodSymbol ? null : GetSymbolType(symbol);
        }

        return symbol;
    }
}
