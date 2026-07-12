using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.MSBuild;

namespace WinUiXaml.Workspace
{
    /// <summary>
    /// The Host B spine: a standalone Roslyn <see cref="MSBuildWorkspace"/> that loads a real
    /// project (including WinUI 3 apps) and exposes its <see cref="Compilation"/> and symbols.
    /// This is what powers semantic XAML features — resolving an <c>x:Class</c> type and its
    /// x:Bind / event-handler members — without needing to co-host inside Roslyn's language server.
    /// </summary>
    public sealed class RoslynProjectWorkspace : IDisposable
    {
        private readonly MSBuildWorkspace _workspace;

        private RoslynProjectWorkspace(MSBuildWorkspace workspace, Project project)
        {
            _workspace = workspace;
            Project = project;
        }

        /// <summary>The loaded project.</summary>
        public Project Project { get; }

        /// <summary>Non-fatal diagnostics produced while loading the project (design-time build warnings, etc.).</summary>
        public ImmutableList<WorkspaceDiagnostic> LoadDiagnostics => _workspace.Diagnostics;

        /// <summary>
        /// Loads a single project by path. WinUI apps only define specific platforms, so callers can
        /// pass e.g. <c>Configuration=Debug;Platform=x64</c> to match a known good design-time build.
        /// </summary>
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

            var workspace = MSBuildWorkspace.Create(properties);
            workspace.LoadMetadataForReferencedProjects = true;

            try
            {
                var project = await workspace
                    .OpenProjectAsync(projectPath, cancellationToken: cancellationToken)
                    .ConfigureAwait(false);
                return new RoslynProjectWorkspace(workspace, project);
            }
            catch
            {
                workspace.Dispose();
                throw;
            }
        }

        /// <summary>Gets the C# compilation for the loaded project.</summary>
        public Task<Compilation?> GetCompilationAsync(CancellationToken cancellationToken = default) =>
            Project.GetCompilationAsync(cancellationToken);

        /// <summary>
        /// Resolves a type by its metadata name (e.g. <c>SmokeFixture.SmokePage</c>) from the
        /// project's compilation. This is the <c>x:Class</c> resolution step.
        /// </summary>
        public async Task<INamedTypeSymbol?> ResolveTypeAsync(string metadataName, CancellationToken cancellationToken = default)
        {
            var compilation = await GetCompilationAsync(cancellationToken).ConfigureAwait(false);
            return compilation?.GetTypeByMetadataName(metadataName);
        }

        public void Dispose() => _workspace.Dispose();
    }
}
