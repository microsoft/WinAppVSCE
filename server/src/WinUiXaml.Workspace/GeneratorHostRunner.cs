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

            ReclaimStaleOutput();

            try
            {
                var manifest = Path.Combine(outputDirectory, "generated-files.txt");

                // No stale manifest is possible: the directory is unique to this invocation, so
                // the file's presence afterwards already means "this run wrote it". An earlier
                // version shared one directory per project and had to clear the manifest first to
                // get that guarantee, which held only against the runs it could see.
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
        /// Keys the output directory on the project path so concurrently loaded projects cannot
        /// overwrite one another's generated files, and gives every invocation its own leaf so two
        /// runs for the *same* project cannot either.
        /// </summary>
        /// <remarks>
        /// The per-invocation leaf is not defensive programming. One project reached twice
        /// concurrently is ordinary: two roots that share a library each build that library in
        /// their own graph, and those graphs are loaded independently. Both runs would then target
        /// one directory, and the host clears that directory on entry -- so the second run's clear
        /// lands between the first run's manifest read and its file reads, and the files vanish.
        /// The reader tolerates that (it skips paths that no longer exist), which is what makes it
        /// dangerous: the symptom is not an error, it is a project that quietly forgets its
        /// generated members until something else invalidates it.
        ///
        /// A lock would close the in-process case and miss the one that motivates this: two VS
        /// Code windows are two server processes sharing one <c>%TEMP%</c>. Separate directories
        /// need no agreement between them.
        /// </remarks>
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

        /// <summary>How long an invocation's output directory is assumed to still be in use.</summary>
        /// <remarks>
        /// Generously past the host's own five-minute timeout. The files are read by the caller
        /// after <see cref="Run"/> returns, so reclaiming on age rather than on completion is what
        /// keeps a sweep from deleting a directory whose trees are still being parsed.
        /// </remarks>
        private static readonly TimeSpan ReclaimAfter = TimeSpan.FromHours(1);

        private static int _sweepStarted;

        /// <summary>
        /// Deletes invocation directories left behind by earlier runs, once per process.
        /// </summary>
        /// <remarks>
        /// Per-invocation directories do not clean themselves up: the process that would delete one
        /// is the process that may have been killed. Without a sweep the cost of the fix above is
        /// an unbounded pile of generated C# under <c>%TEMP%</c>, which is a worse defect than the
        /// race it removes. Failure here is ignored -- a directory that cannot be deleted is
        /// someone else's open handle, and it will be swept by a later session.
        /// </remarks>
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

        /// <remarks>
        /// Every field here is one the server already parsed out of the csc command line. Sending
        /// only the file lists left the host to guess the rest, and its guesses disagreed with the
        /// compilation the server builds from the same command line: nullable disabled where the
        /// project enables it, and a library where the project is an application. Generators read
        /// both. <c>[ObservableProperty]</c> annotates what it emits from the nullable context, so
        /// the guess decided whether a generated property came back as <c>string</c> or
        /// <c>string?</c> -- and that is the type <c>{x:Bind}</c> is then checked against.
        /// </remarks>
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

                writer.WriteString("outputKind", commandLine.OutputKind.ToString());
                writer.WriteBoolean("allowUnsafe", commandLine.AllowUnsafe);
                writer.WriteString("nullableContext", commandLine.NullableContext.ToString());

                WriteArray(writer, "references", commandLine.References);
                WriteArray(writer, "analyzers", commandLine.Analyzers);
                WriteArray(writer, "sources", commandLine.Sources);
                WriteArray(writer, "analyzerConfigs", commandLine.AnalyzerConfigs);
                WriteArray(writer, "additionalFiles", commandLine.AdditionalFiles);
                WriteArray(writer, "preprocessorSymbols", commandLine.PreprocessorSymbols);

                // Reference-level modifiers travel beside the paths rather than reshaping the
                // 'references' array, so a host reading only the paths still works.
                writer.WriteStartObject("referenceAliases");
                foreach (var pair in commandLine.ReferenceAliases)
                {
                    WriteArray(writer, pair.Key, pair.Value);
                }

                writer.WriteEndObject();
                WriteArray(
                    writer,
                    "embeddedInteropReferences",
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
