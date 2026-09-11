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
                        AddReference(value);
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
                languageVersion,
                outputKind,
                allowUnsafe,
                nullableContext,
                assemblyName);

            void AddReference(string value)
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

                    return;
                }

                references.Add(Resolve(text));
            }
        }

        private static bool LooksLikeDriveLetter(string text, int equalsIndex) =>
            equalsIndex == 1 && text.Length > 2 && (text[2] == '\\' || text[2] == '/');

        /// <summary>Materializes the reference closure, honouring any extern aliases.</summary>
        public ImmutableArray<MetadataReference> CreateMetadataReferences()
        {
            var builder = ImmutableArray.CreateBuilder<MetadataReference>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var reference in References)
            {
                if (!seen.Add(reference) || !File.Exists(reference))
                {
                    continue;
                }

                var properties = ReferenceAliases.TryGetValue(reference, out var aliases)
                    ? new MetadataReferenceProperties(MetadataImageKind.Assembly, aliases)
                    : MetadataReferenceProperties.Assembly;
                builder.Add(MetadataReference.CreateFromFile(
                    reference, properties, CreateDocumentationProvider(reference)));
            }

            return builder.ToImmutable();
        }

        /// <summary>
        /// Attaches the sibling XML documentation file so quick info and completion items carry
        /// their &lt;summary&gt; prose.
        /// </summary>
        /// <remarks>
        /// MSBuildWorkspace did this implicitly. Creating references without it produces a
        /// compilation that is correct in every way except that all documentation is silently
        /// missing, which is why the smoke test asserts on it directly.
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
