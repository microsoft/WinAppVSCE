using System;
using System.Collections.Immutable;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using WinUiXaml.Workspace;
using Xunit;

namespace WinUiXaml.LanguageServer.Tests;

public sealed class AttributeCompletionTests
{
    private const string Types = """
        namespace TestApp
        {
            public class DependencyObject : Microsoft.UI.Xaml.DependencyObject { }
            public class Page : DependencyObject
            {
                public Microsoft.UI.Xaml.ResourceDictionary Resources { get; } = new();
                protected void InheritedHandler(object? sender, System.EventArgs e) { }
            }
            public class Button : DependencyObject
            {
                public double Width { get; set; }
                public string Text { get; set; } = "";
                public bool IsEnabled { get; set; }
                public Microsoft.UI.Xaml.Thickness Margin { get; set; }
                public Microsoft.UI.Xaml.Media.FontFamily FontFamily { get; set; } = new();
                public Microsoft.UI.Xaml.Media.Brush Foreground { get; set; } = new();
                public event System.EventHandler? Click;
            }

            public class Window : DependencyObject
            {
                public object SystemBackdrop { get; set; } = new object();
                public double ActualHeight { get; }
                public event System.EventHandler? Closed;
            }

            public class Widget : DependencyObject
            {
                public System.Collections.Generic.List<Button> Resources { get; } = new();
            }

            public class Grid : DependencyObject
            {
                public Microsoft.UI.Xaml.Controls.RowDefinitionCollection RowDefinitions { get; } = new();
                public Microsoft.UI.Xaml.Controls.ColumnDefinitionCollection ColumnDefinitions { get; } = new();
                public static int GetRow(DependencyObject value) => 0;
                public static void SetRow(DependencyObject value, int row) { }
            }

            public class RowDefinition : DependencyObject { }
            public class ColumnDefinition : DependencyObject { }
            public class DoubleAnimation : DependencyObject { }
            public class HelperService { }
            public class ClickEventArgs : System.EventArgs { }
            public class XamlPage : Page
            {
                private void ExistingHandler(object? sender, System.EventArgs e) { }
                private void InheritedHandler(int sender, string e) { }
                private void WrongHandler(int sender, string e) { }
            }

            public static class AutomationProperties
            {
                public static string GetName(DependencyObject value) => "";
                public static void SetName(DependencyObject value, string name) { }
                public static AccessibilityView GetAccessibilityView(DependencyObject value) => AccessibilityView.Raw;
                public static void SetAccessibilityView(DependencyObject value, AccessibilityView view) { }
            }

            public enum AccessibilityView { Raw, Control, Content }
        }

        namespace Microsoft.UI.Xaml.Media
        {
            public class Brush { }
            public class FontFamily { }
        }

        namespace Microsoft.UI.Xaml
        {
            public class DependencyObject { }
            public struct Thickness { }
            public class FrameworkTemplate { }
            public class DataTemplate : FrameworkTemplate { }
            public class Style : DependencyObject
            {
                public System.Type TargetType { get; set; } = typeof(object);
            }
            public class ResourceDictionary
            {
                public System.Collections.Generic.Dictionary<string, ResourceDictionary> ThemeDictionaries { get; } = new();
            }
        }

        namespace Microsoft.UI.Xaml.Controls
        {
            public class RowDefinitionCollection : System.Collections.Generic.List<TestApp.RowDefinition> { }
            public class ColumnDefinitionCollection : System.Collections.Generic.List<TestApp.ColumnDefinition> { }
        }

        namespace Microsoft.UI.Xaml.Media.Animation
        {
            public class Storyboard
            {
                public static string GetTargetName(object value) => "";
                public static void SetTargetName(object value, string name) { }
                public static string GetTargetProperty(object value) => "";
                public static void SetTargetProperty(object value, string name) { }
            }
        }

        namespace Toolkit
        {
            public static class FrameworkElementExtensions
            {
                public static bool GetIsEnabled(TestApp.DependencyObject value) => false;
                public static void SetIsEnabled(TestApp.DependencyObject value, bool enabled) { }
            }

            public static class GridExtensions
            {
                public static int GetColumn(TestApp.Grid value) => 0;
                public static void SetColumn(TestApp.Grid value, int column) { }
            }
        }
        """;

