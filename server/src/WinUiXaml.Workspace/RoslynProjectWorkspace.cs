using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;

namespace WinUiXaml.Workspace
{
    public sealed class ProjectRestoreRequiredException : InvalidOperationException
    {
        public ProjectRestoreRequiredException(string projectPath, Exception? innerException = null)
            : base("Project packages must be restored before project-aware XAML features are available.", innerException)
        {
            ProjectPath = projectPath;
        }

        public string ProjectPath { get; }
    }

    /// <summary>
    /// Clean-clone failure where missing referenced assemblies make WinUI markup abort before <c>CoreCompile</c>; naming them turns silent total outage into a build-required diagnostic.
    /// </summary>
    public sealed class ProjectBuildRequiredException : InvalidOperationException
    {
        public ProjectBuildRequiredException(
            string projectPath, IReadOnlyList<string> unresolvedAssemblies, Exception? innerException = null)
            : base(
                BuildMessage(unresolvedAssemblies),
                innerException)
        {
            ProjectPath = projectPath;
            UnresolvedAssemblies = unresolvedAssemblies;
        }

        public string ProjectPath { get; }

        /// <summary>Assemblies the markup compiler could not resolve, most useful as project names.</summary>
        public IReadOnlyList<string> UnresolvedAssemblies { get; }

        private static string BuildMessage(IReadOnlyList<string> unresolvedAssemblies)
        {
            var names = unresolvedAssemblies.Count == 0
                ? "a referenced project"
                : string.Join(", ", unresolvedAssemblies);
            return $"Referenced project output is missing ({names}) and could not be produced " +
                "from source. Types defined there will not resolve in XAML.";
        }
    }

    /// <summary>
    /// Host B spine: loads real projects via out-of-process MSBuild data and direct <c>CSharpCompilation.Create</c>, avoiding Workspaces APIs that fail under Native AOT while preserving behavior.
    /// </summary>
    public sealed class RoslynProjectWorkspace : IDisposable
    {
        private readonly ImmutableHashSet<string> _projectPaths;

        private RoslynProjectWorkspace(
            Compilation compilation,
            ImmutableArray<MetadataReference> metadataReferences,
            CSharpCompilationOptions compilationOptions,
            string assemblyName,
            ImmutableHashSet<string> projectPaths,
            ImmutableArray<string> xamlFiles,
            string? applicationDefinitionPath,
            ImmutableArray<string> unresolvedProjectReferences)
        {
            Compilation = compilation;
            MetadataReferences = metadataReferences;
            CompilationOptions = compilationOptions;
            AssemblyName = assemblyName;
            _projectPaths = projectPaths;
            XamlFiles = xamlFiles;
            ApplicationDefinitionPath = applicationDefinitionPath;
            UnresolvedProjectReferences = unresolvedProjectReferences.IsDefault
                ? ImmutableArray<string>.Empty
                : unresolvedProjectReferences;
        }

        /// <summary>The compilation for the loaded project, including source-generated members.</summary>
        public Compilation Compilation { get; }

        /// <summary>The resolved reference closure MSBuild selected for the project.</summary>
        public ImmutableArray<MetadataReference> MetadataReferences { get; }

        public CSharpCompilationOptions CompilationOptions { get; }
        public string AssemblyName { get; }
        public ImmutableArray<string> XamlFiles { get; }
        public string? ApplicationDefinitionPath { get; }

        /// <summary>
        /// Non-empty after reference-resolution fallback: IntelliSense has real types, but markup/compiler generated members still require a build.
        /// </summary>
        public ImmutableArray<string> UnresolvedProjectReferences { get; }

        /// <summary>Loads a single project by path.</summary>
        public static Task<RoslynProjectWorkspace> LoadProjectAsync(
            string projectPath,
            IDictionary<string, string>? globalProperties = null,
            CancellationToken cancellationToken = default)
        {
            if (projectPath == null)
            {
                throw new ArgumentNullException(nameof(projectPath));
            }

            var properties = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (globalProperties != null)
            {
                foreach (var pair in globalProperties)
                {
                    properties[pair.Key] = pair.Value;
                }
            }

            // The MSBuild and generator work is spent waiting on child processes and parsing, so it
            // runs on the thread pool to keep the LSP dispatch loop responsive.
            return Task.Run(() => Load(projectPath, properties, cancellationToken), cancellationToken);
        }

