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
        Assert.Null(XamlSemanticFacts.ResolveMarkupExtensionType(
            "local:Abstract",
            element.NamespaceScope,
            TypeSystem));
        Assert.Null(XamlSemanticFacts.ResolveMarkupExtensionType(
            "local:Hidden",
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

    [Fact]
    public void UnprefixedMarkupExtensionDoesNotFallBackUnderCustomDefaultNamespace()
    {
        var element = Element("""<Page xmlns="using:Other" />""");

        Assert.Null(XamlSemanticFacts.ResolveMarkupExtensionType(
                "Binding",
                element.NamespaceScope,
                TypeSystem));
    }

    [Fact]
    public void XBindModeTypingDoesNotLeakToUnknownMarkupExtensions()
    {
        var customElement = Element(
                """<Page xmlns="using:Microsoft.UI.Xaml" xmlns:local="using:Contoso" Tag="{local:Lookalike Mode=OneWay}" />""");
        var customExtension = customElement.DescendantNodesAndSelf()
                .OfType<WinUiXaml.Xaml.XamlMarkupExtension>()
                .Single();
        Assert.Null(XamlSemanticFacts.ResolveMarkupArgumentType(
                customExtension,
                customElement.NamespaceScope,
                "Mode",
                TypeSystem));

        var bindElement = Element(
                """<Page xmlns="using:Microsoft.UI.Xaml" xmlns:lang="http://schemas.microsoft.com/winfx/2006/xaml" Tag="{lang:Bind Mode=OneWay}" />""");
        var bindExtension = bindElement.DescendantNodesAndSelf()
                .OfType<WinUiXaml.Xaml.XamlMarkupExtension>()
                .Single();
        Assert.Equal(
                "Microsoft.UI.Xaml.Data.BindingMode",
                XamlSemanticFacts.ResolveMarkupArgumentType(
                    bindExtension,
                    bindElement.NamespaceScope,
                    "Mode",
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

    [Fact]
    public void NamedElementLookupUsesTheEnclosingTemplateNameScope()
    {
        const string text = """
            <Page xmlns="using:Microsoft.UI.Xaml"
                      xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                      xmlns:lang="http://schemas.microsoft.com/winfx/2006/xaml"
                      xmlns:controls="using:Microsoft.UI.Xaml.Controls">
              <controls:Button x:Name="Shared" />
              <DataTemplate>
                    <controls:Button lang:Name="Shared" />
                    <controls:Button Tag="{Binding ElementName=Shared}" />
              </DataTemplate>
            </Page>
            """;
        var document = new TextDocument("file:///test.xaml", text);
        var context = document.Parsed.FindNode(text.IndexOf("ElementName=Shared", StringComparison.Ordinal));

        var element = XamlSemanticFacts.FindNamedElementInScope(
            document,
            context,
            "Shared",
            TypeSystem);

        Assert.NotNull(element);
        Assert.Equal(
            "DataTemplate",
            Assert.IsType<WinUiXaml.Xaml.XamlElement>(element!.Parent).Name?.LocalName);
    }

    [Fact]
    public void NamedElementLookupTraversesRootTemplateContent()
    {
        const string text = """
            <DataTemplate xmlns="using:Microsoft.UI.Xaml"
                          xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                          xmlns:controls="using:Microsoft.UI.Xaml.Controls">
              <controls:Button x:Name="Target" />
              <controls:Button Tag="{Binding ElementName=Target}" />
            </DataTemplate>
            """;
        var document = new TextDocument("file:///test.xaml", text);
        var context = document.Parsed.FindNode(text.IndexOf("ElementName=Target", StringComparison.Ordinal));

        var element = XamlSemanticFacts.FindNamedElementInScope(
            document,
            context,
            "Target",
            TypeSystem);

        Assert.NotNull(element);
    }

    [Fact]
    public void ConventionalXPrefixIsOnlyAssumedWhenUnresolved()
    {
        var unresolved = Element("""<Page xmlns="using:Microsoft.UI.Xaml" />""");
        var foreign = Element("""<Page xmlns="using:Microsoft.UI.Xaml" xmlns:x="using:Foreign" />""");

        Assert.True(XamlSemanticFacts.IsXamlDirectiveName("x:Name", "Name", unresolved.NamespaceScope));
        Assert.False(XamlSemanticFacts.IsXamlDirectiveName("x:Name", "Name", foreign.NamespaceScope));
    }

    [Theory]
    [InlineData("""<Page Background="{StaticResource Key}" />""", true)]
    [InlineData(
        """<Page xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" Background="{StaticResource Key}" />""",
        true)]
    [InlineData(
        """<Page xmlns="using:Contoso" Background="{StaticResource Key}" />""",
        false)]
    [InlineData(
        """<local:Page xmlns="using:Contoso" xmlns:p="http://schemas.microsoft.com/winfx/2006/xaml/presentation" Background="{p:StaticResource Key}" />""",
        true)]
    public void ResourceReferenceClassifierUsesTheResolvedNamespace(
        string text,
        bool expected)
    {
        var element = Element(text);
        var attribute = Assert.Single(
            element.Attributes,
            candidate => candidate.Value?.MarkupExtension is not null);
        var extension = attribute.Value!.MarkupExtension!;

        Assert.Equal(
            expected,
            XamlSemanticFacts.IsResourceReferenceExtension(
                extension,
                element.NamespaceScope));
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
                public class Page { }
                public class FrameworkTemplate { }
                public class Setter { }
                public class Style { }
                public class DataTemplate : FrameworkTemplate { }
                public class ResourceDictionary { }
            }
            namespace Microsoft.UI.Xaml.Controls
            {
                public class ControlTemplate : Microsoft.UI.Xaml.FrameworkTemplate { }
                public class Button { public object Tag { get; set; } }
            }
            namespace Microsoft.UI.Xaml.Markup
            {
                public abstract class MarkupExtension { }
            }
            namespace Microsoft.UI.Xaml.Data
            {
                public class Binding : Microsoft.UI.Xaml.Markup.MarkupExtension { }
                public class RelativeSource : Microsoft.UI.Xaml.Markup.MarkupExtension { }
                public enum BindingMode { OneWay, TwoWay }
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
                public abstract class AbstractExtension : Microsoft.UI.Xaml.Markup.MarkupExtension { }
                internal class HiddenExtension : Microsoft.UI.Xaml.Markup.MarkupExtension { }
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
