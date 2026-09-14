using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;

namespace WinUiXaml.Workspace
{
    /// <summary>
    /// Drives <c>WinUiXaml.GeneratorHost</c> so the AOT server can see source-generated members.
    /// </summary>
    /// <remarks>
    /// Refreshing generator output is deliberately separate from acquiring the csc command line.
    /// The design-time build that yields the command line runs with
    /// <c>SkipCompilerExecution=true</c>, so csc never runs and no generator output exists; and a
    /// C# edit invalidates the generated members while leaving the command line valid. Splitting
    /// them lets the common case -- a saved <c>.cs</c> file -- re-run only the generators.
    /// </remarks>
    internal static class GeneratorHostRunner
    {
        private static readonly TimeSpan Timeout = TimeSpan.FromMinutes(5);

        /// <summary>Locates the framework-dependent helper deployed beside the server.</summary>
        internal static string? HostAssemblyPath
        {
            get
            {
                var configured = Environment.GetEnvironmentVariable("WINUI_XAML_GENERATOR_HOST");
                if (!string.IsNullOrWhiteSpace(configured))
                {
                    return File.Exists(configured) ? configured : null;
                }

                var baseDirectory = AppContext.BaseDirectory;
                foreach (var candidate in new[]
                {
                    Path.Combine(baseDirectory, "generator-host", "WinUiXaml.GeneratorHost.dll"),
                    Path.Combine(baseDirectory, "WinUiXaml.GeneratorHost.dll"),
                    // The published server sits in dist/server/<rid>/; the shared helper is one
                    // level up so both architectures use a single copy.
                    Path.Combine(baseDirectory, "..", "generator-host", "WinUiXaml.GeneratorHost.dll"),
                })
                {
                    var full = Path.GetFullPath(candidate);
                    if (File.Exists(full))
                    {
                        return full;
                    }
                }

                return null;
            }
        }

        /// <summary>
        /// Runs the project's generators and returns the files they produced. Returns an empty
        /// array when the project has no generators, or when the helper is unavailable -- the
        /// server still works in that case, it just cannot see generated members.
        /// </summary>
        /// <remarks>
        /// Every failure here degrades to "generated members do not resolve", which looks
        /// identical to a project that simply has no generators. Each failure is logged with its
        /// reason so the user is not left with IntelliSense that has silently forgotten a type.
        /// </remarks>
        internal static ImmutableArray<string> Run(
            string projectPath,
            string assemblyName,
            CscCommandLine commandLine,
            CancellationToken cancellationToken)
        {
            // Not a failure: the project has nothing to generate.
            if (commandLine.Analyzers.IsDefaultOrEmpty)
            {
                return ImmutableArray<string>.Empty;
            }

            var host = HostAssemblyPath;
            if (host == null)
            {
                return Unavailable(projectPath, "helper assembly not found beside the server");
            }

            var outputDirectory = OutputDirectoryFor(projectPath);
            var requestPath = Path.Combine(
                Path.GetTempPath(),
                $"winuixaml-genreq-{Guid.NewGuid():N}.json");

            try
            {
                var manifest = Path.Combine(outputDirectory, "generated-files.txt");

                // The manifest is the runner's only proof the host finished. A manifest left over
                // from an earlier run would otherwise be read as this run's output, so a host that
                // dies before it can clear its own directory would look like success and feed
                // stale generated members into IntelliSense. Clearing it first makes its presence
                // afterwards mean "this invocation wrote it".
                TryDeleteManifest(manifest);

                File.WriteAllText(requestPath, BuildRequest(assemblyName, outputDirectory, commandLine));
                var run = Invoke(host, requestPath, cancellationToken);
                if (!run.Succeeded)
                {
                    return Unavailable(projectPath, run.Describe());
                }

                if (!File.Exists(manifest))
                {
                    return Unavailable(projectPath, "helper produced no manifest");
                }

                var builder = ImmutableArray.CreateBuilder<string>();
                foreach (var line in File.ReadAllLines(manifest))
                {
                    if (!string.IsNullOrWhiteSpace(line) && File.Exists(line))
                    {
                        builder.Add(line);
                    }
                }

                return builder.ToImmutable();
            }
            catch (IOException ex)
            {
                return Unavailable(projectPath, $"I/O error: {ex.Message}");
            }
            catch (UnauthorizedAccessException ex)
            {
                return Unavailable(projectPath, $"access denied: {ex.Message}");
            }
            finally
            {
                try
                {
                    File.Delete(requestPath);
                }
                catch (IOException)
                {
                }
                catch (UnauthorizedAccessException)
                {
                }
            }
        }

