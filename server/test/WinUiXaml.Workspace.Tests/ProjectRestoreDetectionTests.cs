using WinUiXaml.Workspace;

namespace WinUiXaml.Workspace.Tests;

public sealed class ProjectRestoreDetectionTests
{
    [Fact]
    public async Task LoadingUnrestoredPackageProjectRequestsRestore()
    {
        var root = Path.Combine(Path.GetTempPath(), "winui-xaml-restore", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var project = Path.Combine(root, "App.csproj");
        File.WriteAllText(
            project,
            """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
              <ItemGroup><PackageReference Include="Example.Unrestored.Package" Version="1.0.0" /></ItemGroup>
            </Project>
            """);

        try
        {
            var exception = await Assert.ThrowsAsync<ProjectRestoreRequiredException>(
                () => RoslynProjectWorkspace.LoadProjectAsync(project));
            Assert.Equal(project, exception.ProjectPath);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task LoadingProjectWithFailedRestoreOutputsRequestsRestore()
    {
        var root = Path.Combine(Path.GetTempPath(), "winui-xaml-restore", Guid.NewGuid().ToString("N"));
        var obj = Path.Combine(root, "obj");
        Directory.CreateDirectory(obj);
        var project = Path.Combine(root, "App.csproj");
        File.WriteAllText(
            project,
            """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
              <ItemGroup><PackageReference Include="Example.Failed.Package" Version="1.0.0" /></ItemGroup>
            </Project>
            """);
        File.WriteAllText(
            Path.Combine(obj, "project.assets.json"),
            AssetsJson(logs: """[{"code":"NU1301","level":"Error","message":"Feed unavailable"}]"""));
        File.WriteAllText(
            Path.Combine(obj, "project.nuget.cache"),
            """{"success":false,"logs":[]}""");

        try
        {
            var exception = await Assert.ThrowsAsync<ProjectRestoreRequiredException>(
                () => RoslynProjectWorkspace.LoadProjectAsync(project));
            Assert.Equal(project, exception.ProjectPath);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void MissingAssetsRequireRestoreWhenProjectHasPackages()
    {
        Assert.True(RoslynProjectWorkspace.RequiresRestore(
            Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"), "project.assets.json"),
            hasPackageReferences: true));
    }

    [Fact]
    public void ProjectsWithoutPackagesDoNotRequireAssets()
    {
        Assert.False(RoslynProjectWorkspace.RequiresRestore(
            projectAssetsFile: null,
            hasPackageReferences: false));
    }

    [Fact]
    public void FailedRestoreOutputsRequireRestoreEvenWhenAssetsExist()
    {
        var root = Path.Combine(Path.GetTempPath(), "winui-xaml-restore", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var assets = Path.Combine(root, "project.assets.json");
        File.WriteAllText(assets, AssetsJson());
        File.WriteAllText(
            Path.Combine(root, "project.nuget.cache"),
            """{"success":false,"logs":[]}""");

        try
        {
            Assert.True(RoslynProjectWorkspace.RequiresRestore(
                assets, hasPackageReferences: true));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void AssetsWithRestoreErrorsRequireRestore()
    {
        var root = Path.Combine(Path.GetTempPath(), "winui-xaml-restore", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var assets = Path.Combine(root, "project.assets.json");
        File.WriteAllText(
            assets,
            AssetsJson(logs: """[{"code":"NU1301","level":"Error","message":"Feed unavailable"}]"""));

        try
        {
            Assert.True(RoslynProjectWorkspace.RequiresRestore(
                assets, hasPackageReferences: true));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void SuccessfulRestoreOutputsDoNotRequireRestore()
    {
        var root = Path.Combine(Path.GetTempPath(), "winui-xaml-restore", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var assets = Path.Combine(root, "project.assets.json");
        File.WriteAllText(assets, AssetsJson());
        File.WriteAllText(
            Path.Combine(root, "project.nuget.cache"),
            """{"success":true,"logs":[]}""");

        try
        {
            Assert.False(RoslynProjectWorkspace.RequiresRestore(
                assets, hasPackageReferences: true));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void MalformedRestoreOutputsRequireRestore()
    {
        var root = Path.Combine(Path.GetTempPath(), "winui-xaml-restore", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var assets = Path.Combine(root, "project.assets.json");
        File.WriteAllText(assets, "{");

        try
        {
            Assert.True(RoslynProjectWorkspace.RequiresRestore(
                assets, hasPackageReferences: true));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void MalformedRestoreCacheRequiresRestore()
    {
        var root = Path.Combine(Path.GetTempPath(), "winui-xaml-restore", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var assets = Path.Combine(root, "project.assets.json");
        File.WriteAllText(assets, AssetsJson());
        File.WriteAllText(Path.Combine(root, "project.nuget.cache"), "{}");

        try
        {
            Assert.True(RoslynProjectWorkspace.RequiresRestore(
                assets, hasPackageReferences: true));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Theory]
    [InlineData("error NETSDK1004: Assets file was not found")]
    [InlineData("error NETSDK1005: Assets file doesn't have a target")]
    [InlineData("The file obj\\project.assets.json was not found")]
    public void MissingRestoreFailuresAreRecognized(string message)
    {
        Assert.True(RoslynProjectWorkspace.IsMissingRestoreFailure(message));
    }

    [Fact]
    public void UnrelatedBuildFailuresAreNotRestoreFailures()
    {
        Assert.False(RoslynProjectWorkspace.IsMissingRestoreFailure("error CS1002: ; expected"));
    }

    private static string AssetsJson(string logs = "[]") =>
        $$"""{"version":3,"targets":{},"libraries":{},"project":{},"logs":{{logs}}}""";
}
