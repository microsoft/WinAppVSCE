using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using WinUiXaml.LanguageServer;
using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Workspace;
using Xunit;

namespace WinUiXaml.LanguageServer.Tests;

/// <summary>
/// Hermetic coverage for <see cref="XamlRename"/> (textDocument/prepareRename + textDocument/rename). A
/// <c>|</c> marks the caret in each buffer. Asserts the renameable-symbol gate, the exact edit set (every
/// occurrence of an x:Name or x:Key), new-name validation, and range precision — all without a running
/// server. Rename reuses the same occurrence engine as Find All References / Document Highlights.
/// </summary>
public class XamlRenameTests
{
    private const string Uri = "file:///C:/proj/Page.xaml";
    private static readonly XamlTypeSystem FrameworkTypeSystem = CreateFrameworkTypeSystem();

    private static (TextDocument Doc, int Offset) Caret(string textWithCaret)
    {
        var offset = textWithCaret.IndexOf('|');
        Assert.True(offset >= 0, "test buffer must contain a '|' caret marker");
        return (new TextDocument(Uri, textWithCaret.Remove(offset, 1)), offset);
    }

    private static string Covered(TextDocument doc, Lsp.Range range) =>
        doc.Text.Substring(doc.OffsetAt(range.Start), doc.OffsetAt(range.End) - doc.OffsetAt(range.Start));

    private static List<TextEdit> RenameEdits(
        string textWithCaret,
        string newName,
        XamlTypeSystem? typeSystem = null)
    {
        var (doc, offset) = Caret(textWithCaret);
        var edit = XamlRename.Rename(doc, offset, newName, typeSystem ?? FrameworkTypeSystem);
        Assert.NotNull(edit);
        Assert.True(edit!.Changes.ContainsKey(Uri), "edit must target the open document");
        return edit.Changes[Uri];
    }

