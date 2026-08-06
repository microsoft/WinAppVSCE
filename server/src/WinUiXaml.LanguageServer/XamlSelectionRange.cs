using System.Collections.Generic;
using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Xaml;

namespace WinUiXaml.LanguageServer;

/// <summary>
/// Computes LSP <c>selectionRange</c> chains for "smart" expand/shrink selection. For each requested
/// position it walks the tolerant XAML syntax tree from the innermost node outward, producing a strictly
/// nested sequence of ranges: an attribute value's inner text -&gt; the quoted value -&gt; the whole
/// attribute -&gt; the element's open tag -&gt; the whole element -&gt; each ancestor element -&gt; the
/// document. Purely syntactic and read-only, so there is no content-corruption vector; the only invariants
/// are that every range contains the caret and each parent strictly contains its child.
/// </summary>
internal static class XamlSelectionRange
{
    public static List<SelectionRange> Compute(TextDocument doc, IReadOnlyList<Position>? positions)
    {
        var result = new List<SelectionRange>();
        if (positions == null)
        {
            return result;
        }

        foreach (var position in positions)
        {
            result.Add(ForPosition(doc, doc.OffsetAt(position)));
        }

        return result;
    }

    private static SelectionRange ForPosition(TextDocument doc, int offset)
    {
        var spans = CollectSpans(doc, offset);

        // Build the linked list from the outermost span inward so each node points at its parent.
        SelectionRange? parent = null;
        for (int i = spans.Count - 1; i >= 0; i--)
        {
            parent = new SelectionRange { Range = doc.RangeOf(spans[i]), Parent = parent };
        }

        return parent!;
    }

    /// <summary>Returns the strictly-nested spans covering <paramref name="offset"/>, innermost first.</summary>
    private static List<TextSpan> CollectSpans(TextDocument doc, int offset)
    {
        var candidates = new List<TextSpan>();

        void Add(TextSpan span)
        {
            if (span.End > span.Start && span.ContainsInclusive(offset))
            {
                candidates.Add(span);
            }
        }

        // The node chain plus a couple of finer sub-spans that are not their own nodes (the value's inner
        // text and an element's open tag) so expand/shrink stops at the places a XAML author expects.
        for (XamlNode? node = doc.Parsed.FindNode(offset); node != null; node = node.Parent)
        {
            if (node is XamlAttributeValue value)
            {
                Add(value.InnerSpan);
            }

            Add(node.Span);

            if (node is XamlElement element)
            {
                Add(element.OpenTagSpan);
            }
        }

        // Guaranteed outermost level, even for positions in trailing whitespace outside the root element.
        Add(new TextSpan(0, doc.Text.Length));

        var seen = new HashSet<(int, int)>();
        var distinct = new List<TextSpan>();
        foreach (var span in candidates)
        {
            if (seen.Add((span.Start, span.End)))
            {
                distinct.Add(span);
            }
        }

        // Innermost -> outermost: shorter spans first; for equal length prefer the one starting later.
        distinct.Sort((a, b) =>
        {
            int byLength = a.Length.CompareTo(b.Length);
            if (byLength != 0)
            {
                return byLength;
            }

            int byStart = b.Start.CompareTo(a.Start);
            return byStart != 0 ? byStart : a.End.CompareTo(b.End);
        });

        var chain = new List<TextSpan>();
        foreach (var span in distinct)
        {
            if (chain.Count == 0)
            {
                chain.Add(span);
                continue;
            }

            TextSpan inner = chain[chain.Count - 1];
            bool contains = span.Start <= inner.Start && span.End >= inner.End;
            bool strictly = contains && (span.Start < inner.Start || span.End > inner.End);
            if (strictly)
            {
                chain.Add(span);
            }
        }

        if (chain.Count == 0)
        {
            // Degenerate (e.g. empty document): a single caret-sized range keeps the response well-formed.
            chain.Add(new TextSpan(0, doc.Text.Length));
        }

        return chain;
    }
}
