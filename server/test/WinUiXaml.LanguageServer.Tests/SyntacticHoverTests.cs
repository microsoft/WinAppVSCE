namespace WinUiXaml.LanguageServer.Tests;

public sealed class SyntacticHoverTests
{
    [Fact]
    public void MarkupExtensionValueIsNotCalledLiteral()
    {
        const string text = """
            <Page xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
              <TextBlock Text="{x:Bind Greeting}" />
            </Page>
            """;
        var document = new TextDocument("file:///Page.xaml", text);
        var offset = text.IndexOf("Greeting", StringComparison.Ordinal) + 2;

        var hover = XamlLanguageServer.ResolveSyntacticHover(document, offset);

        Assert.NotNull(hover);
        Assert.Contains("XAML markup expression", hover!.Contents.Value);
        Assert.DoesNotContain("Literal value", hover.Contents.Value);
    }

    [Fact]
    public void PrefixedElementRangeIncludesPrefix()
    {
        const string text = """
            <Page xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
                  xmlns:controls="using:Example.Controls">
              <controls:Widget />
            </Page>
            """;
        var document = new TextDocument("file:///Page.xaml", text);
        var start = text.IndexOf("controls:Widget", StringComparison.Ordinal);

        var hover = XamlLanguageServer.ResolveSyntacticHover(document, start + 2);

        Assert.NotNull(hover);
        var range = hover!.Range!.Value;
        Assert.Equal("controls:Widget".Length, range.End.Character - range.Start.Character);
    }
}
