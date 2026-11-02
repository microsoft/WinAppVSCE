using System.Linq;
using WinUiXaml.Xaml;

namespace WinUiXaml.Xaml.Tests;

public sealed class MarkupDepthTests
{
    [Theory]
    [InlineData(128, true, true)]
    [InlineData(128, false, true)]
    [InlineData(129, true, true)]
    [InlineData(129, false, true)]
    [InlineData(2048, true, true)]
    [InlineData(2048, false, true)]
    [InlineData(2048, true, false)]
    [InlineData(2048, false, false)]
    public void MarkupRecursionIsBoundedAndLaterElementsSurvive(int depth, bool named, bool terminated)
    {
        var extension = string.Concat(Enumerable.Repeat(named ? "{Binding Converter=" : "{Binding ", depth))
            + "value" + (terminated ? new string('}', depth) : "");
        var text = $"<Grid><Button Tag=\"{extension}\"/><TextBlock Text=\"after\"/></Grid>";
        var document = XamlParser.Parse(text);
        Assert.Equal(depth > 128, document.Diagnostics.Any(d => d.Id == XamlDiagnosticIds.MarkupExtensionTooDeep));
        if (depth > 128)
        {
            Assert.Single(document.Diagnostics, d => d.Id == XamlDiagnosticIds.MarkupExtensionTooDeep);
        }
        Assert.Equal("TextBlock", document.Root!.Content.OfType<XamlElement>().Last().Name!.LocalName);
        Assert.True(document.Root.HasEndTag);
        Assert.Equal(terminated, document.Root.Content.OfType<XamlElement>().First()
            .GetAttribute("Tag")!.Value!.MarkupExtension!.IsClosed);
        Assert.All(document.Diagnostics, d => Assert.InRange(d.Span.End, d.Span.Start, text.Length));
    }

    [Fact]
    public void DepthRecoveryKeepsTheNextMarkupArgument()
    {
        var nested = string.Concat(Enumerable.Repeat("{Binding Converter=", 129))
            + "'}'" + new string('}', 129);
        var document = XamlParser.Parse($"<Button Tag=\"{{Binding Converter={nested}, Mode=OneWay}}\"/>");
        var markup = document.Root!.GetAttribute("Tag")!.Value!.MarkupExtension!;
        Assert.True(markup.IsClosed);
        Assert.Contains(markup.Arguments, argument => argument.Name?.LocalName == "Mode" && argument.Value == "OneWay");
        Assert.Single(document.Diagnostics);
    }
}
