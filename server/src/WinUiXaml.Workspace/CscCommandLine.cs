using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace WinUiXaml.Workspace
{
    /// <summary>
    /// The parsed form of the csc command line MSBuild would have invoked for a project.
    /// </summary>
    /// <remarks>
    /// This replaces what <c>MSBuildWorkspace</c> used to compute in-process. It is the complete
    /// description of the compilation: the resolved reference closure, every source file
    /// (including the XAML compiler's <c>.g.cs</c> output), and the options that change binding.
    /// </remarks>
    internal sealed class CscCommandLine
    {
        private CscCommandLine(
            ImmutableArray<string> references,
            ImmutableArray<string> analyzers,
            ImmutableArray<string> sources,
            ImmutableArray<string> analyzerConfigs,
            ImmutableArray<string> additionalFiles,
            ImmutableArray<string> preprocessorSymbols,
            ImmutableDictionary<string, ImmutableArray<string>> referenceAliases,
            ImmutableHashSet<string> embeddedInteropReferences,
            string? languageVersion,
            OutputKind outputKind,
            bool allowUnsafe,
            NullableContextOptions nullableContext,
            string? assemblyName)
        {
            References = references;
            Analyzers = analyzers;
            Sources = sources;
            AnalyzerConfigs = analyzerConfigs;
            AdditionalFiles = additionalFiles;
            PreprocessorSymbols = preprocessorSymbols;
            ReferenceAliases = referenceAliases;
            EmbeddedInteropReferences = embeddedInteropReferences;
            LanguageVersion = languageVersion;
            OutputKind = outputKind;
            AllowUnsafe = allowUnsafe;
            NullableContext = nullableContext;
            AssemblyName = assemblyName;
        }

        public ImmutableArray<string> References { get; }
        public ImmutableArray<string> Analyzers { get; }
        public ImmutableArray<string> Sources { get; }

        /// <summary>
        /// The <c>.editorconfig</c> and generated <c>.GlobalConfig</c> files csc was given.
        /// </summary>
        /// <remarks>
        /// MSBuild writes <c>build_property.*</c> values -- <c>RootNamespace</c>,
        /// <c>ProjectDir</c>, <c>TargetFramework</c> and the rest -- into a generated global
        /// config. A generator that reads them produces different output when they are absent, so
        /// dropping these switches makes generated members silently wrong rather than missing.
        /// </remarks>
        public ImmutableArray<string> AnalyzerConfigs { get; }

        /// <summary>Files passed as <c>/additionalfile:</c>, which generators read as inputs.</summary>
        public ImmutableArray<string> AdditionalFiles { get; }

        public ImmutableArray<string> PreprocessorSymbols { get; }
        public ImmutableDictionary<string, ImmutableArray<string>> ReferenceAliases { get; }

        /// <summary>
        /// References csc was told to embed rather than link, via <c>/link:</c>.
        /// </summary>
        /// <remarks>
        /// This is the csc spelling of MSBuild's <c>EmbedInteropTypes</c> metadata, which the
        /// pre-AOT <c>MsBuildFrameworkProject</c> read directly off the <c>ReferencePath</c> item.
        /// Dropping it does not just lose an option: an embedded-interop reference carries no
        /// runtime identity of its own, so every COM/WinRT PIA type resolves as if the assembly
        /// were absent, and XAML that binds to those types silently stops resolving.
        /// </remarks>
        public ImmutableHashSet<string> EmbeddedInteropReferences { get; }

        public string? LanguageVersion { get; }
        public OutputKind OutputKind { get; }
        public bool AllowUnsafe { get; }
        public NullableContextOptions NullableContext { get; }
        public string? AssemblyName { get; }

        public static CscCommandLine Empty { get; } = new(
            ImmutableArray<string>.Empty,
            ImmutableArray<string>.Empty,
            ImmutableArray<string>.Empty,
            ImmutableArray<string>.Empty,
            ImmutableArray<string>.Empty,
            ImmutableArray<string>.Empty,
            ImmutableDictionary<string, ImmutableArray<string>>.Empty,
            ImmutableHashSet<string>.Empty,
            null,
            OutputKind.DynamicallyLinkedLibrary,
            false,
            NullableContextOptions.Disable,
            null);

        /// <summary>
        /// Parses raw csc switches into a compilation description.
        /// </summary>
        /// <param name="projectDirectory">
        /// csc is invoked with the project directory as its working directory, so its paths are
        /// project-relative. Resolving against anything else makes <c>File.Exists</c> silently
        /// drop most sources and produces a compilation that is missing types.
        /// </param>
        public static CscCommandLine Parse(
            IEnumerable<string> arguments,
            string projectDirectory)
        {
            var references = ImmutableArray.CreateBuilder<string>();
            var analyzers = ImmutableArray.CreateBuilder<string>();
            var analyzerConfigs = ImmutableArray.CreateBuilder<string>();
            var additionalFiles = ImmutableArray.CreateBuilder<string>();
            var sources = ImmutableArray.CreateBuilder<string>();
            var symbols = ImmutableArray.CreateBuilder<string>();
            var aliases = ImmutableDictionary.CreateBuilder<string, ImmutableArray<string>>(
                StringComparer.OrdinalIgnoreCase);
            var embedded = ImmutableHashSet.CreateBuilder<string>(StringComparer.OrdinalIgnoreCase);
            string? languageVersion = null;
            string? assemblyName = null;
            var outputKind = OutputKind.DynamicallyLinkedLibrary;
            var allowUnsafe = false;
            var nullableContext = NullableContextOptions.Disable;

            string Resolve(string value)
            {
                var trimmed = value.Trim().Trim('"');
                return Path.IsPathRooted(trimmed)
                    ? Path.GetFullPath(trimmed)
                    : Path.GetFullPath(Path.Combine(projectDirectory, trimmed));
            }

            foreach (var raw in arguments)
            {
                if (string.IsNullOrWhiteSpace(raw))
                {
                    continue;
                }

                var argument = raw.Trim();
                if (argument.Length == 0)
                {
                    continue;
                }

                if (argument[0] != '/' && argument[0] != '-')
                {
                    if (argument.EndsWith(".cs", StringComparison.OrdinalIgnoreCase))
                    {
                        sources.Add(Resolve(argument));
                    }

                    continue;
                }

                var body = argument.Substring(1);
                var separator = body.IndexOf(':');
                var name = separator < 0 ? body : body.Substring(0, separator);
                var value = separator < 0 ? string.Empty : body.Substring(separator + 1);

                // Boolean switches carry their value as a trailing sign rather than after a
                // colon, and MSBuild always emits the explicit form. Reading "/unsafe+" as an
                // unknown switch silently disables unsafe blocks for every project that enables
                // them, which then fails to bind rather than failing to parse.
                if (separator < 0 && name.Length > 1 &&
                    (name[name.Length - 1] == '+' || name[name.Length - 1] == '-'))
                {
                    value = name.Substring(name.Length - 1);
                    name = name.Substring(0, name.Length - 1);
                }

                switch (name.ToLowerInvariant())
                {
                    case "reference":
                    case "r":
                        AddReference(value, embedInteropTypes: false);
                        break;
                    // MSBuild emits EmbedInteropTypes="true" references as /link:, never as
                    // /reference: with extra metadata, so this switch is the only source of truth
                    // for interop embedding on a csc command line.
                    case "link":
                    case "l":
                        AddReference(value, embedInteropTypes: true);
                        break;
                    case "analyzer":
                    case "a":
                        analyzers.Add(Resolve(value));
                        break;
                    case "analyzerconfig":
                        analyzerConfigs.Add(Resolve(value));
                        break;
                    case "additionalfile":
                        additionalFiles.Add(Resolve(value));
                        break;
                    case "define":
                    case "d":
                        symbols.AddRange(value.Split(
                            ';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
                        break;
                    case "langversion":
                        languageVersion = value.Trim();
                        break;
                    case "out":
                        assemblyName = Path.GetFileNameWithoutExtension(value.Trim().Trim('"'));
                        break;
                    case "target":
                        outputKind = value.Trim().ToLowerInvariant() switch
                        {
                            "exe" => OutputKind.ConsoleApplication,
                            "winexe" => OutputKind.WindowsApplication,
                            "module" => OutputKind.NetModule,
                            _ => OutputKind.DynamicallyLinkedLibrary,
                        };
                        break;
                    case "unsafe":
                        allowUnsafe = !value.Equals("-", StringComparison.Ordinal);
                        break;
                    case "nullable":
                        nullableContext = value.Trim().ToLowerInvariant() switch
                        {
                            "" or "+" or "enable" => NullableContextOptions.Enable,
                            "warnings" => NullableContextOptions.Warnings,
                            "annotations" => NullableContextOptions.Annotations,
                            _ => NullableContextOptions.Disable,
                        };
                        break;
                }
            }

            return new CscCommandLine(
                references.ToImmutable(),
                analyzers.ToImmutable(),
                sources.ToImmutable(),
                analyzerConfigs.ToImmutable(),
                additionalFiles.ToImmutable(),
                symbols.ToImmutable(),
                aliases.ToImmutable(),
                embedded.ToImmutable(),
                languageVersion,
                outputKind,
                allowUnsafe,
                nullableContext,
                assemblyName);

            void AddReference(string value, bool embedInteropTypes)
            {
                // extern aliases arrive as /reference:Alias=path.
                var text = value.Trim().Trim('"');
                var equals = text.IndexOf('=');
                if (equals > 0 && !LooksLikeDriveLetter(text, equals))
                {
                    var aliasList = text.Substring(0, equals)
                        .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                        .ToImmutableArray();
                    var path = Resolve(text.Substring(equals + 1));
                    references.Add(path);
                    if (!aliasList.IsDefaultOrEmpty)
                    {
                        aliases[path] = aliasList;
                    }

                    if (embedInteropTypes)
                    {
                        embedded.Add(path);
                    }

                    return;
                }

                var resolved = Resolve(text);
                references.Add(resolved);
                if (embedInteropTypes)
                {
                    embedded.Add(resolved);
                }
            }
        }

        private static bool LooksLikeDriveLetter(string text, int equalsIndex) =>
            equalsIndex == 1 && text.Length > 2 && (text[2] == '\\' || text[2] == '/');

        /// <summary>Materializes the reference closure, honouring any extern aliases.</summary>
        /// <summary>Builds the metadata references for the compilation.</summary>
        /// <param name="includeDocumentation">
        /// Whether references carry their sibling XML documentation. This is not a preference: it
        /// reproduces the two-stage behaviour of the MSBuildWorkspace design this replaced. The
        /// framework stage built references without documentation, and the authoritative stage got
        /// it implicitly from MSBuildWorkspace. Supplying it in both places populates Documentation
        /// on completion items the moment a file opens, which makes VS Code open its details pane
        /// beside the suggestion list far earlier than it used to -- a visible UI change unrelated
        /// to Native AOT.
        /// </param>
        public ImmutableArray<MetadataReference> CreateMetadataReferences(
            bool includeDocumentation = true)
        {
            var builder = ImmutableArray.CreateBuilder<MetadataReference>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var reference in References)
            {
                if (!seen.Add(reference) || !File.Exists(reference))
                {
                    continue;
                }

                var aliasList = ReferenceAliases.TryGetValue(reference, out var found)
                    ? found
                    : ImmutableArray<string>.Empty;
                var properties = new MetadataReferenceProperties(
                    MetadataImageKind.Assembly,
                    aliasList,
                    EmbeddedInteropReferences.Contains(reference));
                // Deliberately created without a DocumentationProvider when the caller asks for the
                // framework stage, matching the base branch's MsBuildFrameworkProject.
                builder.Add(MetadataReference.CreateFromFile(
                    reference,
                    properties,
                    includeDocumentation ? CreateDocumentationProvider(reference) : null));
            }

            return builder.ToImmutable();
        }

        /// <summary>
        /// Attaches the sibling XML documentation file so quick info and completion items carry
        /// their &lt;summary&gt; prose.
        /// </summary>
        /// <remarks>
        /// MSBuildWorkspace did this implicitly for the authoritative compilation, which is why the
        /// smoke test asserts completion documentation. It did not do it for the framework stage, so
        /// callers there must opt out.
        /// </remarks>
        private static DocumentationProvider? CreateDocumentationProvider(string referencePath)
        {
            try
            {
                var xmlPath = Path.ChangeExtension(referencePath, ".xml");
                return File.Exists(xmlPath)
                    ? XmlDocFileProvider.GetOrCreate(xmlPath)
                    : null;
            }
            catch (IOException)
            {
                return null;
            }
            catch (UnauthorizedAccessException)
            {
                return null;
            }
        }

        public CSharpCompilationOptions CreateCompilationOptions() =>
            new CSharpCompilationOptions(
                OutputKind,
                allowUnsafe: AllowUnsafe,
                nullableContextOptions: NullableContext);

        public CSharpParseOptions CreateParseOptions()
        {
            var version = Microsoft.CodeAnalysis.CSharp.LanguageVersion.Preview;
            if (!string.IsNullOrWhiteSpace(LanguageVersion) &&
                LanguageVersionFacts.TryParse(LanguageVersion, out var parsed))
            {
                version = parsed;
            }

            return new CSharpParseOptions(version, preprocessorSymbols: PreprocessorSymbols);
        }
    }
}
