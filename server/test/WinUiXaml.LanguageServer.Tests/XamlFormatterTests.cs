using System.Collections.Generic;
using System.Linq;
using System.Text;
using WinUiXaml.LanguageServer.Lsp;
using Xunit;

namespace WinUiXaml.LanguageServer.Tests;

/// <summary>
/// Hermetic coverage for <see cref="XamlFormatter"/>. The formatter is deliberately conservative: it only
/// normalizes the leading indentation of structural lines and must NEVER alter any non-leading-whitespace
/// content. These tests lock both the indentation behavior and — crucially — the content-preservation
/// invariant across malformed, mixed-content, and <c>xml:space="preserve"</c> inputs.
/// </summary>
public class XamlFormatterTests
{
    private static string Lines(params string[] lines) => string.Join("\n", lines);

    private static string Format(string text, int tabSize = 2, bool insertSpaces = true, Lsp.Range? range = null)
    {
        var doc = new TextDocument("file:///test.xaml", text);
        var edits = XamlFormatter.Format(doc, new FormattingOptions { TabSize = tabSize, InsertSpaces = insertSpaces }, range);
        return Apply(text, edits, doc);
    }

    private static string Apply(string text, List<TextEdit> edits, TextDocument doc)
    {
        var sb = new StringBuilder(text);
        foreach (var (start, end, newText) in edits
                     .Select(e => (start: doc.OffsetAt(e.Range.Start), end: doc.OffsetAt(e.Range.End), e.NewText))
                     .OrderByDescending(x => x.start))
        {
            sb.Remove(start, end - start);
            sb.Insert(start, newText);
        }

        return sb.ToString();
    }

    /// <summary>The core safety invariant: stripping leading whitespace from every line yields identical
    /// text before and after. Any violation means the formatter changed something other than indentation.</summary>
    private static void AssertOnlyIndentChanged(string before, string after)
    {
        static string Strip(string s) =>
            string.Join("\n", s.Replace("\r\n", "\n").Split('\n').Select(l => l.TrimStart(' ', '\t')));

        Assert.Equal(Strip(before), Strip(after));
    }

    [Fact]
    public void NormalizesNestingIndentation()
    {
        var input = Lines("<Page>", "<Grid>", "<Button />", "</Grid>", "</Page>");
        var expected = Lines("<Page>", "  <Grid>", "    <Button />", "  </Grid>", "</Page>");
        Assert.Equal(expected, Format(input));
    }

    [Fact]
    public void CollapsesOverIndentation()
    {
        var input = Lines("<Page>", "            <Grid>", "                    <Button />", "  </Grid>", "</Page>");
        var expected = Lines("<Page>", "  <Grid>", "    <Button />", "  </Grid>", "</Page>");
        Assert.Equal(expected, Format(input));
    }

    [Fact]
    public void IsIdempotent()
    {
        var input = Lines("<Page>", "<Grid>", "<Border>", "<TextBlock />", "</Border>", "</Grid>", "</Page>");
        var once = Format(input);
        var twice = Format(once);
        Assert.Equal(once, twice);
    }

    [Fact]
    public void IndentsPropertyElements()
    {
        var input = Lines("<Grid>", "<Grid.RowDefinitions>", "<RowDefinition />", "</Grid.RowDefinitions>", "</Grid>");
        var expected = Lines("<Grid>", "  <Grid.RowDefinitions>", "    <RowDefinition />", "  </Grid.RowDefinitions>", "</Grid>");
        Assert.Equal(expected, Format(input));
    }

    [Fact]
    public void ReindentsComments()
    {
        var input = Lines("<Page>", "<!-- a note -->", "<Grid />", "</Page>");
        var expected = Lines("<Page>", "  <!-- a note -->", "  <Grid />", "</Page>");
        Assert.Equal(expected, Format(input));
    }

    [Fact]
    public void HonorsTabIndentation()
    {
        var input = Lines("<Page>", "<Grid>", "<Button />", "</Grid>", "</Page>");
        var expected = Lines("<Page>", "\t<Grid>", "\t\t<Button />", "\t</Grid>", "</Page>");
        Assert.Equal(expected, Format(input, insertSpaces: false));
    }

