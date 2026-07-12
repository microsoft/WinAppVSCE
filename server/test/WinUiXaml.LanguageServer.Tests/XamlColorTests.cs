using System.Collections.Generic;
using System.Linq;
using WinUiXaml.LanguageServer.Lsp;
using Xunit;
using LspColor = WinUiXaml.LanguageServer.Lsp.Color;
using LspRange = WinUiXaml.LanguageServer.Lsp.Range;

namespace WinUiXaml.LanguageServer.Tests;

/// <summary>
/// Hermetic coverage for <see cref="XamlColor"/>. The provider is scoped to full-value hex literals in
/// non-markup attributes, so the correctness concerns are: (1) exact hex parsing across all four XAML
/// widths with alpha-first ordering, (2) rejecting anything that is not a whole hex color (no substring
/// or named-color false positives), (3) emitting the swatch over exactly the hex token (respecting inner
/// whitespace), and (4) presentations that round-trip the color and preserve a sensible format width.
/// </summary>
public class XamlColorTests
{
    private static List<ColorInformation> Collect(string text) =>
        XamlColor.Collect(new TextDocument("file:///test.xaml", text));

    private static string TextAt(string src, LspRange r)
    {
        var line = src.Replace("\r\n", "\n").Split('\n')[r.Start.Line];
        return line.Substring(r.Start.Character, r.End.Character - r.Start.Character);
    }

    // ---- parsing -----------------------------------------------------------

    [Fact]
    public void TryParseHex_SixDigit_OpaqueRrggbb()
    {
        Assert.True(XamlColor.TryParseHex("#3B82F6", out var a, out var r, out var g, out var b));
        Assert.Equal(255, a);
        Assert.Equal(0x3B, r);
        Assert.Equal(0x82, g);
        Assert.Equal(0xF6, b);
    }

    [Fact]
    public void TryParseHex_EightDigit_AlphaFirst()
    {
        Assert.True(XamlColor.TryParseHex("#80FF0000", out var a, out var r, out var g, out var b));
        Assert.Equal(0x80, a);
        Assert.Equal(0xFF, r);
        Assert.Equal(0x00, g);
        Assert.Equal(0x00, b);
    }

    [Fact]
    public void TryParseHex_ThreeDigit_NibbleDoubled()
    {
        Assert.True(XamlColor.TryParseHex("#f00", out var a, out var r, out var g, out var b));
        Assert.Equal(255, a);
        Assert.Equal(0xFF, r);
        Assert.Equal(0x00, g);
        Assert.Equal(0x00, b);
    }

    [Fact]
    public void TryParseHex_FourDigit_ArgbNibbleDoubled()
    {
        Assert.True(XamlColor.TryParseHex("#8abc", out var a, out var r, out var g, out var b));
        Assert.Equal(0x88, a);
        Assert.Equal(0xAA, r);
        Assert.Equal(0xBB, g);
        Assert.Equal(0xCC, b);
    }

    [Theory]
    [InlineData("")]
    [InlineData("#")]
    [InlineData("FF0000")]     // no leading '#'
    [InlineData("#FF00F")]     // 5 nibbles -> invalid width
    [InlineData("#FF00000")]   // 7 nibbles -> invalid width
    [InlineData("#GG0000")]    // non-hex digit
    [InlineData("#12 34 56")]  // spaces
    [InlineData("Red")]        // named color (out of scope)
    [InlineData("#FF0000 red")]
    public void TryParseHex_Rejects(string bad)
    {
        Assert.False(XamlColor.TryParseHex(bad, out _, out _, out _, out _));
    }

    // ---- collection --------------------------------------------------------

    [Fact]
    public void Collect_FullValueHex_EmitsSwatchOverTokenOnly()
    {
        const string src = "<Rectangle Fill=\"#FF0000\" />";
        var colors = Collect(src);
        var info = Assert.Single(colors);
        Assert.Equal("#FF0000", TextAt(src, info.Range));
        Assert.Equal(1.0, info.Color.Red, 3);
        Assert.Equal(0.0, info.Color.Green, 3);
        Assert.Equal(0.0, info.Color.Blue, 3);
        Assert.Equal(1.0, info.Color.Alpha, 3);
    }

    [Fact]
    public void Collect_InnerWhitespace_RangeCoversJustTheToken()
    {
        const string src = "<Rectangle Fill=\"  #00FF00  \" />";
        var info = Assert.Single(Collect(src));
        Assert.Equal("#00FF00", TextAt(src, info.Range));
        Assert.Equal(1.0, info.Color.Green, 3);
    }

    [Fact]
    public void Collect_MarkupExtensionValue_Skipped()
    {
        Assert.Empty(Collect("<Rectangle Fill=\"{StaticResource Brush1}\" />"));
        Assert.Empty(Collect("<Rectangle Fill=\"{Binding Color}\" />"));
    }

