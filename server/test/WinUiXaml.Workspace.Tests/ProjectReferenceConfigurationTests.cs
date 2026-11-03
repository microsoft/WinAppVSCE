using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;
using WinUiXaml.Workspace;
using Xunit;

namespace WinUiXaml.Workspace.Tests;

public sealed class ProjectReferenceConfigurationTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ReferencesUseTheFrameworkSelectedByTheConsumer(bool diamond)
    {
        var root = Path.Combine(Path.GetTempPath(), "winui-reference-config-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            string WriteProject(string name, string framework, string references, string source)
            {
                var directory = Path.Combine(root, name);
                Directory.CreateDirectory(directory);
                var project = Path.Combine(directory, name + ".csproj");
                var property = framework.Contains(';') ? "TargetFrameworks" : "TargetFramework";
                File.WriteAllText(project, $"""
                    <Project Sdk="Microsoft.NET.Sdk">
                      <PropertyGroup><{property}>{framework}</{property}><NuGetAudit>false</NuGetAudit></PropertyGroup>
                      <ItemGroup>{references}</ItemGroup>
                    </Project>
                    """);
                File.WriteAllText(Path.Combine(directory, "Source.cs"), source);
                return project;
            }
            const string shared = """
                public class ViewModel {
                #if NET9_0
                  public string Name => "net9";
                #else
                  public string Other => "net10";
                #endif
                }
                """;
            WriteProject("Shared", "net9.0;net10.0", "", shared);
            const string reference = """<ProjectReference Include="..\Shared\Shared.csproj" />""";
            var low = WriteProject("Low", "net9.0", reference, "public class Low { public string Value => new ViewModel().Name; }");
            string project = low;
            if (diamond)
            {
                WriteProject("High", "net10.0", reference, "public class High { public string Value => new ViewModel().Other; }");
                project = WriteProject("Root", "net10.0",
                    """<ProjectReference Include="..\Low\Low.csproj" /><ProjectReference Include="..\High\High.csproj" />""",
                    "public class Root { }");
            }
            using var build = Process.Start(new ProcessStartInfo(MsBuildCli.DotnetPath!)
            {
                ArgumentList = { "build", project, "--nologo", "-v:q", "-nr:false", "-p:NuGetAudit=false" },
                RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false,
            })!;
            var stdout = build.StandardOutput.ReadToEndAsync();
            var stderr = build.StandardError.ReadToEndAsync();
            await build.WaitForExitAsync().WaitAsync(TimeSpan.FromMinutes(3));
            Assert.True(build.ExitCode == 0, await stdout + await stderr);

            using var workspace = await RoslynProjectWorkspace.LoadProjectAsync(project);
            var compilation = workspace.Compilation;
            var lowCompilation = diamond
                ? compilation.References.OfType<CompilationReference>().Single(r => r.Compilation.AssemblyName == "Low").Compilation
                : compilation;
            Assert.Empty(lowCompilation.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error));
            var lowShared = lowCompilation.References.OfType<CompilationReference>().Single(r => r.Compilation.AssemblyName == "Shared").Compilation;
            Assert.Single(lowShared.GetTypeByMetadataName("ViewModel")!.GetMembers("Name"));
            Assert.Empty(lowShared.GetTypeByMetadataName("ViewModel")!.GetMembers("Other"));
            if (diamond)
            {
                var highCompilation = compilation.References.OfType<CompilationReference>().Single(r => r.Compilation.AssemblyName == "High").Compilation;
                Assert.Empty(highCompilation.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error));
                var highShared = highCompilation.References.OfType<CompilationReference>().Single(r => r.Compilation.AssemblyName == "Shared").Compilation;
                Assert.Single(highShared.GetTypeByMetadataName("ViewModel")!.GetMembers("Other"));
                Assert.NotSame(lowShared, highShared);
            }
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ReferencePropertiesMatchMSBuildTaskPrecedence()
    {
        using var json = JsonDocument.Parse("""
            { "Items": { "_MSBuildProjectReferenceExistent": [
              { "Identity": "Additional.csproj", "SetTargetFramework": "TargetFramework=net10.0",
                "SetConfiguration": "Configuration=Debug", "AdditionalProperties": "Configuration=Release;TargetFramework=net9.0" },
              { "Identity": "Replacement.csproj", "Properties": "Configuration=Custom;TargetFramework=net9.0",
                "SetConfiguration": "Configuration=Debug", "SetPlatform": "Platform=x64",
                "SetTargetFramework": "TargetFramework=net10.0", "AdditionalProperties": "Configuration=Release" }
            ] } }
            """);
        var edges = MsBuildCli.ReadResolvedProjectReferences(json.RootElement, Path.GetTempPath(),
            new Dictionary<string, string> { ["Platform"] = "ARM64", ["Feature"] = "Inherited" });
        Assert.Equal(2, edges.Length);
        foreach (var edge in edges)
        {
            Assert.Equal("Release", edge.Properties["Configuration"]);
            Assert.Equal("net9.0", edge.Properties["TargetFramework"]);
            Assert.Equal("ARM64", edge.Properties["Platform"]);
            Assert.Equal("Inherited", edge.Properties["Feature"]);
        }
    }

    [Fact]
    public void ReferencePropertiesRespectOverridesRemovalsAndNonAssemblyEdges()
    {
        using var json = JsonDocument.Parse("""
            { "Items": { "_MSBuildProjectReferenceExistent": [
              { "Identity": "Lib.csproj", "SetTargetFramework": "TargetFramework=net9.0",
                "SetPlatform": "Platform=AnyCPU", "AdditionalProperties": "Feature=One%3BTwo",
                "UndefineProperties": "RuntimeIdentifier;SelfContained", "Aliases": "LibAlias" },
              { "Identity": "BuildOnly.csproj", "ReferenceOutputAssembly": "false" },
              { "Identity": "Unknown.csproj" }
            ] } }
            """);
        var edges = MsBuildCli.ReadResolvedProjectReferences(json.RootElement, Path.GetTempPath(),
            new Dictionary<string, string> { ["Platform"] = "ARM64", ["RuntimeIdentifier"] = "win-arm64" });
        var edge = Assert.Single(edges);
        Assert.Equal("net9.0", edge.Properties["TargetFramework"]);
        Assert.Equal("AnyCPU", edge.Properties["Platform"]);
        Assert.Equal("One;Two", edge.Properties["Feature"]);
        Assert.False(edge.Properties.ContainsKey("RuntimeIdentifier"));
        Assert.Equal("LibAlias", Assert.Single(edge.Aliases));
        Assert.NotEqual(
            MsBuildCli.ConfigurationKey(edge.Path, edge.Properties),
            MsBuildCli.ConfigurationKey(edge.Path, edge.Properties.SetItem("TargetFramework", "net10.0")));
    }
}
