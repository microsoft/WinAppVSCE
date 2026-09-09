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

    private static List<TextEdit> GetEdits(string text, int tabSize = 2, bool insertSpaces = true)
    {
        var doc = new TextDocument("file:///test.xaml", text);
        return XamlFormatter.Format(
            doc,
            new FormattingOptions { TabSize = tabSize, InsertSpaces = insertSpaces });
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
        Assert.Empty(GetEdits(once));
    }

    [Fact]
    public void ComboBoxStyleConvergesWithoutReflowOrFileGrowth()
    {
        var input = Lines(
            "<ResourceDictionary>",
            "            <Style",
            "                x:Key=\"DefaultComboBoxStyle\"",
            "                TargetType=\"ComboBox\">",
            "                    <Setter Property=\"FontSize\" Value=\"{ThemeResource ControlContentThemeFontSize}\" />",
            "                    <Setter Property=\"Padding\"",
            "                            Value=\"8,4\" />",
            "            </Style>",
            "</ResourceDictionary>");
        var expected = Lines(
            "<ResourceDictionary>",
            "  <Style",
            "                x:Key=\"DefaultComboBoxStyle\"",
            "                TargetType=\"ComboBox\">",
            "    <Setter Property=\"FontSize\" Value=\"{ThemeResource ControlContentThemeFontSize}\" />",
            "    <Setter Property=\"Padding\"",
            "                            Value=\"8,4\" />",
            "  </Style>",
            "</ResourceDictionary>");

        var once = Format(input);

        Assert.Equal(expected, once);
        Assert.True(once.Length <= input.Length);
        Assert.Equal(input.Split('\n').Length, once.Split('\n').Length);
        Assert.Equal(once, Format(once));
        Assert.Empty(GetEdits(once));
    }

    [Fact]
    public void ProductionStyleExcerptIsByteStableAfterFirstPass()
    {
        var input = string.Join("\r\n",
            "<?xml version=\"1.0\" encoding=\"utf-8\" ?>",
            "<ResourceDictionary",
            "    xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\"",
            "    xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\">",
            "  <ResourceDictionary.MergedDictionaries>",
            "      <XamlControlsResources xmlns=\"using:Microsoft.UI.Xaml.Controls\" />",
            "      <!--  Other merged dictionaries here  -->",
            "  </ResourceDictionary.MergedDictionaries>",
            "    <Style x:Key=\"SubtleComboBoxStyle\" TargetType=\"ComboBox\">",
            "      <Setter Property=\"ItemsPanel\">",
            "          <Setter.Value>",
            "        <ItemsPanelTemplate>",
            "              <CarouselPanel/>",
            "        </ItemsPanelTemplate>",
            "          </Setter.Value>",
            "      </Setter>",
            "      <Setter Property=\"Template\">",
            "        <Setter.Value>",
            "          <ControlTemplate",
            "                       TargetType=\"ComboBox\">",
            "                 <ContentPresenter",
            "                       x:Name=\"ContentPresenter\"",
            "                            Content=\"{TemplateBinding SelectionBoxItem}\"",
            "                       Visibility=\"Visible\" />",
            "          </ControlTemplate>",
            "        </Setter.Value>",
            "      </Setter>",
            "    </Style>",
            "</ResourceDictionary>");
        var expected = string.Join("\r\n",
            "<?xml version=\"1.0\" encoding=\"utf-8\" ?>",
            "<ResourceDictionary",
            "    xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\"",
            "    xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\">",
            "  <ResourceDictionary.MergedDictionaries>",
            "    <XamlControlsResources xmlns=\"using:Microsoft.UI.Xaml.Controls\" />",
            "    <!--  Other merged dictionaries here  -->",
            "  </ResourceDictionary.MergedDictionaries>",
            "  <Style x:Key=\"SubtleComboBoxStyle\" TargetType=\"ComboBox\">",
            "    <Setter Property=\"ItemsPanel\">",
            "      <Setter.Value>",
            "        <ItemsPanelTemplate>",
            "          <CarouselPanel/>",
            "        </ItemsPanelTemplate>",
            "      </Setter.Value>",
            "    </Setter>",
            "    <Setter Property=\"Template\">",
            "      <Setter.Value>",
            "        <ControlTemplate",
            "                       TargetType=\"ComboBox\">",
            "          <ContentPresenter",
            "                       x:Name=\"ContentPresenter\"",
            "                            Content=\"{TemplateBinding SelectionBoxItem}\"",
            "                       Visibility=\"Visible\" />",
            "        </ControlTemplate>",
            "      </Setter.Value>",
            "    </Setter>",
            "  </Style>",
            "</ResourceDictionary>");

        var once = Format(input);
        var twice = Format(once);

        Assert.Equal(expected, once);
        Assert.Equal(once, twice);
        Assert.Empty(GetEdits(once));
        Assert.Equal(input.Count(c => c == '\n'), once.Count(c => c == '\n'));
        Assert.Contains("<CarouselPanel/>", once);
        Assert.Contains("Visibility=\"Visible\" />", once);
    }

    [Fact]
    public void ConventionallyFormattedShortElementsProduceNoEdits()
    {
        var input = Lines(
            "<Style TargetType=\"ComboBox\">",
            "  <Setter Property=\"Background\" Value=\"{ThemeResource ComboBoxBackground}\" />",
            "  <Setter Property=\"BorderThickness\" Value=\"1\" />",
            "</Style>");

        Assert.Equal(input, Format(input));
        Assert.Empty(GetEdits(input));
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

    [Fact]
    public void OnTypeFormatting_ReindentsOnlyCompletedTagLine()
    {
        var input = Lines("<Page>", "<Grid>", "<Button />", "</Grid>", "</Page>");
        var doc = new TextDocument("file:///test.xaml", input);

        var edits = XamlFormatter.FormatOnType(
            doc,
            new FormattingOptions { TabSize = 2, InsertSpaces = true },
            new Position(2, 10),
            ">");

        Assert.Equal(Lines("<Page>", "<Grid>", "    <Button />", "</Grid>", "</Page>"), Apply(input, edits, doc));
    }

    [Fact]
    public void OnTypeFormatting_CompletedEndTagOutdentsCurrentLine()
    {
        var input = Lines("<Page>", "  <Grid>", "    </Grid>", "</Page>");
        var doc = new TextDocument("file:///test.xaml", input);

        var edits = XamlFormatter.FormatOnType(
            doc,
            new FormattingOptions { TabSize = 2, InsertSpaces = true },
            new Position(2, 11),
            ">");

        Assert.Equal(Lines("<Page>", "  <Grid>", "  </Grid>", "</Page>"), Apply(input, edits, doc));
    }

    [Fact]
    public void OnTypeFormatting_IgnoresOtherCharacters()
    {
        var doc = new TextDocument("file:///test.xaml", Lines("<Page>", "<Grid />", "</Page>"));

        Assert.Empty(XamlFormatter.FormatOnType(
            doc,
            new FormattingOptions(),
            new Position(1, 1),
            "/"));
    }

    [Theory]
    [InlineData("<Page xml:space=\"preserve\">\n<Button />\n</Page>")]
    [InlineData("<Page>\n<TextBlock>Hello\n<Button />\n</TextBlock>\n</Page>")]
    public void OnTypeFormatting_PreservesSignificantWhitespace(string input)
    {
        var doc = new TextDocument("file:///test.xaml", input);
        int buttonLine = input.Split('\n').ToList().FindIndex(line => line.Contains("<Button"));

        var edits = XamlFormatter.FormatOnType(
            doc,
            new FormattingOptions { TabSize = 2, InsertSpaces = true },
            new Position(buttonLine, "<Button />".Length),
            ">");

        Assert.Empty(edits);
    }
}