    [Fact]
    public void LeavesWrappedAttributeLinesUntouched()
    {
        // Only the '<Button' line is structural; the attribute continuation lines must stay byte-identical.
        var input = Lines("<Page>", "<Button", "     x:Name=\"Go\"", "        Content=\"Go\" />", "</Page>");
        var result = Format(input);
        Assert.Equal(Lines("<Page>", "  <Button", "     x:Name=\"Go\"", "        Content=\"Go\" />", "</Page>"), result);
        AssertOnlyIndentChanged(input, result);
    }

    [Fact]
    public void PreservesXmlSpacePreserveContent()
    {
        var input = Lines("<Page>", "<TextBlock xml:space=\"preserve\">", "      spaced", "   words</TextBlock>", "</Page>");
        var result = Format(input);

        // The open tag reindents (its leading whitespace is inter-element), but the significant inner
        // content — including the leading whitespace of each content line — is byte-for-byte preserved.
        Assert.Contains("  <TextBlock xml:space=\"preserve\">", result);
        Assert.Contains("\n      spaced\n   words</TextBlock>", result);
        AssertOnlyIndentChanged(input, result);
    }

    [Fact]
    public void PreservesMixedInlineContent()
    {
        // A multi-line element with inline text is content-unsafe: none of its inner lines may move.
        var input = Lines("<Page>", "<TextBlock>", "Hello", "<Run Text=\"x\" />", "</TextBlock>", "</Page>");
        var result = Format(input);

        Assert.Contains("\nHello\n", result);
        Assert.Contains("\n<Run Text=\"x\" />\n", result);
        Assert.Contains("\n</TextBlock>\n", result);
        AssertOnlyIndentChanged(input, result);
    }

    [Fact]
    public void PreservesSingleLineInlineContent()
    {
        var input = Lines("<Page>", "<TextBlock>Hello <Run Text=\"x\" /> World</TextBlock>", "</Page>");
        var result = Format(input);
        Assert.Equal(Lines("<Page>", "  <TextBlock>Hello <Run Text=\"x\" /> World</TextBlock>", "</Page>"), result);
    }

    [Fact]
    public void PreservesCDataContent()
    {
        var input = Lines("<Page>", "<x:String><![CDATA[", "   raw  text", "]]></x:String>", "</Page>");
        var result = Format(input);
        Assert.Contains("<![CDATA[\n   raw  text\n]]>", result);
        AssertOnlyIndentChanged(input, result);
    }

    [Fact]
    public void DoesNotCrashOnUnterminatedElement()
    {
        var input = Lines("<Page>", "<Grid>", "<Button ", "</Page>");
        var result = Format(input);
        AssertOnlyIndentChanged(input, result);
    }

    [Fact]
    public void EmptyDocumentYieldsNoEdits()
    {
        var doc = new TextDocument("file:///test.xaml", "");
        var edits = XamlFormatter.Format(doc, new FormattingOptions());
        Assert.Empty(edits);
    }

    [Fact]
    public void RangeFormattingOnlyTouchesLinesInRange()
    {
        var input = Lines("<Page>", "<Grid>", "<Button />", "</Grid>", "</Page>");
        // Restrict to line 2 (the <Button/> line) only.
        var range = new Lsp.Range(new Position(2, 0), new Position(2, 100));
        var result = Format(input, range: range);
        Assert.Equal(Lines("<Page>", "<Grid>", "    <Button />", "</Grid>", "</Page>"), result);
    }

    [Fact]
    public void AlreadyFormattedProducesNoEdits()
    {
        var input = Lines("<Page>", "  <Grid>", "    <Button />", "  </Grid>", "</Page>");
        var doc = new TextDocument("file:///test.xaml", input);
        var edits = XamlFormatter.Format(doc, new FormattingOptions { TabSize = 2, InsertSpaces = true });
        Assert.Empty(edits);
    }
}
