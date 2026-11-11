using Microsoft.CodeAnalysis.CSharp;
using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Workspace;
using WinUiXaml.Xaml;

namespace WinUiXaml.LanguageServer;

/// <summary>The kind of symbol a rename targets. Drives new-name validation.</summary>
internal enum XamlRenameKind
{
    /// <summary>An <c>x:Name</c>/bare <c>Name</c> — must stay a legal identifier (it backs a generated field).</summary>
    Name,

    /// <summary>An <c>x:Key</c> resource key — permissive, but may not contain characters that would break the XML attribute value or start a markup extension.</summary>
    Key,
}

/// <summary>Raised when a requested rename target name is invalid.</summary>
internal sealed class RenameValidationException : RequestFailedException
{
    public RenameValidationException(string message) : base(message) { }
}

/// <summary>Computes textDocument/prepareRename and textDocument/rename for WinUI XAML.</summary>
internal static class XamlRename
{
    // Keys are also inserted into unquoted markup-extension arguments.
    private static readonly char[] KeyForbidden = { '"', '\'', '<', '>', '&', '{', '}', ',', '=' };

    /// <summary> Validates the caret and returns the exact token range to make editable plus the current name as the placeholder, or null when the caret is not on a renameable symbol.</summary>
    internal static PrepareRenameResult? PrepareRename(
        TextDocument doc,
        int offset,
        XamlTypeSystem? typeSystem = null,
        bool allowExternalDeclaration = false)
    {
        if (doc.Parsed.Root is not { } root)
        {
            return null;
        }

        if (XamlLanguageServer.DetectSymbolAt(doc, offset, typeSystem) is not { } symbol)
        {
            return null;
        }

        if (symbol.Kind == XamlRenameKind.Name &&
            typeSystem?.Capabilities.HasCompleteNameReferenceSemantics != true)
        {
            return null;
        }

        EnsureSafeRename(doc, root, offset, symbol.Kind, symbol.Name, typeSystem);
        var occurrences = XamlLanguageServer.ResolveOccurrences(doc, root, offset, typeSystem);
        if (occurrences is null ||
            (RequiresLocalDeclaration(symbol.Kind, allowExternalDeclaration) &&
             !occurrences.Any(occurrence => occurrence.IsDeclaration)))
        {
            return null;
        }

        // Return the range of the specific occurrence the caret sits in (declaration or usage) so the editor seeds the rename box over the token under the cursor, not some other occurrence.
        foreach (var occurrence in occurrences)
        {
            if (RangeContainsOffset(doc, occurrence.Range, offset))
            {
                return new PrepareRenameResult { Range = occurrence.Range, Placeholder = symbol.Name };
            }
        }

        return null;
    }

    /// <summary>Builds a WorkspaceEdit renaming the symbol under the caret and every reference to it IN THIS DOCUMENT. Cross-file resource-key uses are added by the caller.</summary>
    internal static WorkspaceEdit? Rename(
        TextDocument doc,
        int offset,
        string newName,
        XamlTypeSystem? typeSystem = null,
        bool allowExternalDeclaration = false)
    {
        if (doc.Parsed.Root is not { } root)
        {
            return null;
        }

        if (XamlLanguageServer.DetectSymbolAt(doc, offset, typeSystem) is not { } symbol)
        {
            return null;
        }

        if (symbol.Kind == XamlRenameKind.Name &&
            typeSystem?.Capabilities.HasCompleteNameReferenceSemantics != true)
        {
            return null;
        }

        // Gate on the renameable location first (this also rejects carets inside malformed/unterminated markup), so an invalid-name error is only raised when the caret is genuinely on a symbol.
        EnsureSafeRename(doc, root, offset, symbol.Kind, symbol.Name, typeSystem);
        var occurrences = XamlLanguageServer.ResolveOccurrences(doc, root, offset, typeSystem);
        if (occurrences is null ||
            occurrences.Count == 0 ||
            (RequiresLocalDeclaration(symbol.Kind, allowExternalDeclaration) &&
             !occurrences.Any(occurrence => occurrence.IsDeclaration)))
        {
            return null;
        }

        // The caret must sit on one of the occurrences (the declaration or a usage).
        if (!occurrences.Any(o => RangeContainsOffset(doc, o.Range, offset)))
        {
            return null;
        }

        var trimmed = (newName ?? string.Empty).Trim();
        ValidateNewName(symbol.Kind, trimmed);
        EnsureNoCollision(doc, offset, trimmed, symbol.Kind, typeSystem);

        var edits = occurrences
            .Select(o => new TextEdit { Range = o.Range, NewText = trimmed })
            .ToList();

        return new WorkspaceEdit
        {
            Changes = new Dictionary<string, List<TextEdit>>(System.StringComparer.Ordinal)
            {
                [doc.Uri] = edits,
            },
        };
    }

