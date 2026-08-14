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

    [Fact]
    public void MarkupName_CustomDefaultSuppressesInvalidUnprefixedFrameworkExtensions()
    {
        var labels = Complete(
            """
            <Page xmlns="using:App.Extensions"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                  Tag="{Th|}" />
            """,
            CreateTypeSystem(includeMarkupExtensionBase: true));

        Assert.DoesNotContain("ThemeResource", labels);
        Assert.Contains("x:Type", Complete(
            """
            <Page xmlns="using:App.Extensions"
                  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                  Tag="{x:T|}" />
            """,
            CreateTypeSystem(includeMarkupExtensionBase: true)));
    }

    [Fact]
    public void MarkupName_UsesDeclaredAliasForXamlLanguageIntrinsics()
    {
        var labels = Complete(
            """
            <Page xmlns="using:Microsoft.UI.Xaml"
                  xmlns:lang="http://schemas.microsoft.com/winfx/2006/xaml"
                  Tag="{lang:T|}" />
            """,
            CreateTypeSystem(includeMarkupExtensionBase: true));

        Assert.Contains("lang:Type", labels);
        Assert.DoesNotContain("x:Type", labels);
    }

    [Fact]
    public void MarkupName_DoesNotOfferUndeclaredXamlLanguagePrefix()
    {
        var labels = Complete(
            """
            <Page xmlns="using:Microsoft.UI.Xaml"
                  Tag="{|}" />
            """,
            CreateTypeSystem(includeMarkupExtensionBase: true));

        Assert.DoesNotContain("x:Bind", labels);
        Assert.DoesNotContain("x:Type", labels);
    }

    [Fact]
    public void MarkupName_CustomDefaultQualifiesFrameworkExtensionsWithPresentationPrefix()
    {
        var labels = Complete(
            """
            <Page xmlns="using:App.Extensions"
                  xmlns:ui="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
                  Tag="{ui:Th|}" />
            """,
            CreateTypeSystem(includeMarkupExtensionBase: true));

        Assert.Contains("ui:ThemeResource", labels);
        Assert.DoesNotContain("ThemeResource", labels);
    }

    [Fact]
    public void MarkupArgument_ExactExtensionTypeWinsOverSuffixedType()
    {
        var labels = Complete(
            """
            <Page xmlns="using:Microsoft.UI.Xaml"
                  xmlns:ext="using:App.Extensions"
                  Tag="{ext:Exact Ex|}" />
            """,
            CreateTypeSystem(includeMarkupExtensionBase: true));

        Assert.Contains("ExactOnly", labels);
        Assert.DoesNotContain("SuffixedOnly", labels);
    }

    [Fact]
    public void MarkupName_ExplicitPrefixBypassesBroadNamespaceLimit()
    {
        var declarations = string.Join(
            " ",
            Enumerable.Range(0, 70)
                .Select(index => $"xmlns:p{index}=\"using:App.Extensions\""));
        var labels = Complete(
            $"<Page xmlns=\"using:Microsoft.UI.Xaml\" {declarations} Tag=\"{{p69:Cur|}}\" />",
            CreateTypeSystem(includeMarkupExtensionBase: true));

        Assert.Contains("p69:CurrentTheme", labels);
    }

    [Fact]
    public void MarkupName_BroadDiscoveryLimitsRuntimeNamespacesPerRequest()
    {
        var declarations = string.Join(
            " ",
            Enumerable.Range(1, 69)
                .Select(index => $"xmlns:p{index}=\"using:App.Namespace{index}\""));
        var labels = Complete(
            $"<Page xmlns=\"using:App.Namespace0\" {declarations} Tag=\"{{|}}\" />",
            CreateManyNamespaceTypeSystem());

        Assert.Contains("Theme0", labels);
        Assert.Contains("p63:Theme63", labels);
        Assert.DoesNotContain("p64:Theme64", labels);
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
                public sealed class Exact : {{derivedBase}}
                {
                    public string ExactOnly { get; set; } = "";
                }
                public sealed class ExactExtension : {{derivedBase}}
                {
                    public string SuffixedOnly { get; set; } = "";
                }
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

    private static XamlTypeSystem CreateManyNamespaceTypeSystem()
    {
        var namespaces = string.Join(
            Environment.NewLine,
            Enumerable.Range(0, 70).Select(index => $$"""
                namespace App.Namespace{{index}}
                {
                    {{(index == 0 ? "public class Page { public object Tag { get; set; } }" : string.Empty)}}
                    public sealed class Theme{{index}}Extension :
                        Microsoft.UI.Xaml.Markup.MarkupExtension { }
                }
                """));
        var source = $$"""
            namespace Microsoft.UI.Xaml.Markup
            {
                public abstract class MarkupExtension { }
            }
            {{namespaces}}
            """;
        var compilation = CSharpCompilation.Create(
            "TestApp",
            [CSharpSyntaxTree.ParseText(source)],
            [MetadataReference.CreateFromFile(typeof(object).Assembly.Location)],
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        return XamlTypeSystem.FromCompilation(
            compilation,
            ImmutableArray<IAssemblySymbol>.Empty);
    }
}
