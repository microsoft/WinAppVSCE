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
            string Resolve(string value)
            {
                var trimmed = value.Trim().Trim('"');
                return Path.IsPathRooted(trimmed)
                    ? Path.GetFullPath(trimmed)
                    : Path.GetFullPath(Path.Combine(projectDirectory, trimmed));
            }

            // Roslyn's own parser rather than a hand-rolled switch table. It is the code csc runs,
            // so spellings we would otherwise have to enumerate -- +/- boolean forms, extern
            // aliases, /langversion values, /nullable modes -- are correct by construction instead
            // of by having thought of them. It lives in Microsoft.CodeAnalysis.CSharp, which this
            // project already references; only Microsoft.CodeAnalysis.Workspaces is excluded under
            // Native AOT, so nothing here is blocked by it.
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
            // csc only parses doc comments when /doc is passed, and MSBuild omits it unless the
            // project generates an XML file -- but quick info for the user's own members is read
            // straight off these syntax trees. Left at None, every summary on their own types
            // silently disappears while framework prose keeps working, which looks like a docs
            // problem rather than a parse option.
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
        /// Splits <c>/reference:Alpha,Beta=path</c> into one switch per alias.
        /// </summary>
        /// <remarks>
        /// csc itself takes a single alias per switch, so Roslyn's parser rejects the comma form
        /// outright and drops the reference -- which would remove the assembly from the
        /// compilation, not just its aliases. Expanding first keeps the tolerance the hand-rolled
        /// parser had without giving up the real parser everywhere else.
        /// </remarks>
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
