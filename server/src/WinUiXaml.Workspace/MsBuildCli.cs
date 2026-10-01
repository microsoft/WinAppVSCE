using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
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
        public MsBuildUnavailableException(string message, Exception? innerException = null, bool hostMissing = false)
            : base(message, innerException)
        {
            HostMissing = hostMissing;
        }

        /// <summary>True when the failure is an absent <c>dotnet</c> host rather than a build error, which is the case the user can fix by installing the SDK.</summary>
        public bool HostMissing { get; }
    }

    /// <summary>Acquires MSBuild data by shelling out to <c>dotnet msbuild</c>, avoiding MSBuildLocator so Native AOT and trimming stay safe.</summary>
    internal static class MsBuildCli
    {
        /// <summary>MSBuild evaluation is cheap; a design-time build is not. Keep them separate.</summary>
        private static readonly TimeSpan EvaluateTimeout = TimeSpan.FromMinutes(2);
        private static readonly TimeSpan DesignTimeBuildTimeout = TimeSpan.FromMinutes(10);

        /// <summary>ERROR_FILE_NOT_FOUND, which is how a missing <c>dotnet</c> host surfaces from <see cref="Process.Start()"/>.</summary>
        private const int FileNotFoundNativeErrorCode = 2;

        /// <summary>Test seam: the server starts without .NET, so simulating its absence has to suppress the PATH fallback too.</summary>
        private static bool HostForcedMissing =>
            Environment.GetEnvironmentVariable("WINUI_XAML_FORCE_NO_DOTNET") == "1";

        internal readonly struct Evaluation
        {
            public Evaluation(
                ImmutableArray<string> xamlFiles,
                string? applicationDefinition,
                string? projectAssetsFile,
                bool hasPackageReferences,
                ImmutableArray<string> projectReferences,
                string? assemblyName,
                string? targetFrameworks = null,
                string? customAfterCSharpTargets = null)
            {
                XamlFiles = xamlFiles;
                ApplicationDefinition = applicationDefinition;
                ProjectAssetsFile = projectAssetsFile;
                HasPackageReferences = hasPackageReferences;
                ProjectReferences = projectReferences;
                AssemblyName = assemblyName;
                TargetFrameworks = targetFrameworks;
                CustomAfterCSharpTargets = customAfterCSharpTargets;
            }

            public ImmutableArray<string> XamlFiles { get; }
            public string? ApplicationDefinition { get; }
            public string? ProjectAssetsFile { get; }
            public bool HasPackageReferences { get; }
            public ImmutableArray<string> ProjectReferences { get; }
            public string? AssemblyName { get; }

            /// <summary>The project's semicolon-separated <c>TargetFrameworks</c>, or null for a single framework; non-null means an outer build with no <c>Compile</c> target.</summary>
            public string? TargetFrameworks { get; }

            /// <summary>The project's <c>CustomAfterMicrosoftCSharpTargets</c>, read during evaluation so the design-time build can claim the hook and re-import the user's targets.</summary>
            public string? CustomAfterCSharpTargets { get; }
        }

        /// <summary>The MSBuild host; preferring DOTNET_HOST_PATH keeps the server on the SDK the extension resolved.</summary>
        internal static string DotnetPath =>
            Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") is { Length: > 0 } host &&
            File.Exists(host)
                ? host
                : "dotnet";

        /// <summary>Evaluates without targets to pick an inner build when needed, then design-time-builds one framework for XAML items and csc args; this avoids MSB4057 from outer builds while preserving single-target projects.</summary>
        internal static (
            Evaluation Evaluation,
            ImmutableArray<string> CscCommandLineArgs,
            ImmutableArray<string> UnresolvedProjectReferences) EvaluateAndCompile(
            string projectPath,
            IReadOnlyDictionary<string, string> globalProperties,
            CancellationToken cancellationToken = default)
        {
            var fullPath = Path.GetFullPath(projectPath);
            return EvaluateAndCompileCore(
                fullPath,
                PinTargetFramework(fullPath, globalProperties, cancellationToken),
                ReadUserAfterCSharpTargets(fullPath, globalProperties, cancellationToken),
                cancellationToken);
        }

        /// <summary>Resolves design-time-build properties, selecting one inner build for cross-targeting projects unless the caller already pinned a framework.</summary>
        private static IReadOnlyDictionary<string, string> PinTargetFramework(
            string fullPath,
            IReadOnlyDictionary<string, string> globalProperties,
            CancellationToken cancellationToken)
        {
            if (globalProperties.ContainsKey(TargetFrameworkProperty))
            {
                return globalProperties;
            }

            var framework = SelectTargetFramework(
                ReadDeclaredTargetFrameworks(fullPath, globalProperties, cancellationToken));
            if (framework == null)
            {
                return globalProperties;
            }

            var pinned = globalProperties.ToDictionary(
                entry => entry.Key, entry => entry.Value, StringComparer.OrdinalIgnoreCase);
            pinned[TargetFrameworkProperty] = framework;
            return pinned;
        }

        /// <summary>Memo of declared <c>TargetFrameworks</c>, keyed by project path and global properties, and validated against a write stamp.</summary>
        private static readonly ConcurrentDictionary<string, (string Stamp, string? Declared, string? UserAfterCSharpTargets)>
            TargetFrameworkMemo = new(StringComparer.OrdinalIgnoreCase);

        /// <summary>Drops target-framework decisions when any imported <c>.props</c>/<c>.targets</c> under a root changes, covering imports MSBuild does not expose to the write stamp.</summary>
        internal static void ClearTargetFrameworkMemo() => TargetFrameworkMemo.Clear();

        /// <summary>Reads declared target frameworks from a memo keyed by path and global properties; invalidated by project/Directory.Build stamps and root-local imported build-file changes, avoiding repeated evaluation on C# saves while admitting only out-of-root arbitrary imports remain invisible.</summary>
        internal static string? ReadDeclaredTargetFrameworks(
            string fullPath,
            IReadOnlyDictionary<string, string> globalProperties,
            CancellationToken cancellationToken = default) =>
            ReadEvaluationMemo(fullPath, globalProperties, cancellationToken).Declared;

        /// <summary>Reads the user's <c>CustomAfterMicrosoftCSharpTargets</c> from the shared evaluation memo so the displacing targets file can re-import it at no extra cost.</summary>
        internal static string? ReadUserAfterCSharpTargets(
            string fullPath,
            IReadOnlyDictionary<string, string> globalProperties,
            CancellationToken cancellationToken = default) =>
            ReadEvaluationMemo(fullPath, globalProperties, cancellationToken).UserAfterCSharpTargets;

        private static (string? Declared, string? UserAfterCSharpTargets) ReadEvaluationMemo(
            string fullPath,
            IReadOnlyDictionary<string, string> globalProperties,
            CancellationToken cancellationToken)
        {
            fullPath = Path.GetFullPath(fullPath);
            var key = MemoKey(fullPath, globalProperties);
            var stamp = DeclaringFileStamp(fullPath);
            if (TargetFrameworkMemo.TryGetValue(key, out var memo) &&
                string.Equals(memo.Stamp, stamp, StringComparison.Ordinal))
            {
                return (memo.Declared, memo.UserAfterCSharpTargets);
            }

            var evaluation = Evaluate(fullPath, globalProperties, cancellationToken);
            TargetFrameworkMemo[key] =
                (stamp, evaluation.TargetFrameworks, evaluation.CustomAfterCSharpTargets);
            return (evaluation.TargetFrameworks, evaluation.CustomAfterCSharpTargets);
        }

        /// <summary>The memo key: project path plus global properties in stable order so equivalent dictionaries share one entry.</summary>
        private static string MemoKey(
            string fullPath, IReadOnlyDictionary<string, string> globalProperties)
        {
            if (globalProperties.Count == 0)
            {
                return fullPath;
            }

            var builder = new StringBuilder(fullPath);
            foreach (var entry in globalProperties.OrderBy(
                entry => entry.Key, StringComparer.OrdinalIgnoreCase))
            {
                builder.Append('|').Append(entry.Key).Append('=').Append(entry.Value);
            }

            return builder.ToString();
        }

        /// <summary>A stamp over the project and all ancestor <c>Directory.Build.props</c>/<c>.targets</c>; missing files contribute markers so creation is a change.</summary>
        private static string DeclaringFileStamp(string fullPath)
        {
            var builder = new StringBuilder();
            AppendStamp(builder, fullPath);

            var directory = Path.GetDirectoryName(fullPath);
            while (!string.IsNullOrEmpty(directory))
            {
                AppendStamp(builder, Path.Combine(directory, "Directory.Build.props"));
                AppendStamp(builder, Path.Combine(directory, "Directory.Build.targets"));
                directory = Path.GetDirectoryName(directory);
            }

            return builder.ToString();

            static void AppendStamp(StringBuilder builder, string path)
            {
                try
                {
                    var info = new FileInfo(path);
                    // Length joins the timestamp because a rewrite inside one filesystem tick is
                    // exactly the case a test -- or a scripted edit -- produces.
                    builder.Append(info.Exists
                        ? string.Create(
                            CultureInfo.InvariantCulture,
                            $"{info.LastWriteTimeUtc.Ticks}:{info.Length}")
                        : "-");
                }
                catch (Exception)
                {
                    // An unreadable stamp must not be mistaken for a stable one, or the memo
                    // would pin a framework the project no longer declares.
                    builder.Append(Guid.NewGuid().ToString("N"));
                }

                builder.Append('|');
            }
        }

        private static (
            Evaluation Evaluation,
            ImmutableArray<string> CscCommandLineArgs,
            ImmutableArray<string> UnresolvedProjectReferences) EvaluateAndCompileCore(
            string fullPath,
            IReadOnlyDictionary<string, string> globalProperties,
            string? userAfterCSharpTargets,
            CancellationToken cancellationToken)
        {
            var projectPath = fullPath;
            var arguments = new List<string>
            {
                "msbuild",
                fullPath,
                "-nologo",
                // ResolveReferences;CoreCompile avoids Compile running MarkupCompilePass1 first with no
                // ContinueOnError; entering at CoreCompile lets DesignTimeTargets run Visual
                // Studio's DesignTimeMarkupCompilation pass.
                "-t:ResolveReferences;CoreCompile",

                // Design-time builds default this to false (Microsoft.Common.CurrentVersion.targets
                // L375). Setting it lets never-built ProjectReferences build normally instead of
                // failing the markup compiler with WMC1006.
                "-p:BuildProjectReferences=true",
                "-p:ProvideCommandLineArgs=true",
                "-p:SkipCompilerExecution=true",
                "-p:DesignTimeBuild=true",
                "-p:DesignTimeSilentResolution=true",
                "-getItem:CscCommandLineArgs",
            };

            var designTimeTargets = DesignTimeTargets.Resolve();
            if (designTimeTargets != null)
            {
                arguments.Add($"-p:CustomAfterMicrosoftCSharpTargets={designTimeTargets}");

                // Displacing the hook is not taking it away: a global property cannot be overridden
                // by the project that set it, so the targets file re-imports the user's
                // after-targets instead of silently dropping them only in design-time builds.
                if (!string.IsNullOrWhiteSpace(userAfterCSharpTargets))
                {
                    arguments.Add($"-p:WinUiXamlUserAfterCSharpTargets={userAfterCSharpTargets}");
                }

                // Marks this project as the one being analysed. It is listed in the targets file's
                // remove-list, so a referenced project never sees it and is built normally.
                arguments.Add("-p:WinUiXamlDesignTimeRoot=true");
            }
            AppendEvaluationRequests(arguments);
            AppendProperties(arguments, globalProperties);

            string output;
            try
            {
                output = Run(
                    arguments, Path.GetDirectoryName(fullPath), DesignTimeBuildTimeout, cancellationToken, fullPath);
            }
            catch (ProjectBuildRequiredException ex)
            {
                // A referenced project could not be built, so markup generated no code.
                // Reference resolution stops before markup compilation, preserving SDK/package
                // references and keeping the rest navigable while the reference is fixed.
                var fallback = ResolveReferencesOnly(fullPath, globalProperties, cancellationToken);

                if (fallback.Arguments.IsDefaultOrEmpty)
                {
                    throw;
                }

                return (
                    fallback.Evaluation,
                    fallback.Arguments,
                    ex.UnresolvedAssemblies.ToImmutableArray());
            }

            using var document = ParseJson(output, projectPath);
            return (
                ReadEvaluation(document.RootElement, fullPath),
                ReadItemIdentities(document.RootElement, "CscCommandLineArgs"),
                ImmutableArray<string>.Empty);
        }

        /// <summary>Evaluation-only pass for XAML items, restore markers, and graph edges; running no targets lets <see cref="RoslynProjectWorkspace.RequiresRestore"/> answer first.</summary>
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

        /// <summary>Resolves SDK/package references after full design-time compile fails on an unbuilt <c>ProjectReference</c>; it shapes csc-style args for <see cref="CscCommandLine"/> but cannot recover markup-generated members, so callers still report that a build is required.</summary>
        internal static (Evaluation Evaluation, ImmutableArray<string> Arguments) ResolveReferencesOnly(
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
                "-t:ResolveReferences",
                "-p:BuildProjectReferences=false",
                "-p:DesignTimeBuild=true",
                "-p:DesignTimeSilentResolution=true",
                "-p:BuildingInsideVisualStudio=true",
                "-getItem:ReferencePath",
                "-getItem:Compile",
            };
            AppendEvaluationRequests(arguments);
            AppendProperties(arguments, globalProperties);

            var output = Run(
                arguments, Path.GetDirectoryName(fullPath), DesignTimeBuildTimeout, cancellationToken, fullPath);
            using var document = ParseJson(output, projectPath);
            var root = document.RootElement;
            var evaluation = ReadEvaluation(root, fullPath);

            var projectDirectory = Path.GetDirectoryName(fullPath)!;
            var synthesized = ImmutableArray.CreateBuilder<string>();
            foreach (var reference in ReadItemIdentities(root, "ReferencePath"))
            {
                synthesized.Add("/reference:" + reference);
            }

            // Bare .cs paths are what the parser treats as sources; anything else it ignores.
            foreach (var source in ReadItemPaths(root, "Compile", projectDirectory))
            {
                if (source.EndsWith(".cs", StringComparison.OrdinalIgnoreCase))
                {
                    synthesized.Add(source);
                }
            }

            if (!string.IsNullOrEmpty(evaluation.AssemblyName))
            {
                synthesized.Add("/out:" + evaluation.AssemblyName + ".dll");
            }

            return (evaluation, synthesized.ToImmutable());
        }

        /// <summary>Reference-only framework acquisition uses <see cref="ResolveReferencesOnly"/> with a pinned target framework, avoiding <see cref="EvaluateAndCompile"/> work it would discard: CoreCompile, markup compilation, analyzers, and real <c>ProjectReference</c> builds.</summary>
        internal static (Evaluation Evaluation, ImmutableArray<string> Arguments) ResolveFrameworkReferences(
            string projectPath,
            IReadOnlyDictionary<string, string> globalProperties,
            CancellationToken cancellationToken = default)
        {
            var fullPath = Path.GetFullPath(projectPath);
            return ResolveReferencesOnly(
                fullPath,
                PinTargetFramework(fullPath, globalProperties, cancellationToken),
                cancellationToken);
        }

        /// <summary>
        /// The MSBuild property that selects one inner build of a multi-targeted project.
        /// </summary>
        private const string TargetFrameworkProperty = "TargetFramework";

        /// <summary>Picks one inner build by preferring Windows, then the highest modern .NET version; Windows outranks version so WinUI consumers see platform-only APIs instead of silently compiling a non-Windows leg.</summary>
        internal static string? SelectTargetFramework(string? declared)
        {
            if (string.IsNullOrWhiteSpace(declared))
            {
                return null;
            }

            string? best = null;
            var bestRank = (Modern: false, Windows: false, Version: -1);
            foreach (var raw in declared!.Split(';'))
            {
                var candidate = raw.Trim();
                if (candidate.Length == 0)
                {
                    continue;
                }

                var rank = RankTargetFramework(candidate);
                if (best == null ||
                    (rank.Modern, rank.Windows, rank.Version).CompareTo(bestRank) > 0)
                {
                    best = candidate;
                    bestRank = rank;
                }
            }

            return best;
        }

        private static (bool Modern, bool Windows, int Version) RankTargetFramework(string framework)
        {
            // "net9.0" and "net9.0-windows10.0.26100.0" are modern; "netstandard2.0" and "net48"
            // are not. The digits before the first '.' separate them: a modern target always has
            // one, a net48-style target never does.
            if (!framework.StartsWith("net", StringComparison.OrdinalIgnoreCase))
            {
                return (false, false, -1);
            }

            var rest = framework.Substring(3);
            var dot = rest.IndexOf('.');
            if (dot <= 0 ||
                !int.TryParse(rest.Substring(0, dot), out var major))
            {
                return (false, false, -1);
            }

            // The platform follows the version after a '-': "net9.0-windows10.0.26100.0".
            var dash = rest.IndexOf('-');
            var windows = dash >= 0 &&
                rest.Substring(dash + 1).StartsWith("windows", StringComparison.OrdinalIgnoreCase);

            return (true, windows, major);
        }

        private static void AppendEvaluationRequests(List<string> arguments)
        {
            arguments.Add("-getItem:Page");
            arguments.Add("-getItem:ApplicationDefinition");
            arguments.Add("-getItem:PackageReference");
            arguments.Add("-getItem:ProjectReference");
            arguments.Add("-getProperty:ProjectAssetsFile");
            arguments.Add("-getProperty:AssemblyName");
            arguments.Add("-getProperty:TargetFrameworks");
            arguments.Add("-getProperty:CustomAfterMicrosoftCSharpTargets");
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
                ReadProperty(root, "AssemblyName"),
                ReadProperty(root, "TargetFrameworks"),
                ReadProperty(root, "CustomAfterMicrosoftCSharpTargets"));
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

        /// <summary>Extracts MSBuild's JSON payload by trying each brace offset until it parses and contains requested keys, avoiding diagnostics with braces becoming empty compilations.</summary>
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

        /// <summary>MSBuild <c>-getItem</c>/<c>-getProperty</c> payloads carry these keys, distinguishing them from braces in diagnostics.</summary>
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
            return RunGated(
                projectPath,
                workingDirectory,
                cancellationToken,
                () =>
                {
                    for (var attempt = 0; ; attempt++)
                    {
                        try
                        {
                            return RunCore(
                                arguments, workingDirectory, timeout, cancellationToken, projectPath);
                        }
                        catch (MsBuildUnavailableException ex)
                            when (attempt < ObjContentionRetries && IsProjectFileInUseFailure(ex.Message))
                        {
                            // The gate only covers this process. A build running in a terminal or
                            // another extension holds the same files, and that contention is transient.
                            cancellationToken.ThrowIfCancellationRequested();
                            Thread.Sleep(TimeSpan.FromMilliseconds(250 * (attempt + 1)));
                    }
                }
            });
        }

        /// <summary>Runs <paramref name="body"/> with exclusive access to a project's obj directory, serializing same-project MSBuild calls so markup output contention is testable without a real contending build.</summary>
        internal static T RunGated<T>(
            string? projectPath,
            string? workingDirectory,
            CancellationToken cancellationToken,
            Func<T> body)
        {
            var gate = ProjectGates.GetOrAdd(
                ProjectGateKey(projectPath, workingDirectory),
                _ => new SemaphoreSlim(1, 1));
            gate.Wait(cancellationToken);
            try
            {
                return body();
            }
            finally
            {
                gate.Release();
            }
        }

        /// <summary>Serializes invocations that would write the same project's intermediate output.</summary>
        private static readonly ConcurrentDictionary<string, SemaphoreSlim> ProjectGates =
            new ConcurrentDictionary<string, SemaphoreSlim>(StringComparer.OrdinalIgnoreCase);

        private const int ObjContentionRetries = 3;

        /// <summary>Keys gates by intermediate-output owner directory, not project file or disk probes, so callers with different argument forms still exclude each other while unrelated projects run in parallel.</summary>
        internal static string ProjectGateKey(string? projectPath, string? workingDirectory)
        {
            try
            {
                if (!string.IsNullOrEmpty(projectPath))
                {
                    // Always a project file, so its directory is the obj tree's owner.
                    var full = Path.GetFullPath(projectPath!);
                    return Path.GetDirectoryName(full) is { Length: > 0 } directory
                        ? directory
                        : full;
                }

                return !string.IsNullOrEmpty(workingDirectory)
                    ? Path.GetFullPath(workingDirectory!)
                    : Environment.CurrentDirectory;
            }
            catch (ArgumentException)
            {
                return Fallback(projectPath, workingDirectory);
            }
            catch (IOException)
            {
                return Fallback(projectPath, workingDirectory);
            }
            catch (NotSupportedException)
            {
                return Fallback(projectPath, workingDirectory);
            }

            static string Fallback(string? projectPath, string? workingDirectory) =>
                !string.IsNullOrEmpty(projectPath)
                    ? projectPath!
                    : !string.IsNullOrEmpty(workingDirectory)
                        ? workingDirectory!
                        : Environment.CurrentDirectory;
        }

        /// <summary>Whether MSBuild reported an English file-in-use failure worth retrying; calls force <c>DOTNET_CLI_UI_LANGUAGE=en</c>.</summary>
        internal static bool IsProjectFileInUseFailure(string? detail) =>
            detail is not null &&
            detail.Contains("being used by another process", StringComparison.OrdinalIgnoreCase);

        private static string RunCore(
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

            // One node per invocation: design-time builds now build ProjectReferences, so multi-node
            // calls plus disabled node reuse can create process storms under concurrent loads, with
            // little parallelism to win for these small project sets.
            startInfo.ArgumentList.Add("-maxcpucount:1");

            var (exitCode, combined, standardError) = RunProcess(startInfo, timeout, cancellationToken);

            if (exitCode != 0)
            {
                // The client only prompts for a path it can recognize as a project, so prefer the
                // project path over the working directory.
                throw ClassifyFailure(
                    exitCode, combined, standardError, projectPath ?? workingDirectory ?? string.Empty);
            }

            return combined;
        }

        /// <summary>Maps a failed MSBuild invocation onto the action the user can take -- restore, build once, or nothing. Separated from the child-process call so each mapping is testable from the output that produces it rather than from a build engineered to fail that way.</summary>
        internal static Exception ClassifyFailure(
            int exitCode,
            string combined,
            string standardError,
            string reportedPath)
        {
            var detail = standardError.Length > 0 ? standardError : combined;
            if (RoslynProjectWorkspace.IsMissingRestoreFailure(detail))
            {
                return new ProjectRestoreRequiredException(reportedPath);
            }

            // The markup compiler writes WMC1006 to stdout, so a non-empty stderr from an
            // unrelated warning would otherwise hide it and turn an actionable "build once"
            // into a generic MSBuild failure.
            var diagnosticText = standardError.Length > 0 && !ReferenceEquals(detail, combined)
                ? detail + Environment.NewLine + combined
                : detail;
            if (RoslynProjectWorkspace.ExtractFailedReferencedProjects(diagnosticText, reportedPath)
                is { Count: > 0 } failedReferences)
            {
                return new ProjectBuildRequiredException(reportedPath, failedReferences);
            }

            if (RoslynProjectWorkspace.IsUnbuiltProjectReferenceFailure(diagnosticText))
            {
                return new ProjectBuildRequiredException(
                    reportedPath,
                    RoslynProjectWorkspace.ExtractUnresolvedAssemblies(diagnosticText));
            }

            // A runtime-only install starts dotnet and then fails to find msbuild, so the SDK
            // requirement only shows up in the output rather than as a start failure.
            if (IsMissingSdkFailure(diagnosticText))
            {
                return new MsBuildUnavailableException(
                    "Project-aware XAML features require the .NET SDK. " +
                    $"'dotnet msbuild' is unavailable. {Truncate(detail)}",
                    hostMissing: true);
            }

            return new MsBuildUnavailableException(
                $"MSBuild exited with code {exitCode}. {Truncate(detail)}");
        }

        /// <summary>Recognizes a dotnet host without a usable SDK, which the muxer reports as a missing SDK or as an unknown command because <c>msbuild</c> ships in the SDK.</summary>
        internal static bool IsMissingSdkFailure(string message) =>
            message.Contains("No .NET SDKs were found", StringComparison.OrdinalIgnoreCase) ||
            message.Contains("A compatible .NET SDK was not found", StringComparison.OrdinalIgnoreCase) ||
            message.Contains("could not be found or is not compatible", StringComparison.OrdinalIgnoreCase) ||
            (message.Contains("specified command or file was not found", StringComparison.OrdinalIgnoreCase) &&
             message.Contains("msbuild", StringComparison.OrdinalIgnoreCase));

        /// <summary>Runs a child with event-drained pipes, timeout, and cancellation; split out to test hang cases without a real build and avoid <c>ReadToEnd</c> deadlocks.</summary>
        internal static (int ExitCode, string StandardOutput, string StandardError) RunProcess(
            ProcessStartInfo startInfo, TimeSpan timeout, CancellationToken cancellationToken)
        {
            using var process = new Process { StartInfo = startInfo };
            var standardOutput = new StringBuilder();
            var standardError = new StringBuilder();
            process.OutputDataReceived += (_, e) => { if (e.Data != null) { standardOutput.AppendLine(e.Data); } };
            process.ErrorDataReceived += (_, e) => { if (e.Data != null) { standardError.AppendLine(e.Data); } };

            if (HostForcedMissing)
            {
                throw new MsBuildUnavailableException(
                    "Project-aware XAML features require the .NET SDK. " +
                    $"Failed to start '{startInfo.FileName} msbuild'.",
                    hostMissing: true);
            }

            try
            {
                process.Start();
            }
            catch (Exception ex)
            {
                throw new MsBuildUnavailableException(
                    "Project-aware XAML features require the .NET SDK. " +
                    $"Failed to start '{startInfo.FileName} msbuild'.",
                    ex,
                    hostMissing: ex is Win32Exception { NativeErrorCode: FileNotFoundNativeErrorCode });
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

            return (process.ExitCode, standardOutput.ToString(), standardError.ToString());
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
