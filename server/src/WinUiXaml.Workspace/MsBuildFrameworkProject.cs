using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Threading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace WinUiXaml.Workspace
{
    /// <summary>
    /// Resolves the compiler reference set without parsing project sources or running source
    /// generators.
    /// </summary>
    /// <remarks>
    /// This is the fast first stage behind <c>ResolveFrameworkAsync</c>: it answers "what types
    /// exist in the framework and package closure" long before the full compilation is ready.
    /// It previously drove MSBuild's <c>BuildManager</c> in-process; it now reuses the same
    /// out-of-process acquisition as the full load, and simply stops before touching sources.
    /// </remarks>
    internal sealed class MsBuildFrameworkProject
    {
        private const string WinUiSentinel = "Microsoft.UI.Xaml.Controls.Button";

        private MsBuildFrameworkProject(
            Compilation compilation,
            ImmutableArray<string> xamlFiles,
            string? applicationDefinitionPath,
            ImmutableArray<string> unresolvedProjectReferences)
        {
            Compilation = compilation;
            XamlFiles = xamlFiles;
            ApplicationDefinitionPath = applicationDefinitionPath;
            UnresolvedProjectReferences = unresolvedProjectReferences;
        }

        internal Compilation Compilation { get; }
        internal ImmutableArray<string> XamlFiles { get; }
        internal string? ApplicationDefinitionPath { get; }

        /// <summary>Referenced projects that had never been built when this project loaded.</summary>
        internal ImmutableArray<string> UnresolvedProjectReferences { get; }

        internal static MsBuildFrameworkProject? Load(
            string projectPath,
            IReadOnlyDictionary<string, string> globalProperties,
            CancellationToken cancellationToken = default)
        {
            var properties = globalProperties.ToDictionary(
                pair => pair.Key,
                pair => pair.Value,
                StringComparer.OrdinalIgnoreCase);

            var fullPath = Path.GetFullPath(projectPath);
            var (evaluation, arguments, unresolvedProjectReferences) = MsBuildCli.EvaluateAndCompile(
                fullPath,
                properties,
                cancellationToken);
            if (RoslynProjectWorkspace.RequiresRestore(
                evaluation.ProjectAssetsFile,
                evaluation.HasPackageReferences))
            {
                throw new ProjectRestoreRequiredException(projectPath);
            }

            if (arguments.IsDefaultOrEmpty)
            {
                return null;
            }

            var commandLine = CscCommandLine.Parse(arguments, Path.GetDirectoryName(fullPath)!);
            // No documentation at this stage. The framework compilation exists to answer as early
            // as possible, and the base branch built its references without documentation here;
            // adding it makes completion items carry prose the moment a file opens, which is a
            // visible change in what the editor shows.
            var references = commandLine.CreateMetadataReferences(includeDocumentation: false);
            if (references.IsDefaultOrEmpty)
            {
                return null;
            }

            var compilation = CSharpCompilation.Create(
                commandLine.AssemblyName
                    ?? evaluation.AssemblyName
                    ?? "WinUiXaml.Framework",
                references: references,
                options: new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

            // Without the WinUI closure this stage cannot answer the questions it exists for, so
            // the caller is told to fall back rather than being handed a misleading compilation.
            if (compilation.GetTypeByMetadataName(WinUiSentinel) is null)
            {
                return null;
            }

            return new MsBuildFrameworkProject(
                compilation,
                evaluation.XamlFiles,
                evaluation.ApplicationDefinition,
                unresolvedProjectReferences);
        }
    }
}
