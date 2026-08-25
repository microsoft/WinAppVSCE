using System.Collections.Immutable;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Workspace;
using Xunit;

namespace WinUiXaml.LanguageServer.Tests;

public class XamlValidatorTests
{
    private const string Types = """
        namespace TestApp
        {
            public class BasePage : Microsoft.UI.Xaml.FrameworkElement
            {
                public string Hidden(string first, string second) => first;
                public void OnBaseClick() { }
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
                public Microsoft.UI.Xaml.ResourceDictionary Resources { get; } = new();
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
                public event Handler Clicked;
                private void OnClick() { }
            }

            public delegate void Handler();

            public class Child
            {
                public string Name { get; } = "";
                public string Text { get; set; } = "";
            }

            public class Formatter
            {
                public string Format(Child value) => value.Name;
            }

            public class RenamedTemplate : Microsoft.UI.Xaml.FrameworkTemplate { }
            public class TemplateLookalike { }
            public class ResourceDictionary : System.Collections.Generic.Dictionary<object, object> { }
            public class DerivedDictionary : Microsoft.UI.Xaml.ResourceDictionary { }

            public class Grid
            {
                public System.Collections.Generic.List<RowDefinition> RowDefinitions { get; } = new();
                public static int GetRow(object value) => 0;
                public static void SetRow(object value, int row) { }
            }

            public class RowDefinition { }
            public class SampleRow
            {
                public System.Collections.ObjectModel.ObservableCollection<RowSample> SampleCards { get; } = new();
            }
            public class RowSample { }
            public class StyledControl { public string Text { get; set; } = ""; }
            public class BaseControl { }
            public class GoodRoot : BaseControl { }
            public class WrongRoot { }

            [Microsoft.UI.Xaml.Markup.ContentProperty(Name = "Content")]
            public class ContentHost
            {
                public object Content { get; set; }
            }

            [Microsoft.UI.Xaml.Markup.ContentProperty(Name = "Header")]
            public class SettingsExpander
            {
                public object Header { get; set; }
                public object ItemsHeader { get; set; }
                public Microsoft.UI.Xaml.DataTemplate ItemTemplate { get; set; }
            }
        }

        namespace Microsoft.UI.Xaml
        {
            public struct CornerRadius { }
            public struct Thickness { }
            public class FrameworkTemplate { }
            public class FrameworkElement { public string Name { get; set; } = ""; }
            public class ResourceDictionary
            {
                public System.Collections.Generic.IDictionary<object, object> ThemeDictionaries { get; }
                    = new System.Collections.Generic.Dictionary<object, object>();
            }
            public class DataTemplate : FrameworkTemplate { }
            public class Style { public System.Type TargetType { get; set; } }
            public class Setter { public string Property { get; set; } = ""; }
        }

        namespace Microsoft.UI.Xaml.Markup
        {
            [System.AttributeUsage(System.AttributeTargets.Class, Inherited = true)]
            public sealed class ContentPropertyAttribute : System.Attribute
            {
                public string Name { get; set; } = "";
            }
        }

        namespace Microsoft.UI.Xaml.Data
        {
            public enum BindingMode { OneTime, OneWay, TwoWay }
        }

        namespace Microsoft.UI.Xaml.Media
        {
            public class Brush { }
            public class SolidColorBrush : Brush { }
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

        namespace System.Collections.ObjectModel
        {
            public class ObservableCollection<T> : System.Collections.Generic.List<T> { }
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
            Page("""Foreground="{ui:ThemeResource TextFillColorSecondaryBru}" """),
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
            Page("""Foreground="{ui:ThemeResource TextFillColorSecondaryBrush}" """),
            "TextFillColorSecondaryBrush");
        var uncatalogued = Validate(
            Page("""Foreground="{ui:ThemeResource LibraryProvidedBrush}" """),
            "TextFillColorSecondaryBrush");

        Assert.DoesNotContain(known, item => item.Code == XamlValidator.UnknownResourceKeyCode);
        Assert.DoesNotContain(uncatalogued, item => item.Code == XamlValidator.UnknownResourceKeyCode);
    }

    [Fact]
    public void NestedMisspelledResource_IsReported()
    {
        var diagnostics = Validate(
            Page("""Foreground="{ui:Binding Source={ui:StaticResource AccentBru}}" """),
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

    [Fact]
    public void DuplicateKeyValidationSupportsAlternateXamlPrefix()
    {
        const string xaml = """
            <DerivedDictionary xmlns="using:TestApp"
                               xmlns:lang="http://schemas.microsoft.com/winfx/2006/xaml">
              <Child lang:Key="Shared" />
              <Child lang:Key="Shared" />
            </DerivedDictionary>
            """;

        Assert.Contains(
            Validate(xaml),
            item => item.Code == XamlValidator.DuplicateKeyCode);
    }

    [Fact]
    public void DuplicateThemeDictionaryKeysAreReportedInParentScope()
    {
        const string xaml = """
            <DerivedDictionary xmlns="using:TestApp"
                               xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                               xmlns:ui="using:Microsoft.UI.Xaml">
              <ui:ResourceDictionary.ThemeDictionaries>
                <ui:ResourceDictionary x:Key="Dark" />
                <ui:ResourceDictionary x:Key="Dark" />
              </ui:ResourceDictionary.ThemeDictionaries>
            </DerivedDictionary>
            """;

        Assert.Contains(
            Validate(xaml),
            item => item.Code == XamlValidator.DuplicateKeyCode);
    }

    [Fact]
    public void ThemeDictionaryKeysDoNotCollideWithOrdinaryResourceKeys()
    {
        const string xaml = """
            <DerivedDictionary xmlns="using:TestApp"
                               xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                               xmlns:ui="using:Microsoft.UI.Xaml">
              <Child x:Key="Dark" />
              <ui:ResourceDictionary.ThemeDictionaries>
                <ui:ResourceDictionary x:Key="Dark" />
              </ui:ResourceDictionary.ThemeDictionaries>
            </DerivedDictionary>
            """;

        Assert.DoesNotContain(
            Validate(xaml),
            item => item.Code == XamlValidator.DuplicateKeyCode);
    }

    [Fact]
    public void DuplicateImplicitTypeKeysUseExpandedNamespaceIdentity()
    {
        const string xaml = """
            <DerivedDictionary xmlns="using:TestApp"
                               xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                               xmlns:lang="http://schemas.microsoft.com/winfx/2006/xaml"
                               xmlns:first="using:TestApp"
                               xmlns:second="using:TestApp">
              <Child x:Key="{x:Type first:Child}" />
              <Child lang:Key="{lang:Type second:Child}" />
            </DerivedDictionary>
            """;

        Assert.Contains(
            Validate(xaml),
            item => item.Code == XamlValidator.DuplicateKeyCode);
    }

    [Fact]
    public void CustomTypeMarkupExtensionIsNotTreatedAsXType()
    {
        const string xaml = """
            <Page xmlns="using:TestApp"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                  xmlns:custom="using:TestApp">
              <Page.Resources>
                <Style TargetType="{custom:Type StyledControl}">
                  <Setter Property="Missing" />
                </Style>
              </Page.Resources>
            </Page>
            """;

        Assert.DoesNotContain(
            Validate(xaml),
            item => item.Code == XamlValidator.InvalidSetterPropertyCode);
    }

    [Fact]
    public void ResourceDictionaryPropertyElement_AcceptsKeyedResourceValues()
    {
        const string xaml = """
            <Page xmlns="using:TestApp"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                  xmlns:local="using:TestApp"
                  xmlns:ui="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
                  xmlns:Media="using:Microsoft.UI.Xaml.Media">
              <local:Page.Resources>
                <Media:SolidColorBrush x:Key="Primary" />
                <Media:SolidColorBrush x:Key="Secondary" />
                <Media:SolidColorBrush x:Key="Primary" />
              </local:Page.Resources>
            </Page>
            """;

        var diagnostics = Validate(xaml);

        Assert.Single(diagnostics);
        Assert.Equal(XamlValidator.DuplicateKeyCode, diagnostics[0].Code);
    }

    [Fact]
    public void InstancePropertyElementMustBelongToEnclosingType()
    {
        const string xaml = """
            <Page xmlns="using:TestApp">
              <Grid>
                <Child.Text>invalid owner</Child.Text>
              </Grid>
            </Page>
            """;

        Assert.Contains(
            Validate(xaml),
            item => item.Code == XamlValidator.UnknownPropertyElementCode &&
                item.Message.Contains("enclosing type 'Grid'", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("Valid_Name9", false)]
    [InlineData("9invalid", true)]
    [InlineData("has-dash", true)]
    public void XamlName_UsesIdentifierGrammar(string name, bool invalid)
    {
        var diagnostics = Validate(Page($$"""x:Name="{{name}}" """));

        Assert.Equal(invalid, diagnostics.Any(d => d.Code == XamlValidator.InvalidNameCode));
    }

    [Fact]
    public void FrameworkElementName_UsesIdentifierGrammar()
    {
        var diagnostics = Validate(Page("""Name="1Bad" """));

        Assert.Single(diagnostics, d => d.Code == XamlValidator.InvalidNameCode);
    }

    [Theory]
    [InlineData("OnClick", false)]
    [InlineData("OnBaseClick", false)]
    [InlineData("Missing", true)]
    public void PlainEventHandler_RequiresMethodInResolvedClassChain(string handler, bool missing)
    {
        var diagnostics = Validate(Page($$"""Clicked="{{handler}}" """));

        Assert.Equal(missing, diagnostics.Any(d => d.Code == XamlValidator.MissingEventHandlerCode));
    }

    [Fact]
    public void PlainEventHandler_IsSilentWithoutResolvedXClass()
    {
        const string xaml = """<Page xmlns="using:TestApp" Clicked="Missing" />""";

        Assert.DoesNotContain(Validate(xaml), d => d.Code == XamlValidator.MissingEventHandlerCode);
    }

    [Fact]
    public void ScalarContent_RejectsOnlyTheSecondObject()
    {
        const string xaml = """
            <ContentHost xmlns="using:TestApp">
              <Child />
              <Child />
            </ContentHost>
            """;

        Assert.Single(Validate(xaml), d => d.Code == XamlValidator.MultipleScalarChildrenCode);
    }

    [Fact]
    public void ScalarContent_IgnoresNamespaceQualifiedPropertyElements()
    {
        const string xaml = """
            <toolkit:SettingsExpander
                xmlns="using:TestApp"
                xmlns:toolkit="using:TestApp">
              <Child />
              <toolkit:SettingsExpander.ItemsHeader>
                <Child />
              </toolkit:SettingsExpander.ItemsHeader>
              <toolkit:SettingsExpander.ItemTemplate>
                <DataTemplate />
              </toolkit:SettingsExpander.ItemTemplate>
            </toolkit:SettingsExpander>
            """;

        Assert.DoesNotContain(
            Validate(xaml),
            d => d.Code == XamlValidator.MultipleScalarChildrenCode);
    }

    [Fact]
    public void SetterProperty_IsCheckedAgainstResolvedStyleTarget()
    {
        const string xaml = """
            <Style xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
                   xmlns:local="using:TestApp"
                   TargetType="local:StyledControl">
              <Setter Property="Text" />
              <Setter Property="Missing" />
            </Style>
            """;

        Assert.Single(Validate(xaml), d => d.Code == XamlValidator.InvalidSetterPropertyCode);
    }

    [Fact]
    public void SetterAttachedProperty_IsCheckedAgainstResolvedOwner()
    {
        const string xaml = """
            <Style xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
                   xmlns:local="using:TestApp"
                   TargetType="local:StyledControl">
              <Setter Property="local:Grid.Rwo" />
            </Style>
            """;

        Assert.Single(Validate(xaml), d => d.Code == XamlValidator.InvalidSetterPropertyCode);
    }

    [Fact]
    public void SetterAttachedProperty_ReportsUnknownOwnerWithSuggestion()
    {
        const string xaml = """
            <Style xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
                   xmlns:local="using:TestApp"
                   TargetType="local:StyledControl">
              <Setter Property="local:Gri.Row" />
            </Style>
            """;

        var diagnostic = Assert.Single(
            Validate(xaml),
            item => item.Code == XamlValidator.InvalidSetterPropertyCode);
        var data = Assert.IsType<DiagnosticData>(diagnostic.Data);
        Assert.Equal("Gri", data.Bad);
        Assert.Contains("Grid", data.Suggestions);
    }

    [Fact]
    public void DataTemplate_ResetsInheritedBindRootAndRequiresDataType()
    {
        const string missing = """
            <Page xmlns="using:TestApp" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                  xmlns:ui="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
                  x:Class="TestApp.Page">
              <ui:DataTemplate><Child Text="{x:Bind Width}" /></ui:DataTemplate>
            </Page>
            """;
        const string typed = """
            <Page xmlns="using:TestApp" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                  xmlns:ui="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
                  xmlns:local="using:TestApp" x:Class="TestApp.Page">
              <ui:DataTemplate x:DataType="local:Child"><Child Text="{x:Bind Name}" /></ui:DataTemplate>
            </Page>
            """;

        var missingDiagnostics = Validate(missing);
        Assert.Contains(missingDiagnostics, d => d.Code == XamlValidator.DataTemplateDataTypeRequiredCode);
        Assert.DoesNotContain(missingDiagnostics, d => d.Code == XamlValidator.UnknownBindMemberCode);
        Assert.DoesNotContain(Validate(typed), d => d.Code == XamlValidator.DataTemplateDataTypeRequiredCode);
    }

    [Fact]
    public void DuplicateAttributes_ReportSecondExpandedName()
    {
        const string xaml = """
            <Page xmlns="using:TestApp"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                  xmlns:y="http://schemas.microsoft.com/winfx/2006/xaml"
                  x:Name="First" y:Name="Second" />
            """;

        Assert.Single(Validate(xaml), d => d.Code == XamlValidator.DuplicateAttributeCode);
    }

    [Fact]
    public void CollectionPropertyElement_RejectsWrongResolvedChildType()
    {
        const string xaml = """
            <Grid xmlns="using:TestApp">
              <Grid.RowDefinitions>
                <RowDefinition />
                <Child />
              </Grid.RowDefinitions>
            </Grid>
            """;

        Assert.Single(Validate(xaml), d => d.Code == XamlValidator.InvalidPropertyElementChildCode);
    }

    [Fact]
    public void ObservableCollectionPropertyElement_AcceptsItsItemType()
    {
        const string xaml = """
            <SampleRow xmlns="using:TestApp">
              <SampleRow.SampleCards>
                <RowSample />
              </SampleRow.SampleCards>
            </SampleRow>
            """;

        Assert.DoesNotContain(
            Validate(xaml),
            diagnostic => diagnostic.Code == XamlValidator.InvalidPropertyElementChildCode);
    }

    [Fact]
    public void DictionaryPropertyElement_AcceptsKeyedValueObjects()
    {
        const string xaml = """
            <ResourceDictionary
                xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
                xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
              <ResourceDictionary.ThemeDictionaries>
                <ResourceDictionary x:Key="Default" />
              </ResourceDictionary.ThemeDictionaries>
            </ResourceDictionary>
            """;

        Assert.DoesNotContain(
            Validate(xaml),
            diagnostic => diagnostic.Code == XamlValidator.InvalidPropertyElementChildCode);
    }

    [Fact]
    public void StaticResourceObjectElement_IsACompilerIntrinsic()
    {
        const string xaml = """
            <ResourceDictionary
                xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
                xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
              <StaticResource
                  x:Key="RailNavigationIconForegroundBrush"
                  ResourceKey="ControlAAFillColorDefaultBrush" />
            </ResourceDictionary>
            """;

        Assert.DoesNotContain(
            Validate(xaml),
            diagnostic => diagnostic.Code == XamlValidator.UnknownTypeCode);
    }

    [Fact]
    public void XClass_MustBeAssignableToResolvedRoot()
    {
        const string valid = """
            <BaseControl xmlns="using:TestApp" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                         x:Class="TestApp.GoodRoot" />
            """;
        const string invalid = """
            <BaseControl xmlns="using:TestApp" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                         x:Class="TestApp.WrongRoot" />
            """;

        Assert.DoesNotContain(Validate(valid), d => d.Code == XamlValidator.InvalidRootClassCode);
        Assert.Contains(Validate(invalid), d => d.Code == XamlValidator.InvalidRootClassCode);
    }

    [Theory]
    [InlineData("OneWay", false)]
    [InlineData("NotAMode", true)]
    public void BindMode_UsesSdkEnumMetadata(string mode, bool invalid)
    {
        var diagnostics = Validate(Page($$"""Text="{x:Bind Text, Mode={{mode}}}" """));

        Assert.Equal(invalid, diagnostics.Any(d => d.Code == XamlValidator.InvalidBindModeCode));
    }

    [Fact]
    public void NamedElementBindPath_UsesParsedElementType()
    {
        const string xaml = """
            <Page xmlns="using:TestApp"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                  x:Class="TestApp.Page">
              <Child x:Name="Target" Text="{x:Bind Target.Text}" />
            </Page>
            """;

        Assert.DoesNotContain(
            Validate(xaml),
            diagnostic => diagnostic.Code == XamlValidator.UnknownBindMemberCode);

        var invalid = xaml.Replace("Target.Text", "Target.Missing");
        Assert.Contains(
            Validate(invalid),
            diagnostic => diagnostic.Code == XamlValidator.UnknownBindMemberCode &&
                diagnostic.Message.Contains("'Missing'"));
    }

    [Fact]
    public void FrameworkLookalikes_DoNotEnableSdkBackedDiagnostics()
    {
        const string source = """
            namespace Fake
            {
                public sealed class ContentPropertyAttribute : System.Attribute
                {
                    public string Name { get; set; } = "";
                }
            }
            namespace TestApp
            {
                public class Page
                {
                    public string Text { get; set; } = "";
                    public double Width { get; set; }
                }
                public class DataTemplate { }
                public class Style { public string TargetType { get; set; } = ""; }
                public class Setter { public string Property { get; set; } = ""; }
                public class StyledControl { public string Text { get; set; } = ""; }
                [Fake.ContentProperty(Name = "Content")]
                public class ContentHost { public object Content { get; set; } }
            }
            """;
        const string template = """
            <Page xmlns="using:TestApp" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                  x:Class="TestApp.Page">
              <DataTemplate><Page Text="{x:Bind Width, Mode=Bad}" /></DataTemplate>
            </Page>
            """;
        const string style = """
            <Style xmlns="using:TestApp" TargetType="StyledControl">
              <Setter Property="Missing" />
            </Style>
            """;
        const string content = """
            <ContentHost xmlns="using:TestApp"><Page /><Page /></ContentHost>
            """;

        var diagnostics = ValidateWithSource(template, source)
            .Concat(ValidateWithSource(style, source))
            .Concat(ValidateWithSource(content, source));
        Assert.DoesNotContain(diagnostics, d =>
            d.Code == XamlValidator.DataTemplateDataTypeRequiredCode ||
            d.Code == XamlValidator.InvalidBindModeCode ||
            d.Code == XamlValidator.InvalidSetterPropertyCode ||
            d.Code == XamlValidator.MultipleScalarChildrenCode);
    }

    private static string Page(string attributes) => $$"""
        <Page xmlns="using:TestApp"
              xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
              xmlns:local="using:TestApp"
              xmlns:ui="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
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
