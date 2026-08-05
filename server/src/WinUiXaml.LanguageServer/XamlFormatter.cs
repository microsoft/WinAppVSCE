using System;
using System.Collections.Generic;
using System.Linq;
using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Xaml;

namespace WinUiXaml.LanguageServer;

/// <summary>
/// A deliberately conservative XAML document formatter. It ONLY normalizes the leading indentation of
/// structural lines (element open/end tags and comments) to match their element-nesting depth. It never
/// reorders attributes, reflows wrapped attribute lines, trims trailing whitespace, or touches any
/// non-leading-whitespace text. Lines inside an <c>xml:space="preserve"</c> subtree, or inside an element
/// with mixed (inline-text) or CDATA content, are left byte-for-byte identical so significant whitespace
/// is preserved. Every emitted edit replaces only a run of spaces/tabs at the start of a line with another
/// run of spaces/tabs, so by construction the formatter can only ever change indentation -- never the
/// document's tokens or content. Under-formatting is acceptable; corrupting a document is not.
/// </summary>
internal static class XamlFormatter
{
    /// <summary>
    /// Produces the minimal set of leading-indentation edits for <paramref name="doc"/>. When
    /// <paramref name="range"/> is supplied (range formatting) only edits on lines intersecting the range
    /// are returned. Returns an empty list when there is nothing safe to reindent.
    /// </summary>
    public static List<TextEdit> Format(TextDocument doc, FormattingOptions options, Lsp.Range? range = null)
    {
        var edits = new List<TextEdit>();
        var text = doc.Text;
        if (string.IsNullOrEmpty(text) || doc.Parsed.Root is null)
        {
            return edits;
        }

        // Desired depth keyed by the start offset of each safe, reindentable structural token.
        var depthByOffset = new Dictionary<int, int>();
        foreach (var node in doc.Parsed.Contents)
        {
            CollectIndents(node, depth: 0, ancestorsSafe: true, depthByOffset);
        }

        if (depthByOffset.Count == 0)
        {
            return edits;
        }

        string unit = options.InsertSpaces ? new string(' ', Math.Max(1, options.TabSize)) : "\t";

        int lineStart = 0;
        int line = 0;
        for (int i = 0; i <= text.Length; i++)
        {
            if (i != text.Length && text[i] != '\n')
            {
                continue;
            }

            // The current line occupies [lineStart, i); a trailing '\r' (CRLF) sits just before i.
            int firstNonWs = lineStart;
            while (firstNonWs < i && (text[firstNonWs] == ' ' || text[firstNonWs] == '\t'))
            {
                firstNonWs++;
            }

            if (depthByOffset.TryGetValue(firstNonWs, out int depth))
            {
                int leadingLength = firstNonWs - lineStart;
                string current = text.Substring(lineStart, leadingLength);
                string desired = Repeat(unit, depth);

                // Safety: we only ever replace a pure run of spaces/tabs. This always holds because
                // firstNonWs advanced over spaces/tabs only; the guard makes that invariant explicit.
                bool leadingIsWhitespace = current.All(c => c == ' ' || c == '\t');

                if (leadingIsWhitespace && (range is null || IntersectsRange(line, range.Value)))
                {
                    var edit = CreateIndentEdit(line, leadingLength, current, desired);
                    if (edit is not null)
                    {
                        edits.Add(edit);
                    }
                }
            }

            lineStart = i + 1;
            line++;
        }

        return edits;
    }

