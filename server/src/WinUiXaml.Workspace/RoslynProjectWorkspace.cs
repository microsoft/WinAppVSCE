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
    /// A referenced project's assembly does not exist yet, so the XAML markup compiler aborts the
    /// design-time evaluation before <c>CoreCompile</c> runs and no compilation is produced at all.
    /// </summary>
    /// <remarks>
    /// This is the clean-clone path. <c>BuildProjectReferences=false</c> keeps evaluation fast and
    /// lets referenced projects be compiled from source, but the WinUI markup compiler resolves
    /// project references as assemblies on disk and hard-fails with WMC1006 when they are missing.
    /// The result is a total outage -- not merely the referenced types, but built-in framework
    /// types, page members, and every diagnostic -- and before this exception existed it reached
    /// the user as silence. Naming the unbuilt projects turns that into a self-diagnosing failure.
    /// </remarks>
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
            return $"Referenced project output is missing ({names}). " +
                "Build the solution once to enable project-aware XAML features.";
        }
    }

    /// <summary>
    /// The Host B spine: loads a real project (including WinUI 3 apps) and exposes its Compilation
    /// and symbols.
    /// </summary>
    /// <remarks>
    /// This used to be a Roslyn <c>MSBuildWorkspace</c>. That design cannot run under Native AOT
    /// for two independent reasons: <c>MSBuildLocator</c> resolves <c>Microsoft.Build</c> from the
    /// user's SDK at runtime, and <c>MefHostServices.DefaultHost</c> -- which every Workspaces API
    /// initializes -- fails composition once trimmed. Both are avoided by acquiring MSBuild data
    /// out-of-process (<see cref="MsBuildCli"/>) and building the compilation directly with
    /// <c>CSharpCompilation.Create</c>, which is AOT-clean. The observable surface is unchanged.
    /// </remarks>
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
            string? applicationDefinitionPath)
        {
            Compilation = compilation;
            MetadataReferences = metadataReferences;
            CompilationOptions = compilationOptions;
            AssemblyName = assemblyName;
            _projectPaths = projectPaths;
            XamlFiles = xamlFiles;
            ApplicationDefinitionPath = applicationDefinitionPath;
        }

        /// <summary>The compilation for the loaded project, including source-generated members.</summary>
        public Compilation Compilation { get; }

        /// <summary>The resolved reference closure MSBuild selected for the project.</summary>
        public ImmutableArray<MetadataReference> MetadataReferences { get; }

        public CSharpCompilationOptions CompilationOptions { get; }
        public string AssemblyName { get; }
        public ImmutableArray<string> XamlFiles { get; }
        public string? ApplicationDefinitionPath { get; }

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
            var (evaluation, arguments) = AcquireProjectData(fullPath, properties, cancellationToken);

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

            var references = ImmutableArray.CreateBuilder<MetadataReference>();
            references.AddRange(commandLine.CreateMetadataReferences());

            // Referenced projects are compiled from source so their types resolve even when their
            // output assemblies have never been built. This preserves the behaviour MSBuildWorkspace
            // gave us via LoadMetadataForReferencedProjects = false.
            var graph = new ProjectGraphContext(fullPath);
            AddProjectReferences(
                references,
                graph,
                evaluation.ProjectReferences,
                properties,
                cancellationToken);

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
                evaluation.ApplicationDefinition);
        }

        /// <summary>
        /// Acquires evaluation data and the csc command line, preferring a single MSBuild
        /// invocation and falling back to evaluation alone so an unrestored project still reports
        /// the restore requirement rather than an opaque build failure.
        /// </summary>
        private static (MsBuildCli.Evaluation Evaluation, ImmutableArray<string> Arguments) AcquireProjectData(
            string fullPath,
            Dictionary<string, string> properties,
            CancellationToken cancellationToken)
        {
            try
            {
                var combined = MsBuildCli.EvaluateAndCompile(fullPath, properties, cancellationToken);
                if (RequiresRestore(
                        combined.Evaluation.ProjectAssetsFile,
                        combined.Evaluation.HasPackageReferences))
                {
                    throw new ProjectRestoreRequiredException(fullPath);
                }

                return (combined.Evaluation, combined.CscCommandLineArgs);
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

        private static CscCommandLine ParseCommandLine(
            string fullPath,
            Dictionary<string, string> properties,
            CancellationToken cancellationToken)
        {
            var arguments = MsBuildCli.GetCscCommandLineArgs(fullPath, properties, cancellationToken);
            return arguments.IsDefaultOrEmpty
                ? CscCommandLine.Empty
                : CscCommandLine.Parse(arguments, Path.GetDirectoryName(fullPath)!);
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
        /// Walks the project-reference graph once, reusing each project's compilation.
        /// </summary>
        /// <remarks>
        /// The "visited" set cannot double as the cycle guard. In a diamond (A references B and C,
        /// B also references C) whichever branch reached C first would mark it visited, and the
        /// sibling branch would skip it entirely -- so A would not reference C at all. A's own
        /// <c>/reference:C.dll</c> cannot cover for that, because <c>BuildProjectReferences=false</c>
        /// means C.dll may never have been produced, which makes the failure depend on whether the
        /// user happens to have built. Cycle detection therefore tracks only the projects currently
        /// being loaded, while a separate cache lets a project be referenced from many places.
        /// </remarks>
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

                try
                {
                    var referenced = BuildReferencedProject(
                        referencePath, context, properties, cancellationToken);
                    context.Compilations[referencePath] = referenced;
                    context.KnownProjects.Add(referencePath);
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
                    // A referenced project that cannot be evaluated must not fail the whole load;
                    // the primary project still provides useful IntelliSense without it. The
                    // reason is logged because the symptom -- types from that project silently
                    // failing to resolve -- is otherwise indistinguishable from a code error.
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

        private static Compilation? BuildReferencedProject(
            string projectPath,
            ProjectGraphContext context,
            Dictionary<string, string> properties,
            CancellationToken cancellationToken)
        {
            var (evaluation, arguments) = AcquireProjectData(projectPath, properties, cancellationToken);
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
                // A referenced project is consumed as a library regardless of how it builds.
                new CSharpCompilationOptions(
                    OutputKind.DynamicallyLinkedLibrary,
                    allowUnsafe: commandLine.AllowUnsafe,
                    nullableContextOptions: commandLine.NullableContext));
        }

        /// <summary>
        /// Reads the project's XAML items, restore marker, and graph edges. Evaluation runs no
        /// targets, so this answers even for a project that has never been restored.
        /// </summary>
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
        /// WMC1006 is the WinUI markup compiler failing to resolve a project reference's assembly.
        /// It is emitted once per unresolved assembly and aborts the evaluation, so it must be
        /// distinguished from a generic MSBuild failure: the user's fix is a build, not a repair.
        /// </summary>
        internal static bool IsUnbuiltProjectReferenceFailure(string message) =>
            message.Contains("WMC1006", StringComparison.OrdinalIgnoreCase) ||
            message.Contains(
                "Cannot resolve Assembly or Windows Metadata file",
                StringComparison.OrdinalIgnoreCase);

        /// <summary>
        /// Pulls the assembly paths out of the WMC1006 lines so the user is told which projects to
        /// build. The compiler quotes the full path; the file name is what matches a project name.
        /// </summary>
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

        /// <summary>Gets the C# compilation for the loaded project.</summary>
        public Task<Compilation?> GetCompilationAsync(CancellationToken cancellationToken = default) =>
            Task.FromResult<Compilation?>(Compilation);

        internal bool ContainsProject(string projectPath) =>
            _projectPaths.Contains(Path.GetFullPath(projectPath));

        /// <summary>
        /// Creates a source-free compilation over the exact references selected by MSBuild.
        /// This makes framework metadata available without waiting for project sources and
        /// source generators to compile.
        /// </summary>
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
