using System.Collections.Generic;
using System.Linq;
using WinUiXaml.LanguageServer.Lsp;
using Xunit;

namespace WinUiXaml.LanguageServer.Tests;

/// <summary>
/// Hermetic coverage for <see cref="XamlFolding"/>. Folding is read-only (it never edits text), so the
/// correctness concerns are line-number accuracy, correct <c>kind</c> tagging, and the hard invariant that
/// every emitted range spans at least two lines (<c>EndLine &gt; StartLine</c>) — an inverted or degenerate
/// range would make the client misbehave. These tests also lock the conservative choices (self-closing tags
/// and single-line constructs never fold) and crash-safety on malformed / unbalanced input.
/// </summary>
public class XamlFoldingTests
{
    private static string Lines(params string[] lines) => string.Join("\n", lines);

    private static List<FoldingRange> Fold(string text)
    {
        var doc = new TextDocument("file:///test.xaml", text);
        return XamlFolding.Compute(doc);
    }

    private static void AssertNoInvertedRanges(IEnumerable<FoldingRange> ranges)
    {
        foreach (var r in ranges)
        {
            Assert.True(r.EndLine > r.StartLine, $"range must span >=2 lines but was [{r.StartLine},{r.EndLine}]");
        }
    }

    private static FoldingRange Single(IReadOnlyList<FoldingRange> ranges, int startLine) =>
        Assert.Single(ranges, r => r.StartLine == startLine);

    [Fact]
    public void MultiLineElement_FoldsFromOpenTagToEndTagLine()
    {
        var ranges = Fold(Lines("<Grid>", "  <Button />", "</Grid>"));
        var fold = Assert.Single(ranges);
        Assert.Equal(0, fold.StartLine);
        Assert.Equal(2, fold.EndLine);
        Assert.Null(fold.Kind);
    }

    [Fact]
    public void SingleLineElement_DoesNotFold()
    {
        Assert.Empty(Fold("<Grid><Button /></Grid>"));
    }

    [Fact]
    public void SelfClosingElement_DoesNotFold_EvenWhenAttributesWrap()
    {
        // A self-closing tag is a single logical construct; we deliberately do not fold its attribute block.
        Assert.Empty(Fold(Lines("<Button", "    Content=\"x\"", "    IsEnabled=\"True\" />")));
    }

    [Fact]
    public void NestedElements_EachContributeAFold()
    {
        var ranges = Fold(Lines(
            "<Grid>",           // 0
            "  <StackPanel>",   // 1
            "    <Button />",   // 2
            "  </StackPanel>",  // 3
            "</Grid>"));        // 4
        AssertNoInvertedRanges(ranges);
        Assert.Equal(2, ranges.Count);
        Assert.Equal(4, Single(ranges, 0).EndLine);
        Assert.Equal(3, Single(ranges, 1).EndLine);
    }

    [Fact]
    public void PropertyElement_Folds()
    {
        var ranges = Fold(Lines(
            "<Grid>",                    // 0
            "  <Grid.RowDefinitions>",   // 1
            "    <RowDefinition />",     // 2
            "  </Grid.RowDefinitions>",  // 3
            "</Grid>"));                 // 4
        AssertNoInvertedRanges(ranges);
        Assert.Contains(ranges, r => r.StartLine == 1 && r.EndLine == 3 && r.Kind == null);
    }

    [Fact]
    public void MultiLineComment_FoldsWithCommentKind()
    {
        var ranges = Fold(Lines("<!-- line one", "     line two", "     line three -->"));
        var fold = Assert.Single(ranges);
        Assert.Equal(0, fold.StartLine);
        Assert.Equal(2, fold.EndLine);
        Assert.Equal(FoldingRangeKind.Comment, fold.Kind);
    }

    [Fact]
    public void SingleLineComment_DoesNotFold()
    {
        Assert.Empty(Fold("<!-- one liner -->"));
    }

    [Fact]
    public void RegionPair_FoldsWithRegionKind()
    {
        var ranges = Fold(Lines(
            "<Grid>",                 // 0
            "  <!-- #region Buttons -->", // 1
            "  <Button />",           // 2
            "  <!-- #endregion -->",  // 3
            "</Grid>"));              // 4
        AssertNoInvertedRanges(ranges);
        Assert.Contains(ranges, r => r.StartLine == 1 && r.EndLine == 3 && r.Kind == FoldingRangeKind.Region);
    }