    [Theory]
    [InlineData("<Button Margin=\"|\" />", "0,0,0,0")]
    [InlineData("<Button FontFamily=\"|\" />", "Segoe Fluent Icons")]
    [InlineData("<Grid RowDefinitions=\"|\" />", "Auto,*,Auto")]
    [InlineData("<Grid ColumnDefinitions=\"|\" />", "Auto,*,Auto")]
    public void CommonLiteralValuesOfferAuthoringSuggestions(string body, string expected)
    {
        const string header = "<Page xmlns=\"using:TestApp\">";
        var marked = header + body + "</Page>";
        var offset = marked.IndexOf('|');
        var text = marked.Remove(offset, 1);

        var labels = CompletionProvider.Provide(
            new TextDocument("file:///C:/test/Page.xaml", text),
            offset,
            CreateTypeSystem()).Items.Select(item => item.Label);

        Assert.Contains(expected, labels);
    }

    [Theory]
    [InlineData("<Grid R| />", "RowDefinitions")]
    [InlineData("<Grid C| />", "ColumnDefinitions")]
    public void GridConciseCollectionsAreOfferedAsAttributes(string body, string expected)
    {
        const string header = "<Page xmlns=\"using:TestApp\">";
        Assert.Contains(expected, CompleteLabels(header + body + "</Page>"));
    }

