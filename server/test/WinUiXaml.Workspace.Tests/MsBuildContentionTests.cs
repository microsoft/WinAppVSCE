using System;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
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
        var directory = Path.GetFullPath(Path.Combine(
            Path.GetTempPath(), "winuixaml-gate-fixture-" + Guid.NewGuid().ToString("N")));
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
        var root = Path.GetFullPath(Path.Combine(
            Path.GetTempPath(), "winuixaml-gate-fixture-" + Guid.NewGuid().ToString("N")));
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
        Assert.Single(Regex.Matches(source, @"new Process\b"));
    }

    /// <summary>
    /// The gate serializes invocations against one project; this flag bounds the processes a
    /// single invocation is allowed to spawn. Both are needed, and only this one is invisible
    /// when it regresses: a build without it still produces correct IntelliSense, so no
    /// behavioural test fails. What changes is cost. A design-time build now builds the project
    /// references it is given, so a multi-node build fans each call out to worker processes that
    /// MSBUILDDISABLENODEREUSE=1 forbids recycling; with several projects loading at once the
    /// suite went from roughly 43 seconds to 15m50s, deterministically. That is a performance
    /// cliff a reviewer would read straight past, so the flag is pinned here at the source.
    /// </summary>
    [Fact]
    public void EveryInvocationIsLimitedToOneNode()
    {
        var source = File.ReadAllText(
            Path.Combine(WorkspaceSourceDirectory(), "MsBuildCli.cs"));

        // Exactly one node, set exactly once, and never to any other value.
        Assert.Single(Regex.Matches(source, @"-maxcpucount"));
        Assert.Contains("startInfo.ArgumentList.Add(\"-maxcpucount:1\");", source);

        // It must be part of the launcher's own setup rather than something a caller passes in,
        // because a caller that forgot would silently reintroduce the fan-out.
        var flag = source.IndexOf("-maxcpucount:1", StringComparison.Ordinal);
        var launcher = Regex.Match(source, @"new Process\b").Index;
        Assert.True(flag < launcher, "the node limit must be applied before the process is created");
    }

    /// <summary>
    /// The property the gate exists for, measured rather than inferred: invocations that would
    /// write the same obj directory never overlap. The source-harvest test above proves the gate
    /// is wired in; this proves it actually excludes.
    /// </summary>
    [Fact]
    public void InvocationsAgainstOneProjectNeverOverlap()
    {
        var directory = Path.Combine(
            Path.GetTempPath(), "winuixaml-gate-exclusion-" + Guid.NewGuid().ToString("N"));
        var project = Path.Combine(directory, "App.csproj");

        var active = 0;
        var peak = 0;
        var entered = 0;

        Parallel.For(0, 8, index =>
        {
            // Half arrive as EvaluateAndCompile does and half as Evaluate does, because the two
            // forms have to land on the same gate for any of this to hold.
            var path = index % 2 == 0 ? project : null;
            MsBuildCli.RunGated(path, directory, CancellationToken.None, () =>
            {
                var current = Interlocked.Increment(ref active);
                Interlocked.Increment(ref entered);
                InterlockedMax(ref peak, current);
                Thread.Sleep(25);
                Interlocked.Decrement(ref active);
                return 0;
            });
        });

        Assert.Equal(8, entered);
        Assert.Equal(1, peak);
    }

    /// <summary>
    /// The other half of the contract. A gate that serialized every project would turn a solution
    /// load into a queue, and the exclusion test above would pass just as happily -- so the
    /// negative has to be measured too. Each side refuses to finish until it has seen the other
    /// inside, which cannot happen if they share a gate.
    /// </summary>
    [Fact]
    public async Task UnrelatedProjectsStillLoadInParallel()
    {
        var root = Path.Combine(
            Path.GetTempPath(), "winuixaml-gate-parallel-" + Guid.NewGuid().ToString("N"));
        var first = Path.Combine(root, "AppOne");
        var second = Path.Combine(root, "AppTwo");

        using var firstInside = new ManualResetEventSlim(false);
        using var secondInside = new ManualResetEventSlim(false);

        // Each side gives up waiting rather than hanging, so a shared gate fails the assertion
        // instead of stalling the suite.
        var timeout = TimeSpan.FromSeconds(10);

        var firstSawSecond = Task.Run(() => MsBuildCli.RunGated(
            Path.Combine(first, "AppOne.csproj"), first, CancellationToken.None, () =>
            {
                firstInside.Set();
                return secondInside.Wait(timeout);
            }));

        var secondSawFirst = Task.Run(() => MsBuildCli.RunGated(
            Path.Combine(second, "AppTwo.csproj"), second, CancellationToken.None, () =>
            {
                secondInside.Set();
                return firstInside.Wait(timeout);
            }));

        var results = await Task.WhenAll(firstSawSecond, secondSawFirst);

        Assert.True(results[0]);
        Assert.True(results[1]);
    }

    /// <summary>
    /// A body that throws must not strand the gate; the next invocation for that project would
    /// block forever, which presents as the language server hanging rather than failing.
    /// </summary>
    [Fact]
    public async Task AFailedInvocationReleasesTheGate()
    {
        var directory = Path.Combine(
            Path.GetTempPath(), "winuixaml-gate-release-" + Guid.NewGuid().ToString("N"));

        Assert.Throws<InvalidOperationException>(() =>
            MsBuildCli.RunGated<int>(null, directory, CancellationToken.None,
                () => throw new InvalidOperationException("build failed")));

        var second = Task.Run(() => MsBuildCli.RunGated(
            null, directory, CancellationToken.None, () => true));

        // A stranded gate never completes, so the delay is what turns a hang into a failure.
        var finished = await Task.WhenAny(second, Task.Delay(TimeSpan.FromSeconds(10)));

        Assert.Same(second, finished);
        Assert.True(await second);
    }

    /// <summary>
    /// The key must be a pure function of the two arguments. An earlier version probed
    /// <c>Directory.Exists</c>, so a project whose directory had not been created yet keyed
    /// differently from the same project a moment later -- the gate silently stopped excluding
    /// while every key-equality test still passed.
    /// </summary>
    [Fact]
    public void TheGateKeyDoesNotDependOnWhetherThePathExists()
    {
        var directory = Path.Combine(
            Path.GetTempPath(), "winuixaml-gate-absent-" + Guid.NewGuid().ToString("N"));
        var project = Path.Combine(directory, "App.csproj");

        Assert.False(Directory.Exists(directory));
        var absentCompile = MsBuildCli.ProjectGateKey(project, directory);
        var absentEvaluate = MsBuildCli.ProjectGateKey(null, directory);
        Assert.Equal(absentCompile, absentEvaluate);

        Directory.CreateDirectory(directory);
        try
        {
            Assert.Equal(absentCompile, MsBuildCli.ProjectGateKey(project, directory));
            Assert.Equal(absentEvaluate, MsBuildCli.ProjectGateKey(null, directory));
        }
        finally
        {
            TryDelete(directory);
        }
    }

    private static void InterlockedMax(ref int target, int value)
    {
        int seen;
        while (value > (seen = Volatile.Read(ref target)))
        {
            if (Interlocked.CompareExchange(ref target, value, seen) == seen)
            {
                return;
            }
        }
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
