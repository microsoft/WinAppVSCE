using WinUiXaml.LanguageServer;

namespace WinUiXaml.LanguageServer.Tests;

public sealed class SyntaxOnlyCompletionTests
{
    [Theory]
    [InlineData("<Grid></", "Grid>")]
    [InlineData("<Grid></|>", "Grid")]
    [InlineData("<Grid.RowDefinitions></", "Grid.RowDefinitions>")]
    [InlineData("<local:Panel></", "local:Panel>")]
    public void ClosingTagsDoNotRequireProjectTypes(string text, string expected)
    {
        var offset = text.IndexOf('|');
        if (offset >= 0) text = text.Remove(offset, 1);
        else offset = text.Length;
        var result = CompletionProvider.ProvideSyntaxOnly(new TextDocument("untitled:Test.xaml", text), offset);
        Assert.NotNull(result);
        Assert.Contains(result.Items, item => item.TextEdit?.NewText == expected);
        Assert.False(result.IsIncomplete);
    }

    [Theory]
    [InlineData("<But")]
    [InlineData("<Button Cont")]
    [InlineData("<Button Content=\"{x:Bind Foo.")]
    public void SyntaxOnlyPathDoesNotOfferSemanticSuggestions(string text) =>
        Assert.Null(CompletionProvider.ProvideSyntaxOnly(new TextDocument("untitled:Test.xaml", text), text.Length));
}
