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
            public class DependencyObject { }
            public class Button : DependencyObject
            {
                public double Width { get; set; }
                public string Text { get; set; } = "";
                public bool IsEnabled { get; set; }
                public Microsoft.UI.Xaml.Media.Brush Foreground { get; set; } = new();
                public event System.EventHandler? Click;
            }

            public class Window : DependencyObject
            {
                public object SystemBackdrop { get; set; } = new object();
                public double ActualHeight { get; }
                public event System.EventHandler? Closed;
            }

            public class Grid : DependencyObject
            {
                public System.Collections.Generic.List<RowDefinition> RowDefinitions { get; } = new();
                public static int GetRow(DependencyObject value) => 0;
                public static void SetRow(DependencyObject value, int row) { }
            }

            public class RowDefinition : DependencyObject { }
            public class DoubleAnimation : DependencyObject { }

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
        """;

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
        Assert.Contains(items, item => item.Label == "AutomationProperties.Name");
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