    [Theory]
    [InlineData("<Grid RowDefinitions=\"|\" />", "rows")]
    [InlineData("<Grid ColumnDefinitions=\"|\" />", "columns")]
    public void GridDefinitionSuggestionsDescribeCorrectDimension(string body, string dimension)
    {
        const string header = "<Page xmlns=\"using:TestApp\">";
        var marked = header + body + "</Page>";
        var offset = marked.IndexOf('|');
        var text = marked.Remove(offset, 1);

        var item = CompletionProvider.Provide(
            new TextDocument("file:///C:/test/Page.xaml", text),
            offset,
            CreateTypeSystem()).Items.Single(candidate => candidate.Label == "Auto,*");

        Assert.Contains(dimension, item.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public void NewlineAttributeCompletion_IncludesDirectivesAndAutomationProperties()
    {
        const string marked = """
            <Button xmlns="using:TestApp"
                    xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                    | />
            """;
        var offset = marked.IndexOf('|');
        var text = marked.Remove(offset, 1);
        var items = CompletionProvider.Provide(
            new TextDocument("file:///C:/test/Page.xaml", text),
            offset,
            CreateTypeSystem()).Items;

        Assert.Contains(items, item => item.Label == "Width");
        Assert.Contains(items, item => item.Label == "x:Name");
        Assert.Contains(items, item => item.Label == "x:DataType");
        Assert.Contains(items, item => item.Label == "x:Uid");
        Assert.Contains(items, item => item.Label == "x:Load");
        Assert.Contains(items, item => item.Label == "AutomationProperties.Name");
    }

    [Fact]
    public void ResourceChildCompletionIncludesXKey()
    {
        const string marked = """
            <Page xmlns="using:TestApp"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
              <Page.Resources>
                <Button x:| />
              </Page.Resources>
            </Page>
            """;
        var offset = marked.IndexOf('|');
        var text = marked.Remove(offset, 1);
        var labels = CompletionProvider.Provide(
            new TextDocument("file:///C:/test/Page.xaml", text),
            offset,
            CreateTypeSystem()).Items.Select(item => item.Label);

        Assert.Contains("x:Key", labels);
    }

    [Fact]
    public void ThemeDictionaryChildCompletionIncludesXKey()
    {
        const string marked = """
            <Page xmlns="using:TestApp"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
              <ResourceDictionary.ThemeDictionaries xmlns="using:Microsoft.UI.Xaml">
                <ResourceDictionary x:| />
              </ResourceDictionary.ThemeDictionaries>
            </Page>
            """;
        var offset = marked.IndexOf('|');
        var text = marked.Remove(offset, 1);
        var labels = CompletionProvider.Provide(
            new TextDocument("file:///C:/test/Page.xaml", text),
            offset,
            CreateTypeSystem()).Items.Select(item => item.Label);

        Assert.Contains("x:Key", labels);
    }

    [Fact]
    public void XClassIsOnlyOfferedOnRootElement()
    {
        const string marked = """
            <Page xmlns="using:TestApp"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
              <Button x:| />
            </Page>
            """;
        var offset = marked.IndexOf('|');
        var text = marked.Remove(offset, 1);
        var labels = CompletionProvider.Provide(
            new TextDocument("file:///C:/test/Page.xaml", text),
            offset,
            CreateTypeSystem()).Items.Select(item => item.Label);

        Assert.DoesNotContain("x:Class", labels);
    }

    [Fact]
    public void RootElementCompletionIncludesXClass()
    {
        const string marked = """
            <Page xmlns="using:TestApp"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                  x:| />
            """;

        Assert.Contains("x:Class", CompleteLabels(marked));
    }

    [Fact]
    public void OrdinaryChildCompletionDoesNotIncludeXKey()
    {
        const string marked = """
            <Page xmlns="using:TestApp"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
              <Button x:| />
            </Page>
            """;

        Assert.DoesNotContain("x:Key", CompleteLabels(marked));
    }

    [Fact]
    public void CustomNonDictionaryResourcesPropertyDoesNotIncludeXKey()
    {
        const string marked = """
            <Page xmlns="using:TestApp"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
              <Widget.Resources>
                <Button x:| />
              </Widget.Resources>
            </Page>
            """;

        Assert.DoesNotContain("x:Key", CompleteLabels(marked));
    }

    [Fact]
    public void PropertyElementCompletionRejectsMismatchedOwner()
    {
        const string marked = """
            <Grid xmlns="using:TestApp">
              <Button.| />
            </Grid>
            """;

        Assert.Empty(CompleteLabels(marked));
    }

    [Fact]
    public void DataTypeValueCompletionSupportsAlternateXamlPrefix()
    {
        const string marked = """
            <Page xmlns="using:TestApp"
                  xmlns:lang="http://schemas.microsoft.com/winfx/2006/xaml"
                  lang:DataType="|" />
            """;

        Assert.Contains("Page", CompleteLabels(marked));
    }

    [Fact]
    public void DirectiveCompletionUsesThePrefixBeingTyped()
    {
        const string marked = """
            <Button xmlns="using:TestApp"
                    xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                    xmlns:lang="http://schemas.microsoft.com/winfx/2006/xaml"
                    lang:| />
            """;

        var labels = CompleteLabels(marked);

        Assert.Contains("lang:Name", labels);
        Assert.DoesNotContain("x:Name", labels);
    }

    [Fact]
    public void FieldModifierAndDeferLoadStrategyRequireAName()
    {
        const string unnamed = """
            <Button xmlns="using:TestApp"
                    xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                    x:| />
            """;
        const string named = """
            <Button xmlns="using:TestApp"
                    xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                    x:Name="Action"
                    x:| />
            """;

        Assert.DoesNotContain("x:FieldModifier", CompleteLabels(unnamed));
        Assert.DoesNotContain("x:DeferLoadStrategy", CompleteLabels(unnamed));
        Assert.Contains("x:FieldModifier", CompleteLabels(named));
        Assert.Contains("x:DeferLoadStrategy", CompleteLabels(named));
    }

    [Fact]
    public void XPhaseRequiresXBindInsideDataTemplate()
    {
        const string withBinding = """
            <Page xmlns="using:TestApp"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                  xmlns:ui="using:Microsoft.UI.Xaml">
              <ui:DataTemplate>
                <Button Text="{x:Bind Name}" x:| />
              </ui:DataTemplate>
            </Page>
            """;
        const string withoutBinding = """
            <Page xmlns="using:TestApp"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                  xmlns:ui="using:Microsoft.UI.Xaml">
              <ui:DataTemplate>
                <Button x:| />
              </ui:DataTemplate>
            </Page>
            """;
        const string outsideTemplate = """
            <Page xmlns="using:TestApp"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
              <Button Text="{x:Bind Name}" x:| />
            </Page>
            """;

        Assert.Contains("x:Phase", CompleteLabels(withBinding));
        Assert.DoesNotContain("x:Phase", CompleteLabels(withoutBinding));
        Assert.DoesNotContain("x:Phase", CompleteLabels(outsideTemplate));
    }

    [Fact]
    public void ExistingDirective_IsNotOfferedAgain()
    {
        const string marked = """
            <Button xmlns="using:TestApp"
                    xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                    x:Name="Action"
                    | />
            """;
        var offset = marked.IndexOf('|');
        var text = marked.Remove(offset, 1);
        var labels = CompletionProvider.Provide(
            new TextDocument("file:///C:/test/Page.xaml", text),
            offset,
            CreateTypeSystem()).Items.Select(item => item.Label);

        Assert.DoesNotContain("x:Name", labels);
    }

    [Fact]
    public void ExistingDirectiveAliasSuppressesEquivalentDirective()
    {
        const string marked = """
            <Button xmlns="using:TestApp"
                    xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                    xmlns:lang="http://schemas.microsoft.com/winfx/2006/xaml"
                    lang:Name="Action"
                    x:| />
            """;

        Assert.DoesNotContain("x:Name", CompleteLabels(marked));
    }

    private static string[] CompleteLabels(string marked)
    {
        var offset = marked.IndexOf('|');
        var text = marked.Remove(offset, 1);
        return CompletionProvider.Provide(
            new TextDocument("file:///C:/test/Page.xaml", text),
            offset,
            CreateTypeSystem()).Items.Select(item => item.Label).ToArray();
    }

    [Theory]
    [InlineData("Foreground", true)]
    [InlineData("IsEnabled", true)]
    [InlineData("Click", true)]
    [InlineData("Text", false)]
    [InlineData("Width", false)]
    public void AttributeCompletion_TriggersValueSuggestionsOnlyWhenAvailable(
        string attributeName,
        bool expectsValueSuggestions)
    {
        var marked = $$"""
            <Button xmlns="using:TestApp"
                    {{attributeName.Substring(0, 1)}}| />
            """;
        var offset = marked.IndexOf('|');
        var text = marked.Remove(offset, 1);
        var item = Assert.Single(
            CompletionProvider.Provide(
                new TextDocument("file:///C:/test/Page.xaml", text),
                offset,
                CreateTypeSystem()).Items,
            candidate => candidate.Label == attributeName);

        Assert.Equal(attributeName + "=\"$0\"", item.TextEdit!.NewText);
        Assert.Equal(2, item.InsertTextFormat);
        Assert.Equal(expectsValueSuggestions, item.Command is not null);
        if (expectsValueSuggestions)
        {
            Assert.Equal("editor.action.triggerSuggest", item.Command!.Name);
        }
    }

    [Fact]
    public void AttachedAttributeCompletion_TriggersAvailableValueSuggestions()
    {
        const string marked = """
            <Button xmlns="using:TestApp"
                    AutomationProperties.A| />
            """;
        var offset = marked.IndexOf('|');
        var text = marked.Remove(offset, 1);
        var item = Assert.Single(
            CompletionProvider.Provide(
                new TextDocument("file:///C:/test/Page.xaml", text),
                offset,
                CreateTypeSystem()).Items,
            candidate => candidate.Label == "AutomationProperties.AccessibilityView");

        Assert.Equal("editor.action.triggerSuggest", item.Command?.Name);
    }

    [Fact]
    public void NamespacePrefixCompletion_OffersAttachedPropertiesWithValidationCompatibleName()
    {
        const string marked = """
            <Button xmlns="using:TestApp"
                    xmlns:ui="using:Toolkit"
                    ui:| />
            """;
        var offset = marked.IndexOf('|');
        var text = marked.Remove(offset, 1);
        var item = Assert.Single(
            CompletionProvider.Provide(
                new TextDocument("file:///C:/test/Page.xaml", text),
                offset,
                CreateTypeSystem()).Items,
            candidate =>
                candidate.Label ==
                "ui:FrameworkElementExtensions.IsEnabled");

        Assert.Equal(
            "ui:FrameworkElementExtensions.IsEnabled=\"$0\"",
            item.TextEdit!.NewText);
        Assert.StartsWith("attached property", item.Detail);
    }

    [Fact]
    public void NamespacePrefixCompletion_FiltersIncompatibleAndExistingAttachedProperties()
    {
        const string marked = """
            <Button xmlns="using:TestApp"
                    xmlns:ui="using:Toolkit"
                    ui:FrameworkElementExtensions.IsEnabled="true"
                    ui:| />
            """;
        var labels = CompleteLabels(marked);

        Assert.DoesNotContain(
            "ui:FrameworkElementExtensions.IsEnabled",
            labels);
        Assert.DoesNotContain("ui:GridExtensions.Column", labels);
    }

    [Fact]
    public void DottedOwnerCompletion_FiltersIncompatibleReceiver()
    {
        const string marked = """
            <Button xmlns="using:TestApp"
                    xmlns:ui="using:Toolkit"
                    ui:GridExtensions.| />
            """;

        Assert.DoesNotContain(
            "ui:GridExtensions.Column",
            CompleteLabels(marked));
    }

    [Fact]
    public void DottedOwnerCompletion_FiltersExistingAttachedProperty()
    {
        const string marked = """
            <Button xmlns="using:TestApp"
                    xmlns:ui="using:Toolkit"
                    ui:FrameworkElementExtensions.IsEnabled="true"
                    ui:FrameworkElementExtensions.| />
            """;

        Assert.DoesNotContain(
            "ui:FrameworkElementExtensions.IsEnabled",
            CompleteLabels(marked));
    }

    [Fact]
    public void TargetTypeCompletion_OnlyOffersDependencyObjectTypes()
    {
        const string marked = """
            <Style xmlns="using:Microsoft.UI.Xaml"
                   xmlns:app="using:TestApp"
                   xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                   TargetType="app:|" />
            """;
        var labels = CompleteLabels(marked);

        Assert.Contains("Button", labels);
        Assert.DoesNotContain("HelperService", labels);
        Assert.DoesNotContain("ClickEventArgs", labels);
    }

    [Fact]
    public void TargetTypeCompletion_DoesNotOfferXamlIntrinsicTypes()
    {
        const string marked = """
            <Style xmlns="using:Microsoft.UI.Xaml"
                   xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                   TargetType="x:|" />
            """;

        Assert.Empty(CompleteLabels(marked));
    }

    [Fact]
    public void RelativePanelNameCompletion_DoesNotGuessWhileSdkMetadataIsUnavailable()
    {
        const string marked = """
            <Button xmlns="using:TestApp"
                    xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
              <Button x:Name="Anchor" />
              <Button RelativePanel.RightOf="|" />
            </Button>
            """;
        var offset = marked.IndexOf('|');
        var text = marked.Remove(offset, 1);
        var labels = CompletionProvider.Provide(
            new TextDocument("file:///C:/test/Page.xaml", text),
            offset,
            CreateTypeSystem()).Items.Select(item => item.Label);

        Assert.DoesNotContain("Anchor", labels);
    }

    [Fact]
    public void PrefixedStoryboardTargetPropertyUsesPrefixedTargetNameSibling()
    {
        const string marked = """
            <Grid xmlns="using:TestApp"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                  xmlns:anim="using:Microsoft.UI.Xaml.Media.Animation">
              <Button x:Name="Hero" />
              <DoubleAnimation anim:Storyboard.TargetName="Hero"
                               anim:Storyboard.TargetProperty="Wi|" />
            </Grid>
            """;
        var offset = marked.IndexOf('|');
        var text = marked.Remove(offset, 1);
        var labels = CompletionProvider.Provide(
            new TextDocument("file:///C:/test/Page.xaml", text),
            offset,
            CreateTypeSystem()).Items.Select(item => item.Label);

        Assert.Contains("Width", labels);
    }

    [Theory]
    [InlineData("<Window.", "SystemBackdrop", "Window.SystemBackdrop")]
    [InlineData("<Window.Syst", "SystemBackdrop", "Window.SystemBackdrop")]
    [InlineData("<Grid.", "RowDefinitions", "Grid.RowDefinitions")]
    [InlineData("<Grid.R", "RowDefinitions", "Grid.RowDefinitions")]
    [InlineData("<Grid.", "Row", "Grid.Row")]
    public void PropertyElementCompletion_OffersOwnerProperties(
        string partial,
        string expectedLabel,
        string expectedInsertion)
    {
        var owner = partial.Substring(1, partial.IndexOf('.') - 1);
        var marked = $$"""
            <{{owner}} xmlns="using:TestApp">
                {{partial}}|
            </{{owner}}>
            """;
        var offset = marked.IndexOf('|');
        var text = marked.Remove(offset, 1);

        var document = new TextDocument("file:///C:/test/Page.xaml", text);
        var item = Assert.Single(
            CompletionProvider.Provide(
                document,
                offset,
                CreateTypeSystem()).Items,
            candidate => candidate.Label == expectedLabel);

        var edit = item.TextEdit!;
        var editStart = document.OffsetAt(edit.Range.Start);
        var editEnd = document.OffsetAt(edit.Range.End);
        var edited = text.Substring(0, editStart) + edit.NewText + text.Substring(editEnd);
        Assert.Contains("<" + expectedInsertion, edited);
        Assert.Equal(expectedLabel, edit.NewText);
        Assert.Equal(expectedLabel, item.FilterText);
        Assert.Equal(Lsp.CompletionItemKind.Property, item.Kind);
    }

    [Fact]
    public void PropertyElementCompletion_DoesNotOfferEvents()
    {
        const string marked = """
            <Window xmlns="using:TestApp">
                <Window.|
            </Window>
            """;
        var offset = marked.IndexOf('|');
        var text = marked.Remove(offset, 1);
        var labels = CompletionProvider.Provide(
            new TextDocument("file:///C:/test/Page.xaml", text),
            offset,
            CreateTypeSystem()).Items.Select(item => item.Label);

        Assert.DoesNotContain("Closed", labels);
        Assert.DoesNotContain("ActualHeight", labels);
    }

    [Fact]
    public void EventValueCompletionOffersCompatibleAndConventionalHandlers()
    {
        const string marked = """
            <Page xmlns="using:TestApp"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                  x:Class="TestApp.XamlPage">
              <Button x:Name="ActionButton" Click="|" />
            </Page>
            """;
        var offset = marked.IndexOf('|');
        var text = marked.Remove(offset, 1);
        var typeSystem = CreateTypeSystem();
        var pageClass = typeSystem.ResolveType("using:TestApp", "XamlPage");

        var items = CompletionProvider.Provide(
            new TextDocument("file:///C:/test/Page.xaml", text),
            offset,
            typeSystem,
            pageClass).Items;

        Assert.Contains(items, item => item.Label == "ExistingHandler");
        Assert.Contains(items, item => item.Label == "InheritedHandler");
        Assert.Contains(
            items,
            item => item.Label == "ActionButton_Click" &&
                item.Detail == "new event handler");
        Assert.DoesNotContain(items, item => item.Label == "WrongHandler");
    }

    private static XamlTypeSystem CreateTypeSystem()
    {
        var compilation = CSharpCompilation.Create(
            "TestApp",
            new[] { CSharpSyntaxTree.ParseText(Types) },
            new[] { MetadataReference.CreateFromFile(typeof(object).Assembly.Location) },
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        return XamlTypeSystem.FromCompilation(compilation, ImmutableArray<IAssemblySymbol>.Empty);
    }
}
