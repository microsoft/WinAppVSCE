using WinUiXaml.Workspace;

namespace WinUiXaml.Workspace.Tests;

/// <summary>
/// A peer report raised the possibility that opening the app folder rather than the solution root
/// -- which puts a referenced sibling project outside the allowed root -- silently yields a
/// successful but empty project context. That would be a total outage the server never reports,
/// which is the exact failure mode the build-required prompt exists to eliminate, so it is worth a
/// standing test rather than a source reading.
///
/// The allowed root is a trust boundary on which documents the server will touch, and it bounds the
/// upward walk that finds the owning project. It deliberately does not bound MSBuild evaluation of
/// that project: a reference is part of the project the user already trusted us to load.
/// </summary>
public sealed class OutOfRootProjectReferenceTests
{
    [Fact]
    public async Task AReferenceOutsideTheAllowedRootIsStillEvaluated()
    {
        // Layout: <temp>/App (the allowed root, what the user opened) and <temp>/Lib (a sibling,
        // outside it). Only App is trusted; Lib is reachable solely through the ProjectReference.
        var solutionRoot = Path.Combine(
            Path.GetTempPath(), "winui-xaml-outofroot", Guid.NewGuid().ToString("N"));
        var appDir = Path.Combine(solutionRoot, "App");
        var libDir = Path.Combine(solutionRoot, "Lib");
        Directory.CreateDirectory(appDir);
        Directory.CreateDirectory(libDir);

        var libProject = Path.Combine(libDir, "Lib.csproj");
        File.WriteAllText(
            libProject,
            """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
            </Project>
            """);
        File.WriteAllText(
            Path.Combine(libDir, "Widget.cs"),
            "namespace Lib; public sealed class Widget { }");

        var appProject = Path.Combine(appDir, "App.csproj");
        File.WriteAllText(
            appProject,
            $"""
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
              <ItemGroup><ProjectReference Include="{libProject}" /></ItemGroup>
            </Project>
            """);

        var xamlPath = Path.Combine(appDir, "MainWindow.xaml");
        var xamlText =
            """
            <Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
                    xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
            </Window>
            """;
        File.WriteAllText(xamlPath, xamlText);

        FixtureRestore.Run(appProject);

        try
        {
            var resolver = new XamlProjectResolver();

            // searchRoot is the app folder: the sibling is outside it by construction.
            var resolution = await resolver.ResolveFrameworkAsync(
                xamlPath, searchRoot: appDir, xamlText: xamlText);

            // The owning project must still be found -- it lives inside the root.
            Assert.NotNull(resolution);
            Assert.Equal(appProject, resolution!.ProjectPath, ignoreCase: true);

            // The load that matters: the out-of-root reference has to show up somewhere. Either it
            // resolved (its output is on the reference list) or it was reported unresolved. What
            // must not happen is silence -- a context that looks healthy and simply omits it.
            var sawReference =
                resolution.UnresolvedProjectReferences.Contains(
                    "Lib", StringComparer.OrdinalIgnoreCase)
                || resolution.ReferencedAssemblies.Any(
                    assembly => assembly.Name.Equals("Lib", StringComparison.OrdinalIgnoreCase));

            Assert.True(
                sawReference,
                "The project reference outside the allowed root was neither resolved nor reported "
                    + "unresolved, so the context is silently incomplete. References: "
                    + string.Join(", ", resolution.ReferencedAssemblies.Select(a => a.Name)));
        }
        finally
        {
            TryDelete(solutionRoot);
        }
    }

    [Fact]
    public void TheAllowedRootStillBoundsWhichProjectCanOwnADocument()
    {
        // The negative direction, so the test above cannot be read as "allowed roots do nothing".
        // A document above the root has no owning project as far as the server is concerned.
        var solutionRoot = Path.Combine(
            Path.GetTempPath(), "winui-xaml-outofroot", Guid.NewGuid().ToString("N"));
        var appDir = Path.Combine(solutionRoot, "App");
        Directory.CreateDirectory(appDir);
        File.WriteAllText(
            Path.Combine(solutionRoot, "Outside.csproj"),
            """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
            </Project>
            """);
        var strayXaml = Path.Combine(solutionRoot, "Stray.xaml");
        File.WriteAllText(strayXaml, "<Page />");

        try
        {
            Assert.Null(XamlProjectResolver.FindOwningProject(strayXaml, appDir));

            // ... and the same document resolves once the root actually contains it, so the null
            // above is the boundary talking and not a broken fixture.
            Assert.Equal(
                Path.Combine(solutionRoot, "Outside.csproj"),
                XamlProjectResolver.FindOwningProject(strayXaml, solutionRoot));
        }
        finally
        {
            TryDelete(solutionRoot);
        }
    }

    /// <summary>
    /// Cleanup must never be able to fail the test that already finished. MSBuild can still hold a
    /// handle on the reference output it just built, and on Windows that surfaces as an
    /// access-denied delete -- most likely under the parallel load of a full suite run, which is
    /// exactly when a spurious failure is hardest to attribute. A throw here would also mask the
    /// real assertion result, so a leaked temp directory is strictly the better outcome.
    /// </summary>
    private static void TryDelete(string directory)
    {
        for (var attempt = 0; attempt < 3; attempt++)
        {
            try
            {
                Directory.Delete(directory, recursive: true);
                return;
            }
            catch (IOException)
            {
                Thread.Sleep(100);
            }
            catch (UnauthorizedAccessException)
            {
                Thread.Sleep(100);
            }
        }
    }
}
