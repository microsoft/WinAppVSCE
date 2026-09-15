using System.Diagnostics;
using Microsoft.CodeAnalysis;
using Xunit;

namespace WinUiXaml.Workspace.Tests;

/// <summary>
/// A project reference is supplied to the compilation twice: the csc command line names its
/// output assembly, and the graph adds a compilation built from its source. Two assemblies with
/// one identity means Roslyn picks a winner by its own unification order, so the on-disk copy has
/// to be removed rather than trusted to lose.
/// </summary>
public sealed class ProjectReferenceSupersedesBuiltOutputTests : IDisposable
{
    private readonly string _root =
        Path.Combine(Path.GetTempPath(), "p2pref" + Guid.NewGuid().ToString("N"));

    [Fact]
    public async Task ASourceEditWinsOverTheProjectsLastBuiltAssembly()
    {
        var lib = Path.Combine(_root, "Lib");
        var app = Path.Combine(_root, "App");
        Directory.CreateDirectory(lib);
        Directory.CreateDirectory(app);

        await File.WriteAllTextAsync(Path.Combine(lib, "Lib.csproj"), """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
            </Project>
            """);
        await File.WriteAllTextAsync(
            Path.Combine(lib, "Lib.cs"),
            "namespace Lib; public class Greeter { public string Built => \"a\"; }");

        var appProject = Path.Combine(app, "App.csproj");
        await File.WriteAllTextAsync(appProject, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
              <ItemGroup><ProjectReference Include="..\Lib\Lib.csproj" /></ItemGroup>
            </Project>
            """);
        await File.WriteAllTextAsync(
            Path.Combine(app, "App.cs"), "namespace App; public class A { }");

        // The reference has to actually exist on disk: this is the ordinary built tree, not the
        // never-built tree the shadow repair covers.
        using (var build = Process.Start(new ProcessStartInfo("dotnet", "build -v:q --nologo")
        {
            WorkingDirectory = app,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        })!)
        {
            await build.WaitForExitAsync();
            Assert.Equal(0, build.ExitCode);
        }

        Assert.True(File.Exists(Path.Combine(lib, "bin", "Debug", "net10.0", "Lib.dll")));

        // Edit after the build, so the assembly on disk no longer describes the source.
        await File.WriteAllTextAsync(
            Path.Combine(lib, "Lib.cs"),
            "namespace Lib; public class Greeter { public string Built => \"a\"; public string Edited => \"b\"; }");

        using var workspace = await RoslynProjectWorkspace.LoadProjectAsync(appProject);
        var compilation = await workspace.GetCompilationAsync();
        Assert.NotNull(compilation);

        var libReferences = compilation!.References
            .Where(reference => reference switch
            {
                CompilationReference c => c.Compilation.AssemblyName == "Lib",
                PortableExecutableReference pe =>
                    Path.GetFileNameWithoutExtension(pe.FilePath ?? "") == "Lib",
                _ => false,
            })
            .ToList();

        var single = Assert.Single(libReferences);
        Assert.IsAssignableFrom<CompilationReference>(single);

        var greeter = compilation.GetTypeByMetadataName("Lib.Greeter");
        Assert.NotNull(greeter);
        Assert.NotEmpty(greeter!.GetMembers("Edited"));
    }

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
