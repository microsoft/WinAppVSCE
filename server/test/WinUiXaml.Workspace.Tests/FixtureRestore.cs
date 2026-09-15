using System.Diagnostics;

namespace WinUiXaml.Workspace.Tests;

/// <summary>
/// Restores a fixture before it is loaded.
/// </summary>
/// <remarks>
/// A design-time build now builds the project references it is given rather than assuming someone
/// else already did, and a project that has never been restored cannot be built -- MSBuild stops
/// with NETSDK1004. That is the correct answer for a real workspace, where the server turns it into
/// a restore prompt, but a fixture written inline in a test has no restore behind it.
///
/// Restoring the root is enough: NuGet walks <c>ProjectReference</c> edges, so one call covers the
/// whole graph. These fixtures declare no packages, so nothing is downloaded.
/// </remarks>
internal static class FixtureRestore
{
    internal static void Run(string projectPath)
    {
        using var process = Process.Start(new ProcessStartInfo("dotnet", $"restore \"{projectPath}\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        });

        if (process == null)
        {
            throw new InvalidOperationException("dotnet restore could not be started.");
        }

        var output = process.StandardOutput.ReadToEnd() + process.StandardError.ReadToEnd();
        if (!process.WaitForExit(180_000))
        {
            throw new InvalidOperationException("dotnet restore did not exit within 180 seconds.");
        }

        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException(
                $"restoring '{projectPath}' failed with exit code {process.ExitCode}:{Environment.NewLine}{output}");
        }
    }
}