        /// <summary>
        /// Removes a previous run's completion marker. Failure is not fatal on its own: the host
        /// clears the whole directory, and a manifest it cannot overwrite would fail the run.
        /// </summary>
        private static void TryDeleteManifest(string manifest)
        {
            try
            {
                if (File.Exists(manifest))
                {
                    File.Delete(manifest);
                }
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }

        /// <summary>
        /// Keys the output directory on the project path so concurrently loaded projects cannot
        /// overwrite one another's generated files.
        /// </summary>
        private static string OutputDirectoryFor(string projectPath)
        {
            var full = Path.GetFullPath(projectPath);
            byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes(full.ToLowerInvariant()));
            var name = Convert.ToHexString(hash, 0, 8);
            return Path.Combine(
                Path.GetTempPath(),
                "winuixaml-generated",
                $"{Path.GetFileNameWithoutExtension(full)}-{name}");
        }

        private static string BuildRequest(
            string assemblyName,
            string outputDirectory,
            CscCommandLine commandLine)
        {
            using var buffer = new MemoryStream();
            using (var writer = new Utf8JsonWriter(buffer))
            {
                writer.WriteStartObject();
                writer.WriteString("assemblyName", assemblyName);
                writer.WriteString("outputDirectory", outputDirectory);
                if (commandLine.LanguageVersion != null)
                {
                    writer.WriteString("languageVersion", commandLine.LanguageVersion);
                }

                WriteArray(writer, "references", commandLine.References);
                WriteArray(writer, "analyzers", commandLine.Analyzers);
                WriteArray(writer, "sources", commandLine.Sources);
                WriteArray(writer, "analyzerConfigs", commandLine.AnalyzerConfigs);
                WriteArray(writer, "additionalFiles", commandLine.AdditionalFiles);
                WriteArray(writer, "preprocessorSymbols", commandLine.PreprocessorSymbols);
                writer.WriteEndObject();
            }

            return Encoding.UTF8.GetString(buffer.ToArray());
        }

        private static void WriteArray(
            Utf8JsonWriter writer,
            string name,
            ImmutableArray<string> values)
        {
            writer.WriteStartArray(name);
            if (!values.IsDefaultOrEmpty)
            {
                foreach (var value in values)
                {
                    writer.WriteStringValue(value);
                }
            }

            writer.WriteEndArray();
        }

        /// <summary>
        /// Reports a generator-host failure and degrades to "no generated files".
        /// </summary>
        /// <remarks>
        /// Logged rather than surfaced as a diagnostic because the failure is project-wide, not
        /// tied to any span in a XAML file. Writing to stderr matches the rest of the server and
        /// is picked up by <c>WINUI_XAML_LOG</c>.
        /// </remarks>
        private static ImmutableArray<string> Unavailable(string projectPath, string reason)
        {
            Console.Error.WriteLine(
                $"[winui-xaml-ls] generator host unavailable for '{projectPath}': {reason}. " +
                "Source-generated members will not resolve for this project.");
            return ImmutableArray<string>.Empty;
        }

        private static HostRunResult Invoke(string host, string requestPath, CancellationToken cancellationToken)
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = MsBuildCli.DotnetPath,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = Path.GetDirectoryName(host) ?? Environment.CurrentDirectory,
            };
            startInfo.ArgumentList.Add(host);
            startInfo.ArgumentList.Add(requestPath);

