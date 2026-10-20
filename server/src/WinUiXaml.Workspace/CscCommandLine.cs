using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace WinUiXaml.Workspace
{
    /// <summary>The csc command line MSBuild would invoke, including references, sources, generated XAML output, and binding-affecting options.</summary>
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
            string? assemblyName,
            CSharpParseOptions? parseOptions = null,
            CSharpCompilationOptions? compilationOptions = null)
        {
            _parseOptions = parseOptions;
            _compilationOptions = compilationOptions;
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

        // The options Roslyn's own parser produced, kept verbatim so nothing is lost in the
        // round-trip through this type's properties. Null only for Empty, which has no command
        // line to have parsed.
        private readonly CSharpParseOptions? _parseOptions;
        private readonly CSharpCompilationOptions? _compilationOptions;

        public ImmutableArray<string> References { get; }
        public ImmutableArray<string> Analyzers { get; }
        public ImmutableArray<string> Sources { get; }

        /// <summary>
        /// The <c>.editorconfig</c> and generated <c>.GlobalConfig</c> files csc was given, including MSBuild <c>build_property.*</c> values generators need to avoid silently wrong output.
        /// </summary>
        public ImmutableArray<string> AnalyzerConfigs { get; }

        /// <summary>Files passed as <c>/additionalfile:</c>, which generators read as inputs.</summary>
        public ImmutableArray<string> AdditionalFiles { get; }

        public ImmutableArray<string> PreprocessorSymbols { get; }
        public ImmutableDictionary<string, ImmutableArray<string>> ReferenceAliases { get; }

        /// <summary>
        /// References csc embeds via <c>/link:</c>; preserving MSBuild <c>EmbedInteropTypes</c> is required so COM/WinRT PIA types keep resolving in XAML.
        /// </summary>
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

        /// <summary>Parses raw csc switches into a compilation description.</summary>
        /// <param name="projectDirectory">The csc working directory; resolving paths elsewhere silently drops project-relative sources and types.</param>
        public static CscCommandLine Parse(
            IEnumerable<string> arguments,
            string projectDirectory)
        {
            string Resolve(string value)
            {
                var trimmed = value.Trim().Trim('"');
                return Path.IsPathRooted(trimmed)
                    ? Path.GetFullPath(trimmed)
                    : Path.GetFullPath(Path.Combine(projectDirectory, trimmed));
            }

            // Roslyn's own parser is csc's parser, so +/- booleans, extern aliases, /langversion,
            // and /nullable are correct by construction. This uses Microsoft.CodeAnalysis.CSharp,
            // not the Workspaces layer excluded by Native AOT.
            var parsed = CSharpCommandLineParser.Default.Parse(
                arguments.Where(argument => !string.IsNullOrWhiteSpace(argument))
                    .SelectMany(argument => ExpandMultiAliasReference(argument.Trim())),
                baseDirectory: projectDirectory,
                sdkDirectory: null);

            var references = ImmutableArray.CreateBuilder<string>();
            var aliases = ImmutableDictionary.CreateBuilder<string, ImmutableArray<string>>(
                StringComparer.OrdinalIgnoreCase);
            var embedded = ImmutableHashSet.CreateBuilder<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var reference in parsed.MetadataReferences)
            {
                var path = Resolve(reference.Reference);
                if (!references.Contains(path))
                {
                    references.Add(path);
                }

                if (!reference.Properties.Aliases.IsDefaultOrEmpty)
                {
                    // One reference per alias after the expansion above, so union rather than
                    // overwrite: assigning would keep only the last alias of a multi-alias switch.
                    aliases[path] = aliases.TryGetValue(path, out var existing)
                        ? existing.AddRange(
                            reference.Properties.Aliases.Where(alias => !existing.Contains(alias)))
                        : reference.Properties.Aliases;
                }

                if (reference.Properties.EmbedInteropTypes)
                {
                    embedded.Add(path);
                }
            }

            var parseOptions = parsed.ParseOptions;
            // csc parses doc comments only with /doc, but quick info for user members reads these
            // syntax trees directly. Force parsing so user summaries do not disappear while
            // framework prose still works.
            if (parseOptions.DocumentationMode == DocumentationMode.None)
            {
                parseOptions = parseOptions.WithDocumentationMode(DocumentationMode.Parse);
            }

            var compilationOptions = parsed.CompilationOptions;
            return new CscCommandLine(
                references.ToImmutable(),
                parsed.AnalyzerReferences.Select(analyzer => Resolve(analyzer.FilePath)).ToImmutableArray(),
                // csc would treat any bare argument as C#; MSBuild only ever passes .cs, and
                // handing a .xaml or .txt to the parser produces a syntax tree of garbage rather
                // than an error anyone sees.
                parsed.SourceFiles
                    .Select(source => Resolve(source.Path))
                    .Where(path => path.EndsWith(".cs", StringComparison.OrdinalIgnoreCase))
                    .ToImmutableArray(),
                parsed.AnalyzerConfigPaths.Select(Resolve).ToImmutableArray(),
                parsed.AdditionalFiles.Select(file => Resolve(file.Path)).ToImmutableArray(),
                parseOptions.PreprocessorSymbolNames.ToImmutableArray(),
                aliases.ToImmutable(),
                embedded.ToImmutable(),
                parseOptions.LanguageVersion.ToDisplayString(),
                compilationOptions.OutputKind,
                compilationOptions.AllowUnsafe,
                compilationOptions.NullableContextOptions,
                parsed.CompilationName is { } name
                    ? Path.GetFileNameWithoutExtension(name)
                    : null,
                parseOptions,
                compilationOptions);
        }

        /// <summary>
        /// Splits <c>/reference:Alpha,Beta=path</c> into one switch per alias so Roslyn's csc parser keeps the reference instead of rejecting the comma form.
        /// </summary>
        private static IEnumerable<string> ExpandMultiAliasReference(string argument)
        {
            if (argument.Length == 0 || (argument[0] != '/' && argument[0] != '-'))
            {
                return new[] { argument };
            }

            var separator = argument.IndexOf(':');
            if (separator < 0)
            {
                return new[] { argument };
            }

            var name = argument.Substring(1, separator - 1).ToLowerInvariant();
            if (name is not ("reference" or "r" or "link" or "l"))
            {
                return new[] { argument };
            }

            var value = argument.Substring(separator + 1).Trim().Trim('"');
            var equals = value.IndexOf('=');
            if (equals <= 0 || LooksLikeDriveLetter(value, equals))
            {
                return new[] { argument };
            }

            var aliasText = value.Substring(0, equals);
            if (aliasText.IndexOf(',') < 0)
            {
                return new[] { argument };
            }

            var path = value.Substring(equals + 1);
            var prefix = argument.Substring(0, separator + 1);
            return aliasText
                .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(alias => $"{prefix}{alias}={path}");
        }

        private static bool LooksLikeDriveLetter(string text, int equalsIndex) =>
            equalsIndex == 1 && text.Length > 2 && (text[2] == '\\' || text[2] == '/');

        /// <summary>Materializes metadata references for the compilation, honouring extern aliases.</summary>
        /// <param name="includeDocumentation">Whether sibling XML docs are attached; false preserves the framework stage's old no-doc behavior and avoids changing completion UI timing.</param>
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

        /// <summary>Attaches sibling XML docs for quick info/completion, while letting framework-stage callers opt out to match prior behavior.</summary>
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
            _compilationOptions ?? new CSharpCompilationOptions(
                OutputKind,
                allowUnsafe: AllowUnsafe,
                nullableContextOptions: NullableContext);

        public CSharpParseOptions CreateParseOptions()
        {
            if (_parseOptions is not null)
            {
                return _parseOptions;
            }

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
