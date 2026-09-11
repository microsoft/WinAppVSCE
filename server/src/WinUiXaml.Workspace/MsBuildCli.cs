using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace WinUiXaml.Workspace
{
    public sealed class MsBuildUnavailableException : InvalidOperationException
    {
        public MsBuildUnavailableException(string message, Exception? innerException = null)
            : base(message, innerException)
        {
        }
    }

    /// <summary>
    /// Acquires MSBuild data by invoking the user's installed .NET SDK as a child process.
    /// </summary>
    /// <remarks>
    /// The server used to load <c>Microsoft.Build</c> in-process through MSBuildLocator, which
    /// requires a runtime assembly loader and therefore cannot work under Native AOT. Shelling out
    /// to <c>dotnet msbuild</c> is AOT-safe, and it is the same acquisition strategy the extension
    /// already uses for <c>dotnet restore</c>. All parsing goes through <see cref="JsonDocument"/>
    /// rather than the reflection-based serializer so it survives trimming.
    /// </remarks>
    internal static class MsBuildCli
    {
        /// <summary>MSBuild evaluation is cheap; a design-time build is not. Keep them separate.</summary>
        private static readonly TimeSpan EvaluateTimeout = TimeSpan.FromMinutes(2);
        private static readonly TimeSpan DesignTimeBuildTimeout = TimeSpan.FromMinutes(10);

        internal readonly struct Evaluation
        {
            public Evaluation(
                ImmutableArray<string> xamlFiles,
                string? applicationDefinition,
                string? projectAssetsFile,
                bool hasPackageReferences,
                ImmutableArray<string> projectReferences,
                string? assemblyName)
            {
                XamlFiles = xamlFiles;
                ApplicationDefinition = applicationDefinition;
                ProjectAssetsFile = projectAssetsFile;
                HasPackageReferences = hasPackageReferences;
                ProjectReferences = projectReferences;
                AssemblyName = assemblyName;
            }

            public ImmutableArray<string> XamlFiles { get; }
            public string? ApplicationDefinition { get; }
            public string? ProjectAssetsFile { get; }
            public bool HasPackageReferences { get; }
            public ImmutableArray<string> ProjectReferences { get; }
            public string? AssemblyName { get; }
        }

        /// <summary>
        /// The host used to run MSBuild. The extension sets DOTNET_HOST_PATH on the server's
        /// environment, so preferring it keeps the server on exactly the SDK the user resolved.
        /// </summary>
        internal static string DotnetPath =>
            Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") is { Length: > 0 } host &&
            File.Exists(host)
                ? host
                : "dotnet";

        /// <summary>
        /// Single pass that both evaluates the project and runs the design-time build, returning
        /// the XAML items and the csc command line together.
        /// </summary>
        /// <remarks>
        /// Doing this in one invocation rather than two halves the process launches on the hot
        /// reload path, which is what keeps a C#-edit refresh comparable to the old in-process
        /// workspace. It requires a project that can reach the Compile target, so callers fall
        /// back to <see cref="Evaluate"/> when it fails: evaluation runs no targets and therefore
        /// still answers for an unrestored project.
        /// </remarks>
        internal static (Evaluation Evaluation, ImmutableArray<string> CscCommandLineArgs) EvaluateAndCompile(
            string projectPath,
            IReadOnlyDictionary<string, string> globalProperties,
            CancellationToken cancellationToken = default)
        {
            var fullPath = Path.GetFullPath(projectPath);
            var arguments = new List<string>
            {
                "msbuild",
                fullPath,
                "-nologo",
                "-t:Compile",
                "-p:BuildProjectReferences=false",
                "-p:ProvideCommandLineArgs=true",
                "-p:SkipCompilerExecution=true",
                "-p:DesignTimeBuild=true",
                "-p:DesignTimeSilentResolution=true",
                "-p:BuildingInsideVisualStudio=true",
                "-getItem:CscCommandLineArgs",
            };
            AppendEvaluationRequests(arguments);
            AppendProperties(arguments, globalProperties);

            var output = Run(
                arguments, Path.GetDirectoryName(fullPath), DesignTimeBuildTimeout, cancellationToken, fullPath);
            using var document = ParseJson(output, projectPath);
            return (
                ReadEvaluation(document.RootElement, fullPath),
                ReadItemIdentities(document.RootElement, "CscCommandLineArgs"));
        }

        /// <summary>
        /// Evaluation-only pass: reads XAML items, the restore marker, and the project graph edges.
        /// This runs no targets, so it succeeds even when the project has never been restored,
        /// which is what lets <see cref="RoslynProjectWorkspace.RequiresRestore"/> answer first.
        /// </summary>
        internal static Evaluation Evaluate(
            string projectPath,
            IReadOnlyDictionary<string, string> globalProperties,
            CancellationToken cancellationToken = default)
        {
            var fullPath = Path.GetFullPath(projectPath);
            var arguments = new List<string>
            {
                "msbuild",
                fullPath,
                "-nologo",
            };
            AppendEvaluationRequests(arguments);
            AppendProperties(arguments, globalProperties);

            var output = Run(arguments, Path.GetDirectoryName(fullPath), EvaluateTimeout, cancellationToken);
            using var document = ParseJson(output, projectPath);
            return ReadEvaluation(document.RootElement, fullPath);
        }

        private static void AppendEvaluationRequests(List<string> arguments)
        {
            arguments.Add("-getItem:Page");
            arguments.Add("-getItem:ApplicationDefinition");
            arguments.Add("-getItem:PackageReference");
            arguments.Add("-getItem:ProjectReference");
            arguments.Add("-getProperty:ProjectAssetsFile");
            arguments.Add("-getProperty:AssemblyName");
        }

        private static Evaluation ReadEvaluation(JsonElement root, string fullProjectPath)
        {
            var projectDirectory = Path.GetDirectoryName(fullProjectPath)!;
            var applicationDefinitions = ReadItemPaths(root, "ApplicationDefinition", projectDirectory)
                .Where(File.Exists)
                .ToImmutableArray();
            var pages = ReadItemPaths(root, "Page", projectDirectory);
            var xamlFiles = pages
                .Concat(applicationDefinitions)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .OrderBy(path => path, StringComparer.OrdinalIgnoreCase)
                .ToImmutableArray();

            var assetsFile = ReadProperty(root, "ProjectAssetsFile");
            if (!string.IsNullOrWhiteSpace(assetsFile) && !Path.IsPathRooted(assetsFile))
            {
                assetsFile = Path.Combine(projectDirectory, assetsFile);
            }

            return new Evaluation(
                xamlFiles,
                applicationDefinitions.FirstOrDefault(),
                string.IsNullOrWhiteSpace(assetsFile) ? null : Path.GetFullPath(assetsFile),
                CountItems(root, "PackageReference") > 0,
                ReadItemPaths(root, "ProjectReference", projectDirectory)
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .ToImmutableArray(),
                ReadProperty(root, "AssemblyName"));
        }

        /// <summary>
        /// Design-time build that yields the exact csc command line MSBuild would have invoked.
        /// </summary>
        /// <remarks>
        /// <c>-getItem:ReferencePath</c> looks like the obvious request but returns pre-target
        /// state and comes back empty; only the csc command line reflects the resolved closure.
        /// <c>SkipCompilerExecution</c> means csc never runs, so this call produces no source
        /// generator output -- that is <see cref="GeneratorHost"/>'s job.
        /// </remarks>
        internal static ImmutableArray<string> GetCscCommandLineArgs(
            string projectPath,
            IReadOnlyDictionary<string, string> globalProperties,
            CancellationToken cancellationToken = default)
        {
            var arguments = new List<string>
            {
                "msbuild",
                Path.GetFullPath(projectPath),
                "-nologo",
                // Compile, not Build/Rebuild: SkipCompilerExecution means no assembly is produced,
                // so the output-copy steps in Build fail with MSB3030. Compile stops before them.
                // It is also verified not to be skipped incrementally, even right after a
                // successful full build, so the args are always populated.
                "-t:Compile",
                // Referenced projects are compiled from source by the caller, which is what keeps
                // their types resolvable when they have never been built.
                "-p:BuildProjectReferences=false",
                "-p:ProvideCommandLineArgs=true",
                "-p:SkipCompilerExecution=true",
                "-p:DesignTimeBuild=true",
                "-p:DesignTimeSilentResolution=true",
                "-p:BuildingInsideVisualStudio=true",
                "-getItem:CscCommandLineArgs",
            };
            AppendProperties(arguments, globalProperties);

            var output = Run(
                arguments,
                Path.GetDirectoryName(Path.GetFullPath(projectPath)),
                DesignTimeBuildTimeout,
                cancellationToken,
                Path.GetFullPath(projectPath));
            using var document = ParseJson(output, projectPath);
            return ReadItemIdentities(document.RootElement, "CscCommandLineArgs");
        }

        private static void AppendProperties(
            List<string> arguments,
            IReadOnlyDictionary<string, string> globalProperties)
        {
            foreach (var pair in globalProperties)
            {
                if (string.IsNullOrWhiteSpace(pair.Key))
                {
                    continue;
                }

                arguments.Add($"-p:{pair.Key}={pair.Value}");
            }
        }

        /// <summary>
        /// Extracts the <c>-getItem</c>/<c>-getProperty</c> JSON payload from MSBuild's stdout.
        /// </summary>
        /// <remarks>
        /// Anchoring on the first <c>{</c> is not safe: MSBuild interleaves diagnostics ahead of
        /// the payload, and a warning containing a brace either desynchronizes the parse or --
        /// worse -- parses cleanly against a fragment and yields an empty result, which silently
        /// produces a compilation with no sources instead of an error. Each candidate offset is
        /// therefore tried in turn and accepted only if it parses <em>and</em> carries a key the
        /// request actually asked for.
        /// </remarks>
        private static JsonDocument ParseJson(string output, string projectPath)
        {
            JsonException? lastFailure = null;
            var start = output.IndexOf('{');
            while (start >= 0)
            {
                JsonDocument? candidate = null;
                try
                {
                    candidate = JsonDocument.Parse(output.Substring(start));
                }
                catch (JsonException ex)
                {
                    lastFailure = ex;
                }

                if (candidate != null)
                {
                    if (LooksLikeMsBuildResult(candidate.RootElement))
                    {
                        return candidate;
                    }

                    candidate.Dispose();
                }

                start = output.IndexOf('{', start + 1);
            }

            throw new MsBuildUnavailableException(
                $"MSBuild produced no usable JSON output for '{projectPath}'. Output: {Truncate(output)}",
                lastFailure);
        }

        /// <summary>
        /// MSBuild answers <c>-getItem</c>/<c>-getProperty</c> with an object holding these keys,
        /// so their presence distinguishes the payload from a brace inside a diagnostic message.
        /// </summary>
        private static bool LooksLikeMsBuildResult(JsonElement root) =>
            root.ValueKind == JsonValueKind.Object &&
            (root.TryGetProperty("Items", out _) ||
                root.TryGetProperty("Properties", out _) ||
                root.TryGetProperty("TargetResults", out _));

        private static string Truncate(string value) =>
            value.Length <= 4000 ? value : value.Substring(0, 4000) + "...";

        private static string? ReadProperty(JsonElement root, string name) =>
            root.TryGetProperty("Properties", out var properties) &&
            properties.ValueKind == JsonValueKind.Object &&
            properties.TryGetProperty(name, out var value) &&
            value.ValueKind == JsonValueKind.String
                ? value.GetString()
                : null;

        private static JsonElement.ArrayEnumerator? ItemArray(JsonElement root, string name) =>
            root.TryGetProperty("Items", out var items) &&
            items.ValueKind == JsonValueKind.Object &&
            items.TryGetProperty(name, out var array) &&
            array.ValueKind == JsonValueKind.Array
                ? array.EnumerateArray()
                : null;

        private static int CountItems(JsonElement root, string name)
        {
            var array = ItemArray(root, name);
            return array is null ? 0 : array.Value.Count();
        }

        private static ImmutableArray<string> ReadItemIdentities(JsonElement root, string name)
        {
            var array = ItemArray(root, name);
            if (array is null)
            {
                return ImmutableArray<string>.Empty;
            }

            var builder = ImmutableArray.CreateBuilder<string>();
            foreach (var item in array.Value)
            {
                if (item.ValueKind == JsonValueKind.Object &&
                    item.TryGetProperty("Identity", out var identity) &&
                    identity.ValueKind == JsonValueKind.String &&
                    identity.GetString() is { Length: > 0 } value)
                {
                    builder.Add(value);
                }
            }

            return builder.ToImmutable();
        }

        /// <summary>Prefers the FullPath metadata MSBuild attaches, falling back to the include.</summary>
        private static ImmutableArray<string> ReadItemPaths(
            JsonElement root,
            string name,
            string projectDirectory)
        {
            var array = ItemArray(root, name);
            if (array is null)
            {
                return ImmutableArray<string>.Empty;
            }

            var builder = ImmutableArray.CreateBuilder<string>();
            foreach (var item in array.Value)
            {
                if (item.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }

                string? path = null;
                if (item.TryGetProperty("FullPath", out var fullPath) &&
                    fullPath.ValueKind == JsonValueKind.String &&
                    fullPath.GetString() is { Length: > 0 } resolved)
                {
                    path = resolved;
                }
                else if (item.TryGetProperty("Identity", out var identity) &&
                    identity.ValueKind == JsonValueKind.String &&
                    identity.GetString() is { Length: > 0 } include)
                {
                    path = Path.Combine(projectDirectory, include);
                }

                if (path != null)
                {
                    builder.Add(Path.GetFullPath(path));
                }
            }

            return builder.ToImmutable();
        }

        private static string Run(
            IReadOnlyList<string> arguments,
            string? workingDirectory,
            TimeSpan timeout,
            CancellationToken cancellationToken,
            string? projectPath = null)
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = DotnetPath,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = workingDirectory ?? Environment.CurrentDirectory,
            };
            foreach (var argument in arguments)
            {
                startInfo.ArgumentList.Add(argument);
            }

            // MSBuild node reuse leaves worker processes alive between calls, which holds locks on
            // the project's obj directory and makes later invalidations flaky.
            startInfo.Environment["MSBUILDDISABLENODEREUSE"] = "1";
            startInfo.Environment["DOTNET_CLI_UI_LANGUAGE"] = "en";

            using var process = new Process { StartInfo = startInfo };
            var standardOutput = new StringBuilder();
            var standardError = new StringBuilder();
            process.OutputDataReceived += (_, e) => { if (e.Data != null) { standardOutput.AppendLine(e.Data); } };
            process.ErrorDataReceived += (_, e) => { if (e.Data != null) { standardError.AppendLine(e.Data); } };

            try
            {
                process.Start();
            }
            catch (Exception ex)
            {
                throw new MsBuildUnavailableException(
                    "Project-aware XAML features require the .NET SDK. " +
                    $"Failed to start '{startInfo.FileName} msbuild'.",
                    ex);
            }

            process.BeginOutputReadLine();
            process.BeginErrorReadLine();

            using var registration = cancellationToken.Register(() => TryKill(process));
            if (!process.WaitForExit((int)timeout.TotalMilliseconds))
            {
                TryKill(process);
                throw new MsBuildUnavailableException(
                    $"MSBuild did not complete within {timeout.TotalMinutes:0} minutes.");
            }

            // Flushes the async readers so no trailing output is lost.
            process.WaitForExit();
            cancellationToken.ThrowIfCancellationRequested();

            var combined = standardOutput.ToString();
            if (process.ExitCode != 0)
            {
                var detail = standardError.Length > 0 ? standardError.ToString() : combined;
                // The client only prompts for a path it can recognize as a project, so reporting
                // the working directory here silently dropped the prompt.
                var reportedPath = projectPath ?? workingDirectory ?? string.Empty;
                if (RoslynProjectWorkspace.IsMissingRestoreFailure(detail))
                {
                    throw new ProjectRestoreRequiredException(reportedPath);
                }

                // The markup compiler writes WMC1006 to stdout, so a non-empty stderr from an
                // unrelated warning would otherwise hide it and turn an actionable "build once"
                // into a generic MSBuild failure.
                var diagnosticText = standardError.Length > 0 && !ReferenceEquals(detail, combined)
                    ? detail + Environment.NewLine + combined
                    : detail;
                if (RoslynProjectWorkspace.IsUnbuiltProjectReferenceFailure(diagnosticText))
                {
                    throw new ProjectBuildRequiredException(
                        reportedPath,
                        RoslynProjectWorkspace.ExtractUnresolvedAssemblies(diagnosticText));
                }

                throw new MsBuildUnavailableException(
                    $"MSBuild exited with code {process.ExitCode}. {Truncate(detail)}");
            }

            return combined;
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
