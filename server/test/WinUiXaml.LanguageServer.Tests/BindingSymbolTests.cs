using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using WinUiXaml.Workspace;

namespace WinUiXaml.LanguageServer.Tests;

public sealed class BindingSymbolTests
{
    private static readonly XamlTypeSystem TypeSystem = CreateTypeSystem();

    [Theory]
    [InlineData("ViewModel.Hid|den", null)]
    [InlineData("ViewModel.SetO|nly", null)]
    [InlineData("ViewModel.PrivateGe|tter", null)]
    [InlineData("ViewModel.HiddenCh|ild.Text", null)]
    [InlineData("ViewModel.HiddenChild.Te|xt", null)]
    [InlineData("ViewModel.For|mat()", null)]
    [InlineData("ViewModel.For|mat('a', 'b', 'c')", null)]
    [InlineData("ViewModel.Te|xt", "Text")]
    [InlineData("PrivateTe|xt", "PrivateText")]
    [InlineData("ViewModel.For|mat('a')", "Format")]
    [InlineData("ViewModel.For|mat('a', 'b')", "Format")]
    [InlineData("ViewModel.Opt|ional()", "Optional")]
    [InlineData("ViewModel.Vari|adic()", "Variadic")]
    [InlineData("ViewModel.Vari|adic('a', 'b')", "Variadic")]
    [InlineData("ViewModel.Format(ViewModel.Te|xt)", "Text")]
    [InlineData("(local:ViewModel)Hid|den", null)]
    [InlineData("(local:ViewModel)Te|xt", "Text")]
    [InlineData("ViewModel.For|mat", "Format")]
    public void BindingNavigationUsesReadableAccessibleMembersAndCallableOverloads(
        string path, string? expectedName)
    {
        var buffer = $$"""
            <Page xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                  xmlns:local="using:TestApp" x:Class="TestApp.Page"
                  Text="{x:Bind {{path}}}" />
            """;
        int offset = buffer.IndexOf('|');
        var doc = new TextDocument("file:///C:/test/Page.xaml", buffer.Remove(offset, 1));
        var page = TypeSystem.ResolveMetadataType("TestApp.Page")!;
        var symbol = XamlLanguageServer.ResolveBindableSymbol(doc, offset, page, page, TypeSystem);

        Assert.Equal(expectedName, symbol?.Name);
        if (symbol is IMethodSymbol method && path.Contains("'a', 'b'") && expectedName == "Format")
        {
            Assert.Equal(2, method.Parameters.Length);
        }
    }

    private static XamlTypeSystem CreateTypeSystem()
    {
        const string source = """
            namespace TestApp
            {
                public class Page
                {
                    public ViewModel ViewModel { get; } = new();
                    private string PrivateText => "";
                }
                public class ViewModel
                {
                    public string Text => "";
                    private string Hidden => "";
                    public string SetOnly { set {} }
                    public string PrivateGetter { private get; set; }
                    private ViewModel HiddenChild => this;
                    public string Format(string value) => value;
                    public string Format(string first, string second) => first;
                    public string Optional(string value = "") => value;
                    public string Variadic(params string[] values) => "";
                }
            }
            """;
        var compilation = CSharpCompilation.Create("Bindings",
            [CSharpSyntaxTree.ParseText(source)],
            [MetadataReference.CreateFromFile(typeof(object).Assembly.Location)],
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        return XamlTypeSystem.FromCompilation(compilation, ImmutableArray<IAssemblySymbol>.Empty);
    }
}
