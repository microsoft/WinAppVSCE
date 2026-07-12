using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Xaml;

namespace WinUiXaml.LanguageServer;

/// <summary>
/// Computes LSP <c>linkedEditingRange</c> responses so VS Code renames an element's matching open and
/// end tag names together as the user types (Visual Studio's "auto-rename tag" behavior). Purely
/// syntactic and read-only: we only return the two name ranges plus a word pattern; the editor performs
/// the synchronized edit. We link ONLY when the caret is on a tag name AND the element has BOTH an open
/// and an end tag whose names currently match, so two different names are never fused into one edit
/// (a self-closing tag, an unclosed element, or a mismatched pair such as <c>&lt;Grid&gt;&lt;/Span&gt;</c>
/// yields nothing).
/// </summary>
internal static class XamlLinkedEditing
{
    // Valid XAML element-name characters: a letter/underscore start, then letters/digits/_ plus '.', ':'
    // and '-' so a namespace prefix (local:Foo) and a dotted property-element name (Grid.RowDefinitions)
    // keep the link alive while the name is being edited. Without this pattern VS Code's default word
    // separators would break the link the moment the user typed a ':' or '.'.
    private const string TagNameWordPattern = "[_a-zA-Z][a-zA-Z0-9_.:-]*";

    public static LinkedEditingRanges? Compute(TextDocument doc, Position position)
    {
        int offset = doc.OffsetAt(position);

        // The tolerant parser exposes a tag name as a XamlName (not its own node), so a caret on a tag
        // name resolves to the enclosing element via FindNode. Walk up to the nearest element in case the
        // caret sits on a descendant node (an attribute or content) — we filter that out below.
        XamlElement? element = null;
        for (XamlNode? node = doc.Parsed.FindNode(offset); node != null; node = node.Parent)
        {
            if (node is XamlElement e)
            {
                element = e;
                break;
            }
        }

        if (element is null || element.Name is null || !element.HasEndTag || element.EndTagName is null)
        {
            // Self-closing, unclosed, or a malformed open tag: there is no matching pair to link.
            return null;
        }

        // Only link when the tags currently agree. A mismatched pair is mid-edit and must not be fused;
        // FullName compares prefix + local so local:Foo links to </local:Foo> but not to </Foo>.
        if (!string.Equals(element.Name.FullName, element.EndTagName.FullName, System.StringComparison.Ordinal))
        {
            return null;
        }

        TextSpan openName = element.Name.Span;
        TextSpan closeName = element.EndTagName.Span;

        // Act only when the caret is actually on one of the two names (not on '<', an attribute, or the
        // element's content). Inclusive bounds so a caret at either edge of the name still links.
        if (!openName.ContainsInclusive(offset) && !closeName.ContainsInclusive(offset))
        {
            return null;
        }

        return new LinkedEditingRanges
        {
            Ranges = new[] { doc.RangeOf(openName), doc.RangeOf(closeName) },
            WordPattern = TagNameWordPattern,
        };
    }
}