        private static RoslynProjectWorkspace Load(
            string projectPath,
            Dictionary<string, string> properties,
            CancellationToken cancellationToken)
        {
            var fullPath = Path.GetFullPath(projectPath);

            // Referenced projects compile from source so types resolve before outputs exist,
            // matching MSBuildWorkspace's LoadMetadataForReferencedProjects=false; the shared graph
            // also feeds markup-compiler repair and builds each project once.
            var graph = new ProjectGraphContext(fullPath);
            var (evaluation, arguments, unresolvedProjectReferences) =
                AcquireProjectData(fullPath, properties, cancellationToken, graph);

            cancellationToken.ThrowIfCancellationRequested();
            var commandLine = arguments.IsDefaultOrEmpty
                ? CscCommandLine.Empty
                : CscCommandLine.Parse(arguments, Path.GetDirectoryName(fullPath)!);
            var assemblyName = commandLine.AssemblyName
                ?? evaluation.AssemblyName
                ?? Path.GetFileNameWithoutExtension(fullPath);

            var parseOptions = commandLine.CreateParseOptions();
            var trees = ImmutableArray.CreateBuilder<SyntaxTree>();
            AddSourceTrees(trees, commandLine.Sources, parseOptions, cancellationToken);

            // Source generators run out-of-process because Native AOT cannot load analyzer
            // assemblies. Their output is parsed here as ordinary source, which is what keeps
            // {x:Bind} accurate against generated members such as [ObservableProperty].
            var generated = GeneratorHostRunner.Run(fullPath, assemblyName, commandLine, cancellationToken);
            AddSourceTrees(trees, generated, parseOptions, cancellationToken);

            var projectCompilations = ImmutableArray.CreateBuilder<MetadataReference>();
            AddProjectReferences(
                projectCompilations,
                graph,
                evaluation.ProjectReferences,
                properties,
                cancellationToken);

            var references = ImmutableArray.CreateBuilder<MetadataReference>();
            references.AddRange(WithoutSupersededProjectOutputs(
                commandLine.CreateMetadataReferences(), projectCompilations));
            references.AddRange(projectCompilations);

            var options = commandLine.CreateCompilationOptions();
            var allReferences = references.ToImmutable();
            var compilation = CSharpCompilation.Create(
                assemblyName,
                trees.ToImmutable(),
                allReferences,
                options);

            return new RoslynProjectWorkspace(
                compilation,
                allReferences,
                options,
                assemblyName,
                graph.KnownProjects.ToImmutable(),                evaluation.XamlFiles,
                evaluation.ApplicationDefinition,
                unresolvedProjectReferences);
        }

        /// <summary>Acquires evaluation and csc args in one MSBuild call, falling back to evaluation so unrestored projects report packages-not-restored instead of opaque build failure.</summary>
        /// <param name="graph">When supplied, repairs unresolved project references with stand-in compilations; omitted for referenced projects whose markup output is unused.</param>
        private static (
            MsBuildCli.Evaluation Evaluation,
            ImmutableArray<string> Arguments,
            ImmutableArray<string> UnresolvedProjectReferences) AcquireProjectData(
            string fullPath,
            Dictionary<string, string> properties,
            CancellationToken cancellationToken,
            ProjectGraphContext? graph = null)
        {
            try
            {
                var combined = MsBuildCli.EvaluateAndCompile(
                    fullPath,
                    properties,
                    cancellationToken);
                if (RequiresRestore(
                        combined.Evaluation.ProjectAssetsFile,
                        combined.Evaluation.HasPackageReferences))
                {
                    throw new ProjectRestoreRequiredException(fullPath);
                }

                return (
                    combined.Evaluation,
                    combined.CscCommandLineArgs,
                    combined.UnresolvedProjectReferences);
            }
            catch (MsBuildUnavailableException ex)
            {
                var evaluation = MsBuildCli.Evaluate(fullPath, properties, cancellationToken);
                if (RequiresRestore(evaluation.ProjectAssetsFile, evaluation.HasPackageReferences) ||
                    IsMissingRestoreFailure(ex.Message))
                {
                    throw new ProjectRestoreRequiredException(fullPath, ex);
                }

                throw;
            }
        }

