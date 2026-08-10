using System.Collections.Immutable;
using System.Diagnostics;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using WinUiXaml.Workspace;

namespace WinUiXaml.LanguageServer.Tests;

public sealed class CompletionProviderResourceTests
{
    private const string Presentation = XamlTypeSystem.PresentationNamespace;
    private const string Xaml = XamlTypeSystem.XamlLanguageNamespace;

    [Fact]
    public void ResourceCompletionCombinesSdkAndProjectResourcesWithConservativeFiltering()
    {
        var root = Path.Combine(Path.GetTempPath(), "WinUiXaml.Tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var typeSystem = CreateTypeSystem(root);
            var genericXaml = Path.Combine(
                root, "lib", "net8.0", "Microsoft.WinUI", "Themes", "generic.xaml");
            Directory.CreateDirectory(Path.GetDirectoryName(genericXaml)!);
            File.WriteAllText(genericXaml, $"""
                <ResourceDictionary xmlns="{Presentation}" xmlns:x="{Xaml}" xmlns:test="using:Unknown">
                  <SolidColorBrush x:Key="SdkBrush" />
                  <Style x:Key="SdkStyle" />
                  <test:FutureResource x:Key="UnknownSdkResource" />
                </ResourceDictionary>
                """);

            var text = $$"""
                <Page xmlns="{{Presentation}}" xmlns:x="{{Xaml}}">
                  <Page.Resources>
                    <SolidColorBrush x:Key="LocalBrush" />
                    <Style x:Key="LocalStyle" />
                  </Page.Resources>
                  <Border Background="{ThemeResource |}" />
                </Page>
                """;
            var offset = text.IndexOf('|');
            text = text.Remove(offset, 1);
            var document = new TextDocument("file:///Page.xaml", text);

            var labels = CompletionProvider.Provide(
                    document, offset, typeSystem, appResourceKeys: new[] { "AppBrush" })
                .Items.Select(item => item.Label).ToHashSet(StringComparer.Ordinal);

            Assert.Contains("SdkBrush", labels);
            Assert.Contains("UnknownSdkResource", labels);
            Assert.Contains("LocalBrush", labels);
            Assert.Contains("AppBrush", labels);
            Assert.DoesNotContain("SdkStyle", labels);
            Assert.DoesNotContain("LocalStyle", labels);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ResourceCompletionResolvesEachMatchingSdkTypeOnce()
    {
        var root = Path.Combine(Path.GetTempPath(), "WinUiXaml.Tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var typeSystem = CreateTypeSystem(root);
            var genericXaml = Path.Combine(
                root, "lib", "net8.0", "Microsoft.WinUI", "Themes", "generic.xaml");
            Directory.CreateDirectory(Path.GetDirectoryName(genericXaml)!);
            var resources = new StringBuilder();
            for (var i = 0; i < 2_000; i++)
            {
                resources.Append($"""<SolidColorBrush x:Key="Brush{i:D4}" />""");
                resources.Append($"""<Style x:Key="Style{i:D4}" />""");
                resources.Append($"""<test:FutureResource x:Key="Unknown{i:D4}" />""");
            }

            File.WriteAllText(genericXaml, $"""
                <ResourceDictionary xmlns="{Presentation}" xmlns:x="{Xaml}" xmlns:test="using:Unknown">
                  {resources}
                </ResourceDictionary>
                """);

            var text = $$"""<Border xmlns="{{Presentation}}" Background="{ThemeResource |}" />""";
            var offset = text.IndexOf('|');
            text = text.Remove(offset, 1);
            var document = new TextDocument("file:///Page.xaml", text);
            var resolvedTypes = new HashSet<(string Namespace, string LocalName)>();
            var resolutionAttempts = 0;
            var stopwatch = Stopwatch.StartNew();

            var labels = CompletionProvider.ProvideForTest(
                    document,
                    offset,
                    typeSystem,
                    (typeNamespace, localName) =>
                    {
                        resolutionAttempts++;
                        resolvedTypes.Add((typeNamespace, localName));
                    })
                .Items.Select(item => item.Label).ToHashSet(StringComparer.Ordinal);

            stopwatch.Stop();
            Assert.Equal(3, resolutionAttempts);
            Assert.Equal(3, resolvedTypes.Count);
            Assert.Contains("Brush0000", labels);
            Assert.DoesNotContain("Style0000", labels);
            Assert.True(stopwatch.Elapsed < TimeSpan.FromSeconds(5), $"Completion took {stopwatch.Elapsed}.");

            var partialText = $$"""<Border xmlns="{{Presentation}}" Background="{ThemeResource Unknown|}" />""";
            var partialOffset = partialText.IndexOf('|');
            partialText = partialText.Remove(partialOffset, 1);
            resolutionAttempts = 0;

            var partialLabels = CompletionProvider.ProvideForTest(
                    new TextDocument("file:///PartialPage.xaml", partialText),
                    partialOffset,
                    typeSystem,
                    (_, _) => resolutionAttempts++)
                .Items.Select(item => item.Label).ToHashSet(StringComparer.Ordinal);

            Assert.Equal(1, resolutionAttempts);
            Assert.Contains("Unknown0000", partialLabels);
            Assert.DoesNotContain("Brush0000", partialLabels);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static XamlTypeSystem CreateTypeSystem(string root)
    {
        const string source = """
            namespace Microsoft.UI.Xaml
            {
                public class DependencyObject { }
                public class Page : DependencyObject { public object Resources { get; set; } }
                public class Style { }
            }
            namespace Microsoft.UI.Xaml.Media
            {
                public class Brush : Microsoft.UI.Xaml.DependencyObject { }
                public class SolidColorBrush : Brush { }
            }
            namespace Microsoft.UI.Xaml.Controls
            {
                public class Border : Microsoft.UI.Xaml.DependencyObject
                {
                    public Microsoft.UI.Xaml.Media.Brush Background { get; set; }
                }
            }
            """;
        var coreReference = MetadataReference.CreateFromFile(typeof(object).Assembly.Location);
        var library = CSharpCompilation.Create(
            "Microsoft.WinUI",
            new[] { CSharpSyntaxTree.ParseText(source) },
            new[] { coreReference },
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        AssertNoErrors(library);

        var managedDirectory = Path.Combine(root, "lib", "net8.0");
        Directory.CreateDirectory(managedDirectory);
        var dllPath = Path.Combine(managedDirectory, "Microsoft.WinUI.dll");
        var emit = library.Emit(dllPath);
        Assert.True(emit.Success, string.Join("; ", emit.Diagnostics));

        var winUiReference = MetadataReference.CreateFromFile(dllPath);
        var compilation = CSharpCompilation.Create(
            "TestApp",
            references: new[] { coreReference, winUiReference },
            options: new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        AssertNoErrors(compilation);
        var assembly = (IAssemblySymbol)compilation.GetAssemblyOrModuleSymbol(winUiReference)!;
        return XamlTypeSystem.FromCompilation(compilation, ImmutableArray.Create(assembly));
    }

    private static void AssertNoErrors(Compilation compilation)
    {
        var errors = compilation.GetDiagnostics()
            .Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error)
            .ToList();
        Assert.Empty(errors);
    }
}
