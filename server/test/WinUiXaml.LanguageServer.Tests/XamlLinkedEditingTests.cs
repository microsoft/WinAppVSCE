using WinUiXaml.LanguageServer.Lsp;
using Xunit;

namespace WinUiXaml.LanguageServer.Tests;

/// <summary>
/// Hermetic coverage for <see cref="XamlLinkedEditing"/>. Linked editing is read-only (we only return
/// the open + end tag name ranges plus a word pattern; VS Code performs the synchronized rename), so the
/// correctness concerns are: link ONLY a caret that is on a tag name, link ONLY a well-matched open/end
/// pair (never self-closing, unclosed, or mismatched), and cover exactly the two name tokens.
/// </summary>
public class XamlLinkedEditingTests
{
    private static (TextDocument Doc, int Offset) Caret(string textWithCaret)
    {
        int offset = textWithCaret.IndexOf('|');
        Assert.True(offset >= 0, "test input must contain a '|' caret marker");
        string text = textWithCaret.Remove(offset, 1);
        return (new TextDocument("file:///t.xaml", text), offset);
    }

    private static LinkedEditingRanges? At(string textWithCaret)
    {
        var (doc, offset) = Caret(textWithCaret);
        return XamlLinkedEditing.Compute(doc, doc.PositionAt(offset));
    }

    private static string TextOf(TextDocument doc, Lsp.Range range) =>
        doc.Text.Substring(doc.OffsetAt(range.Start), doc.OffsetAt(range.End) - doc.OffsetAt(range.Start));

    [Fact]
    public void CaretOnOpenTagName_LinksBothNameSpans()
    {
        var (doc, offset) = Caret("<Gr|id>\n  <Button />\n</Grid>");
        var result = XamlLinkedEditing.Compute(doc, doc.PositionAt(offset));
        Assert.NotNull(result);
        Assert.Equal(2, result!.Ranges.Length);
        Assert.Equal("Grid", TextOf(doc, result.Ranges[0]));
        Assert.Equal("Grid", TextOf(doc, result.Ranges[1]));
        // open name precedes end name in source
        Assert.True(doc.OffsetAt(result.Ranges[0].Start) < doc.OffsetAt(result.Ranges[1].Start));
        Assert.False(string.IsNullOrEmpty(result.WordPattern));
    }

    [Fact]
    public void CaretOnEndTagName_LinksBothNameSpans()
    {
        var (doc, offset) = Caret("<Grid>\n  <Button />\n</Gr|id>");
        var result = XamlLinkedEditing.Compute(doc, doc.PositionAt(offset));
        Assert.NotNull(result);
        Assert.Equal(2, result!.Ranges.Length);
        Assert.Equal("Grid", TextOf(doc, result.Ranges[0]));
        Assert.Equal("Grid", TextOf(doc, result.Ranges[1]));
    }

    [Fact]
    public void SelfClosingElement_ReturnsNull()
    {
        Assert.Null(At("<But|ton />"));
    }

    [Fact]
    public void UnclosedElement_ReturnsNull()
    {
        Assert.Null(At("<Gr|id>\n  <Button />"));
    }

    [Fact]
    public void MismatchedTags_ReturnsNull()
    {
        // A mismatched pair is mid-edit; fusing two different names into one rename would be wrong.
        Assert.Null(At("<Gr|id></Span>"));
        Assert.Null(At("<Grid></Sp|an>"));
    }

    [Fact]
    public void CaretOnAttribute_ReturnsNull()
    {
        Assert.Null(At("<Grid Wid|th=\"1\"></Grid>"));
    }

    [Fact]
    public void CaretOnOpeningAngle_ReturnsNull()
    {
        // Offset 0 is the '<', which is not part of the name span.
        Assert.Null(At("|<Grid></Grid>"));
    }

