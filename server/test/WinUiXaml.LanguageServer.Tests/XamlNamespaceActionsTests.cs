using System.Linq;
using Xunit;

namespace WinUiXaml.LanguageServer.Tests;

public class XamlNamespaceActionsTests
{
    [Fact]
    public void RemovesOnlyUnusedRootPrefixDeclarations()
    {
        var text = """
            <Page
                xmlns="using:Microsoft.UI.Xaml"
                xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                xmlns:local="using:Sample"
                xmlns:unused="using:Unused"
                x:Class="Sample.Page">
              <local:Widget />
            </Page>
            """;
        var doc = new TextDocument("file:///C:/Page.xaml", text);

        var edits = XamlNamespaceActions.RemoveUnusedRootNamespaces(doc);
        var result = Apply(text, doc, edits);

        Assert.DoesNotContain("xmlns:unused", result);
        Assert.Contains("xmlns:x=", result);
        Assert.Contains("xmlns:local=", result);
        Assert.Contains("xmlns=\"", result);
    }

    [Fact]
    public void KeepsPrefixesUsedInTypeValuesAndMcIgnorable()
    {
        var text = """
            <Page
                xmlns="using:Microsoft.UI.Xaml"
                xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                xmlns:d="http://schemas.microsoft.com/expression/blend/2008"
                xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
                xmlns:local="using:Sample"
                mc:Ignorable="d">
              <DataTemplate x:DataType="local:ViewModel" />
            </Page>
            """;
        var doc = new TextDocument("file:///C:/Page.xaml", text);

        Assert.Empty(XamlNamespaceActions.RemoveUnusedRootNamespaces(doc));
    }

    [Fact]
    public void CodeActionOffersOrganizeNamespacesEdit()
    {
        const string uri = "file:///C:/Page.xaml";
        var doc = new TextDocument(
            uri,
            """<Page xmlns="using:Microsoft.UI.Xaml" xmlns:unused="using:Unused" />""");
        var context = new Lsp.CodeActionContext
        {
            Only = new[] { "source.organizeImports" },
        };

        var action = Assert.Single(XamlCodeActions.Compute(uri, doc, context));

        Assert.Equal("Remove unused XAML namespaces", action.Title);
        Assert.Equal("source.organizeImports", action.Kind);
        Assert.Single(action.Edit!.Changes[uri]);
    }

    [Fact]
    public void RemovesInlineDeclarationWithoutDamagingNeighboringAttributes()
    {
        const string text =
            """<Page xmlns="using:Microsoft.UI.Xaml" xmlns:unused="using:Unused" Tag="kept" />""";
        var doc = new TextDocument("file:///C:/Page.xaml", text);

        var result = Apply(text, doc, XamlNamespaceActions.RemoveUnusedRootNamespaces(doc));

        Assert.Equal("""<Page xmlns="using:Microsoft.UI.Xaml" Tag="kept" />""", result);
    }

    private static string Apply(string text, TextDocument doc, IEnumerable<Lsp.TextEdit> edits)
    {
        foreach (var edit in edits.OrderByDescending(e => doc.OffsetAt(e.Range.Start)))
        {
            int start = doc.OffsetAt(edit.Range.Start);
            int end = doc.OffsetAt(edit.Range.End);
            text = text.Remove(start, end - start).Insert(start, edit.NewText);
        }

        return text;
    }
}