    private static void EnsureSafeRename(
        TextDocument doc, XamlElement root, int offset, XamlRenameKind kind, string name, XamlTypeSystem? typeSystem)
    {
        if (kind == XamlRenameKind.Name && typeSystem is not null)
        {
            XamlLanguageServer.EnsureCompleteBindRename(doc, offset, name, typeSystem);
        }
        if (kind == XamlRenameKind.Key)
        {
            if (XamlLanguageServer.FindRenameResourceDeclaration(doc, offset, typeSystem) is { } declaration)
            {
                for (XamlNode? current = declaration; current is not null; current = current.Parent)
                {
                    if (current is XamlElement element &&
                        element.Name?.FullName.EndsWith(".ThemeDictionaries", StringComparison.Ordinal) == true)
                    {
                        EnsureNoThemeAlternatives(element, name);
                    }
                }
            }
            else
            {
                EnsureNoThemeAlternatives(root, name);
            }
        }
    }

    internal static void EnsureNoThemeAlternatives(XamlElement root, string key)
    {
        foreach (var theme in root.DescendantNodesAndSelf().OfType<XamlElement>()
                     .Where(element => element.Name?.LocalName.EndsWith(".ThemeDictionaries", StringComparison.Ordinal) == true))
        {
            if (theme.DescendantNodesAndSelf().OfType<XamlElement>().Any(element =>
                    XamlSemanticFacts.GetKeyAttribute(element)?.Value?.Text.Trim() == key ||
                    element.GetAttribute("Source") is not null))
            {
                throw new RequestFailedException(
                    $"Rename cannot safely update resource '{key}' across theme dictionaries. Update its theme variants and usages together.");
            }
        }
    }

    /// <summary>An x:Name needs a local declaration; a cross-file key requires caller-proven ownership.</summary>
    private static bool RequiresLocalDeclaration(XamlRenameKind kind, bool allowExternalDeclaration) =>
        kind == XamlRenameKind.Name ||
        (kind == XamlRenameKind.Key && !allowExternalDeclaration);

    /// <summary>Rejects a new name that would corrupt the markup (or, for a name, the generated field).</summary>
    private static void ValidateNewName(XamlRenameKind kind, string newName)
    {
        if (string.IsNullOrWhiteSpace(newName))
        {
            throw new RenameValidationException("The new name cannot be empty.");
        }

        if (kind == XamlRenameKind.Name)
        {
            if (!IsValidName(newName))
            {
                throw new RenameValidationException(
                    $"'{newName}' is not a valid x:Name. Use a C# identifier that is not a reserved keyword.");
            }

            return;
        }

        foreach (var forbidden in KeyForbidden)
        {
            if (newName.IndexOf(forbidden) >= 0)
            {
                throw new RenameValidationException($"A resource key cannot contain the character '{forbidden}'.");
            }
        }
    }

    internal static bool IsValidName(string value) =>
        SyntaxFacts.IsValidIdentifier(value) &&
        SyntaxFacts.GetKeywordKind(value) == SyntaxKind.None &&
        !value.StartsWith('@');

