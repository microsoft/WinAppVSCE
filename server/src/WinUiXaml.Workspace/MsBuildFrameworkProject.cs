using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using Microsoft.Build.Execution;
using Microsoft.Build.Framework;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace WinUiXaml.Workspace
{
    /// <summary>
    /// Resolves the compiler reference set without asking Roslyn to materialize every project
    /// document or run source generators.
    /// </summary>
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
            IReadOnlyDictionary<string, string> globalProperties)
        {
            MsBuildRegistrar.EnsureRegistered();
            return LoadRegistered(projectPath, globalProperties);
        }

        // Keep direct Microsoft.Build API usage out of Load so Build.Locator can register the
        // SDK assemblies before the runtime resolves this method's MSBuild dependencies.
        private static MsBuildFrameworkProject? LoadRegistered(
            string projectPath,
            IReadOnlyDictionary<string, string> globalProperties)
        {
            var properties = globalProperties.ToDictionary(
                pair => pair.Key,
                pair => pair.Value,
                StringComparer.OrdinalIgnoreCase);
            properties["DesignTimeBuild"] = "true";
            properties["BuildingInsideVisualStudio"] = "true";
            properties["SkipCompilerExecution"] = "true";
            properties["BuildProjectReferences"] = "false";
            properties["ProvideCommandLineArgs"] = "true";

            var evaluated = RoslynProjectWorkspace.EvaluateXamlItems(projectPath, properties);
            if (RoslynProjectWorkspace.RequiresRestore(
                evaluated.ProjectAssetsFile,
                evaluated.HasPackageReferences))
            {
                throw new ProjectRestoreRequiredException(projectPath);
            }

            var request = new BuildRequestData(
                Path.GetFullPath(projectPath),
                properties.ToDictionary(
                    pair => pair.Key,
                    pair => (string?)pair.Value,
                    StringComparer.OrdinalIgnoreCase),
                toolsVersion: null,
                targetsToBuild: new[] { "ResolveReferences" },
                hostServices: null,
                flags: BuildRequestDataFlags.ProvideProjectStateAfterBuild);
            var parameters = new BuildParameters
            {
                EnableNodeReuse = false,
                MaxNodeCount = 1,
                Loggers = Array.Empty<ILogger>(),
            };
            using var buildManager = new BuildManager();
            var result = buildManager.Build(parameters, request);
            var state = result.ProjectStateAfterBuild;
            if (result.OverallResult != BuildResultCode.Success || state is null)
            {
                return null;
            }

            var references = state.GetItems("ReferencePath")
                .Select(CreateMetadataReference)
                .Where(reference => reference is not null)
                .Cast<MetadataReference>()
                .ToImmutableArray();
            if (references.IsDefaultOrEmpty)
            {
                return null;
            }

            var compilation = CSharpCompilation.Create(
                state.GetPropertyValue("AssemblyName") is { Length: > 0 } assemblyName
                    ? assemblyName
                    : "WinUiXaml.Framework",
                references: references,
                options: new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
            if (compilation.GetTypeByMetadataName(WinUiSentinel) is null)
            {
                return null;
            }

            return new MsBuildFrameworkProject(
                compilation,
                evaluated.Files,
                evaluated.ApplicationDefinition);
        }

        private static MetadataReference? CreateMetadataReference(ProjectItemInstance item)
        {
            var path = item.GetMetadataValue("FullPath");
            if (string.IsNullOrWhiteSpace(path))
            {
                path = item.EvaluatedInclude;
            }
            if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
            {
                return null;
            }

            var aliases = item.GetMetadataValue("Aliases")
                .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .ToImmutableArray();
            var embedInteropTypes = bool.TryParse(
                item.GetMetadataValue("EmbedInteropTypes"),
                out var embed) && embed;
            var properties = new MetadataReferenceProperties(
                MetadataImageKind.Assembly,
                aliases,
                embedInteropTypes);
            return MetadataReference.CreateFromFile(Path.GetFullPath(path), properties);
        }
    }
}
