using System.Collections.Immutable;
using Microsoft.CodeAnalysis;

namespace WinUiXaml.Workspace
{
    /// <summary>
    /// The result of associating a <c>.xaml</c> file with the project and type system that give it
    /// meaning: the owning project, the resolved <c>x:Class</c> type, and the set of referenced
    /// assemblies. Every semantic XAML feature (completion, hover, F12, rename) starts here.
    /// </summary>
    public sealed class XamlResolution
    {
        internal XamlResolution(
            string xamlPath,
            string projectPath,
            string? className,
            INamedTypeSymbol? classSymbol,
            Compilation compilation,
            ImmutableArray<IAssemblySymbol> referencedAssemblies,
            ImmutableArray<string> xamlFiles,
            string? applicationDefinitionPath)
        {
            XamlPath = xamlPath;
            ProjectPath = projectPath;
            ClassName = className;
            ClassSymbol = classSymbol;
            Compilation = compilation;
            ReferencedAssemblies = referencedAssemblies;
            XamlFiles = xamlFiles;
            ApplicationDefinitionPath = applicationDefinitionPath;
        }

        /// <summary>Absolute, normalized path to the <c>.xaml</c> file.</summary>
        public string XamlPath { get; }

        /// <summary>Absolute, normalized path to the owning project file.</summary>
        public string ProjectPath { get; }

        /// <summary>The <c>x:Class</c> value declared on the root element, or null if absent.</summary>
        public string? ClassName { get; }

        /// <summary>
        /// The resolved <c>x:Class</c> type symbol, or null if the file declares no <c>x:Class</c>
        /// or the type is not present in the compilation (e.g. a not-yet-built generated partial).
        /// </summary>
        public INamedTypeSymbol? ClassSymbol { get; }

        /// <summary>The owning project's C# compilation.</summary>
        public Compilation Compilation { get; }

        /// <summary>
        /// The assemblies referenced by the project (managed + WinMD). This is the raw material for
        /// the XAML type-system provider (#5): the set of types that can appear in the document.
        /// </summary>
        public ImmutableArray<IAssemblySymbol> ReferencedAssemblies { get; }

        /// <summary>Evaluated Page and ApplicationDefinition files owned by the project.</summary>
        public ImmutableArray<string> XamlFiles { get; }

        /// <summary>The evaluated ApplicationDefinition file, if the project has one.</summary>
        public string? ApplicationDefinitionPath { get; }
    }
}