    [Theory]
    // The caret at the EXCLUSIVE END of a tag name (right after the last name char — on the '>' or the
    // space before attributes) MUST still link: that is where the user types to extend the name. This
    // matches VS Code's own HTML linked-editing reference (vscode-html-languageservice
    // findLinkedEditingRanges), which uses inclusive upper bounds
    // `node.start + 1 <= offset && offset <= node.start + 1 + tagLength`. TextSpan.ContainsInclusive gives
    // the identical [Start, End] window. The FIRST offset past the name must NOT link (tight, not greedy).
    [InlineData("<Grid|></Grid>", true)]              // caret == end of open name, on '>'
    [InlineData("<Grid| Width=\"1\"></Grid>", true)]  // caret == end of open name, on the space
    [InlineData("<Grid></Grid|>", true)]              // caret == end of close name, on '>'
    [InlineData("<Grid>|</Grid>", false)]             // one past open name: on the '<' of the close tag
    [InlineData("<Grid></Grid>|", false)]             // past the whole element
    public void CaretAtNameEndBoundary_MatchesVsCodeHtmlInclusiveSemantics(string probe, bool shouldLink)
    {
        var (doc, offset) = Caret(probe);
        var result = XamlLinkedEditing.Compute(doc, doc.PositionAt(offset));
        if (shouldLink)
        {
            Assert.NotNull(result);
            Assert.Equal(2, result!.Ranges.Length);
            Assert.Equal("Grid", TextOf(doc, result.Ranges[0]));
            Assert.Equal("Grid", TextOf(doc, result.Ranges[1]));
        }
        else
        {
            Assert.Null(result);
        }
    }

    [Fact]
    public void PrefixedName_LinksWholeQualifiedName()
    {
        var (doc, offset) = Caret("<local:MyCtl|></local:MyCtl>");
        var result = XamlLinkedEditing.Compute(doc, doc.PositionAt(offset));
        Assert.NotNull(result);
        Assert.Equal("local:MyCtl", TextOf(doc, result!.Ranges[0]));
        Assert.Equal("local:MyCtl", TextOf(doc, result.Ranges[1]));
    }

    [Fact]
    public void PropertyElement_LinksDottedName()
    {
        var (doc, offset) = Caret("<Grid><Grid.RowDef|initions></Grid.RowDefinitions></Grid>");
        var result = XamlLinkedEditing.Compute(doc, doc.PositionAt(offset));
        Assert.NotNull(result);
        Assert.Equal("Grid.RowDefinitions", TextOf(doc, result!.Ranges[0]));
        Assert.Equal("Grid.RowDefinitions", TextOf(doc, result.Ranges[1]));
    }

    [Fact]
    public void NestedSameNameElements_CaretOnInner_LinksInnerPair()
    {
        // The inner <Grid>'s open name should link to the inner </Grid>, not the outer one.
        const string text = "<Grid><Grid></Grid></Grid>";
        int inner = text.IndexOf("Grid", 6, System.StringComparison.Ordinal) + 1; // caret in the 2nd <Grid>
        var doc = new TextDocument("file:///t.xaml", text);
        var result = XamlLinkedEditing.Compute(doc, doc.PositionAt(inner));
        Assert.NotNull(result);
        // The two linked names must be the inner pair: open at offset 7, close at offset 14.
        int openStart = doc.OffsetAt(result!.Ranges[0].Start);
        int closeStart = doc.OffsetAt(result.Ranges[1].Start);
        Assert.Equal(7, openStart);
        Assert.Equal(14, closeStart);
    }

    [Fact]
    public void EmptyContentElement_CaretOnName_Links()
    {
        var (doc, offset) = Caret("<Sta|ckPanel></StackPanel>");
        var result = XamlLinkedEditing.Compute(doc, doc.PositionAt(offset));
        Assert.NotNull(result);
        Assert.Equal("StackPanel", TextOf(doc, result!.Ranges[0]));
        Assert.Equal("StackPanel", TextOf(doc, result.Ranges[1]));
    }
}
