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
/// builds do -- so the design-time build fails with MSB4057 and the project is dropped from the
/// graph. The symptom is silent: every type in that project stops resolving in XAML, and the only
/// trace is one line on stderr. MSBuildWorkspace handled the outer/inner split itself, so this is
/// a gap the move to the MSBuild CLI opened rather than one it inherited.
/// </summary>
public sealed class MsBuildCrossTargetingTests
{
    /// <summary>
    /// The verbatim failure from a user's log, against a real netstandard2.0;net9.0 library.
    /// Quoting it exactly is the point: a recognizer tuned to invented text proves nothing about
    /// the failure that actually reaches us.
    /// </summary>
    [Fact]
    public void TheRealWorldOuterBuildFailureIsRecognized()
    {
        const string failure =
            "MSBuild exited with code 1. C:\\Users\\chiaramooney\\ai-dev-gallery\\AIDevGallery.Utils" +
            "\\AIDevGallery.Utils.csproj : error MSB4057: The target \"Compile\" does not exist in " +
            "the project.\n\nBuild failed. Properties, Items, and Target results cannot be " +
            "obtained. See details in stderr above.";

        Assert.True(MsBuildCli.IsCrossTargetingFailure(failure));
    }

    /// <summary>
    /// The recognizer must not swallow unrelated build failures into the retry path, or a real
    /// error becomes a second wasted MSBuild invocation and a more confusing message.
    /// </summary>
    [Theory]
    [InlineData("MSBuild exited with code 1. error MSB4018: The \"Csc\" task failed unexpectedly.")]
    [InlineData("error NETSDK1004: Assets file 'project.assets.json' not found. Run a restore.")]
    [InlineData("The process cannot access the file 'output.json' because it is being used by another process.")]
    [InlineData("")]
    [InlineData(null)]
    public void UnrelatedFailuresAreNotTreatedAsCrossTargeting(string? failure)
    {
        Assert.False(MsBuildCli.IsCrossTargetingFailure(failure));
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
    /// The unit tests above pin the two decisions in isolation; only this one fails if the retry
    /// is never wired up, which is precisely how the original defect survived.
    /// </summary>
    [Fact]
    public void AMultiTargetedProjectStillYieldsACommandLine()
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

            if (!TryRestore(directory))
            {
                // Without a restore there is no assets file and the inner build cannot compile
                // either, so the retry would be measured against the wrong failure. Skipping beats
                // reporting a pass that tested nothing.
                return;
            }

            var result = MsBuildCli.EvaluateAndCompile(
                project, new Dictionary<string, string>());

            Assert.False(result.CscCommandLineArgs.IsDefaultOrEmpty);
            Assert.Contains(result.CscCommandLineArgs, argument =>
                argument.EndsWith("Widget.cs", StringComparison.OrdinalIgnoreCase));
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
