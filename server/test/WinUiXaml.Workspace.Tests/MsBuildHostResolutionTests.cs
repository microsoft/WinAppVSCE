using System;
using System.Collections.Generic;
using System.IO;
using WinUiXaml.Workspace;
using Xunit;

namespace WinUiXaml.Workspace.Tests
{
    /// <summary>Guards the dotnet host lookup. MSBuild runs with the user's project directory as its working
    /// directory and Windows searches that directory before PATH, so a bare "dotnet" file name would let a
    /// dotnet.exe committed to a repository win over the real SDK.</summary>
    public class MsBuildHostResolutionTests
    {
        private static readonly string Root = Path.GetTempPath();
        private static readonly string Executable = OperatingSystem.IsWindows() ? "dotnet.exe" : "dotnet";

        private static Func<string, bool> Present(params string[] paths)
        {
            var set = new HashSet<string>(paths, StringComparer.OrdinalIgnoreCase);
            return set.Contains;
        }

        [Fact]
        public void ResolveDotnetHost_PrefersDotnetHostPath()
        {
            var host = Path.Combine(Root, "sdk", Executable);
            var onPath = Path.Combine(Root, "other", Executable);

            Assert.Equal(
                host,
                MsBuildCli.ResolveDotnetHost(host, new[] { Path.Combine(Root, "other") }, Present(host, onPath)));
        }

        /// <summary>A stale DOTNET_HOST_PATH must fall through to the search, not be launched blindly.</summary>
        [Fact]
        public void ResolveDotnetHost_IgnoresMissingDotnetHostPath()
        {
            var missing = Path.Combine(Root, "gone", Executable);
            var onPath = Path.Combine(Root, "sdk", Executable);

            Assert.Equal(
                onPath,
                MsBuildCli.ResolveDotnetHost(missing, new[] { Path.Combine(Root, "sdk") }, Present(onPath)));
        }

        /// <summary>The regression this guards: with nothing found the answer is null, never the bare name that
        /// would resolve against the project directory first.</summary>
        [Fact]
        public void ResolveDotnetHost_WhenNothingIsFound_IsNull()
        {
            Assert.Null(MsBuildCli.ResolveDotnetHost(null, new[] { Path.Combine(Root, "sdk") }, Present()));
            Assert.Null(MsBuildCli.ResolveDotnetHost(null, Array.Empty<string>(), _ => true));
        }

        /// <summary>A relative PATH entry resolves against the working directory, which is the project directory —
        /// exactly the planted-binary case — so it must never be accepted.</summary>
        [Fact]
        public void ResolveDotnetHost_RejectsRelativeSearchDirectories()
        {
            Assert.Null(MsBuildCli.ResolveDotnetHost(null, new[] { ".", "tools" }, _ => true));
        }

        [Fact]
        public void ResolveDotnetHost_SkipsMalformedSearchDirectories()
        {
            var onPath = Path.Combine(Root, "sdk", Executable);
            var directories = new List<string> { "bad\0dir", Path.Combine(Root, "sdk") };

            Assert.Equal(onPath, MsBuildCli.ResolveDotnetHost(null, directories, Present(onPath)));
        }

        /// <summary>The live property must still produce an absolute path on a machine that has the SDK.</summary>
        [Fact]
        public void DotnetPath_IsAbsoluteOrNull()
        {
            if (MsBuildCli.DotnetPath is { } resolved)
            {
                Assert.True(Path.IsPathRooted(resolved), $"'{resolved}' must be absolute, not a bare name.");
            }
        }

        [Fact]
        public void EnumerateHostSearchDirectories_IsNotEmpty()
        {
            Assert.NotEmpty(MsBuildCli.EnumerateHostSearchDirectories());
        }
    }
}
