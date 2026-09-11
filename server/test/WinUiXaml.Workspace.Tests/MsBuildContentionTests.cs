using System;
using System.IO;
using System.Text.RegularExpressions;
using WinUiXaml.Workspace;
using Xunit;

namespace WinUiXaml.Workspace.Tests;

/// <summary>
/// Two MSBuild invocations against one project race on that project's obj directory. The WinUI
/// markup compiler writes output.json from the Compile target chain, and a load runs two stages
/// against the same csproj: the fast framework resolve and the authoritative one. The in-process
/// BuildManager this replaced serialized them implicitly; shelling out to the SDK does not.
/// </summary>
public sealed class MsBuildContentionTests
{
    /// <summary>
    /// The two stages disagree about how they identify a project -- one passes the csproj path and
    /// a working directory, the other only a working directory. Keys derived from those two forms
    /// have to land on the same gate or the gate excludes nothing.
    /// </summary>
    [Fact]
    public void TheTwoStagesOfALoadShareOneGate()
    {
        var directory = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "winuixaml-gate-fixture"));
        Directory.CreateDirectory(directory);
        try
        {
            var project = Path.Combine(directory, "App.csproj");

            // EvaluateAndCompile: project path plus working directory.
            var compileStage = MsBuildCli.ProjectGateKey(project, directory);

            // Evaluate: working directory alone.
            var evaluateStage = MsBuildCli.ProjectGateKey(null, directory);

            Assert.Equal(compileStage, evaluateStage);
        }
        finally
        {
            TryDelete(directory);
        }
    }

    [Fact]
    public void UnrelatedProjectsDoNotShareAGate()
    {
        var root = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "winuixaml-gate-fixture-2"));
        var first = Path.Combine(root, "AppOne");
        var second = Path.Combine(root, "AppTwo");
        Directory.CreateDirectory(first);
        Directory.CreateDirectory(second);
        try
        {
            Assert.NotEqual(
                MsBuildCli.ProjectGateKey(Path.Combine(first, "AppOne.csproj"), first),
                MsBuildCli.ProjectGateKey(Path.Combine(second, "AppTwo.csproj"), second));
        }
        finally
        {
            TryDelete(root);
        }
    }

    /// <summary>
    /// Verbatim from a real failure. The gate only covers this process, so contention with a build
    /// running in a terminal or another extension still reaches the retry, and the retry only
    /// helps if this exact text is recognized.
    /// </summary>
    [Fact]
    public void TheRealWorldContentionFailureIsRecognized()
    {
        const string detail =
            "C:\\Users\\u\\.nuget\\packages\\microsoft.windowsappsdk.winui\\2.2.2-experimental\\" +
            "buildTransitive\\Microsoft.UI.Xaml.Markup.Compiler.interop.targets(470,9): error : " +
            "The process cannot access the file " +
            "'C:\\Users\\u\\ai-dev-gallery\\AIDevGallery\\obj\\ARM64\\Debug\\net9.0-windows10.0.26100.0\\" +
            "win-arm64\\output.json' because it is being used by another process. " +
            "[C:\\Users\\u\\ai-dev-gallery\\AIDevGallery\\AIDevGallery.csproj]";

        Assert.True(MsBuildCli.IsProjectFileInUseFailure(detail));
    }

    /// <summary>
    /// A retry is only correct for transient contention. Retrying a genuine build failure would
    /// quadruple the time a user waits to be told something they could have been told at once.
    /// </summary>
    [Theory]
    [InlineData("MSBuild exited with code 1. error CS1002: ; expected")]
    [InlineData("error MSB3073: The command exited with code 123.")]
    [InlineData("error NETSDK1004: Assets file project.assets.json not found.")]
    [InlineData(null)]
    public void UnrelatedFailuresAreNotRetried(string? detail)
    {
        Assert.False(MsBuildCli.IsProjectFileInUseFailure(detail));
    }

    /// <summary>
    /// The gate lives in the single private helper every invocation funnels through. A new caller
    /// that reaches the process launcher directly would bypass it silently, so the arrangement is
    /// pinned at the source rather than inferred: exactly one method may start the process, and
    /// the method that guards it must be the one that calls it.
    /// </summary>
    [Fact]
    public void EveryInvocationGoesThroughTheGate()
    {
        var source = File.ReadAllText(
            Path.Combine(WorkspaceSourceDirectory(), "MsBuildCli.cs"));

        // Only the gated wrapper may reach the process launcher.
        Assert.Equal(1, Regex.Matches(source, @"\bRunCore\(").Count - 1);
        Assert.Contains("gate.Wait(cancellationToken)", source);

        // And nothing may start a process outside the launcher itself.
        Assert.Equal(1, Regex.Matches(source, @"new Process\b").Count);
    }

    private static string WorkspaceSourceDirectory()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            var candidate = Path.Combine(
                directory.FullName, "server", "src", "WinUiXaml.Workspace");
            if (Directory.Exists(candidate))
            {
                return candidate;
            }

            directory = directory.Parent;
        }

        throw new InvalidOperationException(
            "Could not locate server/src/WinUiXaml.Workspace from " + AppContext.BaseDirectory);
    }

    private static void TryDelete(string directory)
    {
        try
        {
            if (Directory.Exists(directory))
            {
                Directory.Delete(directory, recursive: true);
            }
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }
}