    /// <summary>
    /// Reindents only the line whose tag was completed by typing <c>&gt;</c>. Other characters produce no
    /// edits, keeping the on-type path bounded and avoiding document-wide work on each keystroke.
    /// </summary>
    public static List<TextEdit> FormatOnType(
        TextDocument doc,
        FormattingOptions options,
        Position position,
        string character)
    {
        if (!string.Equals(character, ">", StringComparison.Ordinal))
        {
            return new List<TextEdit>();
        }

        int completedOffset = doc.OffsetAt(position) - 1;
        if (completedOffset < 0)
        {
            return new List<TextEdit>();
        }

        XamlElement? element = null;
        for (var node = doc.Parsed.FindNode(completedOffset); node is not null; node = node.Parent)
        {
            if (node is XamlElement candidate &&
                (candidate.OpenTagSpan.Contains(completedOffset) ||
                 candidate.EndTagSpan is { } endTag && endTag.Contains(completedOffset)))
            {
                element = candidate;
                break;
            }
        }

        if (element is null)
        {
            return new List<TextEdit>();
        }

        bool isEndTag = element.EndTagSpan is { } endSpan && endSpan.Contains(completedOffset);
        int depth = 0;
        for (var ancestor = element.Parent; ancestor is not null; ancestor = ancestor.Parent)
        {
            if (ancestor is XamlElement parent)
            {
                if (!IsContentSafe(parent))
                {
                    return new List<TextEdit>();
                }

                depth++;
            }
        }

        if (isEndTag && !IsContentSafe(element))
        {
            return new List<TextEdit>();
        }

        int lineStart = doc.OffsetAt(new Position(position.Line, 0));
        int firstNonWhitespace = lineStart;
        while (firstNonWhitespace < doc.Text.Length &&
               doc.Text[firstNonWhitespace] is ' ' or '\t')
        {
            firstNonWhitespace++;
        }

        int tokenStart = isEndTag ? element.EndTagSpan!.Value.Start : element.OpenTagSpan.Start;
        if (firstNonWhitespace != tokenStart)
        {
            return new List<TextEdit>();
        }

        string unit = options.InsertSpaces ? new string(' ', Math.Max(1, options.TabSize)) : "\t";
        string desired = Repeat(unit, depth);
        string current = doc.Text.Substring(lineStart, firstNonWhitespace - lineStart);
        var edit = CreateIndentEdit(
            position.Line,
            firstNonWhitespace - lineStart,
            current,
            desired);
        return edit is null ? new List<TextEdit>() : new List<TextEdit> { edit };
    }

    private static TextEdit? CreateIndentEdit(
        int line,
        int leadingLength,
        string current,
        string desired) =>
        string.Equals(current, desired, StringComparison.Ordinal)
            ? null
            : new TextEdit
            {
                Range = new Lsp.Range(
                    new Position(line, 0),
                    new Position(line, leadingLength)),
                NewText = desired,
            };

    /// <summary>
    /// Records, for every structural token whose leading indentation is safe to normalize, its desired
    /// nesting depth. An element's open tag is governed by its ancestors' safety; its end tag is governed
    /// by its own content safety (the whitespace just before <c>&lt;/Tag&gt;</c> belongs to that element's
    /// content). Text, CDATA, and processing-instruction lines are never reindented.
    /// </summary>
    private static void CollectIndents(XamlNode node, int depth, bool ancestorsSafe, Dictionary<int, int> map)
    {
        switch (node)
        {
            case XamlElement element:
                if (ancestorsSafe)
                {
                    map[element.OpenTagSpan.Start] = depth;
                }

                bool selfSafe = ancestorsSafe && IsContentSafe(element);
                foreach (var child in element.Content)
                {
                    CollectIndents(child, depth + 1, selfSafe, map);
                }

                if (selfSafe && element.EndTagSpan is { } endSpan)
                {
                    map[endSpan.Start] = depth;
                }

                break;

            case XamlComment comment when ancestorsSafe:
                map[comment.Span.Start] = depth;
                break;
        }
    }

    /// <summary>
    /// True when it is safe to reindent the direct children of <paramref name="element"/>: false for an
    /// <c>xml:space="preserve"</c> element and for any element carrying mixed (inline non-whitespace text)
    /// or CDATA content, where inner whitespace is significant.
    /// </summary>
    private static bool IsContentSafe(XamlElement element)
    {
        if (element.GetAttribute("xml:space") is { Value: { } spaceValue } &&
            string.Equals(spaceValue.Text.Trim(), "preserve", StringComparison.Ordinal))
        {
            return false;
        }

        foreach (var child in element.Content)
        {
            if (child is XamlText { IsWhitespace: false } or XamlCData)
            {
                return false;
            }
        }

        return true;
    }

    private static bool IntersectsRange(int line, Lsp.Range range) =>
        line >= range.Start.Line && line <= range.End.Line;

    private static string Repeat(string unit, int count)
    {
        if (count <= 0)
        {
            return string.Empty;
        }

        return unit.Length == 1 ? new string(unit[0], count) : string.Concat(Enumerable.Repeat(unit, count));
    }
}
