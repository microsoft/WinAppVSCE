using System.Linq;
using WinUiXaml.Xaml;

namespace WinUiXaml.Xaml.Tests;

/// <summary>Regressions for #356 (well-formedness) and #366 (deep element nesting).</summary>
public sealed class WellFormednessTests
{
    private const string Ns = "xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\"";

    private static XamlDiagnostic Single(string text, string id)
    {
        var doc = XamlParser.Parse(text);
        return Assert.Single(doc.Diagnostics, d => d.Id == id);
    }

    [Fact]
    public void SecondRootElement_IsReported()
    {
        var text = $"<Page {Ns}></Page>\n<Grid/>";
        var d = Single(text, XamlDiagnosticIds.MultipleRootElements);
        Assert.Equal(text.IndexOf("Grid"), d.Span.Start);
    }

    [Fact]
    public void TextOutsideRoot_IsReported()
    {
        var text = $"<Page {Ns}></Page> trailing";
        var d = Single(text, XamlDiagnosticIds.TextOutsideRoot);
        Assert.Equal("trailing", text.Substring(d.Span.Start, d.Span.Length));
    }

    [Theory]
    [InlineData("<Button Content=\"a & b\"/>", "&")]
    [InlineData("<Button Content=\"&nbsp;\"/>", "&nbsp;")]
    [InlineData("<TextBlock>a &bogus; b</TextBlock>", "&bogus;")]
    [InlineData("<Button Content=\"&#x0;\"/>", "&#x0;")]
    public void BadEntityReferences_AreReported(string text, string token)
    {
        var d = Single(text, XamlDiagnosticIds.InvalidEntityReference);
        Assert.Equal(token, text.Substring(d.Span.Start, d.Span.Length));
    }

    [Fact]
    public void RawLessThanInAttribute_IsReported()
    {
        var d = Single("<Button Content=\"a < b\"/>", XamlDiagnosticIds.InvalidAttributeValueCharacter);
        Assert.Equal(1, d.Span.Length);
    }

    [Fact]
    public void WhitespaceAfterOpenBracket_IsReported()
    {
        Single("<Grid>< Button/></Grid>", XamlDiagnosticIds.InvalidTagName);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(0xD800)]
    [InlineData(0xDC00)]
    public void InvalidXmlCharacters_AreReported(int code)
    {
        // Built at runtime: a lone surrogate in an attribute literal is stored as U+FFFD.
        var text = "<Grid>" + (char)code + "</Grid>";
        var d = Single(text, XamlDiagnosticIds.InvalidCharacter);
        Assert.Equal(6, d.Span.Start);
        Assert.Equal(1, d.Span.Length);
    }

    [Theory]
    [InlineData(" <?xml version=\"1.0\"?><Grid/>")]
    [InlineData("<?xml encoding=\"utf-8\"?><Grid/>")]
    [InlineData("<?xml version=\"2.0\"?><Grid/>")]
    [InlineData("<?xml version=\"1.0\" standalone=\"maybe\"?><Grid/>")]
    [InlineData("<?xml version=\"1.0\" bogus=\"x\"?><Grid/>")]
    [InlineData("<?XML version=\"1.0\"?><Grid/>")]
    public void BadXmlDeclarations_AreReported(string text)
    {
        Single(text, XamlDiagnosticIds.InvalidXmlDeclaration);
    }

    [Theory]
    [InlineData("<Button Content=\"{Binding Mode=OneWay, Path}\"/>")]
    [InlineData("<Button Content=\"{Binding Path} extra\"/>")]
    [InlineData("<Button Content=\"{ }\"/>")]
    public void MalformedMarkupExtensions_AreReported(string text)
    {
        Single(text, XamlDiagnosticIds.MalformedMarkupExtension);
    }

    [Theory]
    [InlineData("<?xml version=\"1.0\" encoding=\"utf-8\" standalone=\"yes\"?><Grid/>")]
    [InlineData("<Button Content=\"a &amp; b &lt; &#xE74D; &#65;\"/>")]
    [InlineData("<Button Content=\"{Binding Path, Converter={StaticResource C}, ConverterParameter='a,b}'}\"/>")]
    [InlineData("<Button Content=\"{x:Bind Format('{0}, {1}', A, B)}\"/>")]
    [InlineData("<Button Content=\"{Binding Path, ConverterParameter=&apos;a,b&apos;}\"/>")]
    [InlineData("<Button Content='{Binding Path, ConverterParameter=&quot;a,b&quot;}'/>")]
    [InlineData("<Button Content=\"{x:Bind Format(&apos;{0}, {1}&apos;, A, B)}\"/>")]
    [InlineData("<Button Content=\"{Binding Path, ConverterParameter=&#39;a,b&#39;}\"/>")]
    [InlineData("<Button Content=\"{Binding Path, ConverterParameter=&#x27;a,b&#x27;}\"/>")]
    [InlineData("<Button Content='{Binding Path, ConverterParameter=&#34;a,b&#x22;}'/>")]
    [InlineData("<Button Content=\"{Binding Path, ConverterParameter='a,b&apos;}\"/>")]
    [InlineData("<Button Content=\"{}{literal}\"/>")]
    [InlineData("<!-- c --><Grid/><!-- c -->")]
    [InlineData("<Grid>\U0001F600</Grid>")]
    public void WellFormedDocuments_HaveNoDiagnostics(string text)
    {
        Assert.Empty(XamlParser.Parse(text).Diagnostics);
    }

    [Theory]
    [InlineData(500)]
    [InlineData(512)]
    public void DeepButSupportedNesting_ParsesWithoutDiagnostics(int depth)
    {
        var text = string.Concat(Enumerable.Repeat("<StackPanel>", depth)) + "<TextBlock/>" +
            string.Concat(Enumerable.Repeat("</StackPanel>", depth));
        var doc = XamlParser.Parse(text);
        Assert.Empty(doc.Diagnostics);
        Assert.True(doc.Root!.HasEndTag);
    }

    [Fact]
    public void NestingPastTheLimit_ReportsOnceAndRecovers()
    {
        int depth = 3000;
        var text = string.Concat(Enumerable.Repeat("<StackPanel>", depth)) + "<TextBlock/>" +
            string.Concat(Enumerable.Repeat("</StackPanel>", depth)) ;
        var doc = XamlParser.Parse(text);
        Assert.Single(doc.Diagnostics);
        Assert.Equal(XamlDiagnosticIds.ElementTooDeep, doc.Diagnostics[0].Id);
        Assert.True(doc.Root!.HasEndTag);
        Assert.Equal(text.Length, doc.Root.Span.End);
    }

    // Server requests run on default 1 MB threads; xunit's larger stack hid an overflow at depth 1024.
    [Theory]
    [InlineData(512)]
    [InlineData(5000)]
    public void DeepNesting_FitsInADefaultThreadStack(int depth)
    {
        var text = "<Page xmlns:x=\"x\">" +
            string.Concat(Enumerable.Repeat("<StackPanel Margin=\"1\" x:Name=\"a\">", depth)) +
            "<TextBlock Text=\"{Binding A, Mode=OneWay}\"/>" +
            string.Concat(Enumerable.Repeat("</StackPanel>", depth)) + "</Page>";
        XamlDocument? doc = null;
        var thread = new System.Threading.Thread(() => doc = XamlParser.Parse(text), 1024 * 1024);
        thread.Start();
        thread.Join();
        Assert.True(doc!.Root!.HasEndTag);
    }
}
