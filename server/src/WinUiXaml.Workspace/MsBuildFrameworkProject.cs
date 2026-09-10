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
            string? applicationDefinitionPath)
        {
            Compilation = compilation;
            XamlFiles = xamlFiles;
            ApplicationDefinitionPath = applicationDefinitionPath;
        }

        internal Compilation Compilation { get; }
        internal ImmutableArray<string> XamlFiles { get; }
        internal string? ApplicationDefinitionPath { get; }

        internal static MsBuildFrameworkProject? Load(
            string projectPath,
            IReadOnlyDictionary<string, string> globalProperties,
            CancellationToken cancellationToken = default)
        {
            var properties = globalProperties.ToDictionary(
                pair => pair.Key,
                pair => pair.Value,
                StringComparer.OrdinalIgnoreCase);
            properties["BuildingInsideVisualStudio"] = "true";
            properties["BuildProjectReferences"] = "false";

            var fullPath = Path.GetFullPath(projectPath);
            var (evaluation, arguments) = MsBuildCli.EvaluateAndCompile(
                fullPath, properties, cancellationToken);
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
            var references = commandLine.CreateMetadataReferences();
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
                evaluation.ApplicationDefinition);
        }
    }
}