    [Fact]
    public void RegionMarker_WithoutSpaceOrLabel_StillRecognized()
    {
        var ranges = Fold(Lines(
            "<!--#region-->",     // 0
            "<Button />",         // 1
            "<!--#endregion-->")); // 2
        Assert.Contains(ranges, r => r.StartLine == 0 && r.EndLine == 2 && r.Kind == FoldingRangeKind.Region);
    }

    [Fact]
    public void UnbalancedRegion_ProducesNoRegionFold_AndDoesNotCrash()
    {
        var ranges = Fold(Lines("<!-- #region Orphan -->", "<Button />", "<Grid />"));
        AssertNoInvertedRanges(ranges);
        Assert.DoesNotContain(ranges, r => r.Kind == FoldingRangeKind.Region);
    }

    [Fact]
    public void StrayEndRegion_IsIgnored()
    {
        var ranges = Fold(Lines("<!-- #endregion -->", "<Button />"));
        Assert.DoesNotContain(ranges, r => r.Kind == FoldingRangeKind.Region);
    }

    [Fact]
    public void NestedRegions_PairInnermostFirst()
    {
        var ranges = Fold(Lines(
            "<!-- #region Outer -->", // 0
            "<!-- #region Inner -->", // 1
            "<Button />",             // 2
            "<!-- #endregion -->",    // 3  closes Inner
            "<!-- #endregion -->"));  // 4  closes Outer
        var regions = ranges.Where(r => r.Kind == FoldingRangeKind.Region).ToList();
        Assert.Equal(2, regions.Count);
        Assert.Contains(regions, r => r.StartLine == 1 && r.EndLine == 3); // inner
        Assert.Contains(regions, r => r.StartLine == 0 && r.EndLine == 4); // outer
    }

    [Fact]
    public void RegionMarkerLikeWord_DoesNotMatch()
    {
        // "#regionalize" is not a region marker (marker must be followed by whitespace or end).
        var ranges = Fold(Lines("<!-- #regionalize -->", "<Button />", "<!-- #endregionx -->"));
        Assert.DoesNotContain(ranges, r => r.Kind == FoldingRangeKind.Region);
    }

    [Fact]
    public void MultiLineCData_Folds()
    {
        var ranges = Fold(Lines("<x><![CDATA[", "  raw <not> markup", "]]></x>"));
        AssertNoInvertedRanges(ranges);
        Assert.Contains(ranges, r => r.StartLine == 0);
    }

    [Fact]
    public void UnterminatedElement_FoldsToLastContentLine_NotPhantomBlankLine()
    {
        // Trailing newline after the last content; must not fold into the empty final line.
        var ranges = Fold("<Grid>\n  <Button />\n");
        AssertNoInvertedRanges(ranges);
        var fold = Assert.Single(ranges);
        Assert.Equal(0, fold.StartLine);
        Assert.Equal(1, fold.EndLine);
    }

    [Fact]
    public void MismatchedEndTag_DoesNotCrash_AndHasNoInvertedRanges()
    {
        var ranges = Fold(Lines("<Grid>", "  <Button />", "</Wrong>"));
        AssertNoInvertedRanges(ranges);
    }

    [Fact]
    public void ElementSpanCoincidingWithChildComment_PrefersCommentKind()
    {
        // The element open tag and comment start share line 0; the comment end and element end tag
        // share line 2. Both would fold [0,2]; the coincident structural range must not mask the
        // comment kind (the client de-dups identical spans, so we resolve it deterministically).
        var ranges = Fold(Lines("<Grid><!--", "  comment body", "--></Grid>"));
        AssertNoInvertedRanges(ranges);
        var fold = Assert.Single(ranges, r => r.StartLine == 0 && r.EndLine == 2);
        Assert.Equal(FoldingRangeKind.Comment, fold.Kind);
    }

    [Fact]
    public void EmptyDocument_ProducesNoFolds()
    {
        Assert.Empty(Fold(string.Empty));
        Assert.Empty(Fold("   \n\t\n"));
    }

    [Fact]
    public void RealisticPage_EveryRangeIsWellFormed()
    {
        var ranges = Fold(Lines(
            "<Page>",
            "  <Grid>",
            "    <Grid.RowDefinitions>",
            "      <RowDefinition />",
            "    </Grid.RowDefinitions>",
            "    <!-- #region Content -->",
            "    <StackPanel>",
            "      <TextBlock Text=\"Hi\" />",
            "    </StackPanel>",
            "    <!-- #endregion -->",
            "  </Grid>",
            "</Page>"));
        AssertNoInvertedRanges(ranges);
        Assert.Contains(ranges, r => r.Kind == FoldingRangeKind.Region);
        Assert.Contains(ranges, r => r.StartLine == 0 && r.Kind == null); // <Page> element
    }
}
