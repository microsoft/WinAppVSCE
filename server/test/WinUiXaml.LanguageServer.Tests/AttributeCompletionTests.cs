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
            }

            public static class AutomationProperties
            {
                public static string GetName(DependencyObject value) => "";
                public static void SetName(DependencyObject value, string name) { }
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
