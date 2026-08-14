using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using WinUiXaml.Workspace;
using Xunit;

namespace WinUiXaml.LanguageServer.Tests;

public sealed class XamlSemanticFactsTests
{
    private static readonly XamlTypeSystem TypeSystem = CreateTypeSystem();

    [Theory]
    [InlineData("Setter")]
    [InlineData("Style")]
    [InlineData("ControlTemplate")]
    [InlineData("DataTemplate")]
    [InlineData("ResourceDictionary")]
    public void FrameworkClassifiersRejectSameNamedUserTypes(string typeName)
    {
        var frameworkNamespace = typeName == "ControlTemplate"
            ? "using:Microsoft.UI.Xaml.Controls"
            : "using:Microsoft.UI.Xaml";
        var framework = Element($"""<{typeName} xmlns="{frameworkNamespace}" />""");
        var lookalike = Element($"""<{typeName} xmlns="using:Contoso" />""");

        Assert.True(Classify(typeName, framework));
        Assert.False(Classify(typeName, lookalike));
    }

    [Fact]
    public void ResourceDictionaryClassifierAllowsSdkDerivedTypesOnly()
    {
        var derived = Element("""<local:DerivedDictionary xmlns:local="using:Contoso" />""");
        var lookalike = Element("""<ResourceDictionary xmlns="using:Contoso" />""");

        Assert.True(XamlSemanticFacts.IsElement(
            derived,
            TypeSystem.Capabilities.ResourceDictionary,
            TypeSystem,
            allowDerived: true));
        Assert.False(XamlSemanticFacts.IsElement(
            lookalike,
            TypeSystem.Capabilities.ResourceDictionary,
            TypeSystem,
            allowDerived: true));
    }

    [Fact]
    public void StoryboardAttachedPropertySupportsAlternateNamespacePrefix()
    {
        var element = Element(
            """<DoubleAnimation xmlns="using:Microsoft.UI.Xaml" xmlns:anim="using:Microsoft.UI.Xaml.Media.Animation" anim:Storyboard.TargetName="Hero" />""");

        Assert.True(XamlSemanticFacts.IsStoryboardAttachedProperty(
            "anim:Storyboard.TargetName",
            "TargetName",
            element.NamespaceScope,
            TypeSystem));
    }

    [Fact]
    public void StoryboardAttachedPropertyRejectsSameNamedCustomOwner()
    {
        var element = Element(
            """<DoubleAnimation xmlns="using:Microsoft.UI.Xaml" xmlns:custom="using:Contoso" custom:Storyboard.TargetName="Hero" />""");

        Assert.False(XamlSemanticFacts.IsStoryboardAttachedProperty(
            "custom:Storyboard.TargetName",
            "TargetName",
            element.NamespaceScope,
            TypeSystem));
    }

    [Fact]
    public void StyleTargetTypeUsesDeclarationScopeInsteadOfDescendantShadow()
    {
        var setter = Element(
            """
            <Style xmlns="using:Microsoft.UI.Xaml"
                   xmlns:controls="using:Microsoft.UI.Xaml.Controls"
                   TargetType="controls:Button">
              <Setter xmlns:controls="using:Contoso" Property="Content" />
            </Style>
            """).Content.OfType<WinUiXaml.Xaml.XamlElement>().Single();

        var targetType = XamlSemanticFacts.ResolveStyleTargetType(
            setter,
            setter.NamespaceScope,
            TypeSystem);

        Assert.Equal("Microsoft.UI.Xaml.Controls.Button", targetType?.ToDisplayString());
    }

    [Fact]
    public void MarkupExtensionResolverRejectsLookalikesAndAcceptsSdkDerivedTypes()
    {
        var element = Element(
            """<Page xmlns="using:Microsoft.UI.Xaml" xmlns:local="using:Contoso" />""");

        Assert.Equal(
            "Contoso.CustomExtension",
            XamlSemanticFacts.ResolveMarkupExtensionType(
                "local:Custom",
                element.NamespaceScope,
                TypeSystem)?.ToDisplayString());
        Assert.Null(XamlSemanticFacts.ResolveMarkupExtensionType(
            "local:Lookalike",
            element.NamespaceScope,
            TypeSystem));
    }

