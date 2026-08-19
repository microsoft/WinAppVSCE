namespace WinUiXaml.LanguageServer.Tests;

public sealed class SyntacticHoverTests
{
    [Fact]
    public void MarkupExtensionDescriptionNormalizesXamlLanguageAlias()
    {
        const string text = """
            <Page xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
                  xmlns:lang="http://schemas.microsoft.com/winfx/2006/xaml"
                  Tag="{lang:Null}" />
            """;
        var document = new TextDocument("file:///Page.xaml", text);
        var root = Assert.IsType<WinUiXaml.Xaml.XamlElement>(document.Parsed.Root);
        var extension = root.DescendantNodesAndSelf()
            .OfType<WinUiXaml.Xaml.XamlMarkupExtension>()
            .Single();

        Assert.Equal(
            "x:Null",
            XamlLanguageServer.NormalizeProjectIndependentMarkupName(
                extension.Name!,
                root.NamespaceScope));
    }
}
