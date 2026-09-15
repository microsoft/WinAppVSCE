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
        using var process = Process.Start(new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            ArgumentList = { "restore", projectPath },
        });

        if (process == null)
        {
            throw new InvalidOperationException("dotnet restore could not be started.");
        }

        // Both pipes are read concurrently and the reads are started before the exit wait.
        // Draining one to EOF first deadlocks whenever the child blocks writing the other, and
        // because that read sits ahead of the timeout, the timeout below could never fire.
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();

        if (!process.WaitForExit(180_000))
        {
            // Without this the fixture leaks a restore that still holds the obj directory, and
            // every later test against the same fixture fails for a reason that is not its own.
            TryKill(process);
            throw new InvalidOperationException("dotnet restore did not exit within 180 seconds.");
        }

        var output = string.Concat(stdout.GetAwaiter().GetResult(), stderr.GetAwaiter().GetResult());
        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException(
                $"restoring '{projectPath}' failed with exit code {process.ExitCode}:{Environment.NewLine}{output}");
        }
    }

    private static void TryKill(Process process)
    {
        try
        {
            process.Kill(entireProcessTree: true);
        }
        catch (Exception)
        {
            // The process exited between the wait timing out and the kill.
        }
    }
}
