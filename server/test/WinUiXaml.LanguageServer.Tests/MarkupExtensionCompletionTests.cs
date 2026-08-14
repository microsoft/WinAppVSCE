using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using WinUiXaml.Workspace;

namespace WinUiXaml.LanguageServer.Tests;

public sealed class MarkupExtensionCompletionTests
{
    [Fact]
    public void MarkupName_DiscoversOnlyConcreteSdkDerivedExtensions()
    {
        var labels = Complete(
            """
            <Page xmlns="using:Microsoft.UI.Xaml"
                  xmlns:ext="using:App.Extensions"
                  Tag="{ext:Cur|}" />
            """,
            CreateTypeSystem(includeMarkupExtensionBase: true));

        Assert.Contains("ext:CurrentTheme", labels);
        Assert.DoesNotContain("ext:Lookalike", labels);
        Assert.DoesNotContain("ext:Abstract", labels);
    }

    [Fact]
    public void MarkupArgument_UsesDiscoveredExtensionProperties()
    {
        var labels = Complete(
            """
            <Page xmlns="using:Microsoft.UI.Xaml"
                  xmlns:ext="using:App.Extensions"
                  Tag="{ext:CurrentTheme In|}" />
            """,
            CreateTypeSystem(includeMarkupExtensionBase: true));

        Assert.Contains("Invert", labels);
    }

    [Fact]
    public void MarkupArgument_CompletesCustomEnumDespiteExactNameLookalike()
    {
        var labels = Complete(
            """
            <Page xmlns="using:Microsoft.UI.Xaml"
                  xmlns:ext="using:App.Extensions"
                  Tag="{ext:CurrentTheme Tone=Pri|}" />
            """,
            CreateTypeSystem(includeMarkupExtensionBase: true));

        Assert.Contains("Primary", labels);
    }

    [Theory]
    [InlineData("Bind", "Binding", "BindingExtension")]
    [InlineData("Static", "StaticResource", "StaticResourceExtension")]
    public void MarkupName_CustomDefaultNamespaceWinsBuiltInCollision(
        string partial,
        string label,
        string expectedType)
    {
        var items = CompleteItems(
            "<Page xmlns=\"using:App.Extensions\" Tag=\"{" + partial + "|}\" />",
            CreateTypeSystem(includeMarkupExtensionBase: true));

        var item = Assert.Single(items, candidate => candidate.Label == label);
        Assert.Contains(expectedType, item.Detail);
    }

    [Fact]
    public void MarkupName_WithoutSdkBaseDoesNotGuessFromSuffix()
    {
        var labels = Complete(
            """
            <Page xmlns="using:Microsoft.UI.Xaml"
                  xmlns:ext="using:App.Extensions"
                  Tag="{ext:Cur|}" />
            """,
            CreateTypeSystem(includeMarkupExtensionBase: false));

        Assert.DoesNotContain("ext:CurrentTheme", labels);
        Assert.DoesNotContain("ext:Lookalike", labels);
    }

    private static HashSet<string> Complete(string marked, XamlTypeSystem typeSystem) =>
        CompleteItems(marked, typeSystem)
            .Select(item => item.Label)
            .ToHashSet(StringComparer.Ordinal);

    private static IReadOnlyList<WinUiXaml.LanguageServer.Lsp.CompletionItem> CompleteItems(
        string marked,
        XamlTypeSystem typeSystem)
    {
        int offset = marked.IndexOf('|');
        var text = marked.Remove(offset, 1);
        return CompletionProvider.Provide(
                new TextDocument("file:///C:/test/Page.xaml", text),
                offset,
                typeSystem)
            .Items;
    }

    private static XamlTypeSystem CreateTypeSystem(bool includeMarkupExtensionBase)
    {
        var baseType = includeMarkupExtensionBase
            ? "namespace Microsoft.UI.Xaml.Markup { public abstract class MarkupExtension { } }"
            : string.Empty;
        var derivedBase = includeMarkupExtensionBase
            ? "Microsoft.UI.Xaml.Markup.MarkupExtension"
            : "object";
        var source = $$"""
            {{baseType}}
            namespace Microsoft.UI.Xaml
            {
                public class Page { public object Tag { get; set; } }
            }
            namespace App.Extensions
            {
                public sealed class CurrentThemeExtension : {{derivedBase}}
                {
                    public bool Invert { get; set; }
                    public Tone Tone { get; set; }
                }
                public sealed class CurrentTheme { }
                public sealed class BindingExtension : {{derivedBase}} { }
                public sealed class StaticResourceExtension : {{derivedBase}} { }
                public sealed class LookalikeExtension
                {
                    public bool Invert { get; set; }
                }
                public abstract class AbstractExtension : {{derivedBase}} { }
                public enum Tone { Primary, Secondary }
            }
            """;
        var compilation = CSharpCompilation.Create(
            "TestApp",
            new[] { CSharpSyntaxTree.ParseText(source) },
            new[] { MetadataReference.CreateFromFile(typeof(object).Assembly.Location) },
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        return XamlTypeSystem.FromCompilation(compilation, ImmutableArray<IAssemblySymbol>.Empty);
    }
}
