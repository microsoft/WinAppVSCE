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
                public string Text { get; set; } = "";
                public Microsoft.UI.Xaml.CornerRadius CornerRadius { get; set; }
                public Microsoft.UI.Xaml.Thickness Margin { get; set; }
                public Microsoft.UI.Xaml.Media.Brush Foreground { get; set; } = new Microsoft.UI.Xaml.Media.Brush();
                public Windows.UI.Color Color { get; set; }
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

            public class RenamedTemplate : Microsoft.UI.Xaml.FrameworkTemplate { }
            public class TemplateLookalike { }
            public class ResourceDictionary { }
            public class DerivedDictionary : Microsoft.UI.Xaml.ResourceDictionary { }

            public class Grid
            {
                public static int GetRow(object value) => 0;
                public static void SetRow(object value, int row) { }
            }
        }

        namespace Microsoft.UI.Xaml
        {
            public struct CornerRadius { }
            public struct Thickness { }
            public class FrameworkTemplate { }
            public class ResourceDictionary { }
        }

        namespace Microsoft.UI.Xaml.Media
        {
            public class Brush { }
        }

        namespace Windows.UI
        {
            public struct Color { }
        }

        namespace Microsoft.UI
        {
            public static class Colors
            {
                public static Windows.UI.Color Red => default;
                public static Windows.UI.Color Transparent => default;
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

    [Theory]
    [InlineData("""CornerRadius="8" """, false)]
    [InlineData("""CornerRadius="8,0,8,0" """, false)]
    [InlineData("""CornerRadius="8 0 8 0" """, false)]
    [InlineData("""CornerRadius="8,bad,8,0" """, true)]
    [InlineData("""CornerRadius="" """, true)]
    [InlineData("""Margin="4" """, false)]
    [InlineData("""Margin="4,8" """, false)]
    [InlineData("""Margin="4 8 4 8" """, false)]
    [InlineData("""Margin="4,,8" """, true)]
    [InlineData("""Margin="" """, true)]
    public void WinUiNumericStructValues_AreValidated(string attribute, bool invalid)
    {
        var diagnostics = Validate(Page(attribute));

        Assert.Equal(invalid, diagnostics.Any(d => d.Code == XamlValidator.InvalidAttributeValueCode));
    }

    [Theory]
    [InlineData("""Foreground="Red" """, false)]
    [InlineData("""Foreground="transparent" """, false)]
    [InlineData("""Foreground="#123" """, false)]
    [InlineData("""Foreground="#80112233" """, false)]
    [InlineData("""Foreground="DefinitelyNotABrush" """, true)]
    [InlineData("""Foreground="#12XX34" """, true)]
    [InlineData("""Foreground="" """, true)]
    [InlineData("""Color="Red" """, false)]
    [InlineData("""Color="NoSuchColor" """, true)]
    public void BrushAndColorValues_AreValidated(string attribute, bool invalid)
    {
        var diagnostics = Validate(Page(attribute));

        Assert.Equal(invalid, diagnostics.Any(d => d.Code == XamlValidator.InvalidAttributeValueCode));
    }

    [Fact]
    public void EmptyStringProperty_RemainsValid()
    {
        var diagnostics = Validate(Page("""Text="" """));

        Assert.DoesNotContain(diagnostics, d => d.Code == XamlValidator.InvalidAttributeValueCode);
    }

    [Fact]
    public void MisspelledKnownThemeResource_IsReportedWithSuggestion()
    {
        var diagnostics = Validate(
            Page("""Foreground="{ThemeResource TextFillColorSecondaryBru}" """),
            "TextFillColorSecondaryBrush");

        var diagnostic = Assert.Single(
            diagnostics,
            item => item.Code == XamlValidator.UnknownResourceKeyCode);
        Assert.Equal(1, diagnostic.Severity);
        var data = Assert.IsType<Lsp.DiagnosticData>(diagnostic.Data);
        Assert.Contains("TextFillColorSecondaryBrush", data.Suggestions);
    }

    [Fact]
    public void KnownAndUncataloguedResourceKeys_RemainValid()
    {
        var known = Validate(
            Page("""Foreground="{ThemeResource TextFillColorSecondaryBrush}" """),
            "TextFillColorSecondaryBrush");
        var uncatalogued = Validate(
            Page("""Foreground="{ThemeResource LibraryProvidedBrush}" """),
            "TextFillColorSecondaryBrush");

        Assert.DoesNotContain(known, item => item.Code == XamlValidator.UnknownResourceKeyCode);
        Assert.DoesNotContain(uncatalogued, item => item.Code == XamlValidator.UnknownResourceKeyCode);
    }

    [Fact]
    public void NestedMisspelledResource_IsReported()
    {
        var diagnostics = Validate(
            Page("""Foreground="{Binding Source={StaticResource AccentBru}}" """),
            "AccentBrush");

        Assert.Contains(diagnostics, item => item.Code == XamlValidator.UnknownResourceKeyCode);
    }

    [Fact]
    public void FrameworkTemplateSubclass_StartsIndependentNameScope()
    {
        const string xaml = """
            <Page xmlns="using:TestApp"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
              <Child x:Name="Shared" />
              <RenamedTemplate>
                <Child x:Name="Shared" />
              </RenamedTemplate>
            </Page>
            """;

        Assert.DoesNotContain(Validate(xaml), item => item.Code == XamlValidator.DuplicateNameCode);
    }

    [Fact]
    public void TemplateLikeNameWithoutFrameworkTemplateBase_SharesParentNameScope()
    {
        const string xaml = """
            <Page xmlns="using:TestApp"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
              <Child x:Name="Shared" />
              <TemplateLookalike>
                <Child x:Name="Shared" />
              </TemplateLookalike>
            </Page>
            """;

        Assert.Contains(Validate(xaml), item => item.Code == XamlValidator.DuplicateNameCode);
    }

    [Fact]
    public void DuplicateNameValidation_IsSuppressedWhenFrameworkMetadataIsUnavailable()
    {
        const string source = """
            namespace TestApp
            {
                public class Page { }
                public class Child { }
            }
            """;
        const string xaml = """
            <Page xmlns="using:TestApp"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
              <Child x:Name="Shared" />
              <Child x:Name="Shared" />
            </Page>
            """;

        Assert.DoesNotContain(
            ValidateWithSource(xaml, source),
            item => item.Code == XamlValidator.DuplicateNameCode);
    }

    [Fact]
    public void DuplicateKeyValidation_UsesSdkResourceDictionaryIdentity()
    {
        const string derived = """
            <DerivedDictionary xmlns="using:TestApp"
                               xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
              <Child x:Key="Shared" />
              <Child x:Key="Shared" />
            </DerivedDictionary>
            """;
        const string lookalike = """
            <ResourceDictionary xmlns="using:TestApp"
                                xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
              <Child x:Key="Shared" />
              <Child x:Key="Shared" />
            </ResourceDictionary>
            """;

        Assert.Contains(
            Validate(derived),
            item => item.Code == XamlValidator.DuplicateKeyCode);
        Assert.DoesNotContain(
            Validate(lookalike),
            item => item.Code == XamlValidator.DuplicateKeyCode);
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

    private static System.Collections.Generic.List<Lsp.Diagnostic> Validate(
        string xaml,
        params string[] resourceKeys) =>
        ValidateWithSource(xaml, Types, resourceKeys);

    private static System.Collections.Generic.List<Lsp.Diagnostic> ValidateWithSource(
        string xaml,
        string source,
        params string[] resourceKeys)
    {
        var compilation = CSharpCompilation.Create(
            "TestApp",
            new[] { CSharpSyntaxTree.ParseText(source) },
            new[] { MetadataReference.CreateFromFile(typeof(object).Assembly.Location) },
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var typeSystem = XamlTypeSystem.FromCompilation(
            compilation,
            ImmutableArray<IAssemblySymbol>.Empty);
        var document = new TextDocument("file:///C:/test/Page.xaml", xaml);

        return XamlValidator.Validate(document, typeSystem, resourceKeys);
    }
}
