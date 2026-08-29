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
                private void PrivateBaseClick() { }
                protected string ProtectedText { get; } = "";
                internal string InternalText { get; } = "";
                private protected string PrivateProtectedText { get; } = "";
            }

            public class Page : BasePage
            {
                public double Width { get; set; }
                public bool IsEnabled { get; set; }
                public Microsoft.UI.Xaml.Visibility Visibility { get; set; }
                public double? OptionalWidth { get; set; }
                public double? OptionalWidthTarget { get; set; }
                public ConvertibleWidth ConvertibleWidth { get; set; }
                public Microsoft.UI.Xaml.Data.BindingMode Mode { get; set; }
                public string Text { get; set; } = "";
                public ushort Code { get; set; }
                private string SecretText { get; } = "";
                private char Letter { get; } = 'A';
                public Microsoft.UI.Xaml.CornerRadius CornerRadius { get; set; }
                public Microsoft.UI.Xaml.Thickness Margin { get; set; }
                public Microsoft.UI.Xaml.Media.Brush Foreground { get; set; } = new Microsoft.UI.Xaml.Media.Brush();
                public Microsoft.UI.Xaml.Media.ImageSource Image { get; set; }
                public Windows.UI.Xaml.Media.ImageSource LegacyImage { get; set; }
                public System.Uri Uri { get; set; }
                public System.Uri? OptionalUri { get; set; }
                public string ImagePath { get; set; } = "";
                public string? OptionalImagePath { get; set; }
                public Windows.UI.Color Color { get; set; }
                public Microsoft.UI.Xaml.ResourceDictionary Resources { get; } = new();
                public Child Child { get; } = new Child();
                public System.Collections.ObjectModel.ObservableCollection<Child> Children { get; } = new();
                public System.Collections.Generic.List<System.Collections.Generic.List<Child>> NestedChildren { get; } = new();
                public Formatter Formatter { get; } = new Formatter();
                public BasePage OtherBase { get; } = new BasePage();
                public string Format(string value) => value;
                private string PrivateFormat(string value) => value;
                public string Choose(string value) => value;
                public string Choose(string first, string second) => first;
                public string Optional(string value = "") => value;
                public string Variadic(params string[] values) => "";
                public string Zero() => "";
                public string Literal(string value) => value;
                public string Pair(string first, Child second) => first;
                public new string Hidden(string value) => value;
                public event Handler Clicked;
                public event ValueHandler ValueChanged;
                private void OnClick() { }
                private string BadClick() => "";
                private void OnValueChanged(object sender, string value) { }
                private void BadValueChanged(string value) { }
                private string WrongReturn(object sender, string value) => value;
            }

            public delegate void Handler();
            public delegate void ValueHandler(object sender, string value);

            public class Child
            {
                public string Name { get; } = "";
                public string Text { get; set; } = "";
                internal string InternalText { get; } = "";
                internal string InternalFormat(string value) => value;
                private string Secret { get; } = "";
                public string PrivateGetter { private get; set; } = "";
            }

            public static class BindStatics
            {
                public static bool Flag { get; } = true;
                internal static bool InternalFlag { get; } = true;
                public static Child Child { get; } = new();
                public static System.Collections.Generic.List<Child> Children { get; } = new();
                public static Formatter Formatter { get; } = new();
                public static string Format(string value) => value;
                public static string Format(string first, string second) => first;
                public static string PrivateGetter { private get; set; } = "";
            }

            public readonly struct ConvertibleWidth
            {
                public static implicit operator double(ConvertibleWidth value) => 0;
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
                public Microsoft.UI.Xaml.Controls.ColumnDefinitionCollection ColumnDefinitions { get; } = new();
                public TransitionCollection ChildrenTransitions { get; } = new();
                public static int GetRow(object value) => 0;
                public static void SetRow(object value, int row) { }
            }
            public class ScrollViewer
            {
                public static string GetHorizontalScrollBarVisibility(object value) => "";
                public static void SetHorizontalScrollBarVisibility(object value, string visibility) { }
            }
            public class WriteOnlyAttached
            {
                public static void SetValue(object value, string text) { }
            }
            public class NarrowAttached
            {
                public static string GetValue(StyleHostOther value) => "";
                public static void SetValue(StyleHostOther value, string text) { }
            }

            public class RowDefinition { }
            public class ColumnDefinition { }
            public class Transition { }
            public class RepositionThemeTransition : Transition { }
            public class TransitionCollection : System.Collections.Generic.List<Transition> { }
            public class Button { }
            public class SampleRow
            {
                public System.Collections.ObjectModel.ObservableCollection<RowSample> SampleCards { get; } = new();
            }
            public class RowSample { }
            public class StyledControl
            {
                public string Text { get; set; } = "";
                public string WriteOnly { set { } }
                public System.Collections.Generic.IList<Child> Items { get; } =
                    new System.Collections.Generic.List<Child>();
            }
            public class StyleHostBase : Microsoft.UI.Xaml.FrameworkElement { }
            public class StyleHostDerived : StyleHostBase { }
            public class StyleHostOther : Microsoft.UI.Xaml.FrameworkElement { }
            public class ItemsHost
            {
                public object ItemsSource { get; set; }
                public Microsoft.UI.Xaml.DataTemplate ItemTemplate { get; set; }
            }
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
            public class FrameworkElement
            {
                public string Name { get; set; } = "";
                public Style Style { get; set; }
                public ResourceDictionary Resources { get; } = new();
            }
            public enum Visibility { Visible, Collapsed }
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
            public enum RelativeSourceMode { Self, TemplatedParent }
            public class RelativeSource
            {
                public RelativeSourceMode Mode { get; set; }
            }
            public class Binding
            {
                public string Path { get; set; } = "";
                public BindingMode Mode { get; set; }
                public string ElementName { get; set; } = "";
                public RelativeSource RelativeSource { get; set; }
                public object Converter { get; set; }
            }
        }

        namespace Microsoft.UI.Xaml.Controls
        {
            public class ColumnDefinitionCollection : System.Collections.Generic.List<TestApp.ColumnDefinition> { }
            public class ControlTemplate : Microsoft.UI.Xaml.FrameworkTemplate
            {
                public System.Type TargetType { get; set; }
            }
        }

        namespace Microsoft.UI.Xaml.Media
        {
            public class Brush { }
            public class SolidColorBrush : Brush { }
            public class ImageSource { }
        }

        namespace Windows.UI
        {
            public struct Color { }
        }

        namespace Windows.UI.Xaml.Media
        {
            public class ImageSource { }
        }

        namespace Toolkit
        {
            public static class FrameworkElementExtensions
            {
                public static bool GetIsEnabled(Microsoft.UI.Xaml.FrameworkElement value) => false;
                public static void SetIsEnabled(Microsoft.UI.Xaml.FrameworkElement value, bool enabled) { }
            }

            public static class ChildExtensions
            {
                public static int GetRank(TestApp.Child value) => 0;
                public static void SetRank(TestApp.Child value, int rank) { }
            }
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

        namespace TestApp.Controls
        {
            public class CustomButton : Microsoft.UI.Xaml.FrameworkElement { }
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
    [InlineData("PrivateFormat(SecretText)")]
    [InlineData("Child.InternalFormat(Text)")]
    [InlineData("Format(Child.InternalText)")]
    public void BindFunction_AcceptsValidOverloadsAndFlexibleParameters(string path)
    {
        var diagnostics = Validate(Page($$"""Text="{x:Bind {{path}}}" """));

        Assert.DoesNotContain(diagnostics, d => d.Code == XamlValidator.InvalidBindFunctionCode);
        Assert.DoesNotContain(diagnostics, d => d.Code == XamlValidator.UnknownBindMemberCode);
    }

    [Fact]
    public void BindPath_AcceptsRepeatedIndexers()
    {
        var diagnostics = Validate(
            Page("""Text="{x:Bind NestedChildren[0][0].Name}" """));

        Assert.DoesNotContain(
            diagnostics,
            d => d.Code is XamlValidator.UnknownBindMemberCode or
                XamlValidator.InvalidBindAssignmentCode);
    }

    [Fact]
    public void CastPath_RejectsPrivateMembersOnTheCastType()
    {
        Assert.Single(
            Validate(Page("""Text="{x:Bind (local:Child)Secret}" """)),
            d => d.Code == XamlValidator.InaccessibleBindMemberCode);
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
    public void InvalidEnumAttributeValue_CarriesAuthoritativeMemberSuggestions()
    {
        var diagnostic = Assert.Single(
            Validate(Page("""Mode="OneWya" """)),
            d => d.Code == XamlValidator.InvalidAttributeValueCode);

        var data = Assert.IsType<DiagnosticData>(diagnostic.Data);
        Assert.Equal("OneWya", data.Bad);
        Assert.Contains("OneWay", data.Suggestions);
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
    public void KnownResourceKey_RemainsValidAndMissingKeyIsReported()
    {
        var known = Validate(
            Page("""Foreground="{ui:ThemeResource TextFillColorSecondaryBrush}" """),
            "TextFillColorSecondaryBrush");
        var missing = Validate(
            Page("""Foreground="{ui:ThemeResource LibraryProvidedBrush}" """),
            "TextFillColorSecondaryBrush");

        Assert.DoesNotContain(known, item => item.Code == XamlValidator.UnknownResourceKeyCode);
        Assert.Contains(missing, item => item.Code == XamlValidator.UnknownResourceKeyCode);
    }

    [Theory]
    [InlineData("StaticResource", "StyleHostOther", "StyleHostBase")]
    [InlineData("ThemeResource", "StyleHostBase", "StyleHostDerived")]
    public void ResourceStyle_WithIncompatibleTargetType_IsReported(
        string resourceExtension,
        string consumerType,
        string targetType)
    {
        var xaml = $$"""
            <Page xmlns="using:TestApp"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                  xmlns:local="using:TestApp"
                  xmlns:ui="using:Microsoft.UI.Xaml"
                  x:Class="TestApp.Page">
              <Page.Resources>
                <ui:Style x:Key="LocalStyle" TargetType="local:{{targetType}}" />
              </Page.Resources>
              <local:{{consumerType}} Style="{ui:{{resourceExtension}} LocalStyle}" />
            </Page>
            """;

        var diagnostic = Assert.Single(
            Validate(xaml),
            item => item.Code == XamlValidator.InvalidStyleTargetTypeCode);
        Assert.Equal(1, diagnostic.Severity);
        Assert.Contains($"targets '{targetType}'", diagnostic.Message, StringComparison.Ordinal);
        Assert.Contains($"element type '{consumerType}'", diagnostic.Message, StringComparison.Ordinal);

        var document = new TextDocument("file:///C:/test/Page.xaml", xaml);
        Assert.Equal(
            xaml.LastIndexOf("LocalStyle", StringComparison.Ordinal),
            document.OffsetAt(diagnostic.Range.Start));
        Assert.Equal(
            xaml.LastIndexOf("LocalStyle", StringComparison.Ordinal) + "LocalStyle".Length,
            document.OffsetAt(diagnostic.Range.End));
    }

    [Theory]
    [InlineData("StaticResource", "StyleHostBase")]
    [InlineData("ThemeResource", "StyleHostDerived")]
    public void ResourceStyle_WithCompatibleTargetType_RemainsClean(
        string resourceExtension,
        string consumerType)
    {
        var xaml = $$"""
            <Page xmlns="using:TestApp"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                  xmlns:local="using:TestApp"
                  xmlns:ui="using:Microsoft.UI.Xaml"
                  x:Class="TestApp.Page">
              <Page.Resources>
                <ui:Style x:Key="LocalStyle" TargetType="local:StyleHostBase" />
              </Page.Resources>
              <local:{{consumerType}} Style="{ui:{{resourceExtension}} LocalStyle}" />
            </Page>
            """;

        Assert.DoesNotContain(
            Validate(xaml),
            item => item.Code == XamlValidator.InvalidStyleTargetTypeCode);
    }

    [Fact]
    public void StaticResourceStyle_UsesNearestResourceScope()
    {
        const string xaml = """
            <Page xmlns="using:TestApp"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                  xmlns:local="using:TestApp"
                  xmlns:ui="using:Microsoft.UI.Xaml"
                  x:Class="TestApp.Page">
              <Page.Resources>
                <ui:Style x:Key="ScopedStyle" TargetType="local:StyleHostOther" />
              </Page.Resources>
              <local:StyleHostBase Style="{ui:StaticResource ScopedStyle}">
                <local:StyleHostBase.Resources>
                  <ui:Style x:Key="ScopedStyle" TargetType="local:StyleHostBase" />
                </local:StyleHostBase.Resources>
              </local:StyleHostBase>
            </Page>
            """;

        Assert.DoesNotContain(
            Validate(xaml),
            item => item.Code == XamlValidator.InvalidStyleTargetTypeCode);
    }

    [Fact]
    public void StaticResourceStyle_WithoutLocalAuthoritativeTarget_RemainsClean()
    {
        Assert.DoesNotContain(
            Validate(
                Page("""Style="{ui:StaticResource ExternalStyle}" """),
                "ExternalStyle"),
            item => item.Code == XamlValidator.InvalidStyleTargetTypeCode);
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
    public void MissingConverterResource_IsReportedWithoutNearMatch()
    {
        var diagnostics = Validate(
            Page("""Text="{ui:Binding Converter={ui:StaticResource CompletelyMissingConverter}}" """),
            "AccentBrush");

        Assert.Contains(
            diagnostics,
            item => item.Code == XamlValidator.UnknownResourceKeyCode &&
                item.Message.Contains("CompletelyMissingConverter", StringComparison.Ordinal));
    }

    [Fact]
    public void ResourceReferencesAllowForwardDeclarationsInSameDictionary()
    {
        const string staticReference = """
            <ResourceDictionary
                xmlns="using:Microsoft.UI.Xaml"
                xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                xmlns:local="using:TestApp">
              <local:Child x:Key="Consumer" Text="{StaticResource Later}" />
              <local:Child x:Key="Later" />
            </ResourceDictionary>
            """;
        var themeReference = staticReference.Replace(
            "{StaticResource Later}",
            "{ThemeResource Later}",
            StringComparison.Ordinal);

        Assert.DoesNotContain(
            Validate(staticReference),
            item => item.Code == XamlValidator.UnknownResourceKeyCode);
        Assert.DoesNotContain(
            Validate(themeReference),
            item => item.Code == XamlValidator.UnknownResourceKeyCode);
    }

    [Fact]
    public void NamedAndKeyedResourceEntries_CollideInOneDictionary()
    {
        const string xaml = """
            <Page xmlns="using:TestApp"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                  xmlns:ui="using:Microsoft.UI.Xaml"
                  x:Class="TestApp.Page">
              <Page.Resources>
                <Child x:Name="Duplicate" />
                <Child x:Key="Duplicate" />
              </Page.Resources>
            </Page>
            """;

        Assert.Single(
            Validate(xaml),
            item => item.Code == XamlValidator.DuplicateKeyCode);
    }

    [Fact]
    public void NamedResourceEntry_IsVisibleToStaticResourceReferences()
    {
        const string xaml = """
            <Page xmlns="using:TestApp"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                  xmlns:ui="using:Microsoft.UI.Xaml"
                  x:Class="TestApp.Page">
              <Page.Resources>
                <Child x:Name="ShowTransitions" />
              </Page.Resources>
              <Child Text="{ui:StaticResource ShowTransitions}" />
            </Page>
            """;

        Assert.DoesNotContain(
            Validate(xaml),
            item => item.Code == XamlValidator.UnknownResourceKeyCode);
    }

    [Fact]
    public void NestedResourceDictionaryKey_DoesNotLeakToOuterScope()
    {
        const string xaml = """
            <ResourceDictionary
                xmlns="using:Microsoft.UI.Xaml"
                xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                xmlns:local="using:TestApp">
              <ResourceDictionary x:Key="Nested">
                <local:Child x:Key="NestedOnly" />
              </ResourceDictionary>
              <local:Child x:Key="Consumer" Text="{StaticResource NestedOnly}" />
            </ResourceDictionary>
            """;

        Assert.Contains(
            Validate(xaml),
            item => item.Code == XamlValidator.UnknownResourceKeyCode);
    }

    [Fact]
    public void ExplicitResourceDictionaryWrapper_IsTransparentButKeyedDictionaryIsNot()
    {
        const string xaml = """
            <Page xmlns="using:TestApp"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                  xmlns:ui="using:Microsoft.UI.Xaml"
                  x:Class="TestApp.Page">
              <Page.Resources>
                <ui:ResourceDictionary>
                  <Child x:Key="Wrapped" />
                  <ui:ResourceDictionary x:Key="Nested">
                    <Child x:Key="NestedOnly" />
                  </ui:ResourceDictionary>
                </ui:ResourceDictionary>
              </Page.Resources>
              <Child Text="{ui:StaticResource Wrapped}" />
              <Child Text="{ui:StaticResource NestedOnly}" />
            </Page>
            """;

        var missing = Validate(xaml)
            .Where(item => item.Code == XamlValidator.UnknownResourceKeyCode)
            .ToArray();
        Assert.Single(missing);
        Assert.Contains("NestedOnly", missing[0].Message);
    }

    [Fact]
    public void ThemeDictionaryKeysAreVisibleButThemeDictionaryNamesDoNotLeak()
    {
        const string xaml = """
            <ui:ResourceDictionary
                xmlns="using:TestApp"
                xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                xmlns:ui="using:Microsoft.UI.Xaml">
              <ui:ResourceDictionary.ThemeDictionaries>
                <ui:ResourceDictionary x:Key="Default">
                  <Child x:Key="ThemeValue" />
                </ui:ResourceDictionary>
              </ui:ResourceDictionary.ThemeDictionaries>
              <Child x:Key="Good" Text="{ui:ThemeResource ThemeValue}" />
              <Child x:Key="Bad" Text="{ui:StaticResource Default}" />
            </ui:ResourceDictionary>
            """;

        var missing = Validate(xaml)
            .Where(item => item.Code == XamlValidator.UnknownResourceKeyCode)
            .ToArray();
        Assert.Single(missing);
        Assert.Contains("Default", missing[0].Message);
    }

    [Fact]
    public void ResourceLookupIgnoresTextualOrder()
    {
        const string xaml = """
            <Page xmlns="using:TestApp"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                  xmlns:ui="using:Microsoft.UI.Xaml"
                  x:Class="TestApp.Page">
              <Child Text="{ui:StaticResource LaterAncestor}" />
              <Page.Resources>
                <Child x:Key="LaterAncestor" />
              </Page.Resources>
            </Page>
            """;

        Assert.DoesNotContain(
            Validate(xaml),
            item => item.Code == XamlValidator.UnknownResourceKeyCode);

        const string sameDictionary = """
            <Page xmlns="using:TestApp"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                  xmlns:ui="using:Microsoft.UI.Xaml"
                  x:Class="TestApp.Page">
              <Page.Resources>
                <Child x:Key="First" Text="{ui:StaticResource Later}" />
                <Child x:Key="Later" />
              </Page.Resources>
            </Page>
            """;
        Assert.DoesNotContain(
            Validate(sameDictionary),
            item => item.Code == XamlValidator.UnknownResourceKeyCode);
    }

    [Fact]
    public void IncompleteExternalResourceCatalogReportsMissingKeysAsWarnings()
    {
        var arbitrary = ValidateWithAuthority(
            Page("""Text="{ui:StaticResource RuntimeLibraryKey}" """),
            resourceCatalogIsAuthoritative: false,
            "KnownProjectKey");
        var typo = ValidateWithAuthority(
            Page("""Text="{ui:StaticResource KnownProjectKe}" """),
            resourceCatalogIsAuthoritative: false,
            "KnownProjectKey");

        Assert.Contains(arbitrary, item =>
            item.Code == XamlValidator.UnknownResourceKeyCode && item.Severity == 2);
        Assert.Contains(typo, item =>
            item.Code == XamlValidator.UnknownResourceKeyCode && item.Severity == 2);
    }

    [Fact]
    public void IncompleteExternalResourceCatalogSuggestsScopedDocumentResource()
    {
        const string xaml = """
            <Page xmlns="using:TestApp"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                  xmlns:ui="using:Microsoft.UI.Xaml"
                  x:Class="TestApp.Page">
              <Page.Resources>
                <Child x:Key="LocalAccentBrush" />
              </Page.Resources>
              <Child Text="{ui:StaticResource LocalAcentBrush}" />
            </Page>
            """;

        var diagnostic = Assert.Single(
            ValidateWithAuthority(xaml, resourceCatalogIsAuthoritative: false),
            item => item.Code == XamlValidator.UnknownResourceKeyCode);
        var data = Assert.IsType<DiagnosticData>(diagnostic.Data);
        Assert.Contains("LocalAccentBrush", data.Suggestions);
    }

    [Fact]
    public void IncompleteExternalResourceCatalogAllowsLocalForwardReference()
    {
        const string xaml = """
            <Page xmlns="using:TestApp"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                  xmlns:ui="using:Microsoft.UI.Xaml"
                  x:Class="TestApp.Page">
              <Page.Resources>
                <Child Text="{ui:StaticResource Later}" />
                <Child x:Key="Later" />
              </Page.Resources>
            </Page>
            """;

        Assert.DoesNotContain(
            ValidateWithAuthority(xaml, resourceCatalogIsAuthoritative: false),
            item => item.Code == XamlValidator.UnknownResourceKeyCode);
    }

    [Theory]
    [InlineData("""
        <Page.Resources>
          <Child x:Key="Container">
            <Child.Resources>
              <Child x:Key="ExternalOrNestedKey" />
            </Child.Resources>
          </Child>
        </Page.Resources>
        <Child Text="{ui:StaticResource ExternalOrNestedKe}" />
        """)]
    [InlineData("""
        <Child>
          <Child.Resources>
            <Child x:Key="ExternalOrNestedKey" />
          </Child.Resources>
        </Child>
        <Child Text="{ui:StaticResource ExternalOrNestedKe}" />
        """)]
    public void IncompleteExternalResourceCatalogIgnoresNearMissInaccessibleResource(
        string content)
    {
        const string prefix = """
            <Page xmlns="using:TestApp"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                  xmlns:ui="using:Microsoft.UI.Xaml"
                  x:Class="TestApp.Page">
            """;

        Assert.Contains(
            ValidateWithAuthority(
                prefix + content + "</Page>",
                resourceCatalogIsAuthoritative: false),
            item => item.Code == XamlValidator.UnknownResourceKeyCode);
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

    [Theory]
    [InlineData("Secret")]
    [InlineData("PrivateGetter")]
    public void DataTemplate_RejectsInaccessibleDataTypeMembers(string path)
    {
        const string template = """
            <Page xmlns="using:TestApp"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                  xmlns:ui="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
                  xmlns:local="using:TestApp"
                  x:Class="TestApp.Page">
              <ui:DataTemplate x:DataType="local:Child">
                <Child Text="{x:Bind PATH}" />
              </ui:DataTemplate>
            </Page>
            """;

        Assert.Contains(
            Validate(template.Replace("PATH", path)),
            diagnostic => diagnostic.Code == XamlValidator.InaccessibleBindMemberCode);
    }

    [Fact]
    public void BindPath_RejectsProtectedMemberThroughBaseTypedReceiver()
    {
        Assert.Contains(
            Validate(Page("""Text="{x:Bind OtherBase.ProtectedText}" """)),
            diagnostic => diagnostic.Code == XamlValidator.InaccessibleBindMemberCode);
    }

    [Fact]
    public void DataTemplateMissingDataType_CarriesProvenItemsSourceItemType()
    {
        const string xaml = """
            <Page xmlns="using:TestApp"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                  xmlns:ui="using:Microsoft.UI.Xaml"
                  x:Class="TestApp.Page">
              <ItemsHost ItemsSource="{x:Bind Children}">
                <ItemsHost.ItemTemplate>
                  <ui:DataTemplate>
                    <Child Text="{x:Bind Name}" />
                  </ui:DataTemplate>
                </ItemsHost.ItemTemplate>
              </ItemsHost>
            </Page>
            """;

        var diagnostic = Assert.Single(
            Validate(xaml), d => d.Code == XamlValidator.DataTemplateDataTypeRequiredCode);
        var data = Assert.IsType<DiagnosticData>(diagnostic.Data);
        Assert.Equal("using:TestApp", data.Bad);
        Assert.Equal(["Child"], data.Suggestions);
    }

    [Fact]
    public void DataTemplateMissingDataType_DoesNotGuessFromClassicBinding()
    {
        const string xaml = """
            <Page xmlns="using:TestApp"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                  xmlns:ui="using:Microsoft.UI.Xaml"
                  x:Class="TestApp.Page">
              <ItemsHost ItemsSource="{ui:Binding Path=Children}">
                <ItemsHost.ItemTemplate>
                  <ui:DataTemplate>
                    <Child Text="{x:Bind Name}" />
                  </ui:DataTemplate>
                </ItemsHost.ItemTemplate>
              </ItemsHost>
            </Page>
            """;

        var diagnostic = Assert.Single(
            Validate(xaml), d => d.Code == XamlValidator.DataTemplateDataTypeRequiredCode);
        Assert.Null(diagnostic.Data);
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
    public void CollectionPropertyElement_AcceptsExplicitCollectionWrapper()
    {
        const string xaml = """
            <Grid xmlns="using:TestApp">
              <Grid.ChildrenTransitions>
                <TransitionCollection>
                  <RepositionThemeTransition />
                </TransitionCollection>
              </Grid.ChildrenTransitions>
            </Grid>
            """;

        Assert.DoesNotContain(
            Validate(xaml),
            diagnostic => diagnostic.Code == XamlValidator.InvalidPropertyElementChildCode);
    }

    [Fact]
    public void SelfOwnerDottedAttribute_ResolvesOrdinaryProperty()
    {
        const string xaml = """
            <Grid xmlns="using:TestApp" Grid.ColumnDefinitions="*,*" />
            """;

        Assert.DoesNotContain(
            Validate(xaml),
            diagnostic => diagnostic.Code == XamlValidator.UnknownAttachedPropertyCode);
    }

    [Fact]
    public void UnknownNuGetAttachedPropertyOwner_IsReportedInKnownNamespace()
    {
        const string xaml = """
            <Button xmlns="using:TestApp"
                    xmlns:ui="using:CommunityToolkit.WinUI"
                    ui:NoSuchExtension.Value="1" />
            """;
        const string source = Types + """

            namespace CommunityToolkit.WinUI
            {
                public static class FrameworkElementExtensions
                {
                    public static int GetValue(object element) => 0;
                    public static void SetValue(object element, int value) { }
                }
            }
            """;

        Assert.Contains(
            ValidateWithSource(xaml, source),
            diagnostic => diagnostic.Code == XamlValidator.UnknownTypeCode &&
                diagnostic.Message.Contains("NoSuchExtension", StringComparison.Ordinal));
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
    public void UnqualifiedProjectControlInAnotherNamespace_IsAnError()
    {
        const string xaml = """
            <Page xmlns="using:TestApp">
              <CustomButton />
            </Page>
            """;

        var diagnostic = Assert.Single(
            Validate(xaml),
            item => item.Code == XamlValidator.UnknownTypeCode);

        Assert.Equal(1, diagnostic.Severity);
    }

    [Fact]
    public void PresentationNamespaceColor_ResolvesAsResourceElement()
    {
        const string xaml = """
            <ResourceDictionary
                xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
                xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
              <Color x:Key="AccentColor">#ee9bbf</Color>
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

    [Fact]
    public void XClass_MustResolveInProjectCompilation()
    {
        const string xaml = """
            <BaseControl xmlns="using:TestApp"
                         xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                         x:Class="TestApp.MissingPage" />
            """;

        Assert.Contains(
            Validate(xaml),
            diagnostic => diagnostic.Code == XamlValidator.UnknownRootClassCode);
    }

    [Fact]
    public void ClassicBinding_InUntypedDataTemplate_ReportsWmc1510()
    {
        const string xaml = """
            <ui:DataTemplate xmlns="using:TestApp"
                             xmlns:ui="using:Microsoft.UI.Xaml">
              <Page Text="{ui:Binding Name}" />
            </ui:DataTemplate>
            """;
        const string typed = """
            <ui:DataTemplate xmlns="using:TestApp"
                             xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                             xmlns:ui="using:Microsoft.UI.Xaml"
                             x:DataType="Child">
              <Page Text="{ui:Binding Name}" />
            </ui:DataTemplate>
            """;

        var diagnostic = Assert.Single(
            Validate(xaml),
            item => item.Code == XamlValidator.BindingDataTypeRecommendedCode);
        Assert.Contains("Native AOT", diagnostic.Message);
        Assert.DoesNotContain("cannot be compiled", diagnostic.Message);
        Assert.DoesNotContain(
            Validate(typed),
            diagnostic => diagnostic.Code == XamlValidator.BindingDataTypeRecommendedCode);
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
    public void ClassicBinding_ValidatesNamedArgumentsAndEnumValues()
    {
        var unknown = Validate(Page("""Text="{ui:Binding Pathh=Name}" """));
        var invalidMode = Validate(Page("""Text="{ui:Binding Path=Name, Mode=Sideways}" """));
        var invalidRelativeSource = Validate(Page(
            """Text="{ui:Binding Path=Name, RelativeSource={ui:RelativeSource Mode=Elsewhere}}" """));

        Assert.Single(unknown, d => d.Code == XamlValidator.UnknownBindingArgumentCode);
        Assert.Single(invalidMode, d => d.Code == XamlValidator.InvalidBindingValueCode);
        Assert.Single(invalidRelativeSource, d => d.Code == XamlValidator.InvalidRelativeSourceCode);
    }

    [Fact]
    public void BindingElementName_UsesApplicableNameScope()
    {
        const string xaml = """
            <Page xmlns="using:TestApp"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                  xmlns:ui="using:Microsoft.UI.Xaml"
                  x:Class="TestApp.Page">
              <Child x:Name="Outside" />
              <ui:DataTemplate x:DataType="Child">
                <Child Text="{ui:Binding ElementName=Outside, Path=Text}" />
              </ui:DataTemplate>
            </Page>
            """;

        Assert.Single(Validate(xaml),
            d => d.Code == XamlValidator.UnknownBindingElementNameCode);
    }

    [Fact]
    public void BindingElementName_SeesNamesInsideItsControlTemplate()
    {
        const string xaml = """
            <controls:ControlTemplate xmlns="using:TestApp"
                                      xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                                      xmlns:ui="using:Microsoft.UI.Xaml"
                                      xmlns:controls="using:Microsoft.UI.Xaml.Controls"
                                      TargetType="StyledControl">
              <Child x:Name="RootGrid" />
              <Child Text="{ui:Binding ElementName=RootGrid, Path=Text}" />
            </controls:ControlTemplate>
            """;

        Assert.DoesNotContain(
            Validate(xaml),
            d => d.Code == XamlValidator.UnknownBindingElementNameCode);
    }

    [Fact]
    public void TemplateBinding_ValidatesAgainstTemplateTargetType()
    {
        const string xaml = """
            <controls:ControlTemplate xmlns="using:TestApp"
                                xmlns:ui="using:Microsoft.UI.Xaml"
                                xmlns:controls="using:Microsoft.UI.Xaml.Controls"
                                TargetType="StyledControl">
              <Child Text="{ui:TemplateBinding Missing}" />
            </controls:ControlTemplate>
            """;

        Assert.Single(Validate(xaml), d => d.Code == XamlValidator.InvalidTemplateBindingCode);
    }

    [Fact]
    public void TemplateBinding_AcceptsAttachedPropertyPaths()
    {
        const string xaml = """
            <controls:ControlTemplate xmlns="using:TestApp"
                                      xmlns:ui="using:Microsoft.UI.Xaml"
                                      xmlns:controls="using:Microsoft.UI.Xaml.Controls"
                                      TargetType="StyledControl">
              <Child Text="{ui:TemplateBinding ScrollViewer.HorizontalScrollBarVisibility}" />
            </controls:ControlTemplate>
            """;

        Assert.DoesNotContain(
            Validate(xaml),
            d => d.Code == XamlValidator.InvalidTemplateBindingCode);
    }

    [Fact]
    public void TemplateBinding_AcceptsReadableGetOnlyCollection()
    {
        const string xaml = """
            <controls:ControlTemplate xmlns="using:TestApp"
                                      xmlns:ui="using:Microsoft.UI.Xaml"
                                      xmlns:controls="using:Microsoft.UI.Xaml.Controls"
                                      TargetType="StyledControl">
              <ItemsHost ItemsSource="{ui:TemplateBinding Items}" />
            </controls:ControlTemplate>
            """;

        Assert.DoesNotContain(
            Validate(xaml),
            d => d.Code == XamlValidator.InvalidTemplateBindingCode);
    }

    [Theory]
    [InlineData("WriteOnly")]
    [InlineData("local:Grid.Missing")]
    [InlineData("missing:Grid.Row")]
    public void TemplateBinding_RejectsUnreadableOrUnknownPaths(string path)
    {
        var xaml = $$"""
            <controls:ControlTemplate xmlns="using:TestApp"
                                      xmlns:local="using:TestApp"
                                      xmlns:ui="using:Microsoft.UI.Xaml"
                                      xmlns:controls="using:Microsoft.UI.Xaml.Controls"
                                      TargetType="StyledControl">
              <Child Text="{ui:TemplateBinding {{path}}}" />
            </controls:ControlTemplate>
            """;

        Assert.Single(
            Validate(xaml),
            d => d.Code == XamlValidator.InvalidTemplateBindingCode);
    }

    [Theory]
    [InlineData("WriteOnlyAttached.Value")]
    [InlineData("NarrowAttached.Value")]
    public void TemplateBinding_RejectsUnreadableOrInapplicableAttachedProperties(string path)
    {
        var xaml = $$"""
            <controls:ControlTemplate xmlns="using:TestApp"
                                      xmlns:ui="using:Microsoft.UI.Xaml"
                                      xmlns:controls="using:Microsoft.UI.Xaml.Controls"
                                      TargetType="StyledControl">
              <Child Text="{ui:TemplateBinding {{path}}}" />
            </controls:ControlTemplate>
            """;

        Assert.Single(
            Validate(xaml),
            d => d.Code == XamlValidator.InvalidTemplateBindingCode);
    }

    [Fact]
    public void MissingKnownDataType_IsReportedOnce()
    {
        const string xaml = """
            <ui:DataTemplate xmlns="using:TestApp"
                             xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                             xmlns:ui="using:Microsoft.UI.Xaml"
                             x:DataType="MissingChild">
              <Child Text="{x:Bind Name}" />
            </ui:DataTemplate>
            """;

        Assert.Single(Validate(xaml), d => d.Code == XamlValidator.UnknownDataTypeCode);
    }

    [Fact]
    public void XBind_ValidatesResultAssignmentAccessibilityAndStaticPaths()
    {
        Assert.DoesNotContain(
            Validate(Page("""Visibility="{x:Bind IsEnabled}" """)),
            d => d.Code == XamlValidator.InvalidBindAssignmentCode);
        Assert.DoesNotContain(
            Validate(Page("""Text="{x:Bind Text}" """)),
            d => d.Code == XamlValidator.InvalidBindAssignmentCode);
        Assert.DoesNotContain(
            Validate(Page("""Text="{x:Bind SecretText}" """)),
            d => d.Code is XamlValidator.UnknownBindMemberCode or
                XamlValidator.InaccessibleBindMemberCode);
        foreach (var inheritedPath in new[]
                 {
                     "ProtectedText",
                     "InternalText",
                     "PrivateProtectedText",
                 })
        {
            Assert.DoesNotContain(
                Validate(Page($$"""Text="{x:Bind {{inheritedPath}}}" """)),
                d => d.Code is XamlValidator.UnknownBindMemberCode or
                    XamlValidator.InaccessibleBindMemberCode);
        }
        Assert.DoesNotContain(
            Validate(Page("""Code="{x:Bind Letter}" """)),
            d => d.Code == XamlValidator.InvalidBindAssignmentCode);
        Assert.DoesNotContain(
            Validate(Page("""Text="{x:Bind Code}" """)),
            d => d.Code == XamlValidator.InvalidBindAssignmentCode);
        Assert.Single(
            Validate(Page("""Width="{x:Bind Child}" """)),
            d => d.Code == XamlValidator.InvalidBindAssignmentCode);
        Assert.DoesNotContain(
            Validate(Page("""Width="{x:Bind Child, Converter={StaticResource Converter}}" """)),
            d => d.Code == XamlValidator.InvalidBindAssignmentCode);
        Assert.Single(
            Validate(Page("""Text="{x:Bind Child.Secret}" """)),
            d => d.Code == XamlValidator.InaccessibleBindMemberCode);
        Assert.DoesNotContain(
            Validate(Page("""Text="{x:Bind Child.InternalText}" """)),
            d => d.Code is XamlValidator.UnknownBindMemberCode or
                XamlValidator.InaccessibleBindMemberCode);
        Assert.Single(
            Validate(Page("""Width="{x:Bind local:BindStatics.Flag}" """)),
            d => d.Code == XamlValidator.InvalidBindAssignmentCode);
        Assert.DoesNotContain(
            Validate(Page("""Visibility="{x:Bind local:BindStatics.InternalFlag}" """)),
            d => d.Code is XamlValidator.UnknownBindMemberCode or
                XamlValidator.InaccessibleBindMemberCode);
        Assert.DoesNotContain(
            Validate(Page("""Text="{x:Bind local:BindStatics.Child.InternalText}" """)),
            d => d.Code is XamlValidator.UnknownBindMemberCode or
                XamlValidator.InaccessibleBindMemberCode);
        Assert.DoesNotContain(
            Validate(Page("""Text="{x:Bind local:BindStatics.Children[0].Name}" """)),
            d => d.Code is XamlValidator.UnknownBindMemberCode or
                XamlValidator.InaccessibleBindMemberCode);
        Assert.DoesNotContain(
            Validate(Page("""Text="{x:Bind local:BindStatics.Format(Text)}" """)),
            d => d.Code is XamlValidator.UnknownBindMemberCode or
                XamlValidator.InvalidBindFunctionCode);
        Assert.DoesNotContain(
            Validate(Page("""Text="{x:Bind local:BindStatics.Format(Text, Text)}" """)),
            d => d.Code is XamlValidator.UnknownBindMemberCode or
                XamlValidator.InvalidBindFunctionCode);
        Assert.DoesNotContain(
            Validate(Page("""Text="{x:Bind local:BindStatics.Format(Child.Name)}" """)),
            d => d.Code is XamlValidator.UnknownBindMemberCode or
                XamlValidator.InvalidBindFunctionCode);
        Assert.DoesNotContain(
            Validate(Page("""Text="{x:Bind local:BindStatics.Format((Child))}" """)),
            d => d.Code is XamlValidator.UnknownBindMemberCode or
                XamlValidator.InvalidBindFunctionCode);
        Assert.DoesNotContain(
            Validate(Page("""Text="{x:Bind local:BindStatics.Formatter.Format(Child)}" """)),
            d => d.Code is XamlValidator.UnknownBindMemberCode or
                XamlValidator.InvalidBindFunctionCode);
        Assert.DoesNotContain(
            Validate(Page("""Text="{x:Bind local:BindStatics.Children[0].Name.ToString()}" """)),
            d => d.Code is XamlValidator.UnknownBindMemberCode or
                XamlValidator.InvalidBindFunctionCode);
        Assert.Contains(
            Validate(Page("""Text="{x:Bind local:BindStatics.Format()}" """)),
            d => d.Code == XamlValidator.InvalidBindFunctionCode);
        Assert.Contains(
            Validate(Page("""Text="{x:Bind local:BindStatics.PrivateGetter}" """)),
            d => d.Code == XamlValidator.UnknownBindMemberCode);
        var missingNegated = Validate(Page("""Text="{x:Bind !DefinitelyMissingNegated}" """));
        Assert.Single(
            missingNegated,
            d => d.Code == XamlValidator.UnknownBindMemberCode);
        Assert.DoesNotContain(
            missingNegated,
            d => d.Code == XamlValidator.InvalidBindAssignmentCode);
    }

    [Fact]
    public void BindAssignment_UsesNullableAndUserDefinedConversions()
    {
        Assert.Contains(
            Validate(Page("""Width="{x:Bind OptionalWidth}" """)),
            diagnostic => diagnostic.Code == XamlValidator.InvalidBindAssignmentCode);
        Assert.DoesNotContain(
            Validate(Page("""OptionalWidthTarget="{x:Bind Width}" """)),
            diagnostic => diagnostic.Code == XamlValidator.InvalidBindAssignmentCode);
        Assert.DoesNotContain(
            Validate(Page("""Width="{x:Bind ConvertibleWidth}" """)),
            diagnostic => diagnostic.Code == XamlValidator.InvalidBindAssignmentCode);
    }

    [Theory]
    [InlineData("Image", "ImagePath")]
    [InlineData("Image", "OptionalImagePath")]
    [InlineData("LegacyImage", "ImagePath")]
    [InlineData("Uri", "ImagePath")]
    [InlineData("OptionalUri", "ImagePath")]
    public void BindAssignment_AcceptsBuiltInStringXamlConversions(
        string targetProperty,
        string sourceProperty)
    {
        Assert.DoesNotContain(
            Validate(Page($$"""{{targetProperty}}="{x:Bind {{sourceProperty}}}" """)),
            diagnostic => diagnostic.Code == XamlValidator.InvalidBindAssignmentCode);
    }

    [Fact]
    public void EventHandler_RequiresCompatibleDelegateSignature()
    {
        Assert.DoesNotContain(
            Validate(Page("""ValueChanged="OnValueChanged" """)),
            d => d.Code is XamlValidator.MissingEventHandlerCode or
                XamlValidator.IncompatibleEventHandlerCode);
        Assert.Single(
            Validate(Page("""ValueChanged="BadValueChanged" """)),
            d => d.Code == XamlValidator.IncompatibleEventHandlerCode);
        Assert.Single(
            Validate(Page("""ValueChanged="WrongReturn" """)),
            d => d.Code == XamlValidator.IncompatibleEventHandlerCode);
        Assert.Single(
            Validate(Page("""Clicked="PrivateBaseClick" """)),
            d => d.Code == XamlValidator.MissingEventHandlerCode);
    }

    [Fact]
    public void UnknownLocalNamespace_IsWarned()
    {
        const string xaml = """
            <Page xmlns="using:TestApp"
                  xmlns:empty="using:TestApp.Empty"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                  x:Class="TestApp.Page">
              <Child />
            </Page>
            """;

        Assert.Single(
            Validate(xaml),
            diagnostic => diagnostic.Code == XamlValidator.UnknownNamespaceDeclarationCode);
    }

    [Theory]
    [InlineData("using:TestApp")]
    [InlineData("clr-namespace:TestApp")]
    [InlineData("clr-namespace:TestApp;assembly=TestApp")]
    public void LoadedNamespaceDeclarations_RemainClean(string namespaceUri)
    {
        var xaml = $$"""
            <Page xmlns="using:TestApp"
                  xmlns:known="{{namespaceUri}}"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                  x:Class="TestApp.Page">
              <known:Child />
            </Page>
            """;

        Assert.DoesNotContain(
            Validate(xaml),
            diagnostic => diagnostic.Code == XamlValidator.UnknownNamespaceDeclarationCode);
    }

    [Theory]
    [InlineData("using:")]
    [InlineData("clr-namespace:")]
    [InlineData("clr-namespace: ;assembly=External")]
    public void EmptyNamespaceDeclaration_IsWarned(string namespaceUri)
    {
        var xaml = $$"""
            <Page xmlns="using:TestApp"
                  xmlns:empty="{{namespaceUri}}"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                  x:Class="TestApp.Page">
              <Child />
            </Page>
            """;

        Assert.Single(
            Validate(xaml),
            diagnostic => diagnostic.Code == XamlValidator.UnknownNamespaceDeclarationCode);
    }

    [Fact]
    public void NamespaceAbsentFromLoadedCompilation_IsWarned()
    {
        const string xaml = """
            <Page xmlns="using:TestApp"
                  xmlns:external="using:Package.NotLoaded"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                  x:Class="TestApp.Page">
              <Child />
            </Page>
            """;

        Assert.Single(
            Validate(xaml),
            diagnostic => diagnostic.Code == XamlValidator.UnknownNamespaceDeclarationCode);
    }

    [Fact]
    public void UndeclaredElementPrefix_SuggestsUniqueAuthoritativeUsingUri()
    {
        var diagnostic = Assert.Single(
            Validate("""<missing:Child />"""),
            d => d.Code == XamlValidator.UndeclaredPrefixCode);

        var data = Assert.IsType<DiagnosticData>(diagnostic.Data);
        Assert.Equal("missing", data.Bad);
        Assert.Equal(["using:TestApp"], data.Suggestions);
    }

    [Fact]
    public void UndeclaredElementPrefix_DoesNotSuggestAmbiguousTypes()
    {
        const string ambiguousTypes = Types + """

            namespace Other
            {
                public class Child { }
            }
            """;

        var ambiguous = Assert.Single(
            ValidateWithSource("""<missing:Child />""", ambiguousTypes),
            d => d.Code == XamlValidator.UndeclaredPrefixCode);
        Assert.Null(ambiguous.Data);
    }

    [Theory]
    [InlineData("x", "Class", "http://schemas.microsoft.com/winfx/2006/xaml")]
    [InlineData("d", "DesignInstance", "http://schemas.microsoft.com/expression/blend/2008")]
    [InlineData("mc", "Ignorable", "http://schemas.openxmlformats.org/markup-compatibility/2006")]
    public void UndeclaredStandardPrefix_SuggestsCanonicalNamespace(
        string prefix,
        string localName,
        string namespaceUri)
    {
        var diagnostic = Assert.Single(
            Validate($$"""<Page {{prefix}}:{{localName}}="Value" />"""),
            d => d.Code == XamlValidator.UndeclaredPrefixCode);
        var data = Assert.IsType<DiagnosticData>(diagnostic.Data);

        Assert.Equal(prefix, data.Bad);
        Assert.Equal([namespaceUri], data.Suggestions);
    }

    [Fact]
    public void PrefixedAttachedPropertyDiscoveredByCompletionIsValidated()
    {
        const string valid = """
            <Page xmlns="using:TestApp"
                  xmlns:ui="using:Toolkit"
                  ui:FrameworkElementExtensions.IsEnabled="true" />
            """;
        const string invalid = """
            <Page xmlns="using:TestApp"
                  xmlns:ui="using:Toolkit"
                  ui:FrameworkElementExtensions.IsEnabld="true" />
            """;

        Assert.DoesNotContain(
            Validate(valid),
            diagnostic =>
                diagnostic.Code ==
                XamlValidator.UnknownAttachedPropertyCode);
        Assert.Contains(
            Validate(invalid),
            diagnostic =>
                diagnostic.Code ==
                XamlValidator.UnknownAttachedPropertyCode);

        const string incompatible = """
            <Page xmlns="using:TestApp"
                  xmlns:ui="using:Toolkit"
                  ui:ChildExtensions.Rank="1" />
            """;
        Assert.Contains(
            Validate(incompatible),
            diagnostic =>
                diagnostic.Code ==
                XamlValidator.UnknownAttachedPropertyCode);
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

    private static System.Collections.Generic.List<Lsp.Diagnostic> ValidateWithAuthority(
        string xaml,
        bool resourceCatalogIsAuthoritative,
        params string[] resourceKeys)
    {
        var compilation = CSharpCompilation.Create(
            "TestApp",
            [CSharpSyntaxTree.ParseText(Types)],
            [MetadataReference.CreateFromFile(typeof(object).Assembly.Location)],
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var typeSystem = XamlTypeSystem.FromCompilation(
            compilation,
            ImmutableArray<IAssemblySymbol>.Empty);
        var document = new TextDocument("file:///C:/test/Page.xaml", xaml);

        return XamlValidator.Validate(
            document,
            typeSystem,
            resourceKeys,
            resourceCatalogIsAuthoritative);
    }
}
