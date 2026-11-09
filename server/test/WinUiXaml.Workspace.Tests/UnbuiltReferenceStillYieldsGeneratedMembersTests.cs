using System.Text.RegularExpressions;
using System.Diagnostics;
using Microsoft.CodeAnalysis;
using Xunit;

namespace WinUiXaml.Workspace.Tests;

/// <summary>Exercises real WinUI markup generation with isolated outputs and a shared, initially unbuilt reference.</summary>
public sealed class UnbuiltReferenceStillYieldsGeneratedMembersTests : IDisposable
{
    private readonly string _root =
        Path.Combine(Path.GetTempPath(), "giprobe" + Guid.NewGuid().ToString("N"));

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    public async Task AProjectWhoseReferenceWasNeverBuiltStillGetsItsXamlGeneratedMembers(
        bool sharedReference, bool brokenMarkup)
    {
        var fixtureProject = GetWinUiFixturePath("SmokeFixture.csproj");
        var fixtureText = await File.ReadAllTextAsync(fixtureProject);
        var tfm = Match(fixtureText, @"<TargetFramework>([^<]+)<", "TargetFramework");
        var sdkBuildTools = PackageVersion(fixtureText, "Microsoft.Windows.SDK.BuildTools");
        var appSdk = PackageVersion(fixtureText, "Microsoft.WindowsAppSDK");

        var appDir = Path.Combine(_root, "App");
        var libDir = Path.Combine(_root, "Lib");
        Directory.CreateDirectory(appDir);
        Directory.CreateDirectory(libDir);

        await File.WriteAllTextAsync(Path.Combine(libDir, "Lib.csproj"), $"""
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>{tfm}</TargetFramework>
                <TargetPlatformMinVersion>10.0.17763.0</TargetPlatformMinVersion>
                <IntermediateOutputPath>obj\user\</IntermediateOutputPath>
                <OutputPath>bin\user\</OutputPath>
                <OutDir>bin\user-out\</OutDir>
              </PropertyGroup>
            </Project>
            """);
        await File.WriteAllTextAsync(
            Path.Combine(libDir, "Greeter.cs"),
            "namespace Lib;\npublic class Greeter { public string Text => \"hi\"; }\n");

        var appProject = Path.Combine(appDir, "GeneratedMembers.csproj");
        await File.WriteAllTextAsync(appProject, $"""
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <OutputType>WinExe</OutputType>
                <TargetFramework>{tfm}</TargetFramework>
                <TargetPlatformMinVersion>10.0.17763.0</TargetPlatformMinVersion>
                <RootNamespace>GenApp</RootNamespace>
                <UseWinUI>true</UseWinUI>
                <WinUISDKReferences>false</WinUISDKReferences>
                <EnableMsixTooling>false</EnableMsixTooling>
                <Platforms>x64;ARM64</Platforms>
                <RuntimeIdentifiers>win-x64;win-arm64</RuntimeIdentifiers>
                <ImplicitUsings>enable</ImplicitUsings>
                <IntermediateOutputPath>obj\user\</IntermediateOutputPath>
                <OutputPath>bin\user\</OutputPath>
                <OutDir>bin\user-out\</OutDir>
              </PropertyGroup>
              <ItemGroup>
                <PackageReference Include="Microsoft.Windows.SDK.BuildTools" Version="{sdkBuildTools}" />
                <PackageReference Include="Microsoft.WindowsAppSDK" Version="{appSdk}" />
              </ItemGroup>
              <ItemGroup>
                <ProjectReference Include="..\Lib\Lib.csproj" />
              </ItemGroup>
            </Project>
            """);

        await File.WriteAllTextAsync(Path.Combine(appDir, "App.xaml"), """
            <Application
                x:Class="GenApp.App"
                xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
                xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
            </Application>
            """);
        await File.WriteAllTextAsync(
            Path.Combine(appDir, "App.xaml.cs"),
            "namespace GenApp;\npublic partial class App : Microsoft.UI.Xaml.Application { public App() { InitializeComponent(); } }\n");

        await File.WriteAllTextAsync(Path.Combine(appDir, "GenPage.xaml"), """
            <Page
                x:Class="GenApp.GenPage"
                xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
                xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
                <TextBlock x:Name="NamedFromXaml" Text="Hello" />
            </Page>
            """);
        await File.WriteAllTextAsync(
            Path.Combine(appDir, "GenPage.xaml.cs"),
            "namespace GenApp;\npublic partial class GenPage : Microsoft.UI.Xaml.Controls.Page { public string Title => \"Hello\"; public GenPage() { InitializeComponent(); } }\n");

        if (brokenMarkup)
        {
            await File.WriteAllTextAsync(Path.Combine(appDir, "Broken.xaml"), """
                <Page xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation">
                    <Buton/>
                </Page>
                """);
        }

        var projects = new List<string> { appProject };
        if (sharedReference)
        {
            var secondApp = Path.Combine(_root, "AppB");
            Directory.CreateDirectory(secondApp);
            foreach (var file in Directory.EnumerateFiles(appDir))
            {
                File.Copy(file, Path.Combine(secondApp, Path.GetFileName(file)));
            }
            projects.Add(Path.Combine(secondApp, Path.GetFileName(appProject)));
        }

        foreach (var project in projects)
        {
            FixtureRestore.Run(project);
        }
        Assert.False(Directory.Exists(Path.Combine(libDir, "bin")));

        Dictionary<string, DateTime>? userFiles = null;
        if (sharedReference)
        {
            var start = new ProcessStartInfo(MsBuildCli.DotnetPath!)
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            foreach (var argument in new[] { "build", Path.Combine(libDir, "Lib.csproj"), "--no-restore", "--nologo" })
            {
                start.ArgumentList.Add(argument);
            }
            using var build = Process.Start(start)!;
            var output = build.StandardOutput.ReadToEndAsync();
            var error = build.StandardError.ReadToEndAsync();
            await build.WaitForExitAsync();
            Assert.True(build.ExitCode == 0, await output + await error);
            userFiles = Directory.EnumerateFiles(libDir, "*", SearchOption.AllDirectories)
                .ToDictionary(path => path, File.GetLastWriteTimeUtc);
        }
        using var userOutputLock = sharedReference
            ? new FileStream(Path.Combine(libDir, "bin", "user-out", "Lib.dll"), FileMode.Open, FileAccess.Read, FileShare.Read)
            : null;
        var workspaces = await Task.WhenAll(projects.Select(project =>
            RoslynProjectWorkspace.LoadProjectAsync(project)));
        foreach (var workspace in workspaces)
        {
            using var owned = workspace;
            var compilation = await workspace.GetCompilationAsync();
            Assert.NotNull(compilation);
            var page = compilation.GetTypeByMetadataName("GenApp.GenPage");
            Assert.NotNull(page);
            Assert.Single(page.GetMembers("Title"));
            Assert.Empty(workspace.UnresolvedProjectReferences);
            Assert.Contains(Path.Combine(appDir, "GenPage.xaml"), workspaces[0].XamlFiles);

            if (!brokenMarkup)
            {
                Assert.NotEmpty(page.GetMembers("InitializeComponent"));
                var named = Assert.Single(page.GetMembers("NamedFromXaml"));
                Assert.Equal(
                    "Microsoft.UI.Xaml.Controls.TextBlock",
                    (named as IFieldSymbol)?.Type.ToDisplayString());
                Assert.All(page.GetMembers("InitializeComponent").SelectMany(member => member.DeclaringSyntaxReferences),
                    syntax => Assert.False(syntax.SyntaxTree.FilePath.StartsWith(appDir, StringComparison.OrdinalIgnoreCase)));
            }
            Assert.NotNull(compilation.GetTypeByMetadataName("Lib.Greeter"));
            if (brokenMarkup)
            {
                Assert.False(workspace.InputsChanged());
                await File.WriteAllTextAsync(Path.Combine(appDir, "Broken.xaml"),
                    """<Page xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"><Button/></Page>""");
                Assert.True(workspace.InputsChanged());
                using var repaired = await RoslynProjectWorkspace.LoadProjectAsync(appProject);
                var repairedCompilation = await repaired.GetCompilationAsync();
                Assert.NotEmpty(repairedCompilation!.GetTypeByMetadataName("GenApp.GenPage")!.GetMembers("InitializeComponent"));
            }
        }
        if (userFiles is not null)
        {
            Assert.Equal(userFiles.Keys.Order(), Directory.EnumerateFiles(libDir, "*", SearchOption.AllDirectories).Order());
            Assert.All(userFiles, file => Assert.Equal(file.Value, File.GetLastWriteTimeUtc(file.Key)));
        }
        else
        {
            Assert.False(Directory.Exists(Path.Combine(libDir, "bin")));
            Assert.False(Directory.Exists(Path.Combine(libDir, "obj", "user")));
        }
        Assert.False(File.Exists(Path.Combine(appDir, "obj", "Debug", tfm, "input.json")));
        Assert.False(Directory.Exists(Path.Combine(appDir, "obj", "user")));
        Assert.False(Directory.Exists(Path.Combine(appDir, "bin")));
    }

    private static string PackageVersion(string projectText, string id) =>
        Match(projectText, $"Include=\"{Regex.Escape(id)}\"\\s+Version=\"([^\"]+)\"", id);

    private static string Match(string text, string pattern, string what)
    {
        var match = Regex.Match(text, pattern, RegexOptions.IgnoreCase);
        Assert.True(match.Success, $"could not read {what} from the checked-in fixture");
        return match.Groups[1].Value;
    }

    private static string GetWinUiFixturePath(string fileName) =>
        Path.GetFullPath(Path.Combine(
            AppContext.BaseDirectory,
            "..", "..", "..", "..", "..", "..",
            "test", "fixtures", "xaml", "fixture", fileName));

    public void Dispose()
    {
        try
        {
            Directory.Delete(_root, recursive: true);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }
}
