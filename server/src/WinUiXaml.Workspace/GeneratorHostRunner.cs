using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using WinUiXaml.GeneratorProtocol;

namespace WinUiXaml.Workspace
{
    /// <summary>Runs <c>WinUiXaml.GeneratorHost</c> separately from command-line acquisition so saved C# edits refresh generated members without a full design-time build.</summary>
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
        /// Generated files plus the reason the helper produced none, so a project with no generators is distinguishable from one whose generators could not run.
        /// </summary>
        internal readonly record struct GeneratorRunResult(
            ImmutableArray<string> Files,
            string? FailureReason)
        {
            internal static GeneratorRunResult Nothing { get; } =
                new(ImmutableArray<string>.Empty, null);

            internal static GeneratorRunResult Produced(ImmutableArray<string> files) =>
                new(files, null);
        }

        /// <summary>
        /// Runs project generators; helper failures return no files and the reason, so callers can report the outage instead of silently losing generated members.
        /// </summary>
        internal static GeneratorRunResult Run(
            string projectPath,
            string assemblyName,
            CscCommandLine commandLine,
            CancellationToken cancellationToken)
        {
            // Not a failure: the project has nothing to generate.
            if (commandLine.Analyzers.IsDefaultOrEmpty)
            {
                return GeneratorRunResult.Nothing;
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

            ReclaimStaleOutput();

            try
            {
                var manifest = Path.Combine(outputDirectory, "generated-files.txt");

                // The directory is unique to this invocation, so a manifest's presence means this
                // run wrote it.
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

                return GeneratorRunResult.Produced(builder.ToImmutable());
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
        /// Uses a project-keyed directory plus a per-invocation leaf so concurrent loads, including separate VS Code server processes sharing <c>%TEMP%</c>, cannot clear each other's generated files.
        /// </summary>
        private static string OutputDirectoryFor(string projectPath)
        {
            var full = Path.GetFullPath(projectPath);
            byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes(full.ToLowerInvariant()));
            var name = Convert.ToHexString(hash, 0, 8);
            return Path.Combine(
                GeneratedRoot,
                $"{Path.GetFileNameWithoutExtension(full)}-{name}",
                Guid.NewGuid().ToString("N"));
        }

        private static string GeneratedRoot => Path.Combine(Path.GetTempPath(), "winuixaml-generated");

        /// <summary>How long output is kept so post-<see cref="Run"/> source parsing cannot race cleanup.</summary>
        private static readonly TimeSpan ReclaimAfter = TimeSpan.FromHours(1);

        private static int _sweepStarted;

        /// <summary>
        /// Sweeps old per-invocation output once per process so killed hosts do not leave unbounded generated C# under <c>%TEMP%</c>; locked directories are retried later.
        /// </summary>
        private static void ReclaimStaleOutput()
        {
            if (Interlocked.Exchange(ref _sweepStarted, 1) != 0)
            {
                return;
            }

            try
            {
                if (!Directory.Exists(GeneratedRoot))
                {
                    return;
                }

                var cutoff = DateTime.UtcNow - ReclaimAfter;
                foreach (var project in Directory.EnumerateDirectories(GeneratedRoot))
                {
                    foreach (var invocation in Directory.EnumerateDirectories(project))
                    {
                        try
                        {
                            if (Directory.GetLastWriteTimeUtc(invocation) < cutoff)
                            {
                                Directory.Delete(invocation, recursive: true);
                            }
                        }
                        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                        {
                        }
                    }
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
            }
        }

        /// <summary>
        /// Sends every csc-derived option generators observe, including output kind and nullable context, so generated members match the compilation <c>{x:Bind}</c> checks.
        /// </summary>
        private static string BuildRequest(
            string assemblyName,
            string outputDirectory,
            CscCommandLine commandLine)
        {
            using var buffer = new MemoryStream();
            using (var writer = new Utf8JsonWriter(buffer))
            {
                writer.WriteStartObject();
                writer.WriteString(GeneratorRequestFields.AssemblyName, assemblyName);
                writer.WriteString(GeneratorRequestFields.OutputDirectory, outputDirectory);
                if (commandLine.LanguageVersion != null)
                {
                    writer.WriteString(GeneratorRequestFields.LanguageVersion, commandLine.LanguageVersion);
                }

                writer.WriteString(GeneratorRequestFields.OutputKind, commandLine.OutputKind.ToString());
                writer.WriteBoolean(GeneratorRequestFields.AllowUnsafe, commandLine.AllowUnsafe);
                writer.WriteString(
                    GeneratorRequestFields.NullableContext, commandLine.NullableContext.ToString());

                WriteArray(writer, GeneratorRequestFields.References, commandLine.References);
                WriteArray(writer, GeneratorRequestFields.Analyzers, commandLine.Analyzers);
                WriteArray(writer, GeneratorRequestFields.Sources, commandLine.Sources);
                WriteArray(writer, GeneratorRequestFields.AnalyzerConfigs, commandLine.AnalyzerConfigs);
                WriteArray(writer, GeneratorRequestFields.AdditionalFiles, commandLine.AdditionalFiles);
                WriteArray(
                    writer, GeneratorRequestFields.PreprocessorSymbols, commandLine.PreprocessorSymbols);

                // Reference-level modifiers travel beside the paths rather than reshaping the
                // 'references' array, so a host reading only the paths still works.
                writer.WriteStartObject(GeneratorRequestFields.ReferenceAliases);
                foreach (var pair in commandLine.ReferenceAliases)
                {
                    WriteArray(writer, pair.Key, pair.Value);
                }

                writer.WriteEndObject();
                WriteArray(
                    writer,
                    GeneratorRequestFields.EmbeddedInteropReferences,
                    commandLine.EmbeddedInteropReferences.ToImmutableArray());
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

        /// <summary>Reports a project-wide generator-host failure to stderr/<c>WINUI_XAML_LOG</c> and carries the reason so the caller can surface the outage.</summary>
        private static GeneratorRunResult Unavailable(string projectPath, string reason)
        {
            Console.Error.WriteLine(
                $"[winui-xaml-ls] generator host unavailable for '{projectPath}': {reason}. " +
                "Source-generated members will not resolve for this project.");
            return new GeneratorRunResult(ImmutableArray<string>.Empty, reason);
        }

        private static HostRunResult Invoke(string host, string requestPath, CancellationToken cancellationToken)
        {
            if (MsBuildCli.DotnetPath is not { } dotnet)
            {
                return new HostRunResult(HostRunOutcome.FailedToStart, 0);
            }

            var startInfo = new ProcessStartInfo
            {
                FileName = dotnet,
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

        /// <summary>Why no manifest was produced, preserving distinct support paths for crashes, timeouts, and cancellations.</summary>
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

        /// <summary>
        /// Runs a child process with async pipe draining, timeout, and cancellation so stderr backpressure cannot deadlock project loading.
        /// </summary>
        internal static HostRunResult RunProcess(
            ProcessStartInfo startInfo,
            TimeSpan timeout,
            CancellationToken cancellationToken)
        {
            using var process = new Process { StartInfo = startInfo };

            // stdout is unused but must be drained or the child blocks. stderr is forwarded because
            // skipped generators/analyzers otherwise look the same as the user's own missing
            // generated members.
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
