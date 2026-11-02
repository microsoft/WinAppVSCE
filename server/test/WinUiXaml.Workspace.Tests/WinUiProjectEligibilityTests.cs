using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Xml.Linq;
using WinUiXaml.Workspace;
using Xunit;

namespace WinUiXaml.Workspace.Tests;

public sealed class WinUiProjectEligibilityTests
{
    [Theory]
    [InlineData("true", "Windows", "Microsoft.WindowsAppSDK", false, true)]
    [InlineData("TRUE", "windows", "Microsoft.WindowsAppSDK.WinUI", false, true)]
    [InlineData("", "Windows", "Microsoft.WindowsAppSDK", false, false)]
    [InlineData("true", "", "Microsoft.WindowsAppSDK", false, false)]
    [InlineData("true", "Android", "Microsoft.WindowsAppSDK", false, false)]
    [InlineData("true", "Windows", "Uno.WinUI", false, false)]
    [InlineData("true", "Windows", "Microsoft.Maui.Controls", false, false)]
    [InlineData("true", "Windows", "Microsoft.WindowsAppSDK", true, false)]
    public void RequiresEveryPositiveSignal(string useWinUi, string platform, string package, bool implicitPackage, bool expected)
    {
        using var json = JsonDocument.Parse(JsonSerializer.Serialize(new
        {
            Properties = new { UseWinUI = useWinUi, TargetPlatformIdentifier = platform },
            Items = new { PackageReference = new[] { new { Identity = package, IsImplicitlyDefined = implicitPackage.ToString() } } },
        }));
        Assert.Equal(expected, MsBuildCli.IsWinUiEvaluation(json.RootElement));
    }

    [Theory]
    [InlineData("<Project Sdk='Microsoft.NET.Sdk'/>", true)]
    [InlineData("<Project Sdk='Microsoft.NET.Sdk.WindowsDesktop'/>", true)]
    [InlineData("<Project><Sdk Name='Microsoft.NET.Sdk'/></Project>", true)]
    [InlineData("<Project><Import Project='Sdk.props' Sdk='Microsoft.NET.Sdk'/><Import Project='Sdk.targets' Sdk='Microsoft.NET.Sdk'/></Project>", true)]
    [InlineData("<Project Sdk='Uno.Sdk'/>", false)]
    [InlineData("<Project Sdk='Future.Xaml.Sdk'/>", false)]
    [InlineData("<Project Sdk='Microsoft.NET.Sdk;Future.Xaml.Sdk'/>", false)]
    [InlineData("<Project/>", false)]
    public void OnlyKnownProjectSdkShapesQualify(string xml, bool expected) =>
        Assert.Equal(expected, WinUiProjectEligibility.HasSupportedSdk(XElement.Parse(xml)));

    [Fact]
    public async Task EvaluatesImportsAndSelectedFrameworkWithoutRestoreOrBuildAndInvalidatesEligibility()
    {
        var root = Path.Combine(Path.GetTempPath(), "winui-eligibility-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var project = Path.Combine(root, "Example.csproj");
            File.WriteAllText(project, """
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup><TargetFrameworks>net10.0;net10.0-windows</TargetFrameworks></PropertyGroup>
                  <ItemGroup Condition="'$(TargetFramework)' == 'net10.0-windows'">
                    <PackageReference Include="Microsoft.WindowsAppSDK"/>
                  </ItemGroup>
                  <Target Name="UnexpectedBuild" BeforeTargets="Restore;ResolveReferences;CoreCompile">
                    <Error Text="Eligibility must not run targets"/>
                  </Target>
                </Project>
                """);
            var imported = Path.Combine(root, "Directory.Build.props");
            File.WriteAllText(imported, "<Project><PropertyGroup><UseWinUI>true</UseWinUI></PropertyGroup></Project>");
            using var resolver = new XamlProjectResolver();
            Assert.True(await resolver.IsSupportedProjectAsync(project));
            Assert.False(File.Exists(Path.Combine(root, "obj", "project.assets.json")));
            File.WriteAllText(imported, "<Project/>");
            resolver.InvalidateAll();
            Assert.False(await resolver.IsSupportedProjectAsync(project));
            File.WriteAllText(imported, "<Project><PropertyGroup><UseWinUI>true</UseWinUI></PropertyGroup></Project>");
            resolver.Invalidate(project);
            Assert.True(await resolver.IsSupportedProjectAsync(project));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void UnknownSdkIsRejectedWithoutResolvingOrExecutingIt()
    {
        var root = Path.Combine(Path.GetTempPath(), "winui-unknown-sdk-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var project = Path.Combine(root, "Example.csproj");
            File.WriteAllText(project, """
                <Project Sdk="Example.Unknown.Xaml.Sdk/1.0.0">
                  <PropertyGroup><UseWinUI>true</UseWinUI></PropertyGroup>
                  <ItemGroup><PackageReference Include="Microsoft.WindowsAppSDK"/></ItemGroup>
                </Project>
                """);
            Assert.False(WinUiProjectEligibility.Evaluate(project, new Dictionary<string, string>(), CancellationToken.None));
            Assert.Empty(Directory.GetDirectories(root));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