            return RunProcess(startInfo, Timeout, cancellationToken);
        }

        /// <summary>Why a generator-host invocation did not produce a manifest.</summary>
        /// <remarks>
        /// A crash, a hang and a cancelled request are three different support paths, and an
        /// operator reading a user's log cannot act on them the same way: a non-zero exit is a
        /// defect to escalate, a timeout is usually load, and a cancellation is routine. Collapsing
        /// them into one sentence threw that away at the only point it was known.
        /// </remarks>
        internal enum HostRunOutcome
        {
            Succeeded,
            FailedToStart,
            ExitedNonZero,
            TimedOut,
            Cancelled,
        }

        internal readonly record struct HostRunResult(HostRunOutcome Outcome, int ExitCode)
        {
            internal bool Succeeded => Outcome == HostRunOutcome.Succeeded;

            /// <summary>Log-ready phrase naming the specific failure, with the exit code when there is one.</summary>
            internal string Describe() => Outcome switch
            {
                HostRunOutcome.Succeeded => "helper succeeded",
                HostRunOutcome.FailedToStart => "helper process could not be started",
                HostRunOutcome.ExitedNonZero => $"helper exited with code {ExitCode}",
                HostRunOutcome.TimedOut => $"helper did not exit within {Timeout.TotalMinutes:0} minutes and was terminated",
                HostRunOutcome.Cancelled => "helper was cancelled before it finished",
                _ => "helper failed",
            };
        }

        /// <summary>Runs a child process to completion, draining both pipes asynchronously.</summary>
        /// <remarks>
        /// Reading the pipes sequentially with <c>ReadToEnd</c> deadlocks: a generator that fills
        /// the stderr buffer blocks writing while this process is still blocked on stdout, so the
        /// child never exits and stdout never reaches EOF. That read also sits ahead of the timeout
        /// and the cancellation registration, which makes the hang unbounded rather than capped --
        /// and because <see cref="RoslynProjectWorkspace"/> waits on this call, the project never
        /// finishes loading and the server serves nothing at all for it. Async draining with an
        /// armed timeout is the shape <see cref="MsBuildCli"/> already uses.
        /// </remarks>
        internal static HostRunResult RunProcess(
            ProcessStartInfo startInfo,
            TimeSpan timeout,
            CancellationToken cancellationToken)
        {
            using var process = new Process { StartInfo = startInfo };

            // stdout is unused -- the helper writes its manifest to the path it was handed -- but
            // the pipe must still be drained or the child blocks. stderr is forwarded, because the
            // helper writes the reason a generator or analyzer was skipped, and the symptom --
            // generated members quietly missing -- is otherwise indistinguishable from the user's
            // own code being wrong.
            process.OutputDataReceived += static (_, _) => { };
            process.ErrorDataReceived += static (_, e) =>
            {
                if (!string.IsNullOrWhiteSpace(e.Data))
                {
                    Console.Error.WriteLine(e.Data);
                }
            };

            try
            {
                process.Start();
            }
            catch (Exception)
            {
                return new HostRunResult(HostRunOutcome.FailedToStart, 0);
            }

            process.BeginOutputReadLine();
            process.BeginErrorReadLine();

            using var registration = cancellationToken.Register(() => TryKill(process));

            if (!process.WaitForExit((int)timeout.TotalMilliseconds))
            {
                TryKill(process);
                return new HostRunResult(HostRunOutcome.TimedOut, 0);
            }

            // Flushes the async readers so the exit code reflects a fully drained child.
            process.WaitForExit();

            // Cancellation kills the child, so its exit code is meaningless here. Checking the
            // token first is what keeps a cancelled request from being reported as a crash.
            if (cancellationToken.IsCancellationRequested)
            {
                return new HostRunResult(HostRunOutcome.Cancelled, 0);
            }

            return process.ExitCode == 0
                ? new HostRunResult(HostRunOutcome.Succeeded, 0)
                : new HostRunResult(HostRunOutcome.ExitedNonZero, process.ExitCode);
        }

        private static void TryKill(Process process)
        {
            try
            {
                if (!process.HasExited)
                {
                    process.Kill(entireProcessTree: true);
                }
            }
            catch (InvalidOperationException)
            {
            }
            catch (System.ComponentModel.Win32Exception)
            {
            }
        }
    }
}
