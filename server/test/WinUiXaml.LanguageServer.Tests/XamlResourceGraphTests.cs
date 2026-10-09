using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using WinUiXaml.Workspace;
using Xunit;

namespace WinUiXaml.LanguageServer.Tests;

public class XamlResourceGraphTests
{
    [Fact]
    public void ResolveSourcePath_ResolvesRelativeToOwningDictionary()
    {
        var result = XamlResourceGraph.ResolveSourcePath(
            @"C:\project\Styles\Root.xaml",
            @"C:\project",
            @"Colors\Palette.xaml");

        Assert.Equal(
            Path.GetFullPath(@"C:\project\Styles\Colors\Palette.xaml"),
            result);
    }

    [Theory]
    [InlineData("/Styles/Colors.xaml")]
    [InlineData("ms-appx:///Styles/Colors.xaml")]
    public void ResolveSourcePath_ResolvesAppRootUris(string source)
    {
        var result = XamlResourceGraph.ResolveSourcePath(
            @"C:\project\App.xaml",
            @"C:\project",
            source);

        Assert.Equal(
            Path.GetFullPath(@"C:\project\Styles\Colors.xaml"),
            result);
    }

    [Fact]
    public void ReadReachable_FollowsSourcesOnceAndBreaksCycles()
    {
        var root = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var app = Path.Combine(root, "App.xaml");
            var colors = Path.Combine(root, "Colors.xaml");
            File.WriteAllText(app, Dictionary("AppKey", "Colors.xaml"));
            File.WriteAllText(colors, Dictionary("ColorKey", "App.xaml"));

            var graph = new XamlResourceGraph();
            var files = graph.ReadReachable(
                app,
                root,
                path => Path.GetFullPath(path).StartsWith(root, StringComparison.OrdinalIgnoreCase)
                    ? Path.GetFullPath(path)
                    : null,
                _ => { });

            Assert.Equal(2, files.Count);
            Assert.Contains(files, file => file.Keys.Contains("AppKey"));
            Assert.Contains(files, file => file.Keys.Contains("ColorKey"));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ReadReachable_UsesRuntimeMergedDictionaryPrecedence()
    {
        var root = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var app = Path.Combine(root, "App.xaml");
            File.WriteAllText(app, Dictionary("AppKey", "First.xaml", "Last.xaml"));
            File.WriteAllText(Path.Combine(root, "First.xaml"), Dictionary("FirstKey"));
            File.WriteAllText(Path.Combine(root, "Last.xaml"), Dictionary("LastKey"));

            var files = Read(new XamlResourceGraph(), app, root);

            Assert.Equal(
                new[] { "App.xaml", "Last.xaml", "First.xaml" },
                files.Select(file => Path.GetFileName(file.Path)));
        }

        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ReadReachable_FollowsRootDictionarySource()
    {
        var root = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var proxy = Path.Combine(root, "Proxy.xaml");
            var target = Path.Combine(root, "Target.xaml");
            File.WriteAllText(
                proxy,
                """
                <ResourceDictionary
                    xmlns="using:Microsoft.UI.Xaml"
                    Source="Target.xaml" />
                """);
            File.WriteAllText(target, Dictionary("TargetKey"));

            var files = Read(new XamlResourceGraph(), proxy, root);

            Assert.Equal(
                new[] { "Proxy.xaml", "Target.xaml" },
                files.Select(file => Path.GetFileName(file.Path)));
            Assert.Contains(files, file => file.Keys.Contains("TargetKey"));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ReadReachable_ExportsOnlyKeysVisibleFromEachFileRoot()
    {
        var root = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var app = Path.Combine(root, "App.xaml");
            File.WriteAllText(
                app,
                """
                <ResourceDictionary
                    xmlns="using:Microsoft.UI.Xaml"
                    xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
                  <ResourceDictionary.MergedDictionaries>
                    <ResourceDictionary Source="Merged.xaml" />
                  </ResourceDictionary.MergedDictionaries>
                  <SolidColorBrush x:Key="RootVisible" />
                  <SolidColorBrush x:Name="NamedVisible" />
                  <ResourceDictionary x:Name="NestedDictionary">
                    <ResourceDictionary.MergedDictionaries>
                      <ResourceDictionary Source="NestedMerged.xaml" />
                    </ResourceDictionary.MergedDictionaries>
                    <SolidColorBrush x:Key="NestedOnly" />
                  </ResourceDictionary>
                  <Grid>
                    <Grid.Resources>
                      <ResourceDictionary>
                        <ResourceDictionary.MergedDictionaries>
                          <ResourceDictionary Source="ChildMerged.xaml" />
                        </ResourceDictionary.MergedDictionaries>
                        <SolidColorBrush x:Key="ChildOnly" />
                      </ResourceDictionary>
                    </Grid.Resources>
                  </Grid>
                  <ResourceDictionary.ThemeDictionaries>
                    <ResourceDictionary x:Key="Light">
                      <ResourceDictionary.MergedDictionaries>
                        <ResourceDictionary Source="ThemeMerged.xaml" />
                      </ResourceDictionary.MergedDictionaries>
                      <SolidColorBrush x:Key="ThemeVisible" />
                    </ResourceDictionary>
                  </ResourceDictionary.ThemeDictionaries>
                </ResourceDictionary>
                """);
            File.WriteAllText(Path.Combine(root, "Merged.xaml"), Dictionary("MergedVisible"));
            File.WriteAllText(Path.Combine(root, "ThemeMerged.xaml"), Dictionary("ThemeMergedVisible"));
            File.WriteAllText(Path.Combine(root, "NestedMerged.xaml"), Dictionary("NestedMergedOnly"));
            File.WriteAllText(Path.Combine(root, "ChildMerged.xaml"), Dictionary("ChildMergedOnly"));

            var files = Read(new XamlResourceGraph(), app, root);
            var appFile = Assert.Single(
                files,
                file => string.Equals(file.Path, app, StringComparison.OrdinalIgnoreCase));
            var mergedFile = Assert.Single(
                files,
                file => string.Equals(
                    Path.GetFileName(file.Path),
                    "Merged.xaml",
                    StringComparison.OrdinalIgnoreCase));

            Assert.Contains("RootVisible", appFile.Keys);
            Assert.Contains("NamedVisible", appFile.Keys);
            Assert.Contains("NestedDictionary", appFile.Keys);
            Assert.Contains("ThemeVisible", appFile.Keys);
            Assert.DoesNotContain("NestedOnly", appFile.Keys);
            Assert.DoesNotContain("ChildOnly", appFile.Keys);
            Assert.DoesNotContain("Light", appFile.Keys);
            Assert.Contains("MergedVisible", mergedFile.Keys);
            Assert.Contains(files, file => file.Keys.Contains("ThemeMergedVisible"));
            Assert.DoesNotContain(files, file => file.Keys.Contains("NestedMergedOnly"));
            Assert.DoesNotContain(files, file => file.Keys.Contains("ChildMergedOnly"));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void CollectResourceKeys_ExcludesCurrentDocumentFromServerCatalog()
    {
        var current = new XamlResourceGraph.ResourceFile(
            Path.GetFullPath(@"C:\project\App.xaml"),
            string.Empty,
            WinUiXaml.Xaml.XamlParser.Parse("<ResourceDictionary />"),
            ["CurrentOnly"],
            0);
        var merged = new XamlResourceGraph.ResourceFile(
            Path.GetFullPath(@"C:\project\Merged.xaml"),
            string.Empty,
            WinUiXaml.Xaml.XamlParser.Parse("<ResourceDictionary />"),
            ["MergedOnly"],
            0);

        var keys = XamlLanguageServer.CollectResourceKeys(
            [current, merged],
            Path.GetFullPath(@"C:\project\App.xaml"));

        Assert.Equal(["MergedOnly"], keys);
    }

    [Fact]
    public void ReadReachable_PrefersOpenDocumentTextAndClearInvalidatesDiskCache()
    {
        var root = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var app = Path.Combine(root, "App.xaml");
            File.WriteAllText(app, Dictionary("DiskKey"));
            var graph = new XamlResourceGraph();

            var open = graph.ReadReachable(
                app,
                root,
                path => Path.GetFullPath(path),
                _ => { },
                path => string.Equals(path, app, StringComparison.OrdinalIgnoreCase)
                    ? Dictionary("OpenKey")
                    : null);
            Assert.Contains("OpenKey", Assert.Single(open).Keys);
            Assert.DoesNotContain("DiskKey", open[0].Keys);

            _ = Read(graph, app, root);
            var stamp = File.GetLastWriteTimeUtc(app);
            File.WriteAllText(app, Dictionary("UpdatedDiskKey"));
            File.SetLastWriteTimeUtc(app, stamp);
            Assert.DoesNotContain("UpdatedDiskKey", Assert.Single(Read(graph, app, root)).Keys);

            graph.Clear();
            Assert.Contains("UpdatedDiskKey", Assert.Single(Read(graph, app, root)).Keys);
        }

        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ReadReachable_UsesSdkIdentityForMergedDictionarySources()
    {
        var root = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var app = Path.Combine(root, "App.xaml");
            var included = Path.Combine(root, "Included.xaml");
            var ignored = Path.Combine(root, "Ignored.xaml");
            File.WriteAllText(
                app,
                """
                <ResourceDictionary xmlns="using:Microsoft.UI.Xaml"
                                    xmlns:local="using:Contoso">
                  <local:DerivedDictionary Source="Included.xaml" />
                  <local:ResourceDictionary Source="Ignored.xaml" />
                </ResourceDictionary>
                """);
            File.WriteAllText(included, Dictionary("IncludedKey"));
            File.WriteAllText(ignored, Dictionary("IgnoredKey"));

            var typeSystem = CreateResourceDictionaryTypeSystem();
            var files = new XamlResourceGraph().ReadReachable(
                app,
                root,
                path => File.Exists(path) ? Path.GetFullPath(path) : null,
                _ => { },
                typeSystem: typeSystem);

            Assert.Equal(2, files.Count);
            Assert.Contains(files, file => file.Keys.Contains("IncludedKey"));
            Assert.DoesNotContain(files, file => file.Keys.Contains("IgnoredKey"));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ReadReachable_ReclassifiesCachedParseWithCurrentSdkIdentity()
    {
        var root = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var app = Path.Combine(root, "App.xaml");
            var included = Path.Combine(root, "Included.xaml");
            File.WriteAllText(
                app,
                """
                <ResourceDictionary xmlns="using:Microsoft.UI.Xaml"
                                    xmlns:local="using:Contoso">
                  <local:DerivedDictionary Source="Included.xaml" />
                </ResourceDictionary>
                """);
            File.WriteAllText(included, Dictionary("IncludedKey"));
            var graph = new XamlResourceGraph();
            var authorize = (string path) =>
                File.Exists(path) ? Path.GetFullPath(path) : null;

            Assert.Single(graph.ReadReachable(
                app,
                root,
                authorize,
                _ => { }));

            var typeSystem = CreateResourceDictionaryTypeSystem();
            var reclassified = graph.ReadReachable(
                app,
                root,
                authorize,
                _ => { },
                typeSystem: typeSystem);

            Assert.Equal(2, reclassified.Count);
            Assert.Contains(
                reclassified,
                file => file.Keys.Contains("IncludedKey"));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ReadReachable_RejectsTraversalOutsideAuthorizedProject()
    {
        var parent = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"));
        var root = Path.Combine(parent, "Project");
        Directory.CreateDirectory(root);
        try
        {
            var app = Path.Combine(root, "App.xaml");
            File.WriteAllText(app, Dictionary("AppKey", @"..\Outside.xaml"));
            File.WriteAllText(Path.Combine(parent, "Outside.xaml"), Dictionary("OutsideKey"));

            var files = Read(new XamlResourceGraph(), app, root);

            Assert.Single(files);
            Assert.DoesNotContain(files, file => file.Keys.Contains("OutsideKey"));
        }
        finally
        {
            Directory.Delete(parent, recursive: true);
        }
    }

    [Fact]
    public void ReadReachable_HonorsCancellation()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        Assert.Throws<OperationCanceledException>(() =>
            new XamlResourceGraph().ReadReachable(
                @"C:\project\App.xaml",
                @"C:\project",
                path => path,
                _ => { },
                cancellationToken: cancellation.Token));
    }

    [Fact]
    public void ReadReachable_RejectsOversizedOpenDocumentBeforeParsing()
    {
        var logged = new List<string>();
        var files = new XamlResourceGraph().ReadReachable(
            @"C:\project\App.xaml",
            @"C:\project",
            path => path,
            logged.Add,
            _ => new string(' ', checked((int)(XamlResourceGraph.MaxFileBytes / 2 + 1))));

        Assert.Empty(files);
        Assert.Contains(logged, message => message.Contains("oversized open input"));
    }

    [Fact]
    public void ReadReachable_EnforcesFileCountDepthAndAggregateByteLimits()
    {
        var root = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var app = Path.Combine(root, "App.xaml");
            File.WriteAllText(app, Dictionary("Root", "One.xaml", "Two.xaml", "Three.xaml"));
            File.WriteAllText(Path.Combine(root, "One.xaml"), Dictionary("One", "Deep.xaml"));
            File.WriteAllText(Path.Combine(root, "Two.xaml"), Dictionary("Two"));
            File.WriteAllText(Path.Combine(root, "Three.xaml"), Dictionary("Three"));
            File.WriteAllText(Path.Combine(root, "Deep.xaml"), Dictionary("Deep"));

            var fileLimited = Read(new XamlResourceGraph(2, 4096, 16384, 8), app, root);
            Assert.Equal(2, fileLimited.Count);

            var depthLimited = Read(new XamlResourceGraph(16, 4096, 16384, 0), app, root);
            Assert.Single(depthLimited);

            long rootBytes = new FileInfo(app).Length;
            long lastBytes = new FileInfo(Path.Combine(root, "Three.xaml")).Length;
            var totalLimited = Read(
                new XamlResourceGraph(16, 4096, rootBytes + lastBytes, 8),
                app,
                root);
            Assert.Equal(2, totalLimited.Count);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static IReadOnlyList<XamlResourceGraph.ResourceFile> Read(
        XamlResourceGraph graph,
        string app,
        string root) =>
        graph.ReadReachable(
            app,
            root,
            path =>
            {
                var full = Path.GetFullPath(path);
                return XamlLanguageServer.PathIsWithin(full, root) && File.Exists(full)
                    ? full
                    : null;
            },
            _ => { });

    private static XamlTypeSystem CreateResourceDictionaryTypeSystem()
    {
        const string source = """
            namespace Microsoft.UI.Xaml
            {
                public class ResourceDictionary { }
            }
            namespace Contoso
            {
                public class DerivedDictionary : Microsoft.UI.Xaml.ResourceDictionary { }
                public class ResourceDictionary { }
            }
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

    private static string Dictionary(string key, params string[] sources)
    {
        var merged = string.Join(
            Environment.NewLine,
            sources.Select(source => $"""    <ResourceDictionary Source="{source}" />"""));
        return $$"""
        <ResourceDictionary
            xmlns="using:Microsoft.UI.Xaml"
            xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
          <ResourceDictionary.MergedDictionaries>
        {{merged}}
          </ResourceDictionary.MergedDictionaries>
          <SolidColorBrush x:Key="{{key}}" />
        </ResourceDictionary>
        """;
    }
}
