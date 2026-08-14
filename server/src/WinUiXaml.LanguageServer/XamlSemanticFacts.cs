using System;
using System.Linq;
using Microsoft.CodeAnalysis;
using WinUiXaml.Workspace;
using WinUiXaml.Xaml;

namespace WinUiXaml.LanguageServer;

/// <summary>Shared SDK-backed semantic classification used by all language-server features.</summary>
internal static class XamlSemanticFacts
{
    internal static INamedTypeSymbol? ResolveElementType(
        XamlElement element,
        XamlTypeSystem typeSystem) =>
        element.Name is { } name
            ? ResolveType(name.Prefix, name.LocalName, element.NamespaceScope, typeSystem)
            : null;

    internal static bool IsElement(
        XamlElement element,
        INamedTypeSymbol? frameworkType,
        XamlTypeSystem typeSystem,
        bool allowDerived = false)
    {
        if (frameworkType is null || ResolveElementType(element, typeSystem) is not { } elementType)
        {
            return false;
        }

        if (SymbolEqualityComparer.Default.Equals(elementType, frameworkType))
        {
            return true;
        }

        if (!allowDerived)
        {
            return false;
        }

        for (var current = elementType.BaseType; current is not null; current = current.BaseType)
        {
            if (SymbolEqualityComparer.Default.Equals(current, frameworkType))
            {
                return true;
            }
        }

        return false;
    }

    internal static bool IsSetter(XamlElement element, XamlTypeSystem typeSystem) =>
        IsElement(element, typeSystem.Capabilities.Setter, typeSystem);

    internal static bool IsDataTemplate(XamlElement element, XamlTypeSystem typeSystem) =>
        IsElement(element, typeSystem.Capabilities.DataTemplate, typeSystem);

    internal static bool IsStyleOrControlTemplate(XamlElement element, XamlTypeSystem typeSystem) =>
        IsElement(element, typeSystem.Capabilities.Style, typeSystem) ||
        IsElement(element, typeSystem.Capabilities.ControlTemplate, typeSystem);

    internal static bool IsStoryboardAttachedProperty(
        string attributeName,
        string memberName,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem)
    {
        int dot = attributeName.IndexOf('.');
        if (dot <= 0 || dot == attributeName.Length - 1 ||
            !string.Equals(attributeName.Substring(dot + 1), memberName, StringComparison.Ordinal))
        {
            return false;
        }

        SplitQualified(attributeName.Substring(0, dot), out var prefix, out var ownerName);
        var owner = ResolveType(prefix, ownerName, scope, typeSystem);
        var storyboard = typeSystem.Capabilities.Storyboard;
        return owner is not null &&
            storyboard is not null &&
            SymbolEqualityComparer.Default.Equals(owner, storyboard) &&
            typeSystem.GetAttachedProperties(owner)
                .Any(property => string.Equals(property.Name, memberName, StringComparison.Ordinal));
    }

    internal static bool IsColorAttribute(XamlAttribute attribute, XamlTypeSystem typeSystem)
    {
        if (attribute.Parent is not XamlElement element ||
            (IsSetter(element, typeSystem) &&
             !attribute.Name.HasPrefix &&
             string.Equals(attribute.Name.LocalName, "Value", StringComparison.Ordinal)
                ? ResolveSetterValueType(element, element.NamespaceScope, typeSystem)
                : ResolveAttributeType(attribute, element, typeSystem)) is not { } attributeType)
        {
            return false;
        }

        return typeSystem.Capabilities.Color is { } color &&
                SymbolEqualityComparer.Default.Equals(attributeType, color) ||
            typeSystem.Capabilities.Brush is { } brush &&
                XamlTypeSystem.IsAssignableTo(attributeType, brush);
    }

    internal static bool IsRelativePanelElementReferenceAttribute(
        string attributeName,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem)
    {
        int dot = attributeName.IndexOf('.');
        if (dot <= 0 || dot == attributeName.Length - 1)
        {
            return false;
        }

        SplitQualified(attributeName.Substring(0, dot), out var prefix, out var ownerName);
        var owner = ResolveType(prefix, ownerName, scope, typeSystem);
        return owner is not null &&
            typeSystem.IsRelativePanelElementReference(owner, attributeName.Substring(dot + 1));
    }

    internal static INamedTypeSymbol? ResolveType(
        XamlName name,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem,
        bool usePresentationNamespaceForUnprefixed = false) =>
        ResolveType(
            name.Prefix,
            name.LocalName,
            scope,
            typeSystem,
            usePresentationNamespaceForUnprefixed);

    internal static INamedTypeSymbol? ResolveStyleTargetType(
        XamlNode? start,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem)
    {
        for (var node = start; node is not null; node = node.Parent)
        {
            if (node is not XamlElement element || !IsStyleOrControlTemplate(element, typeSystem))
            {
                continue;
            }

            var text = element.Attributes.FirstOrDefault(
                attribute => !attribute.Name.HasPrefix &&
                    string.Equals(attribute.Name.LocalName, "TargetType", StringComparison.Ordinal))
                ?.Value?.Text;
            var typeToken = NormalizeTypeToken(text);
            if (typeToken is null)
            {
                return null;
            }

            SplitQualified(typeToken, out var prefix, out var localName);
            return ResolveType(prefix, localName, element.NamespaceScope, typeSystem);
        }

        return null;
    }