    [Fact]
    public void Collect_NotAFullValue_Skipped()
    {
        // hex embedded in a larger string is not a color value
        Assert.Empty(Collect("<TextBlock Text=\"#FF0000 is red\" />"));
        Assert.Empty(Collect("<TextBlock Text=\"call #123 today\" />"));
    }

    [Fact]
    public void Collect_NamespaceDeclaration_Skipped()
    {
        // contrived: a value that parses as hex must not be picked up on an xmlns attr
        Assert.Empty(Collect("<Page xmlns:x=\"#FF0000\" />"));
    }

    [Fact]
    public void Collect_MultipleAttributes_EmitsEach()
    {
        const string src = "<Border Background=\"#112233\" BorderBrush=\"#ABCDEF\" />";
        var colors = Collect(src);
        Assert.Equal(2, colors.Count);
        Assert.Contains(colors, c => TextAt(src, c.Range) == "#112233");
        Assert.Contains(colors, c => TextAt(src, c.Range) == "#ABCDEF");
    }

    [Fact]
    public void Collect_AlphaFirstOrdering()
    {
        // #80FF0000 -> alpha 0x80, red full
        var info = Assert.Single(Collect("<Rectangle Fill=\"#80FF0000\" />"));
        Assert.Equal(0x80 / 255.0, info.Color.Alpha, 3);
        Assert.Equal(1.0, info.Color.Red, 3);
        Assert.Equal(0.0, info.Color.Green, 3);
    }

    [Fact]
    public void Collect_ShortHex_Detected()
    {
        var info = Assert.Single(Collect("<Rectangle Fill=\"#f00\" />"));
        Assert.Equal(1.0, info.Color.Red, 3);
        Assert.Equal(0.0, info.Color.Green, 3);
    }

    [Fact]
    public void Collect_MultiLineAttribute_RangeOnCorrectLine()
    {
        const string src = "<Rectangle\n    Fill=\"#00FF00\" />";
        var info = Assert.Single(Collect(src));
        Assert.Equal(1, info.Range.Start.Line);
        Assert.Equal("#00FF00", TextAt(src, info.Range));
    }

    // ---- presentation ------------------------------------------------------

    private static LspRange RangeOn(int startChar, int endChar) => new()
    {
        Start = new Position { Line = 0, Character = startChar },
        End = new Position { Line = 0, Character = endChar },
    };

    private static LspColor Rgba(double r, double g, double b, double a) =>
        new() { Red = r, Green = g, Blue = b, Alpha = a };

    [Fact]
    public void Present_Opaque_OffersRrggbbFirstThenAarrggbb()
    {
        var range = RangeOn(6, 13);
        var presentations = XamlColor.Present(Rgba(0x3B / 255.0, 0x82 / 255.0, 0xF6 / 255.0, 1.0), range);
        Assert.Equal("#3B82F6", presentations[0].Label);
        Assert.Equal("#FF3B82F6", presentations[1].Label);
        // every write-back targets exactly the original literal's range
        Assert.All(presentations, p =>
        {
            Assert.NotNull(p.TextEdit);
            Assert.Equal(range.Start.Character, p.TextEdit!.Range.Start.Character);
            Assert.Equal(range.End.Character, p.TextEdit.Range.End.Character);
            Assert.Equal(p.Label, p.TextEdit.NewText);
        });
    }

    [Fact]
    public void Present_Translucent_OffersAarrggbbFirst()
    {
        var presentations = XamlColor.Present(Rgba(1.0, 0.0, 0.0, 0x80 / 255.0), RangeOn(0, 9));
        Assert.Equal("#80FF0000", presentations[0].Label);
        Assert.StartsWith("#", presentations[1].Label);
        Assert.Equal(7, presentations[1].Label.Length); // #RRGGBB opt-in
    }

    [Fact]
    public void Present_RoundTripsParsedColor()
    {
        Assert.True(XamlColor.TryParseHex("#8ABCDE12", out var a, out var r, out var g, out var b));
        var color = Rgba(r / 255.0, g / 255.0, b / 255.0, a / 255.0);
        var presentations = XamlColor.Present(color, RangeOn(0, 9));
        // translucent -> AARRGGBB primary, must reproduce the exact bytes
        Assert.Equal("#8ABCDE12", presentations[0].Label);
    }

    [Fact]
    public void Present_UppercasesHex()
    {
        var presentations = XamlColor.Present(Rgba(0xab / 255.0, 0xcd / 255.0, 0xef / 255.0, 1.0), RangeOn(0, 7));
        Assert.Equal("#ABCDEF", presentations[0].Label);
    }
}
