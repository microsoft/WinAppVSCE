using System.Collections.Generic;
using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Xaml;

namespace WinUiXaml.LanguageServer;

/// <summary>Computes multi-line XAML folding ranges.</summary>
internal static class XamlFolding
{
    public static List<FoldingRange> Compute(TextDocument doc)
    {
        var ranges = new List<FoldingRange>();
        var comments = new List<XamlComment>();

        foreach (var node in doc.Parsed.Contents)
        {
            Visit(doc, node, ranges, comments);
        }

        AddRegionFolds(doc, comments, ranges);
        return Deduplicate(ranges);
    }

    // Collapses ranges that cover an identical line span, preferring a specific kind (comment/region) over a structural fold.
    private static List<FoldingRange> Deduplicate(List<FoldingRange> ranges)
    {
        var best = new Dictionary<(int Start, int End), FoldingRange>();
        var order = new List<(int Start, int End)>();
        foreach (var range in ranges)
        {
            var key = (range.StartLine, range.EndLine);
            if (best.TryGetValue(key, out var existing))
            {
                if (existing.Kind == null && range.Kind != null)
                {
                    best[key] = range;
                }
            }
            else
            {
                best[key] = range;
                order.Add(key);
            }
        }

        var result = new List<FoldingRange>(order.Count);
        foreach (var key in order)
        {
            result.Add(best[key]);
        }

        return result;
    }

    private static void Visit(TextDocument doc, XamlNode node, List<FoldingRange> ranges, List<XamlComment> comments)
    {
        switch (node)
        {
            case XamlElement element:
                AddElementFold(doc, element, ranges);
                foreach (var child in element.Content)
                {
                    Visit(doc, child, ranges, comments);
                }

                break;

            case XamlComment comment:
                comments.Add(comment);
                AddFold(doc, comment.Span.Start, comment.Span.End, FoldingRangeKind.Comment, ranges);
                break;

            case XamlCData cdata:
                AddFold(doc, cdata.Span.Start, cdata.Span.End, kind: null, ranges);
                break;
        }
    }

    private static void AddElementFold(TextDocument doc, XamlElement element, List<FoldingRange> ranges)
    {
        // Fold from the line the open tag starts on down to the line the end tag starts on.
        int startLine = doc.PositionAt(element.OpenTagSpan.Start).Line;

        if (element.EndTagSpan is { } endTag)
        {
            EmitLines(startLine, doc.PositionAt(endTag.Start).Line, kind: null, ranges);
            return;
        }

        if (element.IsSelfClosing)
        {
            return;
        }

        // Unterminated element: fold across whatever content the parser attached to it.
        var end = doc.PositionAt(element.Span.End);
        int endLine = end.Character == 0 && end.Line > startLine ? end.Line - 1 : end.Line;
        EmitLines(startLine, endLine, kind: null, ranges);
    }

    private static void AddRegionFolds(TextDocument doc, List<XamlComment> comments, List<FoldingRange> ranges)
    {
        // Pair <!-- #region --> with the next unmatched <!-- #endregion --> using a stack, so nested regions fold correctly. Unbalanced markers are ignored (never invert or crash).
        var open = new Stack<XamlComment>();
        foreach (var comment in comments)
        {
            var kind = ClassifyRegion(comment.Text);
            if (kind == RegionMarker.Start)
            {
                open.Push(comment);
            }
            else if (kind == RegionMarker.End && open.Count > 0)
            {
                var start = open.Pop();
                EmitLines(
                    doc.PositionAt(start.Span.Start).Line,
                    doc.PositionAt(comment.Span.Start).Line,
                    FoldingRangeKind.Region,
                    ranges);
            }
        }
    }

    private enum RegionMarker
    {
        None,
        Start,
        End,
    }

    /// <summary>Classifies a comment's inner text as a <c>#region</c>/<c>#endregion</c> marker.</summary>
    private static RegionMarker ClassifyRegion(string innerText)
    {
        string trimmed = innerText.Trim();

        // Check #endregion first: "#endregion" does not start with "#region", but guard order keeps intent obvious and is robust to any future prefix overlap.
        if (StartsWithMarker(trimmed, "#endregion"))
        {
            return RegionMarker.End;
        }

        if (StartsWithMarker(trimmed, "#region"))
        {
            return RegionMarker.Start;
        }

        return RegionMarker.None;
    }

    // A marker matches when the trimmed text is exactly the marker or the marker followed by whitespace (an optional label). This avoids matching identifiers like "#regionalize".
    private static bool StartsWithMarker(string trimmed, string marker)
    {
        if (!trimmed.StartsWith(marker, System.StringComparison.Ordinal))
        {
            return false;
        }

        return trimmed.Length == marker.Length || char.IsWhiteSpace(trimmed[marker.Length]);
    }

    private static void AddFold(TextDocument doc, int startOffset, int endOffset, string? kind, List<FoldingRange> ranges)
    {
        int startLine = doc.PositionAt(startOffset).Line;
        var end = doc.PositionAt(endOffset);
        int endLine = end.Character == 0 && end.Line > startLine ? end.Line - 1 : end.Line;
        EmitLines(startLine, endLine, kind, ranges);
    }

    private static void EmitLines(int startLine, int endLine, string? kind, List<FoldingRange> ranges)
    {
        if (endLine > startLine)
        {
            ranges.Add(new FoldingRange { StartLine = startLine, EndLine = endLine, Kind = kind });
        }
    }
}
