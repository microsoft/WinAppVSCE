using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using WinUiXaml.Workspace;
using Xunit;

namespace WinUiXaml.Workspace.Tests;

/// <summary>
/// A multi-targeted project's outer build defines no <c>Compile</c> target -- only its inner
/// builds do -- so a design-time build aimed at the outer build fails with MSB4057 and the project
/// is dropped from the graph. The symptom is silent: every type in that project stops resolving in
/// XAML, and the only trace is one line on stderr. MSBuildWorkspace handled the outer/inner split
/// itself, so this is a gap the move to the MSBuild CLI opened rather than one it inherited.
///
/// The framework is therefore *decided* from evaluation rather than discovered by failing: these
/// tests pin the decision input (<c>TargetFrameworks</c>), the selection, and the end-to-end
/// result.
/// </summary>
public sealed class MsBuildCrossTargetingTests
{
    /// <summary>
    /// The evaluation pass is what makes the decision possible, so it has to report the declared
    /// targets. If this regresses, every cross-targeting project silently loses its inner build
    /// again -- and evaluation runs no targets, so it answers even for the outer build.
    /// </summary>
    [Fact]
    public void EvaluationReportsTheDeclaredTargetFrameworks()
    {
        WithCrossTargetedProject((directory, project) =>
        {
            var evaluation = MsBuildCli.Evaluate(project, new Dictionary<string, string>());

            Assert.Equal("netstandard2.0;net9.0", evaluation.TargetFrameworks);
        });
    }

    /// <summary>
    /// The mirror case: a single-targeted project must report no <c>TargetFrameworks</c>, because
    /// that emptiness is the signal to leave the build unpinned. If it reported something, every
    /// ordinary project would be forced down the inner-build path for no reason.
    /// </summary>
    [Fact]
    public void ASingleTargetedProjectReportsNoTargetFrameworks()
    {
        var directory = Path.Combine(
            Path.GetTempPath(), "winuixaml-singletarget-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var project = Path.Combine(directory, "SingleTargeted.csproj");
            File.WriteAllText(
                project,
                """
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup>
                    <TargetFramework>net9.0</TargetFramework>
                  </PropertyGroup>
                </Project>
                """);

            var evaluation = MsBuildCli.Evaluate(project, new Dictionary<string, string>());

            Assert.True(string.IsNullOrEmpty(evaluation.TargetFrameworks));
            Assert.Null(MsBuildCli.SelectTargetFramework(evaluation.TargetFrameworks));
        }
        finally
        {
            TryDelete(directory);
        }
    }

    /// <summary>
    /// The exact target list from the project that surfaced this, in its declared order. The
    /// netstandard leg is the compatibility shim; the modern one carries the full API surface and
    /// is what a net9.0 app resolves to.
    /// </summary>
    [Fact]
    public void TheModernTargetIsPreferredOverTheCompatibilityShim()
    {
        Assert.Equal("net9.0", MsBuildCli.SelectTargetFramework("netstandard2.0;net9.0"));
    }

    [Theory]
    [InlineData("net8.0;net9.0;net10.0", "net10.0")]
    [InlineData("net10.0;net8.0", "net10.0")]
    [InlineData("net9.0-windows10.0.19041.0;netstandard2.0", "net9.0-windows10.0.19041.0")]
    [InlineData("netstandard2.0;netstandard2.1", "netstandard2.0")]
    [InlineData("net9.0", "net9.0")]
    [InlineData(" net9.0 ; netstandard2.0 ", "net9.0")]
    public void TheHighestModernTargetWins(string declared, string expected)
    {
        Assert.Equal(expected, MsBuildCli.SelectTargetFramework(declared));
    }

    /// <summary>
    /// Every project this server loads is consumed by a WinUI app, so a Windows leg outranks a
    /// plain one. Ranking by version alone left these tied, and a tie was resolved by declaration
    /// order -- an arbitrary choice with a silent cost, because the types a library puts behind
    /// <c>#if WINDOWS</c> simply do not exist in the plain leg's compilation.
    /// </summary>
    [Theory]
    [InlineData("net8.0;net8.0-windows10.0.19041.0", "net8.0-windows10.0.19041.0")]
    [InlineData("net8.0-windows10.0.19041.0;net8.0", "net8.0-windows10.0.19041.0")]
    [InlineData("netstandard2.0;net8.0;net8.0-windows10.0.19041.0", "net8.0-windows10.0.19041.0")]
    [InlineData("net8.0-windows;net9.0", "net8.0-windows")]
    [InlineData("net8.0-android;net8.0-windows10.0.19041.0", "net8.0-windows10.0.19041.0")]
    public void AWindowsTargetOutranksThePlatformNeutralLeg(string declared, string expected)
    {
        Assert.Equal(expected, MsBuildCli.SelectTargetFramework(declared));
    }

