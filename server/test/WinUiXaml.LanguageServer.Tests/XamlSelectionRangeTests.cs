using System.Collections.Generic;
using WinUiXaml.LanguageServer.Lsp;
using Xunit;

namespace WinUiXaml.LanguageServer.Tests;

/// <summary>
/// Hermetic coverage for <see cref="XamlSelectionRange"/>. Selection ranges are read-only, so the
/// correctness concerns are structural: every emitted range must contain the caret, each parent must
/// STRICTLY contain its child (no equal or inverted spans), the outermost range is the whole document,
/// and the granularity stops at author-meaningful boundaries (value inner text, quoted value, attribute,
/// open tag, element, ancestors). Malformed and degenerate inputs must still yield a well-formed chain.
/// </summary>
public class XamlSelectionRangeTests
{
    private static (TextDocument Doc, int Offset) Caret(string textWithCaret)
    {
        int offset = textWithCaret.IndexOf('|');
        Assert.True(offset >= 0, "test input must contain a '|' caret marker");
        string text = textWithCaret.Remove(offset, 1);
        return (new TextDocument("file:///t.xaml", text), offset);
    }

    // Flattened chain innermost -> outermost as (start,end) offsets.
    private static List<(int Start, int End)> Chain(TextDocument doc, int offset)
    {
        var results = XamlSelectionRange.Compute(doc, new[] { doc.PositionAt(offset) });
        var sr = Assert.Single(results);
        var chain = new List<(int, int)>();
        for (SelectionRange? cur = sr; cur != null; cur = cur.Parent)
        {
            chain.Add((doc.OffsetAt(cur.Range.Start), doc.OffsetAt(cur.Range.End)));
        }

        return chain;
    }

    private static string TextOf(TextDocument doc, (int Start, int End) span) =>
        doc.Text.Substring(span.Start, span.End - span.Start);

    private static void AssertWellFormed(List<(int Start, int End)> chain, int caret, int docLength)
    {
        Assert.NotEmpty(chain);
        foreach (var level in chain)
        {
            Assert.True(level.Start <= caret && caret <= level.End, $"level {level} must contain caret {caret}");
        }

        for (int i = 0; i + 1 < chain.Count; i++)
        {
            var inner = chain[i];
            var outer = chain[i + 1];
            bool contains = outer.Start <= inner.Start && outer.End >= inner.End;
            bool strictly = contains && (outer.Start < inner.Start || outer.End > inner.End);
            Assert.True(strictly, $"level {outer} must strictly contain {inner}");
        }

        Assert.Equal((0, docLength), chain[^1]);
    }

    [Fact]
    public void InsideAttributeValue_ExpandsThroughValueAttributeOpenTagElement()
    {
        var (doc, offset) = Caret("<Grid Background=\"#FF00|00\" />");
        var chain = Chain(doc, offset);
        AssertWellFormed(chain, offset, doc.Text.Length);

        // innermost stop is the inner value text (no quotes), then the quoted value, then the attribute.
        Assert.Equal("#FF0000", TextOf(doc, chain[0]));
        Assert.Contains(chain, s => TextOf(doc, s) == "\"#FF0000\"");
        Assert.Contains(chain, s => TextOf(doc, s) == "Background=\"#FF0000\"");
    }

    [Fact]
    public void NestedElements_ProduceAncestorElementLevels()
    {
        const string text = "<Page>\n  <Grid>\n    <Button Content=\"Hi\" />\n  </Grid>\n</Page>";
        int at = text.IndexOf("Hi", System.StringComparison.Ordinal) + 1; // caret inside "Hi"
        var doc = new TextDocument("file:///t.xaml", text);
        var chain = Chain(doc, at);
        AssertWellFormed(chain, at, doc.Text.Length);

        Assert.Contains(chain, s => TextOf(doc, s).StartsWith("<Button") && TextOf(doc, s).EndsWith("/>"));
        Assert.Contains(chain, s => TextOf(doc, s).StartsWith("<Grid>") && TextOf(doc, s).EndsWith("</Grid>"));
        Assert.Contains(chain, s => TextOf(doc, s).StartsWith("<Page>") && TextOf(doc, s).EndsWith("</Page>"));
    }

