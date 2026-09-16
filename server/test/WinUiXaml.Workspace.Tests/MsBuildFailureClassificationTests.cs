using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using WinUiXaml.Workspace;
using Xunit;

namespace WinUiXaml.Workspace.Tests
{
    /// <summary>Covers how a failed MSBuild invocation becomes the prompt the user sees. The individual detectors are tested on their own, but nothing pinned the order they run in or which stream each one is allowed to read -- and that is where the user-visible difference lives: the same failed build can present as "restore", as "build once", or as an unexplained error, and only one of the three tells the user something they can act on.</summary>
    public class MsBuildFailureClassificationTests
    {
        private const string ProjectPath = @"C:\src\App\App.csproj";

        [Fact]
        public void MissingAssetsFile_AsksForRestore()
        {
            var failure = MsBuildCli.ClassifyFailure(
                1,
                combined: string.Empty,
                standardError: "error NETSDK1004: Assets file 'project.assets.json' not found.",
                ProjectPath);

            var restore = Assert.IsType<ProjectRestoreRequiredException>(failure);
            Assert.Equal(ProjectPath, restore.ProjectPath);
        }

        [Fact]
        public void FailedProjectReference_NamesTheProjectToBuild()
        {
            var failure = MsBuildCli.ClassifyFailure(
                1,
                combined: string.Empty,
                standardError: @"C:\src\Lib\Lib.csproj : error MSB4062: build failed. [C:\src\Lib\Lib.csproj]",
                ProjectPath);

            var build = Assert.IsType<ProjectBuildRequiredException>(failure);
            Assert.Contains("Lib", build.UnresolvedAssemblies);
        }

        /// <summary>The markup compiler writes WMC1006 to stdout. An unrelated warning on stderr is enough to hide it, so classification has to look at both streams -- with only stderr in view this is an unexplained MSBuild failure and the "build once" prompt never appears.</summary>
        [Fact]
        public void UnresolvedMetadataOnStdout_IsNotHiddenByUnrelatedStderr()
        {
            var failure = MsBuildCli.ClassifyFailure(
                1,
                combined: "XamlCompiler error WMC1006: Cannot resolve Assembly or Windows Metadata file " +
                    @"'C:\src\Lib\bin\Debug\Lib.dll'",
                standardError: "warning : an unrelated warning on stderr",
                ProjectPath);

            var build = Assert.IsType<ProjectBuildRequiredException>(failure);
            Assert.Contains("Lib", build.UnresolvedAssemblies);
        }

        /// <summary>Anything unrecognized has to stay unrecognized. Guessing "restore" or "build" here would send the user through an action that cannot fix their project and leaves the real error unreported.</summary>
        [Fact]
        public void UnrecognizedFailure_ReportsTheExitCodeAndOutput()
        {
            var failure = MsBuildCli.ClassifyFailure(
                7,
                combined: "some output",
                standardError: "error MSB1234: something else went wrong",
                ProjectPath);

            var unavailable = Assert.IsType<MsBuildUnavailableException>(failure);
            Assert.Contains("exited with code 7", unavailable.Message);
            Assert.Contains("MSB1234", unavailable.Message);
            Assert.False(unavailable.HostMissing);
        }

        /// <summary>The server now starts without .NET, so "no dotnet on this machine" is a state the user reaches by opening a C# project rather than an impossible one. It has to be distinguishable from a build that ran and failed, because only the former is fixed by installing the SDK.</summary>
        [Fact]
        public void AbsentDotnetHost_IsReportedAsHostMissing()
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = Path.Combine(Path.GetTempPath(), "winui-xaml-no-such-dotnet.exe"),
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };

            var failure = Assert.Throws<MsBuildUnavailableException>(
                () => MsBuildCli.RunProcess(startInfo, TimeSpan.FromSeconds(30), CancellationToken.None));

            Assert.True(failure.HostMissing);
            Assert.Contains(".NET SDK", failure.Message);
        }
    }
}
