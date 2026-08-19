namespace WinUiXaml.LanguageServer.Tests;

public sealed class XamlDirectiveMetadataTests
{
    private const string Presentation = "http://schemas.microsoft.com/winfx/2006/xaml/presentation";
    private const string Xaml = "http://schemas.microsoft.com/winfx/2006/xaml";
    private const string Mc = "http://schemas.openxmlformats.org/markup-compatibility/2006";

    [Theory]
    [InlineData("Class", "CLR class")]
    [InlineData("Name", "namescope")]
    [InlineData("Key", "resource dictionary")]
    [InlineData("DataType", "compile bindings")]
    [InlineData("DefaultBindMode", "default mode")]
    [InlineData("FieldModifier", "access level")]
    [InlineData("Load", "visual tree")]
    [InlineData("Phase", "rendering phase")]
    [InlineData("Uid", "localized resources")]
    public void ResolvesXamlDirectiveAttributes(string localName, string expected)
    {
        var text = $"<Page xmlns=\"{Presentation}\" xmlns:x=\"{Xaml}\" x:{localName}=\"value\" />";

        var info = Resolve(text, $"x:{localName}");

        Assert.Contains($"x:{localName}", info.Markdown);
        Assert.Contains(expected, info.Markdown, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ResolvesXamlDirectiveByNamespaceUriNotLiteralPrefix()
    {
        var text = $"<Page xmlns=\"{Presentation}\" xmlns:language=\"{Xaml}\" language:Class=\"App.Page\" />";

        var info = Resolve(text, "language:Class");

        Assert.Contains("x:Class", info.Markdown);
        Assert.Contains("CLR class", info.Markdown);
    }

    [Fact]
    public void ResolvesMarkupCompatibilityIgnorableByNamespaceUri()
    {
        var text = $"<Page xmlns=\"{Presentation}\" xmlns:compat=\"{Mc}\" compat:Ignorable=\"design\" />";

        var info = Resolve(text, "compat:Ignorable");

        Assert.Contains("mc:Ignorable", info.Markdown);
        Assert.Contains("namespace prefixes", info.Markdown);
    }

    [Theory]
    [InlineData("Bind", "compiled binding")]
    [InlineData("Null", "null reference")]
    [InlineData("Static", "static field")]
    [InlineData("Type", "System.Type")]
    public void ResolvesXamlMarkupExtensionsWithAlternatePrefix(string localName, string expected)
    {
        var text =
            $"<Page xmlns=\"{Presentation}\" xmlns:language=\"{Xaml}\"><TextBlock Text=\"{{language:{localName}}}\" /></Page>";

        var info = Resolve(text, $"language:{localName}");

        Assert.Contains($"x:{localName}", info.Markdown);
        Assert.Contains(expected, info.Markdown, StringComparison.OrdinalIgnoreCase);
    }

    private static DirectiveQuickInfo Resolve(string text, string token)
    {
        var document = new TextDocument("file:///directive.xaml", text);
        var offset = text.IndexOf(token, StringComparison.Ordinal) + token.Length / 2;
        return Assert.IsType<DirectiveQuickInfo>(XamlDirectiveMetadata.Resolve(document, offset));
    }
}