        private static void AddSourceTrees(
            ImmutableArray<SyntaxTree>.Builder trees,
            ImmutableArray<string> paths,
            CSharpParseOptions parseOptions,
            CancellationToken cancellationToken)
        {
            if (paths.IsDefaultOrEmpty)
            {
                return;
            }

            foreach (var path in paths)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (!File.Exists(path))
                {
                    continue;
                }

                try
                {
                    trees.Add(CSharpSyntaxTree.ParseText(
                        SourceText.From(File.ReadAllText(path)), parseOptions, path));
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
        /// Walks project references once with separate cycle and cache sets, so diamond graphs reuse C without skipping it when <c>BuildProjectReferences=false</c> leaves no C.dll fallback.
        /// </summary>
        private sealed class ProjectGraphContext
        {
            public ProjectGraphContext(string rootPath)
            {
                KnownProjects = ImmutableHashSet.CreateBuilder<string>(StringComparer.OrdinalIgnoreCase);
                KnownProjects.Add(rootPath);
                InProgress = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { rootPath };
                Compilations = new Dictionary<string, Compilation?>(StringComparer.OrdinalIgnoreCase);
            }

            public ImmutableHashSet<string>.Builder KnownProjects { get; }

            /// <summary>Projects on the current recursion path; re-entering one is a cycle.</summary>
            public HashSet<string> InProgress { get; }

            /// <summary>Every project already built, including those that produced nothing.</summary>
            public Dictionary<string, Compilation?> Compilations { get; }
        }


        private static void AddProjectReferences(
            ImmutableArray<MetadataReference>.Builder references,
            ProjectGraphContext context,
            ImmutableArray<string> projectReferences,
            Dictionary<string, string> properties,
            CancellationToken cancellationToken)
        {
            if (projectReferences.IsDefaultOrEmpty)
            {
                return;
            }

            foreach (var reference in projectReferences)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var referencePath = Path.GetFullPath(reference);
                if (!File.Exists(referencePath))
                {
                    continue;
                }

                // Already built somewhere else in the graph: reuse it rather than skipping it.
                if (context.Compilations.TryGetValue(referencePath, out var cached))
                {
                    if (cached != null)
                    {
                        references.Add(cached.ToMetadataReference());
                    }

                    continue;
                }

                // Currently being loaded further up the stack, so this edge closes a cycle.
                if (!context.InProgress.Add(referencePath))
                {
                    continue;
                }

                // Record before build: this is the invalidation graph, so even failed references
                // must evict the cache when edited; fixing the broken project is the edit most
                // likely to change the answer.
                context.KnownProjects.Add(referencePath);

                try
                {
                    var referenced = BuildReferencedProject(
                        referencePath, context, properties, cancellationToken);
                    context.Compilations[referencePath] = referenced;
                    if (referenced != null)
                    {
                        references.Add(referenced.ToMetadataReference());
                    }
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    // A bad referenced project must not fail the primary load; log the reason so
                    // missing types from that project are not mistaken for ordinary code errors.
                    context.Compilations[referencePath] = null;
                    Console.Error.WriteLine(
                        $"[winui-xaml-ls] referenced project '{referencePath}' was skipped: {ex.Message}");
                }
                finally
                {
                    context.InProgress.Remove(referencePath);
                }
            }
        }

        /// <summary>
        /// Drops on-disk project-reference assemblies when a live compilation exists, matching Roslyn swap behavior so stale <c>bin</c> outputs cannot beat edit-tracking source compilations.
        /// </summary>
        private static IEnumerable<MetadataReference> WithoutSupersededProjectOutputs(
            ImmutableArray<MetadataReference> fromCommandLine,
            ImmutableArray<MetadataReference>.Builder projectCompilations)
        {
            var superseded = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var reference in projectCompilations)
            {
                if (reference is CompilationReference compilation &&
                    !string.IsNullOrEmpty(compilation.Compilation.AssemblyName))
                {
                    superseded.Add(compilation.Compilation.AssemblyName!);
                }
            }

            if (superseded.Count == 0)
            {
                return fromCommandLine;
            }

            return fromCommandLine.Where(reference =>
                reference is not PortableExecutableReference portable ||
                string.IsNullOrEmpty(portable.FilePath) ||
                !superseded.Contains(Path.GetFileNameWithoutExtension(portable.FilePath)));
        }