    internal static ITypeSymbol? ResolveSetterValueType(
        XamlElement setter,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem)
    {
        var propertyName = setter.Attributes.FirstOrDefault(
            attribute => !attribute.Name.HasPrefix &&
                string.Equals(attribute.Name.LocalName, "Property", StringComparison.Ordinal))
            ?.Value?.Text?.Trim();
        if (string.IsNullOrEmpty(propertyName))
        {
            return null;
        }

        int dot = propertyName!.IndexOf('.');
        if (dot > 0)
        {
            SplitQualified(propertyName.Substring(0, dot), out var prefix, out var ownerName);
            var owner = ResolveType(prefix, ownerName, scope, typeSystem);
            return owner is null
                ? null
                : typeSystem.GetAttachedProperties(owner)
                    .FirstOrDefault(member =>
                        string.Equals(member.Name, propertyName.Substring(dot + 1), StringComparison.Ordinal))
                    ?.Type;
        }

        var targetType = ResolveStyleTargetType(setter, scope, typeSystem);
        return targetType is null ? null : typeSystem.FindMember(targetType, propertyName)?.Type;
    }

    internal static INamedTypeSymbol? ResolveMarkupExtensionType(
        string? extensionName,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem)
    {
        if (string.IsNullOrEmpty(extensionName))
        {
            return null;
        }

        SplitQualified(extensionName!, out var prefix, out var localName);
        if (scope.TryResolvePrefix(prefix, out var namespaceUri))
        {
            var exactType = typeSystem.ResolveType(namespaceUri, localName);
            if (typeSystem.IsMarkupExtensionType(exactType))
            {
                return exactType;
            }

            var suffixedType = typeSystem.ResolveType(namespaceUri, localName + "Extension");
            if (typeSystem.IsMarkupExtensionType(suffixedType))
            {
                return suffixedType;
            }

            if (!string.Equals(
                    namespaceUri,
                    XamlTypeSystem.PresentationNamespace,
                    StringComparison.Ordinal))
            {
                return null;
            }
        }
        else if (prefix.Length > 0)
        {
            return null;
        }

        return localName switch
        {
            "RelativeSource" => typeSystem.Capabilities.RelativeSource,
            "Binding" => typeSystem.Capabilities.Binding,
            _ => null,
        };
    }

    internal static INamedTypeSymbol? ResolveTypeName(
        string text,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem,
        bool usePresentationNamespaceForUnprefixed = false)
    {
        SplitQualified(text, out var prefix, out var localName);
        return ResolveType(
            prefix,
            localName,
            scope,
            typeSystem,
            usePresentationNamespaceForUnprefixed);
    }

    private static INamedTypeSymbol? ResolveType(
        string? prefix,
        string localName,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem,
        bool usePresentationNamespaceForUnprefixed = true)
    {
        var normalizedPrefix = prefix ?? string.Empty;
        if (scope.TryResolvePrefix(normalizedPrefix, out var uri))
        {
            return typeSystem.ResolveType(uri, localName);
        }

        // Editor probes and incomplete fragments commonly omit the root xmlns while being typed.
        // Unprefixed names still belong to WinUI's presentation namespace; prefixed names remain strict.
        return usePresentationNamespaceForUnprefixed && normalizedPrefix.Length == 0
            ? typeSystem.ResolveType(XamlTypeSystem.PresentationNamespace, localName)
            : null;
    }

    private static ITypeSymbol? ResolveAttributeType(
        XamlAttribute attribute,
        XamlElement element,
        XamlTypeSystem typeSystem)
    {
        int dot = attribute.Name.LocalName.IndexOf('.');
        if (dot > 0)
        {
            var ownerToken = attribute.Name.LocalName.Substring(0, dot);
            var owner = ResolveType(
                attribute.Name.Prefix,
                ownerToken,
                element.NamespaceScope,
                typeSystem);
            return owner is null
                ? null
                : typeSystem.GetAttachedMemberType(
                    owner,
                    attribute.Name.LocalName.Substring(dot + 1));
        }

        var elementType = ResolveElementType(element, typeSystem);
        return elementType is null
            ? null
            : typeSystem.FindMember(elementType, attribute.Name.LocalName)?.Type;
    }

    private static void SplitQualified(string text, out string prefix, out string localName)
    {
        int colon = text.IndexOf(':');
        if (colon < 0)
        {
            prefix = string.Empty;
            localName = text;
            return;
        }

        prefix = text.Substring(0, colon);
        localName = text.Substring(colon + 1);
    }

    internal static string? NormalizeTypeToken(string? value)
    {
        var text = value?.Trim();
        if (string.IsNullOrEmpty(text))
        {
            return null;
        }

        if (text![0] != '{')
        {
            return text.TrimEnd('}').Trim();
        }

        int index = 1;
        while (index < text.Length && char.IsWhiteSpace(text[index]))
        {
            index++;
        }

        int extensionStart = index;
        while (index < text.Length && (char.IsLetterOrDigit(text[index]) || text[index] == ':'))
        {
            index++;
        }

        var extensionName = text.Substring(extensionStart, index - extensionStart);
        int colon = extensionName.LastIndexOf(':');
        if (!string.Equals(
            colon >= 0 ? extensionName.Substring(colon + 1) : extensionName,
            "Type",
            StringComparison.Ordinal))
        {
            return null;
        }

        while (index < text.Length && char.IsWhiteSpace(text[index]))
        {
            index++;
        }

        int typeStart = index;
        while (index < text.Length &&
               (char.IsLetterOrDigit(text[index]) || text[index] == ':' || text[index] == '.'))
        {
            index++;
        }

        var wrapped = text.Substring(typeStart, index - typeStart);
        return wrapped.Length > 0 ? wrapped : null;
    }
}