    [Fact]
    public void UnprefixedMarkupExtensionHonorsCustomDefaultNamespace()
    {
        var element = Element("""<Page xmlns="using:Contoso" />""");

        Assert.Equal(
            "Contoso.Binding",
            XamlSemanticFacts.ResolveMarkupExtensionType(
                "Binding",
                element.NamespaceScope,
                TypeSystem)?.ToDisplayString());
    }

    [Theory]
    [InlineData("Binding", "Microsoft.UI.Xaml.Data.Binding")]
    [InlineData("RelativeSource", "Microsoft.UI.Xaml.Data.RelativeSource")]
    public void BuiltInMarkupExtensionSupportsExplicitPresentationPrefix(
        string extensionName,
        string expectedType)
    {
        var element = Element(
                """<Page xmlns="using:Contoso" xmlns:ui="http://schemas.microsoft.com/winfx/2006/xaml/presentation" />""");

        Assert.Equal(
                expectedType,
                XamlSemanticFacts.ResolveMarkupExtensionType(
                    "ui:" + extensionName,
                    element.NamespaceScope,
                    TypeSystem)?.ToDisplayString());
    }

    private static bool Classify(string typeName, WinUiXaml.Xaml.XamlElement element) => typeName switch
    {
        "Setter" => XamlSemanticFacts.IsSetter(element, TypeSystem),
        "Style" or "ControlTemplate" => XamlSemanticFacts.IsStyleOrControlTemplate(element, TypeSystem),
        "DataTemplate" => XamlSemanticFacts.IsDataTemplate(element, TypeSystem),
        "ResourceDictionary" => XamlSemanticFacts.IsElement(
            element,
            TypeSystem.Capabilities.ResourceDictionary,
            TypeSystem,
            allowDerived: true),
        _ => false,
    };

    private static WinUiXaml.Xaml.XamlElement Element(string text) =>
        Assert.IsType<WinUiXaml.Xaml.XamlElement>(
            new TextDocument("file:///test.xaml", text).Parsed.Root);

    private static XamlTypeSystem CreateTypeSystem()
    {
        const string source = """
            namespace Microsoft.UI.Xaml
            {
                public class Setter { }
                public class Style { }
                public class DataTemplate { }
                public class ResourceDictionary { }
            }
            namespace Microsoft.UI.Xaml.Controls
            {
                public class ControlTemplate { }
                public class Button { }
            }
            namespace Microsoft.UI.Xaml.Markup
            {
                public abstract class MarkupExtension { }
            }
            namespace Microsoft.UI.Xaml.Data
            {
                public class Binding : Microsoft.UI.Xaml.Markup.MarkupExtension { }
                public class RelativeSource : Microsoft.UI.Xaml.Markup.MarkupExtension { }
            }
            namespace Microsoft.UI.Xaml.Media.Animation
            {
                public class Storyboard
                {
                    public static string GetTargetName(object element) => "";
                    public static void SetTargetName(object element, string value) { }
                }
            }
            namespace Contoso
            {
                public class Setter { }
                public class Style { }
                public class ControlTemplate { }
                public class DataTemplate { }
                public class ResourceDictionary { }
                public class Button { }
                public class DerivedDictionary : Microsoft.UI.Xaml.ResourceDictionary { }
                public class CustomExtension : Microsoft.UI.Xaml.Markup.MarkupExtension { }
                public class Binding : Microsoft.UI.Xaml.Markup.MarkupExtension { }
                public class Lookalike { }
                public class Storyboard
                {
                    public static string GetTargetName(object element) => "";
                    public static void SetTargetName(object element, string value) { }
                }
            }
            """;
        var compilation = CSharpCompilation.Create(
            "TestApp",
            [CSharpSyntaxTree.ParseText(source)],
            [MetadataReference.CreateFromFile(typeof(object).Assembly.Location)],
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        return XamlTypeSystem.FromCompilation(compilation, ImmutableArray<IAssemblySymbol>.Empty);
    }
}