        private static Compilation? BuildReferencedProject(
            string projectPath,
            ProjectGraphContext context,
            Dictionary<string, string> properties,
            CancellationToken cancellationToken)
        {
            var (evaluation, arguments, _) = AcquireProjectData(projectPath, properties, cancellationToken);
            if (arguments.IsDefaultOrEmpty)
            {
                return null;
            }

            var commandLine = CscCommandLine.Parse(arguments, Path.GetDirectoryName(projectPath)!);
            if (commandLine.Sources.IsDefaultOrEmpty)
            {
                return null;
            }

            var assemblyName = commandLine.AssemblyName
                ?? evaluation.AssemblyName
                ?? Path.GetFileNameWithoutExtension(projectPath);
            var parseOptions = commandLine.CreateParseOptions();
            var trees = ImmutableArray.CreateBuilder<SyntaxTree>();
            AddSourceTrees(trees, commandLine.Sources, parseOptions, cancellationToken);
            AddSourceTrees(
                trees,
                GeneratorHostRunner.Run(projectPath, assemblyName, commandLine, cancellationToken),
                parseOptions,
                cancellationToken);

            var references = ImmutableArray.CreateBuilder<MetadataReference>();
            references.AddRange(commandLine.CreateMetadataReferences());
            AddProjectReferences(
                references, context, evaluation.ProjectReferences, properties, cancellationToken);

            return CSharpCompilation.Create(
                assemblyName,
                trees.ToImmutable(),
                references.ToImmutable(),
                // Keep the referenced project's compiler settings so its symbols mean what its own
                // build says; force only output kind because references are consumed as libraries.
                commandLine.CreateCompilationOptions()
                    .WithOutputKind(OutputKind.DynamicallyLinkedLibrary));        }

        /// <summary>Reads XAML items, restore markers, and graph edges without running targets, even before restore.</summary>
        internal static (
            ImmutableArray<string> Files,
            string? ApplicationDefinition,
            string? ProjectAssetsFile,
            bool HasPackageReferences) EvaluateXamlItems(
            string projectPath,
            IDictionary<string, string> globalProperties)
        {
            var evaluation = MsBuildCli.Evaluate(
                projectPath,
                new Dictionary<string, string>(globalProperties, StringComparer.OrdinalIgnoreCase));
            return (
                evaluation.XamlFiles,
                evaluation.ApplicationDefinition,
                evaluation.ProjectAssetsFile,
                evaluation.HasPackageReferences);
        }

        internal static bool RequiresRestore(string? projectAssetsFile, bool hasPackageReferences)
        {
            if (!hasPackageReferences)
            {
                return false;
            }

            if (string.IsNullOrWhiteSpace(projectAssetsFile) || !File.Exists(projectAssetsFile))
            {
                return true;
            }

            return AssetsContainRestoreErrors(projectAssetsFile) ||
                CacheReportsFailedRestore(Path.Combine(
                    Path.GetDirectoryName(projectAssetsFile)!,
                    "project.nuget.cache"));
        }

        private static bool AssetsContainRestoreErrors(string projectAssetsFile)
        {
            try
            {
                using var document = JsonDocument.Parse(File.ReadAllText(projectAssetsFile));
                if (document.RootElement.ValueKind != JsonValueKind.Object)
                {
                    return true;
                }

                if (!document.RootElement.TryGetProperty("targets", out var targets) ||
                    targets.ValueKind != JsonValueKind.Object ||
                    !document.RootElement.TryGetProperty("libraries", out var libraries) ||
                    libraries.ValueKind != JsonValueKind.Object ||
                    !document.RootElement.TryGetProperty("project", out var project) ||
                    project.ValueKind != JsonValueKind.Object)
                {
                    return true;
                }

                if (!document.RootElement.TryGetProperty("logs", out var logs))
                {
                    return false;
                }

                if (logs.ValueKind != JsonValueKind.Array)
                {
                    return true;
                }

                foreach (var log in logs.EnumerateArray())
                {
                    if (log.ValueKind != JsonValueKind.Object ||
                        !log.TryGetProperty("level", out var level) ||
                        level.ValueKind != JsonValueKind.String)
                    {
                        return true;
                    }

                    if (string.Equals(
                            level.GetString(), "Error", StringComparison.OrdinalIgnoreCase))
                    {
                        return true;
                    }
                }

                return false;
            }
            catch (IOException)
            {
                return true;
            }
            catch (UnauthorizedAccessException)
            {
                return true;
            }
            catch (JsonException)
            {
                return true;
            }
        }

