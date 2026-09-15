using System.Diagnostics;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Xunit;

namespace WinUiXaml.Workspace.Tests;

/// <summary>
/// Pins the payoff of the reference repair, which nothing else asserts.
/// </summary>
/// <remarks>
/// The repair exists so a never-built <c>ProjectReference</c> still lets the XAML markup compiler
/// run, and the markup compiler is what writes <c>.g.i.cs</c> -- <c>InitializeComponent</c> and one
/// field per <c>x:Name</c>. Every other test around this covers either the failure string or the
/// reported status, so the whole mechanism could be removed and they would all still pass while
/// the feature it was built for silently disappeared. This asserts the generated members
/// themselves, on a project whose reference is genuinely absent from disk.
/// </remarks>
public sealed class UnbuiltReferenceStillYieldsGeneratedMembersTests : IDisposable
{
    private readonly string _root =
        Path.Combine(Path.GetTempPath(), "giprobe" + Guid.NewGuid().ToString("N"));

    [Fact]
    public async Task AProjectWhoseReferenceWasNeverBuiltStillGetsItsXamlGeneratedMembers()
    {
        // Package versions come from the checked-in fixture: a version this machine has never
        // restored would send the test to the network, and that failure would read like a project
        // that simply did not resolve.
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
            "namespace GenApp;\npublic partial class GenPage : Microsoft.UI.Xaml.Controls.Page { public GenPage() { InitializeComponent(); } }\n");

        // Restore only. `dotnet restore` does not build project references, so Lib.dll stays
        // absent -- which is the whole point of the fixture.
        using (var restore = Process.Start(new ProcessStartInfo("dotnet", $"restore \"{appProject}\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        })!)
        {
            await restore.WaitForExitAsync();
            Assert.Equal(0, restore.ExitCode);
        }

        Assert.False(
            Directory.Exists(Path.Combine(libDir, "bin")),
            "the referenced project must be unbuilt for this test to mean anything");

        using var workspace = await RoslynProjectWorkspace.LoadProjectAsync(appProject);
        var compilation = await workspace.GetCompilationAsync();
        Assert.NotNull(compilation);

        var page = compilation!.GetTypeByMetadataName("GenApp.GenPage");
        Assert.NotNull(page);

        // Both of these come only from the markup compiler's .g.i.cs. Without the repair the
        // markup compiler aborts on the missing Lib.dll and neither exists.
        Assert.NotEmpty(page!.GetMembers("InitializeComponent"));
        var named = Assert.Single(page.GetMembers("NamedFromXaml"));
        Assert.Equal(
            "Microsoft.UI.Xaml.Controls.TextBlock",
            (named as IFieldSymbol)?.Type.ToDisplayString());

        // The referenced project's own types still resolve from source, which is the separate
        // guarantee the project-reference graph provides.
        Assert.NotNull(compilation.GetTypeByMetadataName("Lib.Greeter"));
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