    /// <summary>
    /// A single-targeted project reports no <c>TargetFrameworks</c> at all. Returning null there
    /// is what makes the caller rethrow the original failure instead of retrying forever.
    /// </summary>
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData(";")]
    public void NothingDeclaredSelectsNothing(string? declared)
    {
        Assert.Null(MsBuildCli.SelectTargetFramework(declared));
    }

    /// <summary>
    /// Deciding the framework costs an evaluation pass on a path that reruns on every C# save, so
    /// the answer is memoized. The risk that buys is a stale pin: a project edited from multi- to
    /// single-target (or the reverse) must not keep the old decision, because that silently drops
    /// it again -- the exact defect this file exists to prevent. Rewriting the project must
    /// therefore change the answer.
    /// </summary>
    [Fact]
    public void EditingTheProjectFileDefeatsTheMemoizedDecision()
    {
        WithCrossTargetedProject((directory, project) =>
        {
            var properties = new Dictionary<string, string>();

            Assert.Equal(
                "netstandard2.0;net9.0",
                MsBuildCli.ReadDeclaredTargetFrameworks(project, properties));

            // Prove the memo is actually in play without disturbing the stamp: swap in content
            // that evaluates differently, then restore the original length and write time. A
            // stamp-keyed memo must still answer with the first result.
            WriteDecoyPreservingStamp(project);
            Assert.Equal(
                "netstandard2.0;net9.0",
                MsBuildCli.ReadDeclaredTargetFrameworks(project, properties));

            // A same-tick rewrite is the adversarial case: the stamp must still move.
            File.WriteAllText(
                project,
                """
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup>
                    <TargetFramework>net9.0</TargetFramework>
                  </PropertyGroup>
                </Project>
                """);

            var reread = MsBuildCli.ReadDeclaredTargetFrameworks(project, properties);

            Assert.True(
                string.IsNullOrEmpty(reread),
                $"expected the rewritten project to declare no TargetFrameworks, got '{reread}'");
        });
    }

    /// <summary>
    /// The write stamp cannot see an arbitrarily named imported <c>.props</c> file, and MSBuild
    /// will not name its own import closure -- <c>-getProperty:MSBuildAllProjects</c> reports the
    /// project and a couple of SDK targets, not the file that declared the property. The language
    /// server already drops every project when an imported build file changes, so the memo hangs
    /// on that signal too. Without this it could outlive the compilations it fed, and pin a
    /// framework the project no longer declares.
    /// </summary>
    [Fact]
    public void ClearingTheMemoDefeatsADecisionTheStampCannotSee()
    {
        WithCrossTargetedProject((directory, project) =>
        {
            var properties = new Dictionary<string, string>();

            Assert.Equal(
                "netstandard2.0;net9.0",
                MsBuildCli.ReadDeclaredTargetFrameworks(project, properties));

            WriteDecoyPreservingStamp(project);

            // Still memoized: the stamp is byte-identical, so nothing else would notice.
            Assert.Equal(
                "netstandard2.0;net9.0",
                MsBuildCli.ReadDeclaredTargetFrameworks(project, properties));

            MsBuildCli.ClearTargetFrameworkMemo();

            Assert.True(
                string.IsNullOrEmpty(MsBuildCli.ReadDeclaredTargetFrameworks(project, properties)),
                "clearing the memo must force a fresh evaluation");
        });
    }

    /// <summary>
    /// <c>TargetFrameworks</c> can be declared under a condition on <c>$(Configuration)</c>, so a
    /// memo keyed on the path alone would answer for the wrong build. The stamp is deliberately
    /// held identical here: only the properties differ, so only the key can tell them apart.
    /// </summary>
    [Fact]
    public void TheMemoDoesNotAnswerAcrossDifferentGlobalProperties()
    {
        WithCrossTargetedProject((directory, project) =>
        {
            Assert.Equal(
                "netstandard2.0;net9.0",
                MsBuildCli.ReadDeclaredTargetFrameworks(project, new Dictionary<string, string>()));

            WriteDecoyPreservingStamp(project);

            var underOtherProperties = MsBuildCli.ReadDeclaredTargetFrameworks(
                project, new Dictionary<string, string> { ["Configuration"] = "Release" });

            Assert.True(
                string.IsNullOrEmpty(underOtherProperties),
                $"a different property set must not reuse the memo, got '{underOtherProperties}'");
        });
    }

    /// <summary>
    /// Replaces the project with content that evaluates differently while leaving the write stamp
    /// byte-identical, so a stamp-keyed memo cannot notice the change.
    /// </summary>
    private static void WriteDecoyPreservingStamp(string project)
    {
        var original = new FileInfo(project);
        var writeTime = original.LastWriteTimeUtc;
        var length = original.Length;
        var decoy = """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net9.0</TargetFramework>
              </PropertyGroup>
            </Project>
            """;
        decoy += new string(' ', Math.Max(0, (int)length - decoy.Length));
        File.WriteAllText(project, decoy);

        Assert.Equal(length, new FileInfo(project).Length);
        File.SetLastWriteTimeUtc(project, writeTime);
    }

    /// <summary>
    /// The end-to-end proof, against a genuinely multi-targeted project built by MSBuild itself.
    /// The unit tests above pin the decision inputs in isolation; only this one fails if the
    /// framework is never actually pinned, which is precisely how the original defect survived.
    /// </summary>
    [Fact]
    public void AMultiTargetedProjectStillYieldsACommandLine()
    {
        WithCrossTargetedProject((directory, project) =>
        {
            // Restore has to succeed for the inner build to compile, so a failure here is not a
            // reason to stop testing -- it is a reason to say so. Returning early would report a
            // pass having asserted nothing, which is the same shape of defect as the silent
            // project drop this file exists to prevent: a precondition that cannot be met reads
            // exactly like the behaviour working.
            var (restored, diagnostics) = Restore(directory);
            Assert.True(restored, $"restoring the cross-targeted fixture failed:{Environment.NewLine}{diagnostics}");

            var result = MsBuildCli.EvaluateAndCompile(
                project, new Dictionary<string, string>());

            Assert.False(result.CscCommandLineArgs.IsDefaultOrEmpty);
            Assert.Contains(result.CscCommandLineArgs, argument =>
                argument.EndsWith("Widget.cs", StringComparison.OrdinalIgnoreCase));
        });
    }

    /// <summary>
    /// Writes the netstandard2.0;net9.0 library that surfaced this, runs <paramref name="body"/>
    /// against it, and cleans up.
    /// </summary>
    private static void WithCrossTargetedProject(Action<string, string> body)
    {
        var directory = Path.Combine(
            Path.GetTempPath(), "winuixaml-crosstarget-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var project = Path.Combine(directory, "CrossTargeted.csproj");
            File.WriteAllText(
                project,
                """
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup>
                    <TargetFrameworks>netstandard2.0;net9.0</TargetFrameworks>
                    <EnableDefaultItems>true</EnableDefaultItems>
                  </PropertyGroup>
                </Project>
                """);
            File.WriteAllText(
                Path.Combine(directory, "Widget.cs"),
                "namespace CrossTargeted { public sealed class Widget { } }");

            body(directory, project);
        }
        finally
        {
            TryDelete(directory);
        }
    }

    /// <summary>
    /// Restores the fixture, returning why it failed rather than only that it did. A caller that
    /// cannot say why a precondition failed can only choose between a silent pass and an
    /// unactionable failure.
    /// </summary>
    private static (bool Succeeded, string Diagnostics) Restore(string directory)
    {
        try
        {
            using var process = Process.Start(new ProcessStartInfo
            {
                FileName = "dotnet",
                WorkingDirectory = directory,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                ArgumentList = { "restore" },
            });

            if (process == null)
            {
                return (false, "dotnet restore could not be started.");
            }

            // Both pipes are read concurrently: reading one to EOF while the child is blocked
            // writing to the other deadlocks, and this helper sits ahead of the exit wait.
            var stdout = process.StandardOutput.ReadToEndAsync();
            var stderr = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit(milliseconds: 180_000))
            {
                return (false, "dotnet restore did not exit within 180 seconds.");
            }

            var output = string.Concat(stdout.GetAwaiter().GetResult(), stderr.GetAwaiter().GetResult());
            return process.ExitCode == 0
                ? (true, output)
                : (false, $"dotnet restore exited with code {process.ExitCode}:{Environment.NewLine}{output}");
        }
        catch (Exception ex)
        {
            return (false, ex.ToString());
        }
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
