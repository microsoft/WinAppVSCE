using System;
using System.Collections.Generic;
using System.IO;
using WinUiXaml.Workspace;
using Xunit;

namespace WinUiXaml.Workspace.Tests;

/// <summary>
/// The design-time build reaches its own targets through the <c>CustomAfterMicrosoftCSharpTargets</c>
/// hook, passed as an MSBuild *global* property. A global property cannot be overridden by the
/// project that declares it, so a project using that same hook -- the documented way for a repo to
/// inject its own targets, and how several SDKs and source generators ship -- had its value
/// silently discarded for the whole design-time build.
///
/// The symptom is not an error. The project loads, compiles and resolves, but without whatever the
/// user's targets contributed: generated sources go missing, added <c>Compile</c> items never
/// appear, and the types they declare stop resolving in XAML with nothing to explain why. Only the
/// design-time build is affected, so a normal <c>dotnet build</c> of the same project works
/// perfectly -- which makes it look like the language server is wrong about the project rather than
/// about the hook.
///
/// The fix reads the user's value during the evaluation-only pass -- the only pass where the answer
/// is still theirs, because no global property has been set yet -- and re-imports it from our own
/// targets file. These tests pin both halves: that the value is recovered, and that it takes effect.
/// </summary>
public sealed class MsBuildUserTargetsTests
{
    /// <summary>
    /// The recovery step. Evaluation runs without the global property, so it still sees the
    /// project's own value; if this regresses there is nothing left to re-import and the
    /// end-to-end test below has no way to pass.
    /// </summary>
    [Fact]
    public void EvaluationRecoversTheProjectsOwnAfterTargetsHook()
    {
        WithProjectUsingTheHook((_, project, userTargets) =>
        {
            var evaluation = MsBuildCli.Evaluate(project, new Dictionary<string, string>());

            Assert.Equal(userTargets, evaluation.CustomAfterCSharpTargets);
        });
    }

    /// <summary>
    /// The end-to-end proof. The user's targets add a <c>Compile</c> item, so if they are dropped
    /// the source is simply absent from the compiler command line -- exactly the silent shape of
    /// the original defect. Asserting on the recovered property alone would pass even if the
    /// re-import were deleted.
    /// </summary>
    [Fact]
    public void TheProjectsOwnAfterTargetsStillRunInADesignTimeBuild()
    {
        WithProjectUsingTheHook((_, project, _) =>
        {
            FixtureRestore.Run(project);

            var result = MsBuildCli.EvaluateAndCompile(project, new Dictionary<string, string>());

            Assert.False(result.CscCommandLineArgs.IsDefaultOrEmpty);
            Assert.Contains(result.CscCommandLineArgs, argument =>
                argument.EndsWith("Injected.cs", StringComparison.OrdinalIgnoreCase));
        });
    }

    /// <summary>
    /// Writes a project that points <c>CustomAfterMicrosoftCSharpTargets</c> at a targets file
    /// contributing an extra source, runs <paramref name="body"/> against it, and cleans up.
    /// </summary>
    private static void WithProjectUsingTheHook(Action<string, string, string> body)
    {
        var directory = Path.Combine(
            Path.GetTempPath(), "winuixaml-usertargets-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var userTargets = Path.Combine(directory, "Injected.targets");
            File.WriteAllText(
                userTargets,
                """
                <Project>
                  <ItemGroup>
                    <Compile Include="Injected.cs" />
                  </ItemGroup>
                </Project>
                """);

            // Not included by the SDK's default globbing: the file the hook contributes has to be
            // one only the hook can supply, or the assertion passes without the hook running.
            File.WriteAllText(
                Path.Combine(directory, "Injected.cs"),
                "namespace Fixture { public sealed class Injected { } }");

            var project = Path.Combine(directory, "UserTargets.csproj");
            File.WriteAllText(
                project,
                """
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup>
                    <TargetFramework>net9.0</TargetFramework>
                    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
                    <CustomAfterMicrosoftCSharpTargets>$(MSBuildThisFileDirectory)Injected.targets</CustomAfterMicrosoftCSharpTargets>
                  </PropertyGroup>
                </Project>
                """);

            body(directory, project, userTargets);
        }
        finally
        {
            try
            {
                Directory.Delete(directory, recursive: true);
            }
            catch (IOException)
            {
                // A build server can still hold a handle under the fixture; the temp directory is
                // reclaimed by the OS either way, and failing cleanup must not fail the test.
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }
}
