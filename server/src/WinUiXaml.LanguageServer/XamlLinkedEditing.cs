using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Xaml;

namespace WinUiXaml.LanguageServer;

/// <summary>Links matching open and end tag names for synchronized editing.</summary>
internal static class XamlLinkedEditing
{
    // Include namespace and property-element separators in the linked name.
    private const string TagNameWordPattern = "[_a-zA-Z][a-zA-Z0-9_.:-]*";

    public static LinkedEditingRanges? Compute(TextDocument doc, Position position)
    {
        int offset = doc.OffsetAt(position);

        // The tolerant parser exposes a tag name as a XamlName (not its own node), so a caret on a tag name resolves to the enclosing element via FindNode. Walk up to the nearest element in case the caret sits on a descendant node (an attribute or content) — we filter that out below.
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

        // Only link when the tags currently agree. A mismatched pair is mid-edit and must not be fused; FullName compares prefix + local so local:Foo links to </local:Foo> but not to </Foo>.
        if (!string.Equals(element.Name.FullName, element.EndTagName.FullName, System.StringComparison.Ordinal))
        {
            return null;
        }

        TextSpan openName = element.Name.Span;
        TextSpan closeName = element.EndTagName.Span;

        // Act only when the caret is actually on one of the two names (not on '<', an attribute, or the element's content). Inclusive bounds so a caret at either edge of the name still links.
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
