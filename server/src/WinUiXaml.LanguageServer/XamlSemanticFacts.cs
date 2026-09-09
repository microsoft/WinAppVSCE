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

    internal static bool IsBindingMarkupExtension(
        XamlMarkupExtension extension,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem) =>
        IsBindingMarkupExtensionName(extension.Name?.FullName, scope, typeSystem);

    internal static bool IsBindingMarkupExtensionName(
        string? extensionName,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem) =>
        typeSystem.Capabilities.Binding is { } binding &&
        ResolveMarkupExtensionType(extensionName, scope, typeSystem) is { } extensionType &&
        XamlTypeSystem.IsAssignableTo(extensionType, binding);

    internal static bool IsResourceReferenceExtension(
        XamlMarkupExtension extension,
        XamlNamespaceScope scope) =>
        extension.Name is { } name &&
        name.LocalName is "StaticResource" or "ThemeResource" or "CustomResource" &&
        (!scope.TryResolvePrefix(name.Prefix, out var namespaceUri)
            ? !name.HasPrefix
            : IsPresentationNamespace(namespaceUri));

    internal static bool IsStaticResourceElement(XamlName name, string namespaceUri) =>
        name.LocalName == "StaticResource" &&
        IsPresentationNamespace(namespaceUri);

    internal static bool IsPresentationNamespace(string namespaceUri) =>
        string.Equals(
            namespaceUri,
            XamlTypeSystem.PresentationNamespace,
            StringComparison.Ordinal) ||
        string.Equals(namespaceUri, "using:Microsoft.UI.Xaml", StringComparison.Ordinal) ||
        string.Equals(namespaceUri, "using:Windows.UI.Xaml", StringComparison.Ordinal);

    internal static bool IsXBind(XamlAttribute attribute, XamlNamespaceScope scope) =>
        attribute.Value?.MarkupExtension is
            { IsClosed: true } extension &&
        IsXBind(extension, scope);

    internal static bool IsXBind(XamlMarkupExtension extension, XamlNamespaceScope scope) =>
        extension.Name is { } name &&
        IsXamlLanguageName(name, "Bind", scope);

    internal static bool IsXamlLanguageName(
        XamlName name,
        string localName,
        XamlNamespaceScope scope) =>
        name.HasPrefix &&
        string.Equals(name.LocalName, localName, StringComparison.Ordinal) &&
        (scope.TryResolvePrefix(name.Prefix, out var uri)
            ? string.Equals(uri, XamlTypeSystem.XamlLanguageNamespace, StringComparison.Ordinal)
            : string.Equals(name.Prefix, "x", StringComparison.Ordinal));

    internal static bool IsXamlDirectiveName(
        string attributeName,
        string localName,
        XamlNamespaceScope scope)
    {
        SplitQualified(attributeName, out var prefix, out var candidate);
        if (prefix.Length == 0 || !string.Equals(candidate, localName, StringComparison.Ordinal))
        {
            return false;
        }

        return scope.TryResolvePrefix(prefix, out var uri)
            ? string.Equals(uri, XamlTypeSystem.XamlLanguageNamespace, StringComparison.Ordinal)
            : string.Equals(prefix, "x", StringComparison.Ordinal);
    }

    internal static bool IsXamlDirective(XamlAttribute attribute, string localName)
    {
        for (var current = attribute.Parent; current is not null; current = current.Parent)
        {
            if (current is XamlElement element)
            {
                return IsXamlDirectiveName(
                    attribute.Name.FullName,
                    localName,
                    element.NamespaceScope);
            }
        }

        return false;
    }

    internal static bool IsXamlDirective(
        XamlAttribute attribute,
        string localName,
        XamlNamespaceScope scope) =>
        IsXamlLanguageName(attribute.Name, localName, scope);

    internal static XamlAttribute? GetDirectiveAttribute(XamlElement element, string localName) =>
        element.Attributes.FirstOrDefault(attribute =>
            !attribute.IsNamespaceDeclaration &&
            IsXamlDirective(attribute, localName, element.NamespaceScope));

    internal static XamlAttribute? GetNameAttribute(XamlElement element) =>
        GetDirectiveAttribute(element, "Name") ??
        element.Attributes.FirstOrDefault(attribute =>
            !attribute.IsNamespaceDeclaration &&
            !attribute.Name.HasPrefix &&
            string.Equals(attribute.Name.LocalName, "Name", StringComparison.Ordinal));

    internal static XamlAttribute? GetNameAttribute(
        XamlElement element,
        XamlTypeSystem typeSystem)
    {
        var directive = GetDirectiveAttribute(element, "Name");
        if (directive is not null ||
            ResolveElementType(element, typeSystem) is not { } elementType ||
            typeSystem.Capabilities.FrameworkElement is not { } frameworkElement ||
            !XamlTypeSystem.IsAssignableTo(elementType, frameworkElement))
        {
            return directive;
        }

        return element.Attributes.FirstOrDefault(attribute =>
            !attribute.IsNamespaceDeclaration &&
            !attribute.Name.HasPrefix &&
            string.Equals(attribute.Name.LocalName, "Name", StringComparison.Ordinal));
    }

    internal static string GetExpandedAttributeName(
        XamlElement element,
        XamlAttribute attribute)
    {
        if (attribute.IsNamespaceDeclaration)
        {
            return "xmlns:" + (attribute.DeclaredPrefix ?? string.Empty);
        }

        return attribute.Name.HasPrefix &&
            element.NamespaceScope.TryResolvePrefix(attribute.Name.Prefix, out var uri)
                ? "{" + uri + "}" + attribute.Name.LocalName
                : attribute.Name.FullName;
    }

    internal static bool IsNameAttribute(
        XamlAttribute attribute,
        INamedTypeSymbol elementType,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem) =>
        IsXamlDirective(attribute, "Name", scope) ||
        (!attribute.Name.HasPrefix &&
         string.Equals(attribute.Name.LocalName, "Name", StringComparison.Ordinal) &&
         typeSystem.Capabilities.FrameworkElement is { } frameworkElement &&
         XamlTypeSystem.IsAssignableTo(elementType, frameworkElement));

    internal static XamlAttribute? GetKeyAttribute(XamlElement element) =>
        GetDirectiveAttribute(element, "Key");

    internal static XamlAttribute? GetResourceKeyAttribute(XamlElement element) =>
        GetKeyAttribute(element) ?? GetDirectiveAttribute(element, "Name");

    internal static XamlElement? FindResourceDeclarationInScope(
        XamlElement reference,
        string key,
        XamlTypeSystem? typeSystem = null)
        => CreateResourceIndex(reference, typeSystem)
            .FindDeclaration(reference, key, int.MaxValue, allowForwardReference: true);

    internal static XamlElement? FindResourceDeclarationInScope(
        ResourceScopeIndex index,
        XamlElement reference,
        string key) =>
        index.FindDeclaration(reference, key, int.MaxValue, allowForwardReference: true);

    internal static ResourceScopeIndex CreateResourceIndex(
        XamlElement element,
        XamlTypeSystem? typeSystem)
    {
        var root = element;
        while (ParentElement(root) is { } parent)
        {
            root = parent;
        }

        return new ResourceScopeIndex(root, typeSystem);
    }

    internal sealed class ResourceScopeIndex
    {
        private readonly XamlTypeSystem? _typeSystem;
        private readonly Dictionary<XamlElement, Dictionary<string, XamlElement>> _declarations = new();
        private readonly string[] _keys;
        internal int LookupCount { get; private set; }
        private readonly Dictionary<XamlElement, IReadOnlyList<XamlElement>> _sourceDictionaries = new();

        internal ResourceScopeIndex(XamlElement root, XamlTypeSystem? typeSystem)
        {
            _typeSystem = typeSystem;
            foreach (var element in root.DescendantNodesAndSelf().OfType<XamlElement>())
            {
                if (IsResourceDictionaryScope(element, typeSystem) ||
                    IsResourceOwnerPropertyScope(element, typeSystem))
                {
                    var (declarations, sourceDictionaries) = BuildDeclarations(element);
                    _declarations[element] = declarations;
                    _sourceDictionaries[element] = sourceDictionaries;
                }
            }

            _keys = _declarations.Values
                .SelectMany(scope => scope.Keys)
                .Distinct(StringComparer.Ordinal)
                .ToArray();
        }

        internal XamlElement? FindDeclaration(
            XamlElement reference,
            string key,
            int referenceStart,
            bool allowForwardReference)
        {
            LookupCount++;
            return FindDeclarationCore(reference, key, referenceStart, allowForwardReference);
        }

        internal IReadOnlyCollection<string> GetVisibleKeys(
            XamlElement reference,
            int referenceStart,
            bool allowForwardReference) =>
            _keys.Where(key =>
                    FindDeclarationCore(reference, key, referenceStart, allowForwardReference) is not null)
                .ToArray();

        private XamlElement? FindDeclarationCore(
            XamlElement reference,
            string key,
            int referenceStart,
            bool allowForwardReference)
        {
            XamlElement? previousDictionary = null;
            bool sameLogicalDictionary = true;
            bool foundDictionary = false;
            for (XamlElement? scope = reference; scope is not null; scope = ParentElement(scope))
            {
                if (IsResourceDictionaryScope(scope, _typeSystem) ||
                    IsResourceOwnerPropertyScope(scope, _typeSystem))
                {
                    if (foundDictionary &&
                        (previousDictionary is null ||
                         GetResourceKeyAttribute(previousDictionary) is not null))
                    {
                        sameLogicalDictionary = false;
                    }

                    foundDictionary = true;
                    if (TryFind(
                            scope,
                            key,
                            enforceOrder: sameLogicalDictionary && !allowForwardReference,
                            referenceStart,
                            out var declaration))
                    {
                        return declaration;
                    }

                    previousDictionary = scope;
                }
                else if (foundDictionary)
                {
                    sameLogicalDictionary = false;
                    previousDictionary = null;
                }

                foreach (var child in scope.Content.OfType<XamlElement>())
                {
                    if (IsResourceOwnerPropertyScope(child, _typeSystem) &&
                        !IsAncestorOf(child, reference) &&
                        TryFind(child, key, enforceOrder: false, referenceStart, out var declaration))
                    {
                        return declaration;
                    }
                }
            }

            return null;
        }

        internal IReadOnlyCollection<string> Keys => _keys;

        internal bool HasSameDictionaryForwardDeclaration(
            XamlElement reference,
            string key,
            int referenceStart)
        {
            bool foundDictionary = false;
            XamlElement? previousDictionary = null;
            for (XamlElement? scope = reference; scope is not null; scope = ParentElement(scope))
            {
                if (IsResourceDictionaryScope(scope, _typeSystem) ||
                    IsResourceOwnerPropertyScope(scope, _typeSystem))
                {
                    if (foundDictionary &&
                        (previousDictionary is null ||
                         GetResourceKeyAttribute(previousDictionary) is not null))
                    {
                        return false;
                    }

                    foundDictionary = true;
                    if (_declarations.TryGetValue(scope, out var entries) &&
                        entries.TryGetValue(key, out var declaration) &&
                        declaration.Span.Start > referenceStart)
                    {
                        return true;
                    }

                    previousDictionary = scope;
                }
                else if (foundDictionary)
                {
                    return false;
                }
            }

            return false;
        }

        internal IReadOnlyCollection<string> GetVisibleKeys(XamlElement reference) =>
            Keys.Where(key =>
                    FindDeclaration(
                        reference,
                        key,
                        int.MaxValue,
                        allowForwardReference: true) is not null)
                .ToArray();

        internal IReadOnlyCollection<XamlElement> GetVisibleSourceDictionaries(
            XamlElement reference)
        {
            var result = new List<XamlElement>();
            var seen = new HashSet<XamlElement>();
            for (XamlElement? scope = reference; scope is not null; scope = ParentElement(scope))
            {
                AddSources(scope, result, seen);
                foreach (var child in scope.Content.OfType<XamlElement>())
                {
                    if (IsResourceOwnerPropertyScope(child, _typeSystem) &&
                        !IsAncestorOf(child, reference))
                    {
                        AddSources(child, result, seen);
                    }
                }
            }

            return result.ToArray();
        }

        private void AddSources(
            XamlElement scope,
            ICollection<XamlElement> result,
            ISet<XamlElement> seen)
        {
            if (_sourceDictionaries.TryGetValue(scope, out var sources))
            {
                foreach (var source in sources)
                {
                    if (seen.Add(source))
                    {
                        result.Add(source);
                    }
                }
            }
        }

        private bool TryFind(
            XamlElement scope,
            string key,
            bool enforceOrder,
            int referenceStart,
            out XamlElement? declaration)
        {
            if (_declarations.TryGetValue(scope, out var entries) &&
                entries.TryGetValue(key, out declaration) &&
                (!enforceOrder || declaration.Span.Start < referenceStart))
            {
                return true;
            }

            declaration = null;
            return false;
        }

        private (
            Dictionary<string, XamlElement> Declarations,
            IReadOnlyList<XamlElement> SourceDictionaries) BuildDeclarations(
                XamlElement container)
        {
            var declarations = new Dictionary<string, XamlElement>(StringComparer.Ordinal);
            var sourceDictionaries = new List<XamlElement>();
            if (IsResourceDictionaryScope(container, _typeSystem))
            {
                AddSourceDictionary(container, sourceDictionaries);
            }

            CollectDeclarations(container, declarations, collectionWrapper: false);
            CollectSourceDictionaries(
                container,
                sourceDictionaries,
                collectionWrapper: false);
            return (declarations, sourceDictionaries);
        }

        private void CollectDeclarations(
            XamlElement container,
            Dictionary<string, XamlElement> result,
            bool collectionWrapper)
        {
            var entries = container.Content.OfType<XamlElement>();
            if (collectionWrapper)
            {
                entries = entries.Reverse();
            }

            foreach (var entry in entries)
            {
                if (collectionWrapper)
                {
                    CollectDeclarations(entry, result, collectionWrapper: false);
                    continue;
                }

                if (IsResourceDictionaryCollectionScope(entry, _typeSystem))
                {
                    continue;
                }

                if (GetResourceKeyAttribute(entry)?.Value is { IsMarkupExtension: false } value)
                {
                    result.TryAdd(value.Text.Trim(), entry);
                    continue;
                }

                if (IsResourceDictionaryScope(entry, _typeSystem))
                {
                    CollectDeclarations(entry, result, collectionWrapper: false);
                }
            }

            if (!collectionWrapper)
            {
                foreach (var entry in container.Content.OfType<XamlElement>()
                             .Where(entry => IsResourceDictionaryCollectionScope(entry, _typeSystem)))
                {
                    CollectDeclarations(entry, result, collectionWrapper: true);
                }
            }
        }

        private void CollectSourceDictionaries(
            XamlElement container,
            List<XamlElement> result,
            bool collectionWrapper)
        {
            foreach (var entry in container.Content.OfType<XamlElement>())
            {
                if (collectionWrapper)
                {
                    if (IsResourceDictionaryScope(entry, _typeSystem))
                    {
                        AddSourceDictionary(entry, result);
                        CollectSourceDictionaries(entry, result, collectionWrapper: false);
                    }

                    continue;
                }

                if (IsResourceDictionaryCollectionScope(entry, _typeSystem))
                {
                    continue;
                }

                if (GetResourceKeyAttribute(entry) is not null)
                {
                    continue;
                }

                if (IsResourceDictionaryScope(entry, _typeSystem))
                {
                    AddSourceDictionary(entry, result);
                    CollectSourceDictionaries(entry, result, collectionWrapper: false);
                }
            }

            if (!collectionWrapper)
            {
                foreach (var entry in container.Content.OfType<XamlElement>()
                             .Where(entry => IsResourceDictionaryCollectionScope(entry, _typeSystem)))
                {
                    CollectSourceDictionaries(entry, result, collectionWrapper: true);
                }
            }
        }

        private static void AddSourceDictionary(
            XamlElement dictionary,
            ICollection<XamlElement> result)
        {
            if (dictionary.GetAttribute("Source")?.Value is
                {
                    MarkupExtension: null,
                    Text.Length: > 0,
                })
            {
                result.Add(dictionary);
            }
        }

        private static bool IsAncestorOf(XamlElement ancestor, XamlElement element)
        {
            for (XamlNode? current = element; current is not null; current = current.Parent)
            {
                if (ReferenceEquals(current, ancestor))
                {
                    return true;
                }
            }

            return false;
        }
    }

    private static bool IsResourceDictionaryScope(
        XamlElement element,
        XamlTypeSystem? typeSystem)
    {
        if (typeSystem?.Capabilities.ResourceDictionary is not null &&
            ResolveElementType(element, typeSystem) is not null)
        {
            return IsResourceDictionary(element, typeSystem);
        }

        if (element.Name is not { LocalName: "ResourceDictionary" } name)
        {
            return false;
        }

        return element.NamespaceScope.TryResolvePrefix(name.Prefix, out var namespaceUri)
            ? IsPresentationNamespace(namespaceUri)
            : !name.HasPrefix;
    }

    private static bool IsResourceDictionaryPropertyScope(
        XamlElement element,
        XamlTypeSystem? typeSystem)
    {
        if (typeSystem?.Capabilities.ResourceDictionary is not null &&
            ResolvePropertyElementMember(element, typeSystem) is { Owner: not null })
        {
            return IsResourceDictionaryPropertyElement(element, typeSystem);
        }

        return element.Name?.FullName.EndsWith(".Resources", StringComparison.Ordinal) == true;
    }

    private static bool IsResourceOwnerPropertyScope(
        XamlElement element,
        XamlTypeSystem? typeSystem) =>
        IsResourceDictionaryPropertyScope(element, typeSystem) &&
        !IsResourceDictionaryCollectionScope(element, typeSystem);

    private static bool IsResourceDictionaryCollectionScope(
        XamlElement element,
        XamlTypeSystem? typeSystem)
    {
        if (typeSystem?.Capabilities.ResourceDictionary is { } resourceDictionary &&
            ResolvePropertyElementMember(element, typeSystem) is
                { Owner: { } owner, MemberName: "MergedDictionaries" or "ThemeDictionaries" })
        {
            return XamlTypeSystem.IsAssignableTo(owner, resourceDictionary);
        }

        return element.Name?.FullName.EndsWith(
            ".MergedDictionaries",
            StringComparison.Ordinal) == true ||
            element.Name?.FullName.EndsWith(
                ".ThemeDictionaries",
                StringComparison.Ordinal) == true;
    }

    private static XamlElement? ParentElement(XamlElement element)
    {
        for (var parent = element.Parent; parent is not null; parent = parent.Parent)
        {
            if (parent is XamlElement parentElement)
            {
                return parentElement;
            }
        }

        return null;
    }

    internal static (
        string OwnerName,
        string MemberName,
        INamedTypeSymbol? Owner,
        ITypeSymbol? PropertyType,
        bool IsAttached)? ResolvePropertyElementMember(
            XamlElement propertyElement,
            XamlTypeSystem typeSystem)
    {
        if (propertyElement.Name is not { IsDotted: true } name ||
            !propertyElement.NamespaceScope.TryResolvePrefix(name.Prefix, out var uri))
        {
            return null;
        }

        return ResolvePropertyElementMember(name, uri, typeSystem);
    }

    internal static (
        string OwnerName,
        string MemberName,
        INamedTypeSymbol? Owner,
        ITypeSymbol? PropertyType,
        bool IsAttached)? ResolvePropertyElementMember(
            XamlName name,
            string uri,
            XamlTypeSystem typeSystem)
    {
        var dot = name.LocalName.LastIndexOf('.');
        if (dot <= 0 || dot >= name.LocalName.Length - 1)
        {
            return null;
        }

        var ownerName = name.LocalName[..dot];
        var memberName = name.LocalName[(dot + 1)..];
        var owner = typeSystem.ResolveType(uri, ownerName);
        var propertyType = owner is null ? null : typeSystem.GetPropertyType(owner, memberName);
        var isAttached = false;
        if (propertyType is null && owner is not null)
        {
            propertyType = typeSystem.GetAttachedMemberType(owner, memberName);
            isAttached = propertyType is not null;
        }

        return (ownerName, memberName, owner, propertyType, isAttached);
    }

    internal static bool IsNameScopeBoundary(XamlElement element, XamlTypeSystem typeSystem) =>
        typeSystem.Capabilities.FrameworkTemplate is { } template &&
        IsElement(element, template, typeSystem, allowDerived: true);

    internal static IEnumerable<(string Name, XamlElement Element)> EnumerateNamedElementsInScope(
        TextDocument document,
        XamlNode? context,
        XamlTypeSystem typeSystem)
    {
        foreach (var element in EnumerateElementsInNameScope(document, context, typeSystem))
        {
            var attribute = GetNameAttribute(element, typeSystem);
            if (attribute?.Value is { IsMarkupExtension: false } value)
            {
                var name = value.Text.Trim();
                if (name.Length > 0 && element.Name is { LocalName.Length: > 0 })
                {
                    yield return (name, element);
                }
            }
        }
    }

    internal static IEnumerable<XamlElement> EnumerateElementsInNameScope(
        TextDocument document,
        XamlNode? context,
        XamlTypeSystem typeSystem)
    {
        if (document.Parsed.Root is not { } documentRoot)
        {
            yield break;
        }
        var scopeRoot = documentRoot;
        var scopeStartsInsideBoundary = false;
        for (var current = context; current is not null; current = current.Parent)
        {
            if (current is XamlElement element &&
                IsNameScopeBoundary(element, typeSystem) &&
                IsWithinElementContent(context, element))
            {
                scopeRoot = element;
                scopeStartsInsideBoundary = true;
                break;
            }
        }

        var roots = scopeStartsInsideBoundary
            ? scopeRoot.Content.OfType<XamlElement>()
            : new[] { scopeRoot };
        foreach (var root in roots)
        {
            foreach (var element in EnumerateElementsInNameScopeCore(root, typeSystem))
            {
                yield return element;
            }
        }
    }

    private static bool IsWithinElementContent(XamlNode? context, XamlElement element)
    {
        var child = context;
        while (child is not null && !ReferenceEquals(child.Parent, element))
        {
            child = child.Parent;
        }

        return child is not null && child is not XamlAttribute;
    }

    internal static XamlElement? FindNamedElementInScope(
        TextDocument document,
        XamlNode? context,
        string name,
        XamlTypeSystem typeSystem) =>
        EnumerateNamedElementsInScope(document, context, typeSystem)
            .FirstOrDefault(candidate => string.Equals(candidate.Name, name, StringComparison.Ordinal))
            .Element;

    internal static INamedTypeSymbol? ResolveNamedElementTypeInScope(
        TextDocument document,
        XamlNode? context,
        string name,
        XamlTypeSystem typeSystem)
    {
        var element = FindNamedElementInScope(document, context, name, typeSystem);
        return element is null ? null : ResolveElementType(element, typeSystem);
    }

    internal static IEnumerable<IMethodSymbol> EnumerateEventHandlerMethods(
        INamedTypeSymbol type,
        string methodName,
        XamlTypeSystem typeSystem) =>
        EnumerateEventHandlerMethods(type, typeSystem, methodName);

    internal static IEnumerable<IMethodSymbol> EnumerateEventHandlerMethods(
        INamedTypeSymbol type,
        XamlTypeSystem typeSystem,
        string? methodName = null)
    {
        for (INamedTypeSymbol? current = type; current is not null; current = current.BaseType)
        {
            var members = methodName is null ? current.GetMembers() : current.GetMembers(methodName);
            foreach (var method in members.OfType<IMethodSymbol>())
            {
                if (!method.IsImplicitlyDeclared &&
                    method.AssociatedSymbol is null &&
                    typeSystem.IsSymbolAccessibleWithin(method, type))
                {
                    yield return method;
                }
            }
        }
    }

    internal static bool IsCompatibleEventHandler(
        IMethodSymbol method,
        IMethodSymbol delegateInvoke)
    {
        if (method.MethodKind != MethodKind.Ordinary ||
            method.IsStatic ||
            !method.ReturnsVoid ||
            method.Parameters.Length != delegateInvoke.Parameters.Length)
        {
            return false;
        }

        for (int i = 0; i < method.Parameters.Length; i++)
        {
            if (method.Parameters[i].RefKind != delegateInvoke.Parameters[i].RefKind ||
                !(SymbolEqualityComparer.Default.Equals(
                      method.Parameters[i].Type,
                      delegateInvoke.Parameters[i].Type) ||
                  XamlTypeSystem.IsAssignableTo(
                      delegateInvoke.Parameters[i].Type,
                      method.Parameters[i].Type)))
            {
                return false;
            }
        }

        return true;
    }

    internal static IReadOnlyList<IReadOnlyList<(string Name, XamlAttribute Attribute)>> GetNameScopes(
        XamlElement root,
        XamlTypeSystem typeSystem)
    {
        var scopes = new List<IReadOnlyList<(string Name, XamlAttribute Attribute)>>();
        var rootScope = new List<(string Name, XamlAttribute Attribute)>();
        scopes.Add(rootScope);
        CollectNameScopes(root, rootScope, scopes, typeSystem);
        return scopes;
    }

    private static void CollectNameScopes(
        XamlElement element,
        List<(string Name, XamlAttribute Attribute)> scope,
        List<IReadOnlyList<(string Name, XamlAttribute Attribute)>> scopes,
        XamlTypeSystem typeSystem)
    {
        if (GetNameAttribute(element, typeSystem) is
            { Value: { IsMarkupExtension: false } value } attribute)
        {
            var name = value.Text.Trim();
            if (name.Length > 0)
            {
                scope.Add((name, attribute));
            }
        }

        var childScope = scope;
        if (IsNameScopeBoundary(element, typeSystem))
        {
            childScope = new List<(string Name, XamlAttribute Attribute)>();
            scopes.Add(childScope);
        }

        foreach (var child in element.Content.OfType<XamlElement>())
        {
            CollectNameScopes(child, childScope, scopes, typeSystem);
        }
    }

    private static IEnumerable<XamlElement> EnumerateElementsInNameScopeCore(
        XamlElement element,
        XamlTypeSystem typeSystem)
    {
        yield return element;

        if (IsNameScopeBoundary(element, typeSystem))
        {
            yield break;
        }

        foreach (var child in element.Content.OfType<XamlElement>())
        {
            foreach (var result in EnumerateElementsInNameScopeCore(child, typeSystem))
            {
                yield return result;
            }
        }
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

    internal static bool IsResourceDictionary(
        XamlElement element,
        XamlTypeSystem typeSystem) =>
        IsElement(
            element,
            typeSystem.Capabilities.ResourceDictionary,
            typeSystem,
            allowDerived: true);

    internal static bool IsResourceDictionaryPropertyElement(
        XamlElement propertyElement,
        XamlTypeSystem typeSystem)
    {
        var resolved = ResolvePropertyElementMember(propertyElement, typeSystem);
        if (resolved?.PropertyType is not { } propertyType)
        {
            return false;
        }

        if (propertyType is INamedTypeSymbol namedPropertyType &&
            typeSystem.Capabilities.ResourceDictionary is { } resourceDictionary &&
            XamlTypeSystem.IsAssignableTo(namedPropertyType, resourceDictionary))
        {
            return true;
        }

        return typeSystem.Capabilities.ResourceDictionary is { } ownerDictionary &&
            resolved.Value.Owner is { } owner &&
            XamlTypeSystem.IsAssignableTo(owner, ownerDictionary) &&
            string.Equals(resolved.Value.MemberName, "ThemeDictionaries", StringComparison.Ordinal);
    }

    internal static ITypeSymbol? ResolveMarkupArgumentType(
        XamlMarkupExtension extension,
        XamlNamespaceScope scope,
        string argumentName,
        XamlTypeSystem typeSystem) =>
        ResolveMarkupArgumentType(extension.Name?.FullName, scope, argumentName, typeSystem);

    internal static ITypeSymbol? ResolveMarkupArgumentType(
        string? extensionName,
        XamlNamespaceScope scope,
        string argumentName,
        XamlTypeSystem typeSystem)
    {
        var extensionType = ResolveMarkupExtensionType(extensionName, scope, typeSystem);
        var argumentType = extensionType is null
            ? null
            : typeSystem.FindMember(extensionType, argumentName)?.Type;
        if (argumentType is not null || !IsXBindName(extensionName, scope, typeSystem))
        {
            return argumentType;
        }

        if (string.Equals(argumentName, "Mode", StringComparison.OrdinalIgnoreCase))
        {
            return typeSystem.Capabilities.BindingMode;
        }

        return string.Equals(
            argumentName,
            "UpdateSourceTrigger",
            StringComparison.OrdinalIgnoreCase)
                ? typeSystem.Capabilities.UpdateSourceTrigger
                : null;
    }

    internal static bool IsXBindName(
        string? extensionName,
        XamlNamespaceScope scope,
        XamlTypeSystem typeSystem)
    {
        if (string.IsNullOrEmpty(extensionName))
        {
            return false;
        }

        SplitQualified(extensionName!, out var prefix, out var localName);
        if (!string.Equals(localName, "Bind", StringComparison.Ordinal))
        {
            return false;
        }

        if (prefix.Length == 0)
        {
            return ResolveMarkupExtensionType(extensionName, scope, typeSystem) is null;
        }

        return scope.TryResolvePrefix(prefix, out var namespaceUri)
            ? string.Equals(namespaceUri, XamlTypeSystem.XamlLanguageNamespace, StringComparison.Ordinal)
            : string.Equals(prefix, "x", StringComparison.Ordinal);
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

            if (!IsPresentationNamespace(namespaceUri))
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
        bool usePresentationNamespaceForUnprefixed = false,
        bool allowMetadataNameFallback = false)
    {
        text = text.Trim();
        if (text.Length == 0)
        {
            return null;
        }

        SplitQualified(text, out var prefix, out var localName);
        var resolved = ResolveType(
            prefix,
            localName,
            scope,
            typeSystem,
            usePresentationNamespaceForUnprefixed);
        return resolved ??
            (allowMetadataNameFallback && prefix.Length == 0
                ? typeSystem.ResolveMetadataType(text)
                : null);
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
            : typeSystem.FindAttributeMember(elementType, attribute.Name.LocalName)?.Type;
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