        private static bool CacheReportsFailedRestore(string projectNuGetCache)
        {
            if (!File.Exists(projectNuGetCache))
            {
                return false;
            }

            try
            {
                using var document = JsonDocument.Parse(File.ReadAllText(projectNuGetCache));
                if (document.RootElement.ValueKind != JsonValueKind.Object ||
                    !document.RootElement.TryGetProperty("success", out var success) ||
                    success.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                {
                    return true;
                }

                return !success.GetBoolean();
            }
            catch (IOException)
            {
                return true;
            }
            catch (UnauthorizedAccessException)
            {
                return true;
            }
            catch (JsonException)
            {
                return true;
            }
        }

        internal static bool IsMissingRestoreFailure(string message) =>
            message.Contains("NETSDK1004", StringComparison.OrdinalIgnoreCase) ||
            message.Contains("NETSDK1005", StringComparison.OrdinalIgnoreCase) ||
            (message.Contains("project.assets.json", StringComparison.OrdinalIgnoreCase) &&
             message.Contains("not found", StringComparison.OrdinalIgnoreCase));

        /// <summary>
        /// Names referenced projects whose own build failed by reading MSBuild's bracketed project tag, a localized-safe structural signal with multi-target suffixes removed.
        /// </summary>
        internal static IReadOnlyList<string> ExtractFailedReferencedProjects(
            string message,
            string requestedProjectPath)
        {
            var names = new List<string>();
            if (string.IsNullOrEmpty(message))
            {
                return names;
            }

            string requested;
            try
            {
                requested = Path.GetFullPath(requestedProjectPath);
            }
            catch (ArgumentException)
            {
                requested = requestedProjectPath;
            }

            foreach (Match match in FailedProjectPattern.Matches(message))
            {
                var raw = match.Groups["project"].Value.Trim();
                var separator = raw.IndexOf("::", StringComparison.Ordinal);
                if (separator >= 0)
                {
                    raw = raw.Substring(0, separator);
                }

                if (raw.Length == 0 || string.Equals(raw, requested, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                string name;
                try
                {
                    name = Path.GetFileNameWithoutExtension(raw);
                }
                catch (ArgumentException)
                {
                    continue;
                }

                if (name.Length > 0 && !names.Contains(name, StringComparer.OrdinalIgnoreCase))
                {
                    names.Add(name);
                }
            }

            return names;
        }

        /// <summary>Detects WMC1006 missing project-reference assemblies, where the fix is a build rather than a generic MSBuild repair.</summary>
        internal static bool IsUnbuiltProjectReferenceFailure(string message) =>
            message.Contains("WMC1006", StringComparison.OrdinalIgnoreCase) ||
            message.Contains(
                "Cannot resolve Assembly or Windows Metadata file",
                StringComparison.OrdinalIgnoreCase);

        /// <summary>Pulls quoted WMC1006 assembly paths and reports file names as project names to build.</summary>
        internal static IReadOnlyList<string> ExtractUnresolvedAssemblies(string message)
        {
            var names = new List<string>();
            foreach (Match match in UnresolvedAssemblyPattern.Matches(message))
            {
                var raw = match.Groups["path"].Value.Trim();
                if (raw.Length == 0)
                {
                    continue;
                }

                string name;
                try
                {
                    name = Path.GetFileNameWithoutExtension(raw);
                }
                catch (ArgumentException)
                {
                    // A malformed path in compiler output must not take down project loading.
                    continue;
                }

                if (name.Length > 0 && !names.Contains(name, StringComparer.OrdinalIgnoreCase))
                {
                    names.Add(name);
                }
            }

            return names;
        }

        private static readonly Regex UnresolvedAssemblyPattern = new(
            @"Cannot resolve Assembly or Windows Metadata file '(?<path>[^']*)'",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        // MSBuild appends the producing project in brackets at the end of each diagnostic line.
        private static readonly Regex FailedProjectPattern = new(
            @"(?m):\s*error\s+[^\r\n]*\[(?<project>[^\]\r\n]+\.(?:cs|vb|fs|vcx)proj[^\]\r\n]*)\]\s*$",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        /// <summary>Gets the C# compilation for the loaded project.</summary>
        public Task<Compilation?> GetCompilationAsync(CancellationToken cancellationToken = default) =>
            Task.FromResult<Compilation?>(Compilation);

        internal bool ContainsProject(string projectPath) =>
            _projectPaths.Contains(Path.GetFullPath(projectPath));

        /// <summary>Creates a source-free compilation over MSBuild-selected references so framework metadata is available before sources and generators compile.</summary>
        public Compilation GetFrameworkCompilation() =>
            CSharpCompilation.Create(
                AssemblyName,
                references: MetadataReferences,
                options: CompilationOptions);

        /// <summary> Resolves a type by its metadata name.</summary>
        public async Task<INamedTypeSymbol?> ResolveTypeAsync(string metadataName, CancellationToken cancellationToken = default)
        {
            var compilation = await GetCompilationAsync(cancellationToken).ConfigureAwait(false);
            return compilation?.GetTypeByMetadataName(metadataName);
        }

        public void Dispose()
        {
        }
    }
}
