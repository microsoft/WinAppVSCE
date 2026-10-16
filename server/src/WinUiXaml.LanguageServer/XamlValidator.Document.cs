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

/// <summary>Document-scope validation: x:Class resolution, directives, mc:Ignorable, and unique names and resource keys.</summary>
internal static partial class XamlValidator
{
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
