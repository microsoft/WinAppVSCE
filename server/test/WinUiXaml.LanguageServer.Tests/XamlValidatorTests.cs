using System.Collections.Immutable;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using WinUiXaml.Workspace;
using Xunit;

namespace WinUiXaml.LanguageServer.Tests;

public class XamlValidatorTests
{
    private const string Types = """
        namespace TestApp
        {
            public class BasePage
            {
                public string Hidden(string first, string second) => first;
            }

            public class Page : BasePage
            {
                public double Width { get; set; }
                public bool IsEnabled { get; set; }
                public Child Child { get; } = new Child();
                public Formatter Formatter { get; } = new Formatter();
                public string Format(string value) => value;
                public string Choose(string value) => value;
                public string Choose(string first, string second) => first;
                public string Optional(string value = "") => value;
                public string Variadic(params string[] values) => "";
                public string Zero() => "";
                public string Literal(string value) => value;
                public string Pair(string first, Child second) => first;
                public new string Hidden(string value) => value;
            }

            public class Child
            {
                public string Name { get; } = "";
            }

            public class Formatter
            {
                public string Format(Child value) => value.Name;
            }

            public class Grid
            {
                public static int GetRow(object value) => 0;
                public static void SetRow(object value, int row) { }
            }
        }
        """;

    [Fact]
    public void AttachedPropertyBindPath_ValidatesOwnerAndMember()
    {
        var valid = Validate(Page("""Text="{x:Bind (Grid.Row)}" """));
        Assert.DoesNotContain(valid, d => d.Code == XamlValidator.UnknownAttachedPropertyCode);

        var invalid = Validate(Page("""Text="{x:Bind (Grid.Rwo)}" """));
        Assert.Contains(invalid, d =>
            d.Code == XamlValidator.UnknownAttachedPropertyCode &&
            d.Message.Contains("'Rwo'"));

        var invalidTail = Validate(Page("""Text="{x:Bind (Grid.Row).Missing}" """));
        Assert.Contains(invalidTail, d =>
            d.Code == XamlValidator.UnknownBindMemberCode &&
            d.Message.Contains("'Missing'"));
    }

    [Fact]
    public void BindFunction_ReportsUnsupportedArgumentCount()
    {
        var diagnostics = Validate(Page("""Text="{x:Bind Format(Child, Child)}" """));

        Assert.Contains(diagnostics, d =>
            d.Code == XamlValidator.InvalidBindFunctionCode &&
            d.Message.Contains("2 argument(s)"));
    }

    [Fact]
    public void BindFunction_ReportsNonCallableMember()
    {
        var diagnostics = Validate(Page("""Text="{x:Bind Child()}" """));

        Assert.Contains(diagnostics, d =>
            d.Code == XamlValidator.InvalidBindFunctionCode &&
            d.Message.Contains("not a callable method"));
    }

    [Theory]
    [InlineData("Choose(Child)")]
    [InlineData("Choose(Child, Child)")]
    [InlineData("Optional()")]
    [InlineData("Variadic()")]
    [InlineData("Variadic(Child, Child)")]
    [InlineData("Zero( )")]
    [InlineData("Literal('a,b')")]
    [InlineData("Formatter.Format(Child)")]
    [InlineData("Pair(')', Child)")]
    public void BindFunction_AcceptsValidOverloadsAndFlexibleParameters(string path)
    {
        var diagnostics = Validate(Page($$"""Text="{x:Bind {{path}}}" """));

        Assert.DoesNotContain(diagnostics, d => d.Code == XamlValidator.InvalidBindFunctionCode);
    }

    [Fact]
    public void BindFunction_DoesNotTreatHiddenBaseMethodsAsOverloads()
    {
        var diagnostics = Validate(Page("""Text="{x:Bind Hidden(Child, Child)}" """));

        Assert.Contains(diagnostics, d =>
            d.Code == XamlValidator.InvalidBindFunctionCode &&
            d.Message.Contains("2 argument(s)"));
    }

    [Fact]
    public void BindFunction_ReportsInvalidDottedReceiverMember()
    {
        var diagnostics = Validate(Page("""Text="{x:Bind Child.Missing.Format(Child)}" """));

        Assert.Contains(diagnostics, d =>
            d.Code == XamlValidator.UnknownBindMemberCode &&
            d.Message.Contains("'Missing'"));
    }

    [Fact]
    public void BindFunction_ReportsUnknownMethodOnDottedReceiverType()
    {
        var diagnostics = Validate(Page("""Text="{x:Bind Formatter.Missing(Child)}" """));

        Assert.Contains(diagnostics, d =>
            d.Code == XamlValidator.InvalidBindFunctionCode &&
            d.Message.Contains("'Formatter'"));
    }

    [Fact]
    public void DesignInstance_ReportsUnknownType()
    {
        var diagnostics = Validate(Page(
            """d:DataContext="{d:DesignInstance Type=local:Missing}" """));

        Assert.Contains(diagnostics, d =>
            d.Code == XamlValidator.UnknownDirectiveTypeCode &&
            d.Message.Contains("local:Missing"));
    }

    [Fact]
    public void McIgnorable_ReportsOnlyUndeclaredEntries()
    {
        var diagnostics = Validate(Page("""mc:Ignorable="d missing" """));

        var diagnostic = Assert.Single(
            diagnostics, d => d.Code == XamlValidator.UnknownIgnorablePrefixCode);
        Assert.Contains("'missing'", diagnostic.Message);
    }

    [Theory]
    [InlineData("""Width="abc" """, true)]
    [InlineData("""Width="12.5" """, false)]
    [InlineData("""Width="Auto" """, false)]
    [InlineData("""Width='12.5' """, false)]
    [InlineData("""Width="{x:Bind Child}" """, false)]
    [InlineData("""IsEnabled="not-bool" """, true)]
    public void PrimitiveAttributeValues_AreValidatedConservatively(string attribute, bool invalid)
    {
        var diagnostics = Validate(Page(attribute));

        Assert.Equal(invalid, diagnostics.Any(d => d.Code == XamlValidator.InvalidAttributeValueCode));
    }

    [Fact]
    public void AttachedPrimitiveAttributeValues_AreValidated()
    {
        var diagnostics = Validate(Page("""Grid.Row="abc" """));

        Assert.Contains(diagnostics, d => d.Code == XamlValidator.InvalidAttributeValueCode);
    }

    private static string Page(string attributes) => $$"""
        <Page xmlns="using:TestApp"
              xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
              xmlns:local="using:TestApp"
              xmlns:d="http://schemas.microsoft.com/expression/blend/2008"
              xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
              x:Class="TestApp.Page"
              {{attributes}} />
        """;

    private static System.Collections.Generic.List<Lsp.Diagnostic> Validate(string xaml)
    {
        var compilation = CSharpCompilation.Create(
            "TestApp",
            new[] { CSharpSyntaxTree.ParseText(Types) },
            new[] { MetadataReference.CreateFromFile(typeof(object).Assembly.Location) },
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var typeSystem = XamlTypeSystem.FromCompilation(
            compilation,
            ImmutableArray<IAssemblySymbol>.Empty);
        var document = new TextDocument("file:///C:/test/Page.xaml", xaml);

        return XamlValidator.Validate(document, typeSystem);
    }
}
