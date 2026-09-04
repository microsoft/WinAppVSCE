using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.MSBuild;

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

    /// <summary>The Host B spine: a standalone Roslyn MSBuildWorkspace that loads a real project (including WinUI 3 apps) and exposes its Compilation and symbols.</summary>
    public sealed class RoslynProjectWorkspace : IDisposable
    {
        private readonly MSBuildWorkspace _workspace;

        private RoslynProjectWorkspace(
            MSBuildWorkspace workspace,
            Project project,
            ImmutableArray<string> xamlFiles,
            string? applicationDefinitionPath)
        {
            _workspace = workspace;
            Project = project;
            XamlFiles = xamlFiles;
            ApplicationDefinitionPath = applicationDefinitionPath;
        }

        /// <summary>The loaded project.</summary>
        public Project Project { get; }
        public ImmutableArray<string> XamlFiles { get; }
        public string? ApplicationDefinitionPath { get; }

        /// <summary>Non-fatal diagnostics produced while loading the project (design-time build warnings, etc.).</summary>
        public ImmutableList<WorkspaceDiagnostic> LoadDiagnostics => _workspace.Diagnostics;

        /// <summary>Loads a single project by path.</summary>
        public static async Task<RoslynProjectWorkspace> LoadProjectAsync(
            string projectPath,
            IDictionary<string, string>? globalProperties = null,
            CancellationToken cancellationToken = default)
        {
            if (projectPath == null)
            {
                throw new ArgumentNullException(nameof(projectPath));
            }

            MsBuildRegistrar.EnsureRegistered();

            var properties = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (globalProperties != null)
            {
                foreach (var pair in globalProperties)
                {
                    properties[pair.Key] = pair.Value;
                }
            }

            var (xamlFiles, applicationDefinitionPath, projectAssetsFile, hasPackageReferences) =
                EvaluateXamlItems(projectPath, properties);
            if (RequiresRestore(projectAssetsFile, hasPackageReferences))
            {
                throw new ProjectRestoreRequiredException(projectPath);
            }

            var workspace = MSBuildWorkspace.Create(properties);
            // Keep project references in the workspace graph so IntelliSense can discover controls
            // directly from referenced source projects even when their output DLLs do not exist yet.
            workspace.LoadMetadataForReferencedProjects = false;
            try
            {
                var project = await workspace
                    .OpenProjectAsync(projectPath, cancellationToken: cancellationToken)
                    .ConfigureAwait(false);
                cancellationToken.ThrowIfCancellationRequested();
                if (workspace.Diagnostics.Any(diagnostic =>
                    IsMissingRestoreFailure(diagnostic.Message)))
                {
                    throw new ProjectRestoreRequiredException(projectPath);
                }
                return new RoslynProjectWorkspace(
                    workspace, project, xamlFiles, applicationDefinitionPath);
            }

            catch (ProjectRestoreRequiredException)
            {
                workspace.Dispose();
                throw;
            }
            catch (Exception ex) when (IsMissingRestoreFailure(ex.ToString()))
            {
                workspace.Dispose();
                throw new ProjectRestoreRequiredException(projectPath, ex);
            }
            catch
            {
                workspace.Dispose();
                throw;
            }
        }

        internal static (
            ImmutableArray<string> Files,
            string? ApplicationDefinition,
            string? ProjectAssetsFile,
            bool HasPackageReferences) EvaluateXamlItems(
            string projectPath,
            IDictionary<string, string> globalProperties)
        {
            using var projects = new Microsoft.Build.Evaluation.ProjectCollection(globalProperties);
            var project = projects.LoadProject(projectPath);
            var applicationDefinitions = project.GetItems("ApplicationDefinition")
                .Select(GetFullPath)
                .Where(File.Exists)
                .ToArray();
            var files = project.GetItems("Page")
                .Select(GetFullPath)
                .Concat(applicationDefinitions)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .OrderBy(path => path, StringComparer.OrdinalIgnoreCase)
                .ToImmutableArray();
            var assetsFile = project.GetPropertyValue("ProjectAssetsFile");
            if (!string.IsNullOrWhiteSpace(assetsFile) && !Path.IsPathRooted(assetsFile))
            {
                assetsFile = Path.Combine(Path.GetDirectoryName(projectPath)!, assetsFile);
            }
            return (
                files,
                applicationDefinitions.FirstOrDefault(),
                string.IsNullOrWhiteSpace(assetsFile) ? null : Path.GetFullPath(assetsFile),
                project.GetItems("PackageReference").Count > 0);

            string GetFullPath(Microsoft.Build.Evaluation.ProjectItem item)
            {
                var fullPath = item.GetMetadataValue("FullPath");
                return Path.GetFullPath(
                    string.IsNullOrWhiteSpace(fullPath)
                        ? Path.Combine(Path.GetDirectoryName(projectPath)!, item.EvaluatedInclude)
                        : fullPath);
            }
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

        /// <summary>Gets the C# compilation for the loaded project.</summary>
        public Task<Compilation?> GetCompilationAsync(CancellationToken cancellationToken = default) =>
            Project.GetCompilationAsync(cancellationToken);

        internal bool ContainsProject(string projectPath)
        {
            var target = Path.GetFullPath(projectPath);
            return Project.Solution.Projects.Any(project =>
                project.FilePath is { } filePath &&
                string.Equals(
                    Path.GetFullPath(filePath),
                    target,
                    StringComparison.OrdinalIgnoreCase));
        }

        /// <summary>
        /// Creates a source-free compilation over the exact references selected by MSBuild.
        /// This makes framework metadata available without waiting for project sources and
        /// source generators to compile.
        /// </summary>
        public Compilation GetFrameworkCompilation() =>
            CSharpCompilation.Create(
                Project.AssemblyName ?? "WinUiXaml.Framework",
                references: Project.MetadataReferences,
                options: Project.CompilationOptions as CSharpCompilationOptions);

        /// <summary> Resolves a type by its metadata name.</summary>
        public async Task<INamedTypeSymbol?> ResolveTypeAsync(string metadataName, CancellationToken cancellationToken = default)
        {
            var compilation = await GetCompilationAsync(cancellationToken).ConfigureAwait(false);
            return compilation?.GetTypeByMetadataName(metadataName);
        }

        public void Dispose() => _workspace.Dispose();
    }
}