    [Fact]
    public void OnElementTagName_StopsAtOpenTagThenWholeElement()
    {
        var (doc, offset) = Caret("<Gr|id>\n  <Button />\n</Grid>");
        var chain = Chain(doc, offset);
        AssertWellFormed(chain, offset, doc.Text.Length);

        // open tag "<Grid>" is a finer stop than the whole element "<Grid>...</Grid>".
        Assert.Contains(chain, s => TextOf(doc, s) == "<Grid>");
        Assert.Contains(chain, s => TextOf(doc, s).StartsWith("<Grid>") && TextOf(doc, s).EndsWith("</Grid>"));
    }

    [Fact]
    public void MalformedUnterminatedMarkup_StillWellFormed()
    {
        var (doc, offset) = Caret("<Grid><Button Content=\"x|x\"");
        var chain = Chain(doc, offset);
        AssertWellFormed(chain, offset, doc.Text.Length);
        Assert.Equal("xx", TextOf(doc, chain[0]));
    }

    [Fact]
    public void EmptyDocument_ReturnsSingleWellFormedRange()
    {
        var doc = new TextDocument("file:///t.xaml", string.Empty);
        var results = XamlSelectionRange.Compute(doc, new[] { new Position(0, 0) });
        var sr = Assert.Single(results);
        Assert.Null(sr.Parent);
        Assert.Equal(0, doc.OffsetAt(sr.Range.Start));
        Assert.Equal(0, doc.OffsetAt(sr.Range.End));
    }

    [Fact]
    public void MultiplePositions_ReturnsOneChainPerPositionInOrder()
    {
        const string text = "<Grid Background=\"#FF0000\"><Button Content=\"Hi\" /></Grid>";
        var doc = new TextDocument("file:///t.xaml", text);
        int p1 = text.IndexOf("#FF0000", System.StringComparison.Ordinal) + 2;
        int p2 = text.IndexOf("Hi", System.StringComparison.Ordinal) + 1;
        var results = XamlSelectionRange.Compute(doc, new[] { doc.PositionAt(p1), doc.PositionAt(p2) });
        Assert.Equal(2, results.Count);

        // first chain's innermost is the color literal, second's is the "Hi" text
        Assert.Equal("#FF0000", doc.Text.Substring(doc.OffsetAt(results[0].Range.Start), doc.OffsetAt(results[0].Range.End) - doc.OffsetAt(results[0].Range.Start)));
        Assert.Equal("Hi", doc.Text.Substring(doc.OffsetAt(results[1].Range.Start), doc.OffsetAt(results[1].Range.End) - doc.OffsetAt(results[1].Range.Start)));
    }

    [Fact]
    public void CaretAtEndOfDocument_IsWellFormed()
    {
        const string text = "<Grid />";
        var doc = new TextDocument("file:///t.xaml", text);
        var chain = Chain(doc, text.Length);
        AssertWellFormed(chain, text.Length, doc.Text.Length);
    }

    [Fact]
    public void EmptyPositions_ReturnsEmptyList()
    {
        var doc = new TextDocument("file:///t.xaml", "<Grid />");
        Assert.Empty(XamlSelectionRange.Compute(doc, System.Array.Empty<Position>()));
    }

    // Regression: a caret in trailing whitespace after a self-closing root must still yield a
    // strictly-nested chain from OUR provider (no duplicate/coincident levels). The round-39 red-team
    // observed a duplicate innermost level ONLY through VS Code's editor command, which MERGES our
    // provider's chain with VS Code's built-in (word/bracket) selection-range providers; the built-in
    // contribution emitted two equal ranges. Our provider itself is correct, as pinned here for both
    // LF and CRLF buffers (CRLF is what VS Code stores on Windows).
    [Theory]
    [InlineData("<Grid />\n    \n")]
    [InlineData("<Grid />\r\n    \r\n")]
    public void TrailingWhitespaceAfterRoot_StrictlyNestedNoDuplicateLevels(string text)
    {
        var doc = new TextDocument("file:///t.xaml", text);
        int offset = doc.OffsetAt(new Position(1, 2)); // caret inside the trailing whitespace run
        var chain = Chain(doc, offset);
        AssertWellFormed(chain, offset, doc.Text.Length);

        // Every level's offset span is distinct (strict nesting already implies this, but assert it
        // explicitly since the reported symptom was two identical levels).
        Assert.Equal(chain.Count, new HashSet<(int, int)>(chain).Count);
    }
}
