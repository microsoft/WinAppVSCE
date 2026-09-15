using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Collections.Immutable;
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
                string? assemblyName,
                string? targetFrameworks = null,
                string? customAfterCommonTargets = null)
            {
                XamlFiles = xamlFiles;
                ApplicationDefinition = applicationDefinition;
                ProjectAssetsFile = projectAssetsFile;
                HasPackageReferences = hasPackageReferences;
                ProjectReferences = projectReferences;
                AssemblyName = assemblyName;
                TargetFrameworks = targetFrameworks;
                CustomAfterCommonTargets = customAfterCommonTargets;
            }

            public ImmutableArray<string> XamlFiles { get; }
            public string? ApplicationDefinition { get; }
            public string? ProjectAssetsFile { get; }
            public bool HasPackageReferences { get; }
            public ImmutableArray<string> ProjectReferences { get; }
            public string? AssemblyName { get; }

            /// <summary>
            /// The project's declared <c>TargetFrameworks</c>, semicolon-separated, or null when
            /// the project targets exactly one framework. Non-null is precisely the condition
            /// that makes this an outer build with no <c>Compile</c> target.
            /// </summary>
            public string? TargetFrameworks { get; }

            /// <summary>
            /// The project's own <c>CustomAfterMicrosoftCommonTargets</c>, if it sets one. The
            /// shadow-reference repair claims that hook, so it has to re-import whatever the user
            /// had there or the repair would silently delete part of their build.
            /// </summary>
            public string? CustomAfterCommonTargets { get; }
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
        /// Evaluates the project, then runs the design-time build for exactly one target
        /// framework, returning the XAML items and the csc command line together.
        /// </summary>
        /// <remarks>
        /// The evaluation pass runs no targets, so it answers for any project state -- unrestored,
        /// never built, single- or multi-targeted. That is what lets the target framework be
        /// *decided* rather than discovered by failing: a multi-targeted project's outer build
        /// defines no <c>Compile</c> target, so asking it to compile dies with MSB4057 and the
        /// project is dropped, silently costing the user every type in it. Only an inner build has
        /// that target. Pinning <c>TargetFramework</c> selects one, and pinning it on a project
        /// that already targets one framework is a no-op -- so a single build shape serves both.
        ///
        /// The old MSBuildWorkspace evaluated before selecting an inner build for the same reason,
        /// which is why nothing above this layer expects to have to.
        /// </remarks>
        internal static (
            Evaluation Evaluation,
            ImmutableArray<string> CscCommandLineArgs,
            ImmutableArray<string> UnresolvedProjectReferences) EvaluateAndCompile(
            string projectPath,
            IReadOnlyDictionary<string, string> globalProperties,
            CancellationToken cancellationToken = default,
            ShadowReferenceRepair? repair = null)
        {
            var fullPath = Path.GetFullPath(projectPath);
            return EvaluateAndCompileCore(
                fullPath,
                PinTargetFramework(fullPath, globalProperties, cancellationToken),
                cancellationToken,
                repair);
        }

        /// <summary>
        /// Supplies shadow assemblies for referenced projects the markup compiler could not
        /// resolve. Returns null when nothing could be produced, which leaves the caller on the
        /// reference-only result.
        /// </summary>
        /// <remarks>
        /// The names the markup compiler reported are deliberately not passed in. It abandons its
        /// schema context at the first assembly it cannot load, so that list is a lower bound on
        /// what is missing, not the set; repairing only what it named would leave the next one
        /// unresolved and turn one failed build into several. Every referenced project is
        /// supplied instead, and the injected targets substitute only the paths that are actually
        /// absent.
        /// </remarks>
        /// <param name="evaluation">The failing project's evaluation, including its graph edges.</param>
        internal delegate ShadowReferenceInjection? ShadowReferenceRepair(Evaluation evaluation);

        /// <summary>
        /// Points a design-time build at a directory of stand-in assemblies.
        /// </summary>
        /// <remarks>
        /// The stand-ins deliberately do not live in the referenced project's own output folder.
        /// Writing there would make MSBuild consider that project built, so the user's next real
        /// build would skip it and any other tool reading <c>bin</c> would see a file no build
        /// produced. Redirecting <c>ReferencePath</c> instead keeps the fiction inside this
        /// process's scratch directory.
        /// </remarks>
        internal sealed class ShadowReferenceInjection
        {
            public ShadowReferenceInjection(string directory, string targetsFile, string? chainedCustomAfterTargets)
            {
                Directory = directory;
                TargetsFile = targetsFile;
                ChainedCustomAfterTargets = chainedCustomAfterTargets;
            }

            public string Directory { get; }
            public string TargetsFile { get; }

            /// <summary>The value this injection displaces, re-imported by the generated targets.</summary>
            public string? ChainedCustomAfterTargets { get; }

            internal void AppendTo(List<string> arguments)
            {
                arguments.Add($"-p:CustomAfterMicrosoftCommonTargets={TargetsFile}");
                arguments.Add($"-p:WinUiXamlShadowReferenceDir={Directory}");
                if (!string.IsNullOrWhiteSpace(ChainedCustomAfterTargets))
                {
                    arguments.Add(
                        $"-p:WinUiXamlChainedCustomAfterTargets={ChainedCustomAfterTargets}");
                }
            }
        }

        /// <summary>
        /// Resolves the properties the design-time build runs under, selecting one inner build
        /// when the project cross-targets. A caller that already pinned a framework is left alone.
        /// </summary>
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

        /// <summary>
        /// Memo of each project's declared <c>TargetFrameworks</c>, keyed by the project path and
        /// the global properties it was evaluated under, and validated against a write stamp.
        /// </summary>
        private static readonly ConcurrentDictionary<string, (string Stamp, string? Declared)>
            TargetFrameworkMemo = new(StringComparer.OrdinalIgnoreCase);

        /// <summary>
        /// Drops every memoized target-framework decision.
        /// </summary>
        /// <remarks>
        /// Called when an imported build file changes. The write stamp cannot cover that case on
        /// its own: a project is free to <c>&lt;Import&gt;</c> an arbitrarily named
        /// <c>.props</c> file -- <c>build/Common.props</c> is a common repo convention -- and
        /// MSBuild will not name its import closure when asked. <c>-getProperty:MSBuildAllProjects</c>
        /// returns the project and a couple of SDK targets, not the file that actually declared
        /// the property, so there is nothing to stamp. The language server already treats every
        /// <c>.props</c>/<c>.targets</c> change under a workspace root as structural and drops all
        /// projects; this hangs the memo on that same signal so it can never outlive the
        /// compilations it fed.
        /// </remarks>
        internal static void ClearTargetFrameworkMemo() => TargetFrameworkMemo.Clear();

        /// <summary>
        /// The declared target frameworks, evaluated at most once per edit of the files that can
        /// declare them.
        /// </summary>
        /// <remarks>
        /// Deciding the framework costs a full evaluation pass, and the project reloads on every
        /// C# save -- but a C# edit cannot change which frameworks a project targets, so re-asking
        /// is provably repeated work.
        ///
        /// Two independent things invalidate the answer, because neither covers the other:
        /// <list type="bullet">
        /// <item>the write stamp, which covers the project file and the
        /// <c>Directory.Build.props</c>/<c>.targets</c> chain above it -- including the part of
        /// that chain that sits *outside* the workspace roots, where no file-change notification
        /// ever arrives;</item>
        /// <item><see cref="ClearTargetFrameworkMemo"/>, which covers an arbitrarily named
        /// imported <c>.props</c>/<c>.targets</c> file inside a root, which the stamp cannot
        /// enumerate.</item>
        /// </list>
        /// The remaining gap is an arbitrarily named import located outside every workspace root:
        /// unreachable by either signal, and equally invisible to the rest of the server.
        ///
        /// The key carries the global properties as well as the path, because
        /// <c>TargetFrameworks</c> can be declared under a condition on <c>$(Configuration)</c> or
        /// <c>$(Platform)</c> -- evaluating under one and answering for another would pin a
        /// framework the project does not declare.
        /// </remarks>
        internal static string? ReadDeclaredTargetFrameworks(
            string fullPath,
            IReadOnlyDictionary<string, string> globalProperties,
            CancellationToken cancellationToken = default)
        {
            fullPath = Path.GetFullPath(fullPath);
            var key = MemoKey(fullPath, globalProperties);
            var stamp = DeclaringFileStamp(fullPath);
            if (TargetFrameworkMemo.TryGetValue(key, out var memo) &&
                string.Equals(memo.Stamp, stamp, StringComparison.Ordinal))
            {
                return memo.Declared;
            }

            var declared = Evaluate(fullPath, globalProperties, cancellationToken).TargetFrameworks;
            TargetFrameworkMemo[key] = (stamp, declared);
            return declared;
        }

        /// <summary>
        /// The memo key: the project path plus the global properties it is evaluated under, in a
        /// stable order so two equivalent dictionaries cannot produce two entries.
        /// </summary>
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

        /// <summary>
        /// A stamp over the project file and every <c>Directory.Build.props</c>/<c>.targets</c>
        /// above it. A file that does not exist contributes a marker, so creating one later is
        /// itself a change.
        /// </summary>
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
            CancellationToken cancellationToken,
            ShadowReferenceRepair? repair = null,
            ShadowReferenceInjection? shadow = null)
        {
            var projectPath = fullPath;
            var arguments = new List<string>
            {
                "msbuild",
                fullPath,
                "-nologo",
                // ResolveReferences;CoreCompile rather than Compile: MarkupCompilePass1 hangs off
                // PrepareResourcesDependsOn, which Compile runs first, and it has no
                // ContinueOnError. Entering at CoreCompile instead lets DesignTimeTargets run the
                // DesignTimeMarkupCompilation pass, which is the one Visual Studio uses.
                "-t:ResolveReferences;CoreCompile",

                // Design-time builds default this to false (Microsoft.Common.CurrentVersion
                // .targets L375). Asking for it explicitly is what lets a never-built
                // ProjectReference be built here instead of failing the markup compiler with
                // WMC1006; DesignTimeTargets strips the design-time properties on the way down so
                // the reference gets an ordinary build.
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

                // Marks this project as the one being analysed. It is listed in the targets file's
                // remove-list, so a referenced project never sees it and is built normally.
                arguments.Add("-p:WinUiXamlDesignTimeRoot=true");
            }
            shadow?.AppendTo(arguments);
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
                // The markup compiler aborted because a referenced project has never been built.
                // Reference resolution stops short of it, so it still yields the SDK and package
                // references on a never-built tree, and it also hands back the project graph the
                // repair needs.
                var fallback = ResolveReferencesOnly(fullPath, globalProperties, cancellationToken);

                // Repair rather than degrade: the referenced projects are compiled from source
                // anyway, so emitting those compilations to a scratch directory and pointing the
                // markup compiler at them produces the same generated code a real build would.
                // This runs only on the path that is otherwise broken, so a healthy project still
                // costs exactly one MSBuild invocation.
                if (repair != null && shadow == null)
                {
                    var injection = repair(fallback.Evaluation);
                    if (injection != null)
                    {
                        try
                        {
                            return EvaluateAndCompileCore(
                                fullPath, globalProperties, cancellationToken, repair: null, shadow: injection);
                        }
                        catch (ProjectBuildRequiredException)
                        {
                            // The shadow assemblies did not satisfy the markup compiler either.
                            // Fall through to the reference-only result below.
                        }
                    }
                }

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

        /// <summary>
        /// Reference-resolution pass used when the full design-time compile aborts because a
        /// referenced project has never been built.
        /// </summary>
        /// <remarks>
        /// The WinUI markup compiler (MarkupCompilePass1) runs ahead of CoreCompile and hard-fails
        /// with WMC1006 when a <c>ProjectReference</c>'s output assembly is missing, which takes
        /// the whole compile down and leaves <c>CscCommandLineArgs</c> empty. <c>ResolveReferences</c>
        /// stops short of the markup compiler, so it still resolves the SDK and package references
        /// on a never-built tree. The result is shaped into csc-style arguments so the existing
        /// <see cref="CscCommandLine"/> parser consumes it unchanged.
        ///
        /// What this cannot recover is the markup compiler's generated output (InitializeComponent
        /// and the x:Name backing fields), so the caller still reports that a build is required --
        /// this degrades the outage to a partial loss instead of serving nothing.
        /// </remarks>
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

        /// <summary>
        /// The MSBuild property that selects one inner build of a multi-targeted project.
        /// </summary>
        private const string TargetFrameworkProperty = "TargetFramework";

        /// <summary>
        /// Picks the inner build to load for a multi-targeted project. Preferring a Windows target,
        /// then the highest modern .NET version, approximates what a consuming app resolves to, and
        /// it is the target most likely to expose the project's full API surface; a
        /// <c>netstandard</c> leg is the compatibility shim. This is a heuristic, not NuGet's
        /// resolution -- but loading one reasonable framework is strictly better than the
        /// alternative of loading none.
        /// </summary>
        /// <remarks>
        /// Windows outranks version because every project this server loads is consumed by a WinUI
        /// app, and NuGet's own reducer prefers a matching platform over a nearer version. Ranking
        /// by version alone made <c>net8.0</c> and <c>net8.0-windows10.0.19041.0</c> tie, so the
        /// leg declared first won -- and a library whose Windows-only types sit behind
        /// <c>#if WINDOWS</c> would be compiled without them, leaving its controls unresolvable in
        /// XAML for no reason the user could see.
        /// </remarks>
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
            arguments.Add("-getProperty:CustomAfterMicrosoftCommonTargets");
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
                ReadProperty(root, "CustomAfterMicrosoftCommonTargets"));
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

        /// <summary>
        /// Runs <paramref name="body"/> with exclusive access to one project's intermediate output
        /// directory.
        /// </summary>
        /// <remarks>
        /// Two MSBuild invocations against one project race on that project's obj directory -- the
        /// WinUI markup compiler writes output.json from the Compile target chain, so the loser
        /// dies with "being used by another process". Both stages of a load (the fast framework
        /// resolve and the authoritative one) target the same csproj, and the in-process
        /// BuildManager this replaced serialized them for free. Shelling out does not, so the gate
        /// has to be explicit.
        ///
        /// This is a separate method so the exclusion itself can be tested. Driving it through a
        /// real build would need a project that actually contends, and a fixture that does not
        /// contend produces a test that passes whether or not the gate is there at all.
        /// </remarks>
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

        /// <summary>
        /// The directory an invocation writes its intermediate output under. Keying on the
        /// directory rather than the project file matters: callers are inconsistent about
        /// supplying <c>projectPath</c>, and two invocations that disagree about the key would not
        /// exclude each other -- which is the whole point. Keying per directory rather than
        /// globally still lets unrelated projects load in parallel, since they own different obj
        /// trees.
        ///
        /// The two forms are told apart by which argument was supplied, never by probing the disk.
        /// An earlier version asked <c>Directory.Exists</c>, which made the key depend on whether
        /// the path happened to exist yet -- so the same project could take two different gates.
        /// </summary>
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

        /// <summary>
        /// Whether a failure is another process holding a file this build needed, which is worth
        /// retrying. MSBuild reports it as plain text, and the invocation forces
        /// <c>DOTNET_CLI_UI_LANGUAGE=en</c>, so matching the English phrasing is sound here.
        /// </summary>
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

            // One node per invocation. Now that a design-time build builds the project references
            // it is given, a multi-node build would fan each call out to a set of worker processes
            // that node reuse is not allowed to recycle, and several concurrent loads turn that
            // into a process storm. The work here is a handful of projects, so there is little to
            // win from parallelism and a great deal to lose from oversubscription.
            startInfo.ArgumentList.Add("-maxcpucount:1");

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
