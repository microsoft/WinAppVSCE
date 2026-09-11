using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using WinUiXaml.Workspace;
using Xunit;

namespace WinUiXaml.Workspace.Tests
{
    /// <summary>
    /// Covers the generator-host child-process boundary, which drives source generators
    /// out-of-process because Native AOT cannot load analyzer assemblies.
    /// </summary>
    public class GeneratorHostRunnerProcessTests
    {
        /// <summary>Enough to overrun the pipe buffer several times over.</summary>
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
        /// Fails the test rather than hanging the run when the call under test never returns,
        /// which is the exact symptom being guarded against.
        /// </summary>
        private static async Task<bool> CompleteWithin(Task<bool> run, TimeSpan budget, string because)
        {
            var finished = await Task.WhenAny(run, Task.Delay(budget)).ConfigureAwait(false);
            Assert.True(ReferenceEquals(finished, run), because);
            return await run.ConfigureAwait(false);
        }

        /// <summary>
        /// A generator that logs heavily must not wedge project load. Draining the pipes
        /// sequentially deadlocks here: the child blocks filling stderr while this process waits
        /// on stdout, so the child never exits and stdout never reaches EOF. That hang is
        /// unbounded, and because project load awaits this call the server then serves nothing
        /// at all for the project -- not merely the generated members.
        /// </summary>
        [Fact]
        public async Task RunProcess_ChildFloodingStderr_StillCompletes()
        {
            var startInfo = PowerShell(
                $"$chunk = 'x' * 8192; for ($i = 0; $i -lt {StderrBytes / 8192}; $i++) " +
                "{ [Console]::Error.Write($chunk) }; exit 0");

            var succeeded = await CompleteWithin(
                Task.Run(() => GeneratorHostRunner.RunProcess(
                    startInfo, TimeSpan.FromMinutes(2), CancellationToken.None)),
                TimeSpan.FromSeconds(90),
                $"RunProcess did not return while the child wrote {StderrBytes} bytes to stderr. " +
                "Both pipes must be drained concurrently.");

            Assert.True(succeeded);
        }

        /// <summary>
        /// Cancellation must be armed before the wait, not after the pipes are drained, or a
        /// wedged generator cannot be interrupted.
        /// </summary>
        [Fact]
        public async Task RunProcess_WhenCancelled_StopsWaitingOnTheChild()
        {
            using var cts = new CancellationTokenSource();
            var run = Task.Run(() => GeneratorHostRunner.RunProcess(
                PowerShell("Start-Sleep -Seconds 120; exit 0"),
                TimeSpan.FromMinutes(5),
                cts.Token));

            cts.CancelAfter(TimeSpan.FromSeconds(2));

            var succeeded = await CompleteWithin(
                run,
                TimeSpan.FromSeconds(60),
                "Cancelling did not interrupt the wait on a long-running generator host.");

            Assert.False(succeeded);
        }

        /// <summary>The timeout must cap a child that never exits on its own.</summary>
        [Fact]
        public async Task RunProcess_WhenChildOutlivesTimeout_ReturnsFailure()
        {
            var succeeded = await CompleteWithin(
                Task.Run(() => GeneratorHostRunner.RunProcess(
                    PowerShell("Start-Sleep -Seconds 120; exit 0"),
                    TimeSpan.FromSeconds(3),
                    CancellationToken.None)),
                TimeSpan.FromSeconds(60),
                "RunProcess ignored its timeout for a child that does not exit.");

            Assert.False(succeeded);
        }

        /// <summary>A non-zero exit is reported as failure rather than silently succeeding.</summary>
        [Fact]
        public async Task RunProcess_WhenChildFails_ReturnsFailure()
        {
            var succeeded = await CompleteWithin(
                Task.Run(() => GeneratorHostRunner.RunProcess(
                    PowerShell("exit 3"), TimeSpan.FromMinutes(1), CancellationToken.None)),
                TimeSpan.FromSeconds(60),
                "RunProcess did not return for a child that exits immediately.");

            Assert.False(succeeded);
        }
        /// <summary>
        /// A project with no analyzers is not a failure, so it must stay silent -- otherwise the
        /// log fills with noise for the common case and the real failures stop standing out.
        /// </summary>
        [Fact]
        public void Run_WithoutAnalyzers_ReportsNothing()
        {
            var commandLine = CscCommandLine.Parse(new[] { "/out:App.dll" }, Path.GetTempPath());

            var stderr = CaptureStandardError(() =>
                GeneratorHostRunner.Run(
                    Path.Combine(Path.GetTempPath(), "App.csproj"),
                    "App",
                    commandLine,
                    CancellationToken.None));

            Assert.Equal(string.Empty, stderr);
        }

        /// <summary>
        /// Every generator-host failure degrades to "generated members do not resolve", which is
        /// indistinguishable from a project that has no generators. Without a logged reason the
        /// user just sees IntelliSense forget a type, with nothing to diagnose.
        /// </summary>
        [Fact]
        public void Run_WhenHostIsMissing_ReportsTheReason()
        {
            var previous = Environment.GetEnvironmentVariable("WINUI_XAML_GENERATOR_HOST");
            Environment.SetEnvironmentVariable(
                "WINUI_XAML_GENERATOR_HOST",
                Path.Combine(Path.GetTempPath(), $"no-such-host-{Guid.NewGuid():N}.dll"));

            try
            {
                var commandLine = CscCommandLine.Parse(
                    new[] { "/out:App.dll", "/analyzer:SomeGenerator.dll" }, Path.GetTempPath());

                var stderr = CaptureStandardError(() =>
                    GeneratorHostRunner.Run(
                        Path.Combine(Path.GetTempPath(), "App.csproj"),
                        "App",
                        commandLine,
                        CancellationToken.None));

                Assert.Contains("generator host unavailable", stderr);
                Assert.Contains("will not resolve", stderr);
            }
            finally
            {
                Environment.SetEnvironmentVariable("WINUI_XAML_GENERATOR_HOST", previous);
            }
        }

        private static string CaptureStandardError(Action action)
        {
            var original = Console.Error;
            using var writer = new StringWriter();
            Console.SetError(writer);
            try
            {
                action();
            }
            finally
            {
                Console.SetError(original);
            }

            return writer.ToString();
        }
    }
}