using System;
using System.Collections.Generic;
using System.Linq;
using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Xaml;

namespace WinUiXaml.LanguageServer;

/// <summary>Formats leading indentation without changing document tokens or significant whitespace.</summary>
internal static class XamlFormatter
{
    /// <summary>Produces safe leading-indentation edits within an optional range.</summary>
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

                // Safety: we only ever replace a pure run of spaces/tabs. This always holds because firstNonWs advanced over spaces/tabs only; the guard makes that invariant explicit.
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

    /// <summary>Reindents only the line whose tag was completed by typing &gt;.</summary>
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

    /// <summary>Records, for every structural token whose leading indentation is safe to normalize, its desired nesting depth.</summary>
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

    /// <summary>True when it is safe to reindent the direct children of element: false for an xml:space="preserve" element and for any element carrying mixed (inline non-whitespace text) or CDATA</summary>
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
