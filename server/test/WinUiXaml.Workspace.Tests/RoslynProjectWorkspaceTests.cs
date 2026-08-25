using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;

namespace WinUiXaml.Workspace.Tests;

public sealed class RoslynProjectWorkspaceTests : IDisposable
{
    private static readonly Dictionary<string, string> WinUiProperties =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["Configuration"] = "Debug",
            ["Platform"] = "x64",
            ["NuGetAudit"] = "false",
        };

    private readonly string _root =
        Path.Combine(Path.GetTempPath(), "winui-xaml-workspace-tests", Guid.NewGuid().ToString("N"));

    [Fact]
    public async Task FrameworkCompilationUsesProjectReferencesWithoutProjectSources()
    {
        Directory.CreateDirectory(_root);
        var projectPath = Path.Combine(_root, "Fixture.csproj");
        await File.WriteAllTextAsync(
            projectPath,
            """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
              </PropertyGroup>
            </Project>
            """);
        await File.WriteAllTextAsync(
            Path.Combine(_root, "SourceOnly.cs"),
            "namespace Fixture; public sealed class SourceOnly { }");

        using var workspace = await RoslynProjectWorkspace.LoadProjectAsync(projectPath);
        var framework = workspace.GetFrameworkCompilation();
        var full = await workspace.GetCompilationAsync();

        Assert.NotNull(framework.GetTypeByMetadataName("System.String"));
        Assert.Null(framework.GetTypeByMetadataName("Fixture.SourceOnly"));
        Assert.NotNull(full?.GetTypeByMetadataName("Fixture.SourceOnly"));
        Assert.Empty(framework.SyntaxTrees);
    }

    [Fact]
    public async Task LightweightFrameworkProjectMatchesWorkspaceReferences()
    {
        var projectPath = GetWinUiFixturePath("SmokeFixture.csproj");

        var lightweight = MsBuildFrameworkProject.Load(projectPath, WinUiProperties);
        using var workspace = await RoslynProjectWorkspace.LoadProjectAsync(
            projectPath,
            WinUiProperties);

        Assert.NotNull(lightweight);
        Assert.NotNull(lightweight.Compilation.GetTypeByMetadataName(
            "Microsoft.UI.Xaml.Controls.Button"));
        Assert.Empty(lightweight.Compilation.SyntaxTrees);

        var lightweightReferences = lightweight.Compilation.References
            .OfType<PortableExecutableReference>()
            .ToDictionary(
                reference => Path.GetFullPath(reference.FilePath!),
                reference => reference.Properties,
                StringComparer.OrdinalIgnoreCase);
        var workspaceReferences = workspace.Project.MetadataReferences
            .OfType<PortableExecutableReference>()
            .ToDictionary(
                reference => Path.GetFullPath(reference.FilePath!),
                reference => reference.Properties,
                StringComparer.OrdinalIgnoreCase);
        Assert.True(
            lightweightReferences.Keys.ToHashSet(StringComparer.OrdinalIgnoreCase)
                .SetEquals(workspaceReferences.Keys),
            $"Lightweight-only: {string.Join(", ", lightweightReferences.Keys.Except(workspaceReferences.Keys))}\n" +
            $"Workspace-only: {string.Join(", ", workspaceReferences.Keys.Except(lightweightReferences.Keys))}");
        foreach (var reference in lightweightReferences)
        {
            Assert.Equal(workspaceReferences[reference.Key], reference.Value);
        }
    }

    [Fact]
    public async Task CancelledFrameworkCallerDoesNotPoisonSharedLoad()
    {
        var xamlPath = GetWinUiFixturePath("MainWindow.xaml");
        using var resolver = new XamlProjectResolver(WinUiProperties);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => resolver.ResolveFrameworkAsync(
                xamlPath,
                cancellationToken: cancellation.Token));

        var resolution = await resolver.ResolveFrameworkAsync(xamlPath);
        Assert.NotNull(resolution);
        Assert.NotNull(resolution.Compilation.GetTypeByMetadataName(
            "Microsoft.UI.Xaml.Controls.Button"));
    }

    [Fact]
    public async Task InvalidationReplacesLightweightFrameworkCompilation()
    {
        var projectPath = GetWinUiFixturePath("SmokeFixture.csproj");
        var xamlPath = GetWinUiFixturePath("MainWindow.xaml");
        using var resolver = new XamlProjectResolver(WinUiProperties);

        var first = await resolver.ResolveFrameworkAsync(xamlPath);
        resolver.Invalidate(projectPath);
        var second = await resolver.ResolveFrameworkAsync(xamlPath);

        Assert.NotNull(first);
        Assert.NotNull(second);
        Assert.NotSame(first.Compilation, second.Compilation);
    }

    [Fact]
    public async Task FullProjectCompilationResolvesWinUiBaseTypesAndInheritedMembers()
    {
        var xamlPath = GetWinUiFixturePath("SmokePage.xaml");
        using var resolver = new XamlProjectResolver(WinUiProperties);
        var resolution = await resolver.ResolveAsync(xamlPath);
        Assert.NotNull(resolution);
        Assert.NotNull(resolution!.ClassSymbol);
        Assert.NotEqual(TypeKind.Error, resolution.ClassSymbol!.BaseType?.TypeKind);
        var typeSystem = XamlTypeSystem.FromResolution(resolution);
        var userControl = typeSystem.ResolveType(
            XamlTypeSystem.PresentationNamespace, "UserControl");
        Assert.NotNull(userControl);

        Assert.NotNull(typeSystem.FindAttributeMember(resolution.ClassSymbol, "Background"));
        Assert.NotNull(typeSystem.FindAttributeMember(resolution.ClassSymbol, "Margin"));
        Assert.NotNull(typeSystem.FindAttributeMember(userControl!, "VerticalContentAlignment"));
        Assert.NotNull(typeSystem.FindAttributeMember(userControl!, "Background"));
        Assert.NotNull(typeSystem.FindAttributeMember(userControl!, "Margin"));
        var bindableNames = typeSystem.GetBindableMembers(userControl)
            .Select(member => member.Name)
            .ToHashSet(StringComparer.Ordinal);
        Assert.Contains("HorizontalContentAlignment", bindableNames);
        Assert.Contains("VerticalContentAlignment", bindableNames);
        Assert.Contains("Background", bindableNames);
        Assert.Contains("BorderBrush", bindableNames);
        Assert.Contains("BorderThickness", bindableNames);
        Assert.Contains("CornerRadius", bindableNames);
        Assert.Contains(
            typeSystem.GetThemeResources(),
            resource => resource.Key == "PaneToggleButtonSize");
        var observableCollection = resolution.Compilation.GetTypeByMetadataName(
            "System.Collections.ObjectModel.ObservableCollection`1");
        Assert.NotNull(observableCollection);
        var rowSampleCollection = observableCollection!.Construct(
            resolution.Compilation.GetSpecialType(SpecialType.System_String));
        Assert.Equal(
            SpecialType.System_String,
            XamlTypeSystem.GetCollectionElementType(rowSampleCollection)?.SpecialType);
    }

    private static string GetWinUiFixturePath(string fileName)
    {
        return Path.GetFullPath(
            Path.Combine(
                AppContext.BaseDirectory,
                "..", "..", "..", "..", "..", "..",
                "test", "fixtures", "xaml", "fixture", fileName));
    }

    public void Dispose()
    {
        if (Directory.Exists(_root))
        {
            Directory.Delete(_root, recursive: true);
        }
    }
}
