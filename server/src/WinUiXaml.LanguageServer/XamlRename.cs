using System.Text.RegularExpressions;
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
internal sealed class RenameValidationException : System.Exception
{
    public RenameValidationException(string message) : base(message) { }
}

/// <summary>Computes textDocument/prepareRename and textDocument/rename for WinUI XAML.</summary>
internal static class XamlRename
{
    // An x:Name backs a generated C# field, so it must be a legal identifier.
    private static readonly Regex NamePattern = new(@"^[A-Za-z_][A-Za-z0-9_]*$", RegexOptions.Compiled);

    // Characters that would break out of the quoted attribute value or start a markup extension.
    private static readonly char[] KeyForbidden = { '"', '\'', '<', '>', '&', '{', '}' };

    /// <summary> Validates the caret and returns the exact token range to make editable plus the current name as the placeholder, or null when the caret is not on a renameable symbol.</summary>
    internal static PrepareRenameResult? PrepareRename(
        TextDocument doc,
        int offset,
        XamlTypeSystem? typeSystem = null)
    {
        if (doc.Parsed.Root is not { } root)
        {
            return null;
        }

        if (XamlLanguageServer.DetectSymbolAt(doc, offset, typeSystem) is not { } symbol)
        {
            return null;
        }

        var occurrences = XamlLanguageServer.ResolveOccurrences(doc, root, offset, typeSystem);
        if (occurrences is null)
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

    /// <summary>Builds a single-document WorkspaceEdit renaming the symbol under the caret and every reference to it.</summary>
    internal static WorkspaceEdit? Rename(
        TextDocument doc,
        int offset,
        string newName,
        XamlTypeSystem? typeSystem = null)
    {
        if (doc.Parsed.Root is not { } root)
        {
            return null;
        }

        if (XamlLanguageServer.DetectSymbolAt(doc, offset, typeSystem) is not { } symbol)
        {
            return null;
        }

        // Gate on the renameable location first (this also rejects carets inside malformed/unterminated markup), so an invalid-name error is only raised when the caret is genuinely on a symbol.
        var occurrences = XamlLanguageServer.ResolveOccurrences(doc, root, offset, typeSystem);
        if (occurrences is null || occurrences.Count == 0)
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

    /// <summary>Rejects a new name that would corrupt the markup (or, for a name, the generated field).</summary>
    private static void ValidateNewName(XamlRenameKind kind, string newName)
    {
        if (string.IsNullOrWhiteSpace(newName))
        {
            throw new RenameValidationException("The new name cannot be empty.");
        }

        if (kind == XamlRenameKind.Name)
        {
            if (!NamePattern.IsMatch(newName))
            {
                throw new RenameValidationException(
                    $"'{newName}' is not a valid x:Name. A name must start with a letter or underscore and " +
                    "contain only letters, digits, and underscores.");
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

    /// <summary>True when offset falls within range (inclusive on both ends, matching the caret-containment used elsewhere), so a caret at either boundary of the token resolves to that occurrence.</summary>
    private static bool RangeContainsOffset(TextDocument doc, Lsp.Range range, int offset)
    {
        var start = doc.OffsetAt(range.Start);
        var end = doc.OffsetAt(range.End);
        return offset >= start && offset <= end;
    }
}
