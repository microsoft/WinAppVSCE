using System.Text.RegularExpressions;
using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Xaml;

namespace WinUiXaml.LanguageServer;

/// <summary>The kind of symbol a rename targets. Drives new-name validation.</summary>
internal enum XamlRenameKind
{
    /// <summary>An <c>x:Name</c>/bare <c>Name</c> — must stay a legal identifier (it backs a generated field).</summary>
    Name,

    /// <summary>An <c>x:Key</c> resource key — permissive, but may not contain characters that would break the
    /// XML attribute value or start a markup extension.</summary>
    Key,
}

/// <summary>
/// Raised when a requested rename target name is invalid. The message is surfaced to the user (the language
/// server turns a handler exception into a JSON-RPC error response), so a rename can never silently corrupt
/// the markup or the generated code-behind field.
/// </summary>
internal sealed class RenameValidationException : System.Exception
{
    public RenameValidationException(string message) : base(message) { }
}

/// <summary>
/// Computes <c>textDocument/prepareRename</c> and <c>textDocument/rename</c> for WinUI XAML. Renames an
/// <c>x:Name</c>/<c>Name</c> or an <c>x:Key</c> resource key and every reference to it within the document,
/// reusing the same occurrence engine that powers Find All References and Document Highlights (so the edit
/// set is always identical to what the user sees highlighted).
/// <para>
/// Scope: XAML-only. The declaration plus its XAML references (<c>ElementName=</c>, <c>Storyboard.TargetName</c>,
/// and <c>{StaticResource}</c>/<c>{ThemeResource}</c>/<c>{CustomResource}</c> usages) are rewritten. Code-behind
/// field references to an <c>x:Name</c> are NOT updated here (that is a cross-file C# refactor); the editor's
/// rename preview lets the user review every edit before applying.
/// </para>
/// </summary>
internal static class XamlRename
{
    // An x:Name backs a generated C# field, so it must be a legal identifier.
    private static readonly Regex NamePattern = new(@"^[A-Za-z_][A-Za-z0-9_]*$", RegexOptions.Compiled);

    // Characters that would break out of the quoted attribute value or start a markup extension.
    private static readonly char[] KeyForbidden = { '"', '\'', '<', '>', '&', '{', '}' };

    /// <summary>
    /// Validates the caret and returns the exact token range to make editable plus the current name as the
    /// placeholder, or null when the caret is not on a renameable symbol.
    /// </summary>
    internal static PrepareRenameResult? PrepareRename(TextDocument doc, int offset)
    {
        if (doc.Parsed.Root is not { } root)
        {
            return null;
        }

        if (XamlLanguageServer.DetectSymbolAt(doc, offset) is not { } symbol)
        {
            return null;
        }

        var occurrences = XamlLanguageServer.ResolveOccurrences(doc, root, offset);
        if (occurrences is null)
        {
            return null;
        }

        // Return the range of the specific occurrence the caret sits in (declaration or usage) so the editor
        // seeds the rename box over the token under the cursor, not some other occurrence.
        foreach (var occurrence in occurrences)
        {
            if (RangeContainsOffset(doc, occurrence.Range, offset))
            {
                return new PrepareRenameResult { Range = occurrence.Range, Placeholder = symbol.Name };
            }
        }

        return null;
    }

    /// <summary>
    /// Builds a single-document <see cref="WorkspaceEdit"/> renaming the symbol under the caret and every
    /// reference to it. Throws <see cref="RenameValidationException"/> when <paramref name="newName"/> is
    /// invalid for the symbol kind. Returns null when the caret is not on a renameable symbol.
    /// </summary>
    internal static WorkspaceEdit? Rename(TextDocument doc, int offset, string newName)
    {
        if (doc.Parsed.Root is not { } root)
        {
            return null;
        }

        if (XamlLanguageServer.DetectSymbolAt(doc, offset) is not { } symbol)
        {
            return null;
        }

        // Gate on the renameable location first (this also rejects carets inside malformed/unterminated
        // markup), so an invalid-name error is only raised when the caret is genuinely on a symbol.
        var occurrences = XamlLanguageServer.ResolveOccurrences(doc, root, offset);
        if (occurrences is null || occurrences.Count == 0)
        {
            return null;
        }

        // The caret must sit on one of the occurrences (the declaration or a usage). PrepareRename enforces
        // this, but a client can invoke rename directly without a prepareRename round-trip (e.g. VS Code's
        // executeDocumentRenameProvider), so re-check here: a caret in the value's surrounding whitespace or
        // otherwise off-token is not renameable and must not mutate every occurrence.
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

    /// <summary>True when <paramref name="offset"/> falls within <paramref name="range"/> (inclusive on both
    /// ends, matching the caret-containment used elsewhere), so a caret at either boundary of the token
    /// resolves to that occurrence.</summary>
    private static bool RangeContainsOffset(TextDocument doc, Lsp.Range range, int offset)
    {
        var start = doc.OffsetAt(range.Start);
        var end = doc.OffsetAt(range.End);
        return offset >= start && offset <= end;
    }
}