    private static XamlTypeSystem CreateFrameworkTypeSystem()
    {
        const string source = """
            namespace Microsoft.UI.Xaml
            {
                public class FrameworkElement { public string Name { get; set; } = ""; }
                public class UIElement : FrameworkElement { }
                public class Setter { }
                public class FrameworkTemplate { }
                public class DataTemplate : FrameworkTemplate { }
                public class ResourceDictionary { }
            }
            namespace Microsoft.UI.Xaml.Markup
            {
                public abstract class MarkupExtension { }
            }
            namespace Microsoft.UI.Xaml.Data
            {
                public class Binding : Microsoft.UI.Xaml.Markup.MarkupExtension { }
            }
            namespace Microsoft.UI.Xaml.Controls
            {
                public class RelativePanel : Microsoft.UI.Xaml.UIElement
                {
                    public static object GetRightOf(Microsoft.UI.Xaml.UIElement element) => new object();
                    public static void SetRightOf(Microsoft.UI.Xaml.UIElement element, object value) { }
                    public static object GetAlignTopWith(Microsoft.UI.Xaml.UIElement element) => new object();
                    public static void SetAlignTopWith(Microsoft.UI.Xaml.UIElement element, object value) { }
                    public static object GetBelow(Microsoft.UI.Xaml.UIElement element) => new object();
                    public static void SetBelow(Microsoft.UI.Xaml.UIElement element, object value) { }
                }
                public class TextBox : Microsoft.UI.Xaml.UIElement { }
                public class Button : Microsoft.UI.Xaml.UIElement { }
            }
            namespace Microsoft.UI.Xaml.Media.Animation
            {
                public class Storyboard
                {
                    public static string GetTargetName(Microsoft.UI.Xaml.UIElement element) => "";
                    public static void SetTargetName(Microsoft.UI.Xaml.UIElement element, string value) { }
                    public static string GetTargetProperty(Microsoft.UI.Xaml.UIElement element) => "";
                    public static void SetTargetProperty(Microsoft.UI.Xaml.UIElement element, string value) { }
                }
            }
            namespace Contoso
            {
                public class Plain { public string Name { get; set; } = ""; }
                public class AppResources : Microsoft.UI.Xaml.ResourceDictionary { }
            }
            """;
        var compilation = CSharpCompilation.Create(
            "TestApp",
            new[] { CSharpSyntaxTree.ParseText(source) },
            new[] { MetadataReference.CreateFromFile(typeof(object).Assembly.Location) },
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        return XamlTypeSystem.FromCompilation(compilation, ImmutableArray<IAssemblySymbol>.Empty);
    }

    // ---- prepareRename gating ------------------------------------------------

    [Fact]
    public void PrepareRename_OnNameDeclaration_ReturnsTokenRangeAndPlaceholder()
    {
        var (doc, offset) = Caret("<Grid x:Name=\"Ro|ot\" />");
        var result = XamlRename.PrepareRename(doc, offset, FrameworkTypeSystem);
        Assert.NotNull(result);
        Assert.Equal("Root", result!.Placeholder);
        Assert.Equal("Root", Covered(doc, result.Range));
    }

    [Fact]
    public void PrepareRename_OnElementNameUsage_ReturnsUsageTokenRange()
    {
        var buffer =
            "<Grid x:Name=\"Root\">\n" +
            "  <TextBox Text=\"{Binding ElementName=Ro|ot}\" />\n" +
            "</Grid>";
        var (doc, offset) = Caret(buffer);
        var result = XamlRename.PrepareRename(doc, offset, FrameworkTypeSystem);
        Assert.NotNull(result);
        Assert.Equal("Root", result!.Placeholder);
        Assert.Equal("Root", Covered(doc, result.Range));
        // The editable range is the usage on line 1, not the declaration on line 0.
        Assert.Equal(1, result.Range.Start.Line);
    }

    [Fact]
    public void PrepareRename_OnResourceKeyDeclaration_ReturnsPlaceholder()
    {
        var buffer =
            "<Page><Page.Resources>\n" +
            "  <SolidColorBrush x:Key=\"Acc|ent\" Color=\"Red\" />\n" +
            "</Page.Resources></Page>";
        var (doc, offset) = Caret(buffer);
        var result = XamlRename.PrepareRename(doc, offset);
        Assert.NotNull(result);
        Assert.Equal("Accent", result!.Placeholder);
        Assert.Equal("Accent", Covered(doc, result.Range));
    }

    [Fact]
    public void PrepareRename_OnElementName_ReturnsNull()
    {
        var (doc, offset) = Caret("<Gr|id x:Name=\"Root\" />");
        Assert.Null(XamlRename.PrepareRename(doc, offset));
    }

    [Fact]
    public void PrepareRename_OnPlainAttributeValue_ReturnsNull()
    {
        var (doc, offset) = Caret("<Grid Width=\"1|00\" />");
        Assert.Null(XamlRename.PrepareRename(doc, offset));
    }

    [Fact]
    public void PrepareRename_InsideUnterminatedExtension_ReturnsNull()
    {
        var (doc, offset) = Caret("<Grid Background=\"{StaticResource Acc|ent\" />");
        Assert.Null(XamlRename.PrepareRename(doc, offset));
    }

    // ---- rename edit sets ----------------------------------------------------

    [Fact]
    public void Rename_Name_RewritesDeclarationAndAllUsages()
    {
        var buffer =
            "<Grid xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" x:Name=\"Ro|ot\">\n" +
            "  <TextBox Text=\"{Binding ElementName=Root}\" />\n" +
            "  <Storyboard><DoubleAnimation Storyboard.TargetName=\"Root\" /></Storyboard>\n" +
            "</Grid>";
        var edits = RenameEdits(buffer, "Panel", CreateFrameworkTypeSystem());
        Assert.Equal(3, edits.Count);
        Assert.All(edits, e => Assert.Equal("Panel", e.NewText));
    }

    [Fact]
    public void Rename_NameDoesNotCrossTemplateNameScope()
    {
        const string buffer = """
            <Page xmlns="using:Microsoft.UI.Xaml"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                  xmlns:controls="using:Microsoft.UI.Xaml.Controls">
              <controls:Grid x:Name="Sha|red" />
              <controls:TextBox Text="{Binding ElementName=Shared}" />
              <DataTemplate>
                <controls:Grid x:Name="Shared" />
                <controls:TextBox Text="{Binding ElementName=Shared}" />
              </DataTemplate>
            </Page>
            """;

        var edits = RenameEdits(buffer, "Outer", CreateFrameworkTypeSystem());

        Assert.Equal(2, edits.Count);
        Assert.All(edits, edit => Assert.Equal("Outer", edit.NewText));
    }

    [Fact]
    public void Rename_NameInsideTemplateDoesNotCrossToOuterNameScope()
    {
        const string buffer = """
            <Page xmlns="using:Microsoft.UI.Xaml"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                  xmlns:controls="using:Microsoft.UI.Xaml.Controls">
              <controls:Grid x:Name="Shared" />
              <controls:TextBox Text="{Binding ElementName=Shared}" />
              <DataTemplate>
                <controls:Grid x:Name="Sha|red" />
                <controls:TextBox Text="{Binding ElementName=Shared}" />
              </DataTemplate>
            </Page>
            """;

        var edits = RenameEdits(buffer, "Inner", CreateFrameworkTypeSystem());

        Assert.Equal(2, edits.Count);
        Assert.All(edits, edit => Assert.Equal("Inner", edit.NewText));
    }

    [Fact]
    public void Rename_Name_DoesNotRewriteCustomMarkupExtensionElementNameArgument()
    {
        const string source = """
            namespace Microsoft.UI.Xaml
            {
                public class UIElement { }
                public class Setter { }
            }
            namespace Microsoft.UI.Xaml.Controls
            {
                public class RelativePanel : Microsoft.UI.Xaml.UIElement { }
            }
            namespace Microsoft.UI.Xaml.Markup
            {
                public abstract class MarkupExtension { }
            }
            namespace Microsoft.UI.Xaml.Data
            {
                public class Binding : Microsoft.UI.Xaml.Markup.MarkupExtension { }
            }
            namespace Microsoft.UI.Xaml.Media.Animation
            {
                public class Storyboard { }
            }
            namespace TestApp
            {
                public class ProbeExtension : Microsoft.UI.Xaml.Markup.MarkupExtension
                {
                    public string ElementName { get; set; } = "";
                }
            }
            """;
        var compilation = CSharpCompilation.Create(
            "TestApp",
            [CSharpSyntaxTree.ParseText(source)],
            [MetadataReference.CreateFromFile(typeof(object).Assembly.Location)],
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var typeSystem = XamlTypeSystem.FromCompilation(
            compilation,
            ImmutableArray<IAssemblySymbol>.Empty);
        var buffer =
            "<Grid xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" " +
            "xmlns:local=\"using:TestApp\" x:Name=\"Ro|ot\">" +
            "<TextBox Text=\"{Binding ElementName=Root}\" Tag=\"{local:Probe ElementName=Root}\" />" +
            "</Grid>";

        var edits = RenameEdits(buffer, "Panel", typeSystem);

        Assert.Equal(2, edits.Count);
    }

    [Fact]
    public void Rename_Name_FromUsageCaret_RewritesSameSet()
    {
        var buffer =
            "<Grid x:Name=\"Root\">\n" +
            "  <TextBox Text=\"{Binding ElementName=Ro|ot}\" />\n" +
            "</Grid>";
        var edits = RenameEdits(buffer, "Panel");
        Assert.Equal(2, edits.Count);
        Assert.All(edits, e => Assert.Equal("Panel", e.NewText));
    }

    [Fact]
    public void Rename_ResourceKey_RewritesDeclarationAndStaticResourceUsages()
    {
        var buffer =
            "<Page><Page.Resources>\n" +
            "  <SolidColorBrush x:Key=\"Acc|ent\" Color=\"Red\" />\n" +
            "</Page.Resources>\n" +
            "  <Grid Background=\"{StaticResource Accent}\" />\n" +
            "  <Border Background=\"{ThemeResource Accent}\" />\n" +
            "  <Border Background=\"{CustomResource Accent}\" />\n" +
            "</Page>";
        var edits = RenameEdits(buffer, "Brand");
        Assert.Equal(4, edits.Count);
        Assert.All(edits, e => Assert.Equal("Brand", e.NewText));
    }

    [Fact]
    public void Rename_ResourceKeySupportsPresentationNamespaceAlias()
    {
        var buffer =
            "<Page xmlns:p=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\"><Page.Resources>\n" +
            "  <SolidColorBrush x:Key=\"Acc|ent\" Color=\"Red\" />\n" +
            "</Page.Resources>\n" +
            "  <Grid Background=\"{p:StaticResource Accent}\" />\n" +
            "  <Border Background=\"{p:ThemeResource Accent}\" />\n" +
            "</Page>";

        var edits = RenameEdits(buffer, "Brand");

        Assert.Equal(3, edits.Count);
        Assert.All(edits, edit => Assert.Equal("Brand", edit.NewText));
    }

    [Fact]
    public void Rename_ResourceKeyDoesNotCrossShadowingScopes()
    {
        const string buffer = """
            <Page>
              <Page.Resources>
                <SolidColorBrush x:Key="Shared" />
              </Page.Resources>
              <Border Background="{StaticResource Shared}" />
              <Grid>
                <Grid.Resources>
                  <SolidColorBrush x:Key="Sha|red" />
                </Grid.Resources>
                <Border Background="{StaticResource Shared}" />
              </Grid>
            </Page>
            """;

        var edits = RenameEdits(buffer, "Inner");

        Assert.Equal(2, edits.Count);
        Assert.All(edits, edit => Assert.Equal("Inner", edit.NewText));
    }

    [Fact]
    public void Rename_OuterResourceKeyDoesNotCrossIntoShadowingScope()
    {
        const string buffer = """
            <Page>
              <Page.Resources>
                <SolidColorBrush x:Key="Sha|red" />
              </Page.Resources>
              <Border Background="{StaticResource Shared}" />
              <Grid>
                <Grid.Resources>
                  <SolidColorBrush x:Key="Shared" />
                </Grid.Resources>
                <Border Background="{StaticResource Shared}" />
              </Grid>
            </Page>
            """;

        var edits = RenameEdits(buffer, "Outer");

        Assert.Equal(2, edits.Count);
        Assert.All(edits, edit => Assert.Equal("Outer", edit.NewText));
    }

    [Fact]
    public void Rename_ResourceKeyInStandaloneDictionary()
    {
        const string buffer = """
            <ResourceDictionary xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
                                xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
              <SolidColorBrush x:Key="Shared" />
              <Style BasedOn="{StaticResource Sha|red}" />
            </ResourceDictionary>
            """;

        var edits = RenameEdits(buffer, "DictionaryKey");

        Assert.Equal(2, edits.Count);
        Assert.All(edits, edit => Assert.Equal("DictionaryKey", edit.NewText));
    }

    [Fact]
    public void Rename_ResourceKeyInDerivedStandaloneDictionary()
    {
        const string buffer = """
            <local:AppResources xmlns:local="using:Contoso"
                                xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
              <SolidColorBrush x:Key="Shared" />
              <Style BasedOn="{StaticResource Sha|red}" />
            </local:AppResources>
            """;

        var edits = RenameEdits(buffer, "DerivedKey", FrameworkTypeSystem);

        Assert.Equal(2, edits.Count);
        Assert.All(edits, edit => Assert.Equal("DerivedKey", edit.NewText));
    }

    [Fact]
    public void Rename_OuterResourceIgnoresNestedTemplateResource()
    {
        const string buffer = """
            <Page>
              <Page.Resources>
                <Style x:Key="ContainerStyle">
                  <Style.Template>
                    <ControlTemplate>
                      <Grid>
                        <Grid.Resources>
                          <SolidColorBrush x:Key="Shared" />
                        </Grid.Resources>
                        <Border Background="{StaticResource Shared}" />
                      </Grid>
                    </ControlTemplate>
                  </Style.Template>
                </Style>
                <SolidColorBrush x:Key="Sha|red" />
              </Page.Resources>
              <Border Background="{StaticResource Shared}" />
            </Page>
            """;

        var edits = RenameEdits(buffer, "PageKey");

        Assert.Equal(2, edits.Count);
        Assert.All(edits, edit => Assert.Equal("PageKey", edit.NewText));
    }

    [Fact]
    public void Rename_BareNameRejectsNonFrameworkElements()
    {
        var (doc, offset) = Caret(
            "<local:Plain xmlns:local=\"using:Contoso\" Name=\"Val|ue\" />");

        Assert.Null(XamlRename.PrepareRename(doc, offset, FrameworkTypeSystem));
        Assert.Null(XamlRename.Rename(doc, offset, "Other", FrameworkTypeSystem));
    }

    [Fact]
    public void Rename_RejectsDanglingElementNameReferences()
    {
        var (doc, offset) = Caret(
            "<TextBox xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" " +
            "Text=\"{Binding ElementName=Miss|ing}\" />");

        Assert.Null(XamlRename.PrepareRename(doc, offset, FrameworkTypeSystem));
        Assert.Null(XamlRename.Rename(doc, offset, "Other", FrameworkTypeSystem));
    }

    [Fact]
    public void Rename_ResourceKeySupportsAlternateXamlPrefix()
    {
        var buffer =
            "<Page xmlns:lang=\"http://schemas.microsoft.com/winfx/2006/xaml\"><Page.Resources>\n" +
            "  <SolidColorBrush lang:Key=\"Acc|ent\" Color=\"Red\" />\n" +
            "</Page.Resources>\n" +
            "  <Grid Background=\"{StaticResource Accent}\" />\n" +
            "</Page>";

        var edits = RenameEdits(buffer, "Brand");

        Assert.Equal(2, edits.Count);
        Assert.All(edits, edit => Assert.Equal("Brand", edit.NewText));
    }

    [Fact]
    public void Rename_OnlyRewritesTheTargetedSymbol()
    {
        var buffer =
            "<Grid x:Name=\"Ro|ot\">\n" +
            "  <Grid x:Name=\"Other\" />\n" +
            "  <TextBox Text=\"{Binding ElementName=Other}\" />\n" +
            "</Grid>";
        var edits = RenameEdits(buffer, "Panel");
        Assert.Single(edits);
        Assert.Equal("Panel", edits[0].NewText);
    }

    [Fact]
    public void Rename_EditRangesCoverTheOldNameTokens()
    {
        var buffer =
            "<Grid x:Name=\"Root\">\n" +
            "  <TextBox Text=\"{Binding ElementName=Ro|ot}\" />\n" +
            "</Grid>";
        var (doc, offset) = Caret(buffer);
        var edit = XamlRename.Rename(doc, offset, "Panel", FrameworkTypeSystem);
        Assert.NotNull(edit);
        Assert.All(edit!.Changes[Uri], e => Assert.Equal("Root", Covered(doc, e.Range)));
    }

    [Fact]
    public void Rename_OnNonSymbol_ReturnsNull()
    {
        var (doc, offset) = Caret("<Gr|id x:Name=\"Root\" />");
        Assert.Null(XamlRename.Rename(doc, offset, "Panel"));
    }

    // ---- round 80: RelativePanel alignment + VSM Setter.Target element references ----

    [Fact]
    public void Rename_Name_RewritesRelativePanelAlignmentReferences()
    {
        var buffer =
            "<RelativePanel xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\">\n" +
            "  <TextBox x:Name=\"An|chor\" />\n" +
            "  <Button RelativePanel.RightOf=\"Anchor\" RelativePanel.AlignTopWith=\"Anchor\" />\n" +
            "</RelativePanel>";
        var edits = RenameEdits(buffer, "Pivot", CreateFrameworkTypeSystem());
        Assert.Equal(3, edits.Count); // declaration + RightOf + AlignTopWith
        Assert.All(edits, e => Assert.Equal("Pivot", e.NewText));
    }

    [Fact]
    public void Rename_Name_RewritesPrefixedStoryboardTargetName()
    {
        var buffer =
            "<Grid xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" " +
            "xmlns:anim=\"using:Microsoft.UI.Xaml.Media.Animation\">\n" +
            "  <Border x:Name=\"He|ro\" />\n" +
            "  <DoubleAnimation anim:Storyboard.TargetName=\"Hero\" />\n" +
            "</Grid>";
        var edits = RenameEdits(buffer, "Pivot", CreateFrameworkTypeSystem());
        Assert.Equal(2, edits.Count);
        Assert.All(edits, edit => Assert.Equal("Pivot", edit.NewText));
    }

    [Fact]
    public void Rename_Name_FromRelativePanelUsageCaret_RewritesSameSet()
    {
        var buffer =
            "<RelativePanel xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\">\n" +
            "  <TextBox x:Name=\"Anchor\" />\n" +
            "  <Button RelativePanel.Below=\"An|chor\" />\n" +
            "</RelativePanel>";
        var edits = RenameEdits(buffer, "Pivot", CreateFrameworkTypeSystem());
        Assert.Equal(2, edits.Count);
        Assert.All(edits, e => Assert.Equal("Pivot", e.NewText));
    }

    [Fact]
    public void Rename_Name_RewritesSetterTargetElementSegmentOnly()
    {
        var buffer =
            "<Page xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\">\n" +
            "  <Border x:Name=\"He|ro\" />\n" +
            "  <Setter Target=\"Hero.Background\" Value=\"Red\" />\n" +
            "</Page>";
        var (doc, offset) = Caret(buffer);
        var edit = XamlRename.Rename(doc, offset, "Banner", CreateFrameworkTypeSystem());
        Assert.NotNull(edit);
        var edits = edit!.Changes[Uri];
        Assert.Equal(2, edits.Count); // declaration + Setter.Target element segment
        Assert.All(edits, e => Assert.Equal("Banner", e.NewText));
        // The razor: each edit covers exactly "Hero", never the ".Background" property tail.
        Assert.All(edits, e => Assert.Equal("Hero", Covered(doc, e.Range)));
    }

    [Fact]
    public void PrepareRename_OnSetterTargetElementSegment_ReturnsName()
    {
        var buffer =
            "<Page xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\">\n" +
            "  <Border x:Name=\"Hero\" />\n" +
            "  <Setter Target=\"He|ro.Background\" Value=\"Red\" />\n" +
            "</Page>";
        var (doc, offset) = Caret(buffer);
        var result = XamlRename.PrepareRename(doc, offset, CreateFrameworkTypeSystem());
        Assert.NotNull(result);
        Assert.Equal("Hero", result!.Placeholder);
        Assert.Equal("Hero", Covered(doc, result.Range));
    }

    [Fact]
    public void PrepareRename_OnSetterTargetPropertySegment_ReturnsNull()
    {
        // The caret is on the ".Background" property tail — a member on Hero, not the element name.
        var buffer =
            "<Page>\n" +
            "  <Border x:Name=\"Hero\" />\n" +
            "  <Setter Target=\"Hero.Backgr|ound\" Value=\"Red\" />\n" +
            "</Page>";
        var (doc, offset) = Caret(buffer);
        Assert.Null(XamlRename.PrepareRename(doc, offset, FrameworkTypeSystem));
    }

    // ---- new-name validation -------------------------------------------------

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("1Panel")]
    [InlineData("My Panel")]
    [InlineData("Panel!")]
    [InlineData("local:Panel")]
    [InlineData("Panel.Child")]
    public void Rename_Name_RejectsInvalidIdentifier(string newName)
    {
        var (doc, offset) = Caret("<Grid x:Name=\"Ro|ot\" />");
        Assert.Throws<RenameValidationException>(() =>
            XamlRename.Rename(doc, offset, newName, FrameworkTypeSystem));
    }

    [Theory]
    [InlineData("Panel")]
    [InlineData("_hidden")]
    [InlineData("Panel2")]
    [InlineData("MyGrid_1")]
    public void Rename_Name_AcceptsValidIdentifier(string newName)
    {
        var edits = RenameEdits("<Grid x:Name=\"Ro|ot\" />", newName);
        Assert.Single(edits);
        Assert.Equal(newName, edits[0].NewText);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("Bad<Key")]
    [InlineData("Bad>Key")]
    [InlineData("Bad&Key")]
    [InlineData("Bad{Key")]
    [InlineData("Bad}Key")]
    [InlineData("Bad\"Key")]
    public void Rename_Key_RejectsForbiddenCharacters(string newName)
    {
        var buffer =
            "<Page><Page.Resources>\n" +
            "  <SolidColorBrush x:Key=\"Acc|ent\" Color=\"Red\" />\n" +
            "</Page.Resources></Page>";
        var (doc, offset) = Caret(buffer);
        Assert.Throws<RenameValidationException>(() => XamlRename.Rename(doc, offset, newName));
    }

    [Theory]
    [InlineData("Brand")]
    [InlineData("Brand.Accent")]
    [InlineData("Accent-2")]
    public void Rename_Key_AcceptsPermissiveNames(string newName)
    {
        var buffer =
            "<Page><Page.Resources>\n" +
            "  <SolidColorBrush x:Key=\"Acc|ent\" Color=\"Red\" />\n" +
            "</Page.Resources>\n" +
            "  <Grid Background=\"{StaticResource Accent}\" />\n" +
            "</Page>";
        var edits = RenameEdits(buffer, newName);
        Assert.Equal(2, edits.Count);
        Assert.All(edits, e => Assert.Equal(newName, e.NewText));
    }

    [Fact]
    public void Rename_TrimsSurroundingWhitespaceFromNewName()
    {
        var edits = RenameEdits("<Grid x:Name=\"Ro|ot\" />", "  Panel  ");
        Assert.Single(edits);
        Assert.Equal("Panel", edits[0].NewText);
    }

    // ---- robustness ----------------------------------------------------------

    [Fact]
    public void Rename_IsDeterministicAcrossRepeatedCalls()
    {
        var buffer =
            "<Grid x:Name=\"Ro|ot\">\n" +
            "  <TextBox Text=\"{Binding ElementName=Root}\" />\n" +
            "</Grid>";
        var (doc, offset) = Caret(buffer);
        var first = XamlRename.Rename(doc, offset, "Panel", FrameworkTypeSystem)!.Changes[Uri];
        var second = XamlRename.Rename(doc, offset, "Panel", FrameworkTypeSystem)!.Changes[Uri];
        Assert.Equal(first.Count, second.Count);
        for (var i = 0; i < first.Count; i++)
        {
            Assert.Equal(first[i].NewText, second[i].NewText);
            Assert.Equal(first[i].Range.Start.Line, second[i].Range.Start.Line);
            Assert.Equal(first[i].Range.Start.Character, second[i].Range.Start.Character);
            Assert.Equal(first[i].Range.End.Line, second[i].Range.End.Line);
            Assert.Equal(first[i].Range.End.Character, second[i].Range.End.Character);
        }
    }

    [Fact]
    public void PrepareRename_OnEmptyDocument_ReturnsNull()
    {
        var doc = new TextDocument(Uri, string.Empty);
        Assert.Null(XamlRename.PrepareRename(doc, 0));
    }

    // ---- whitespace-padded values (round-42 red-team) ------------------------
    // A padded attribute value (e.g. x:Name="Root ") must resolve to the trimmed token only: the edit /
    // highlight range never swallows surrounding whitespace, and a caret out in the padding is off-token.

    [Fact]
    public void Rename_Name_PaddedDeclaration_CoversTrimmedTokenOnly()
    {
        var buffer =
            "<Grid x:Name=\"Ro|ot \">\n" +
            "  <TextBox Text=\"{Binding ElementName=Root}\" />\n" +
            "</Grid>";
        var (doc, offset) = Caret(buffer);
        var edit = XamlRename.Rename(doc, offset, "Panel", FrameworkTypeSystem);
        Assert.NotNull(edit);
        Assert.Equal(2, edit!.Changes[Uri].Count);
        Assert.All(edit.Changes[Uri], e => Assert.Equal("Root", Covered(doc, e.Range)));
    }

    [Fact]
    public void Rename_Name_LeadingAndTrailingWhitespace_CoversTrimmedTokenOnly()
    {
        var edits = RenameEdits("<Grid x:Name=\" Ro|ot \" />", "Panel");
        var (doc, offset) = Caret("<Grid x:Name=\" Ro|ot \" />");
        Assert.Single(edits);
        Assert.Equal("Root", Covered(doc, edits[0].Range));
    }

    [Fact]
    public void Rename_Name_PaddedStoryboardTargetName_CoversTrimmedTokenOnly()
    {
        var buffer =
            "<Grid xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" x:Name=\"Ro|ot\">\n" +
            "  <Storyboard><DoubleAnimation Storyboard.TargetName=\"Root \" /></Storyboard>\n" +
            "</Grid>";
        var (doc, offset) = Caret(buffer);
        var edit = XamlRename.Rename(doc, offset, "Panel", CreateFrameworkTypeSystem());
        Assert.NotNull(edit);
        Assert.Equal(2, edit!.Changes[Uri].Count);
        Assert.All(edit.Changes[Uri], e => Assert.Equal("Root", Covered(doc, e.Range)));
    }

    [Fact]
    public void Rename_Key_PaddedDeclaration_CoversTrimmedTokenOnly()
    {
        var buffer =
            "<Page><Page.Resources>\n" +
            "  <SolidColorBrush x:Key=\" Acc|ent \" Color=\"Red\" />\n" +
            "</Page.Resources>\n" +
            "  <Grid Background=\"{StaticResource Accent}\" />\n" +
            "</Page>";
        var (doc, offset) = Caret(buffer);
        var edit = XamlRename.Rename(doc, offset, "Brand");
        Assert.NotNull(edit);
        Assert.Equal(2, edit!.Changes[Uri].Count);
        Assert.All(edit.Changes[Uri], e => Assert.Equal("Accent", Covered(doc, e.Range)));
    }

    [Fact]
    public void PrepareRename_PaddedDeclaration_ReturnsTrimmedTokenRange()
    {
        var (doc, offset) = Caret("<Grid x:Name=\"Ro|ot \" />");
        var result = XamlRename.PrepareRename(doc, offset, FrameworkTypeSystem);
        Assert.NotNull(result);
        Assert.Equal("Root", Covered(doc, result!.Range));
    }

    [Fact]
    public void Rename_CaretAtTokenEndBoundary_RenamesTrimmedToken()
    {
        // Caret sits immediately after the last identifier char (before the trailing space): this is the
        // token's end boundary, so it renames — but only the token, never the trailing whitespace.
        var (doc, offset) = Caret("<Grid x:Name=\"Root| \" />");
        var edit = XamlRename.Rename(doc, offset, "Panel", FrameworkTypeSystem);
        Assert.NotNull(edit);
        Assert.Single(edit!.Changes[Uri]);
        Assert.Equal("Root", Covered(doc, edit.Changes[Uri][0].Range));
    }

    [Fact]
    public void Rename_CaretInTrailingPadding_ReturnsNull()
    {
        // Caret sits past the token, out in the value's trailing whitespace: not renameable.
        var (doc, offset) = Caret("<Grid x:Name=\"Root |\" />");
        Assert.Null(XamlRename.Rename(doc, offset, "Panel"));
        Assert.Null(XamlRename.PrepareRename(doc, offset));
    }

    [Fact]
    public void Rename_Name_RejectsPartialEditWithoutCompleteSdkSemantics()
    {
        var (doc, offset) = Caret(
            "<Grid x:Name=\"Ro|ot\">" +
            "<TextBox Text=\"{Binding ElementName=Root}\" />" +
            "<DoubleAnimation Storyboard.TargetName=\"Root\" />" +
            "</Grid>");

        Assert.Null(XamlRename.PrepareRename(doc, offset));
        Assert.Null(XamlRename.Rename(doc, offset, "Panel"));
    }
}
