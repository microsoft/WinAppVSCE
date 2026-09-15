using System;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;
using WinUiXaml.Workspace;
using Xunit;

namespace WinUiXaml.Workspace.Tests
{
    /// <summary>
    /// Covers the MSBuild child-process boundary: the timeout, the cancellation registration and
    /// the pipe draining that sit between a design-time build and the rest of the server.
    /// </summary>
    /// <remarks>
    /// Every failure here presents to the user as a language server that has stopped answering,
    /// with nothing in the log to say why -- the same symptom for a hung build, an ignored
    /// cancellation and a deadlocked pipe. None of the three can be provoked reliably by driving a
    /// real design-time build: they depend on how the child behaves, not on what the project
    /// contains. Driving <see cref="MsBuildCli.RunProcess"/> with a child that misbehaves on
    /// purpose is what makes them testable at all.
    /// </remarks>
    public class MsBuildProcessTests
    {
        /// <summary>Enough to overrun the pipe buffer many times over.</summary>
        private const int StderrBytes = 512 * 1024;

        private static ProcessStartInfo PowerShell(string command)
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = "powershell",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };

            startInfo.ArgumentList.Add("-NoProfile");
            startInfo.ArgumentList.Add("-NonInteractive");
            startInfo.ArgumentList.Add("-Command");
            startInfo.ArgumentList.Add(command);
            return startInfo;
        }

        /// <summary>
        /// Fails the test rather than hanging the run when the call under test never returns, which
        /// is the exact symptom being guarded against.
        /// </summary>
        private static async Task<T> CompleteWithin<T>(Task<T> run, TimeSpan budget, string because)
        {
            var finished = await Task.WhenAny(run, Task.Delay(budget)).ConfigureAwait(false);
            Assert.True(ReferenceEquals(finished, run), because);
            return await run.ConfigureAwait(false);
        }

        /// <summary>
        /// A build that never finishes must be capped, and the reason must survive into the
        /// message -- a design-time build has a ten-minute budget, so the difference between "still
        /// working" and "wedged" is not something a user can tell by waiting.
        /// </summary>
        [Fact]
        public async Task RunProcess_WhenChildOutlivesTimeout_Throws()
        {
            var run = Task.Run(() => MsBuildCli.RunProcess(
                PowerShell("Start-Sleep -Seconds 120"),
                TimeSpan.FromSeconds(3),
                CancellationToken.None));

            var failure = await CompleteWithin(
                Record.ExceptionAsync(() => run),
                TimeSpan.FromSeconds(60),
                "RunProcess ignored its timeout for a child that does not exit.");

            var unavailable = Assert.IsType<MsBuildUnavailableException>(failure);
            Assert.Contains("did not complete within", unavailable.Message);
        }

        /// <summary>
        /// Cancellation has to be armed before the wait, not after it. A load cancelled by the user
        /// closing the document leaves the child running otherwise, and MSBUILDDISABLENODEREUSE
        /// means nothing will reap it.
        /// </summary>
        [Fact]
        public async Task RunProcess_WhenCancelled_StopsWaitingOnTheChild()
        {
            using var cts = new CancellationTokenSource();
            var run = Task.Run(() => MsBuildCli.RunProcess(
                PowerShell("Start-Sleep -Seconds 120"),
                TimeSpan.FromMinutes(5),
                cts.Token));

            cts.CancelAfter(TimeSpan.FromSeconds(2));

            var failure = await CompleteWithin(
                Record.ExceptionAsync(() => run),
                TimeSpan.FromSeconds(60),
                "Cancelling did not interrupt the wait on a long-running MSBuild invocation.");

            // Either shape is correct: killing the child can surface as the cancellation itself or
            // as the invocation it cut short. What must not happen is waiting out the timeout.
            Assert.True(
                failure is OperationCanceledException or MsBuildUnavailableException,
                $"Unexpected exception after cancellation: {failure}");
        }

        /// <summary>
        /// A verbose build must not wedge the load. MSBuild is routinely noisy -- restore output,
        /// warnings from every project in the graph -- and a reader that drains one pipe to EOF
        /// before touching the other deadlocks as soon as the child fills the one being ignored.
        /// </summary>
        [Fact]
        public async Task RunProcess_ChildFloodingStderr_StillCompletes()
        {
            var result = await CompleteWithin(
                Task.Run(() => MsBuildCli.RunProcess(
                    PowerShell(
                        $"$chunk = 'x' * 8192; for ($i = 0; $i -lt {StderrBytes / 8192}; $i++) " +
                        "{ [Console]::Error.Write($chunk) }; exit 0"),
                    TimeSpan.FromMinutes(2),
                    CancellationToken.None)),
                TimeSpan.FromSeconds(90),
                $"RunProcess did not return while the child wrote {StderrBytes} bytes to stderr. " +
                "Both pipes must be drained concurrently.");

            Assert.Equal(0, result.ExitCode);
            Assert.NotEmpty(result.StandardError);
        }

        /// <summary>
        /// The exit code and both streams are the raw material every MSBuild failure is classified
        /// from -- restore-required, build-required, or an unexplained failure. Flattening any of
        /// them here would lose the distinction before the classifier ever sees it.
        /// </summary>
        [Fact]
        public async Task RunProcess_ReportsExitCodeAndBothStreams()
        {
            var result = await CompleteWithin(
                Task.Run(() => MsBuildCli.RunProcess(
                    PowerShell("Write-Output 'to-stdout'; [Console]::Error.Write('to-stderr'); exit 7"),
                    TimeSpan.FromMinutes(1),
                    CancellationToken.None)),
                TimeSpan.FromSeconds(60),
                "RunProcess did not return for a child that exits immediately.");

            Assert.Equal(7, result.ExitCode);
            Assert.Contains("to-stdout", result.StandardOutput);
            Assert.Contains("to-stderr", result.StandardError);
        }
    }
}