    /// <summary>True when renaming declaration to newName would change which element any classic ElementName binding resolves to.</summary>
    private static bool ChangesElementNameResolution(
        TextDocument doc, XamlElement declaration, string oldName, string newName, XamlTypeSystem typeSystem)
    {
        foreach (var reference in XamlLanguageServer.EnumerateElementNameReferences(doc, typeSystem))
        {
            var current = XamlSemanticFacts.FindElementNameBindingTarget(doc, reference.Attribute, reference.Name, typeSystem);

            // A renamed reference must not be shadowed by newName, and a newName reference must not be captured.
            if ((reference.Name == oldName && ReferenceEquals(current, declaration) &&
                 XamlSemanticFacts.FindElementNameBindingTarget(doc, reference.Attribute, newName, typeSystem) is { } other &&
                 IsFoundFirst(doc, reference.Attribute, other, declaration, typeSystem)) ||
                (reference.Name == newName && current is not null &&
                 IsFoundFirst(doc, reference.Attribute, declaration, current, typeSystem)))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>True when an ElementName lookup from context reaches first before second.</summary>
    private static bool IsFoundFirst(
        TextDocument doc, XamlNode context, XamlElement first, XamlElement second, XamlTypeSystem typeSystem)
    {
        foreach (var (_, element) in XamlSemanticFacts.EnumerateElementNameBindingTargets(doc, context, typeSystem))
        {
            if (ReferenceEquals(element, first))
            {
                return true;
            }

            if (ReferenceEquals(element, second))
            {
                return false;
            }
        }

        return false;
    }

    internal static void EnsureNoCollision(
        TextDocument doc, int offset, string newName, XamlRenameKind kind, XamlTypeSystem? typeSystem)
    {
        if (doc.Parsed.Root is not { } root)
        {
            return;
        }

        if (kind == XamlRenameKind.Name && typeSystem is not null)
        {
            var occurrences = XamlLanguageServer.ResolveOccurrences(doc, root, offset, typeSystem);
            foreach (var scope in XamlSemanticFacts.GetNameScopes(root, typeSystem))
            {
                if (occurrences?.Any(occurrence => occurrence.IsDeclaration &&
                    scope.Any(entry => entry.Attribute.Value is { } value &&
                        doc.OffsetAt(occurrence.Range.Start) == value.InnerSpan.Start)) == true &&
                    scope.Any(entry => entry.Name == newName &&
                        !occurrences.Any(occurrence => occurrence.IsDeclaration &&
                            doc.OffsetAt(occurrence.Range.Start) == entry.Attribute.Value!.InnerSpan.Start)))
                {
                    throw new RenameValidationException(
                        $"The name '{newName}' already exists in the current name scope.");
                }
            }

            if (occurrences?.FirstOrDefault(occurrence => occurrence.IsDeclaration) is { IsDeclaration: true } declared)
            {
                int start = doc.OffsetAt(declared.Range.Start);
                var oldName = doc.Text.Substring(start, doc.OffsetAt(declared.Range.End) - start);
                if (XamlSemanticFacts.FindElementNameBindingTarget(doc, doc.Parsed.FindNode(start), oldName, typeSystem) is { } declaration &&
                    ChangesElementNameResolution(doc, declaration, oldName, newName, typeSystem))
                {
                    throw new RenameValidationException(
                        $"Renaming to '{newName}' would change which element an ElementName binding refers to.");
                }
            }
        }
        else if (kind == XamlRenameKind.Key &&
            XamlLanguageServer.FindRenameResourceDeclaration(doc, offset, typeSystem) is { } declaration)
        {
            var container = declaration.Parent as XamlElement;
            if (container?.Content.OfType<XamlElement>().Any(entry =>
                !ReferenceEquals(entry, declaration) &&
                XamlSemanticFacts.GetResourceKeyAttribute(entry)?.Value is { IsMarkupExtension: false } value &&
                value.Text.Trim() == newName) == true)
            {
                throw new RenameValidationException(
                    $"The resource key '{newName}' already exists in the current dictionary.");
            }
        }
    }

    internal static string SanitizeName(string value)
    {
        var characters = value.Select(character =>
            SyntaxFacts.IsIdentifierPartCharacter(character) ? character : '_').ToArray();
        string result = new(characters);
        if (result.Length == 0)
        {
            return "Element";
        }

        if (!SyntaxFacts.IsIdentifierStartCharacter(result[0]))
        {
            result = "_" + result;
        }
        return IsValidName(result) ? result : result + "_";
    }

    /// <summary>True when offset falls within range (inclusive on both ends, matching the caret-containment used elsewhere), so a caret at either boundary of the token resolves to that occurrence.</summary>
    private static bool RangeContainsOffset(TextDocument doc, Lsp.Range range, int offset)
    {
        var start = doc.OffsetAt(range.Start);
        var end = doc.OffsetAt(range.End);
        return offset >= start && offset <= end;
    }
}
