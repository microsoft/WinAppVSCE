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
        internal static ImmutableArray<string> Run(
            string projectPath,
            string assemblyName,
            CscCommandLine commandLine,
            CancellationToken cancellationToken)
        {
            if (commandLine.Analyzers.IsDefaultOrEmpty)
            {
                return ImmutableArray<string>.Empty;
            }

            var host = HostAssemblyPath;
            if (host == null)
            {
                return ImmutableArray<string>.Empty;
            }

            var outputDirectory = OutputDirectoryFor(projectPath);
            var requestPath = Path.Combine(
                Path.GetTempPath(),
                $"winuixaml-genreq-{Guid.NewGuid():N}.json");

            try
            {
                File.WriteAllText(requestPath, BuildRequest(assemblyName, outputDirectory, commandLine));
                if (!Invoke(host, requestPath, cancellationToken))
                {
                    return ImmutableArray<string>.Empty;
                }

                var manifest = Path.Combine(outputDirectory, "generated-files.txt");
                if (!File.Exists(manifest))
                {
                    return ImmutableArray<string>.Empty;
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
            catch (IOException)
            {
                return ImmutableArray<string>.Empty;
            }
            catch (UnauthorizedAccessException)
            {
                return ImmutableArray<string>.Empty;
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

        private static bool Invoke(string host, string requestPath, CancellationToken cancellationToken)
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
        internal static bool RunProcess(
            ProcessStartInfo startInfo,
            TimeSpan timeout,
            CancellationToken cancellationToken)
        {
            using var process = new Process { StartInfo = startInfo };

            // The output is not consumed, but the pipes must still be drained or the child blocks.
            process.OutputDataReceived += static (_, _) => { };
            process.ErrorDataReceived += static (_, _) => { };

            try
            {
                process.Start();
            }
            catch (Exception)
            {
                return false;
            }

            process.BeginOutputReadLine();
            process.BeginErrorReadLine();

            using var registration = cancellationToken.Register(() => TryKill(process));

            if (!process.WaitForExit((int)timeout.TotalMilliseconds))
            {
                TryKill(process);
                return false;
            }

            // Flushes the async readers so the exit code reflects a fully drained child.
            process.WaitForExit();

            return process.ExitCode == 0;
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
