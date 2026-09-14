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
    /// The end-to-end proof, against a genuinely multi-targeted project built by MSBuild itself.
    /// The unit tests above pin the decision inputs in isolation; only this one fails if the
    /// framework is never actually pinned, which is precisely how the original defect survived.
    /// </summary>
    [Fact]
    public void AMultiTargetedProjectStillYieldsACommandLine()
    {
        WithCrossTargetedProject((directory, project) =>
        {
            if (!TryRestore(directory))
            {
                // Without a restore there is no assets file and the inner build cannot compile
                // either, so the pin would be measured against the wrong failure. Skipping beats
                // reporting a pass that tested nothing.
                return;
            }

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

    private static bool TryRestore(string directory)
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
                return false;
            }

            process.StandardOutput.ReadToEnd();
            process.StandardError.ReadToEnd();
            return process.WaitForExit(milliseconds: 180_000) && process.ExitCode == 0;
        }
        catch (Exception)
        {
            return false;
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
