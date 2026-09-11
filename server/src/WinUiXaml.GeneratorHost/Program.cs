using System.Collections.Immutable;
using System.Reflection;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;

namespace WinUiXaml.GeneratorHost;

/// <summary>
/// Runs a project's source generators out-of-process and writes their output to disk so the
/// Native AOT language server can parse it as ordinary source.
/// </summary>
/// <remarks>
/// The server cannot host generators itself: <c>AnalyzerFileReference</c> ultimately needs
/// <c>Assembly.LoadFrom</c>, and Native AOT has no assembly loader. Everything else the server
/// needs from Roslyn -- parsing, binding, symbol display -- is AOT-clean, so only this narrow
/// step is delegated.
/// </remarks>
internal static class Program
{
    private static int Main(string[] args)
    {
        if (args.Length != 1)
        {
            Console.Error.WriteLine("usage: WinUiXaml.GeneratorHost <request.json>");
            return 2;
        }

        try
        {
            Run(args[0]);
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.ToString());
            return 1;
        }
    }

    private static void Run(string requestPath)
    {
        using var document = JsonDocument.Parse(File.ReadAllText(requestPath));
        var root = document.RootElement;

        var assemblyName = ReadString(root, "assemblyName") ?? "WinUiXaml.Project";
        var outputDirectory = ReadString(root, "outputDirectory")
            ?? throw new InvalidOperationException("Request is missing 'outputDirectory'.");
        var languageVersion = ReadString(root, "languageVersion");
        var references = ReadArray(root, "references");
        var analyzers = ReadArray(root, "analyzers");
        var sources = ReadArray(root, "sources");
        var analyzerConfigs = ReadArray(root, "analyzerConfigs");
        var additionalFilePaths = ReadArray(root, "additionalFiles");
        var preprocessorSymbols = ReadArray(root, "preprocessorSymbols");

        // A stale directory would otherwise leak members that the current sources no longer declare.
        if (Directory.Exists(outputDirectory))
        {
            Directory.Delete(outputDirectory, recursive: true);
        }
        Directory.CreateDirectory(outputDirectory);

        var parseOptions = new CSharpParseOptions(
            ParseLanguageVersion(languageVersion),
            preprocessorSymbols: preprocessorSymbols);

        var trees = new List<SyntaxTree>(sources.Count);
        foreach (var source in sources)
        {
            if (!File.Exists(source))
            {
                continue;
            }

            trees.Add(CSharpSyntaxTree.ParseText(
                SourceText.From(File.ReadAllText(source)), parseOptions, source));
        }

        var metadataReferences = new List<MetadataReference>(references.Count);
        foreach (var reference in references)
        {
            if (File.Exists(reference))
            {
                metadataReferences.Add(MetadataReference.CreateFromFile(reference));
            }
        }

        var compilation = CSharpCompilation.Create(
            assemblyName,
            trees,
            metadataReferences,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, allowUnsafe: true));

        var generators = LoadGenerators(analyzers);
        if (generators.Count == 0)
        {
            WriteManifest(outputDirectory, Array.Empty<string>());
            return;
        }

        var driver = CSharpGeneratorDriver.Create(
            generators,
            additionalTexts: BuildAdditionalTexts(additionalFilePaths),
            parseOptions: parseOptions,
            optionsProvider: AnalyzerConfigOptionsProviderFactory.Create(analyzerConfigs));
        var runResult = driver.RunGenerators(compilation).GetRunResult();

        var written = new List<string>();
        var used = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var tree in runResult.GeneratedTrees)
        {
            // Generated hint names collide across generators often enough to matter; the
            // de-duplicating suffix keeps every tree instead of silently dropping one.
            var name = Path.GetFileName(tree.FilePath);
            if (string.IsNullOrWhiteSpace(name))
            {
                name = "Generated.g.cs";
            }

            var candidate = Path.Combine(outputDirectory, name);
            var index = 1;
            while (!used.Add(candidate))
            {
                candidate = Path.Combine(
                    outputDirectory,
                    $"{Path.GetFileNameWithoutExtension(name)}.{index++}{Path.GetExtension(name)}");
            }

            File.WriteAllText(candidate, tree.GetText().ToString());
            written.Add(candidate);
        }

        WriteManifest(outputDirectory, written);
    }

    private static ImmutableArray<AdditionalText> BuildAdditionalTexts(IReadOnlyList<string> paths)
    {
        var builder = ImmutableArray.CreateBuilder<AdditionalText>();
        foreach (var path in paths)
        {
            if (File.Exists(path))
            {
                builder.Add(new PhysicalAdditionalText(path));
            }
        }

        return builder.ToImmutable();
    }

    /// <summary>
    /// The manifest is the completion signal. Its presence tells the server the run finished,
    /// so a half-written directory from a killed process is never mistaken for a result.
    /// </summary>
    private static void WriteManifest(string outputDirectory, IReadOnlyCollection<string> files)
    {
        var manifest = Path.Combine(outputDirectory, "generated-files.txt");
        File.WriteAllLines(manifest, files);
    }

    private static List<ISourceGenerator> LoadGenerators(IReadOnlyList<string> analyzers)
    {
        var generators = new List<ISourceGenerator>();
        foreach (var analyzer in analyzers)
        {
            if (!File.Exists(analyzer))
            {
                continue;
            }

            Assembly assembly;
            try
            {
                assembly = Assembly.LoadFrom(analyzer);
            }
            catch (Exception)
            {
                continue;
            }

            Type?[] types;
            try
            {
                types = assembly.GetTypes();
            }
            catch (ReflectionTypeLoadException ex)
            {
                // Code-fix assemblies reference Microsoft.CodeAnalysis.Workspaces, which is not
                // deployed here. Partial results still contain every generator we care about.
                types = ex.Types;
            }
            catch (Exception)
            {
                continue;
            }

            foreach (var type in types)
            {
                if (type is null || type.IsAbstract || !type.IsPublic)
                {
                    continue;
                }

                try
                {
                    if (typeof(IIncrementalGenerator).IsAssignableFrom(type))
                    {
                        generators.Add(((IIncrementalGenerator)Activator.CreateInstance(type)!).AsSourceGenerator());
                    }
                    else if (typeof(ISourceGenerator).IsAssignableFrom(type))
                    {
                        generators.Add((ISourceGenerator)Activator.CreateInstance(type)!);
                    }
                }
                catch (Exception)
                {
                    // A generator that cannot be constructed is skipped rather than failing the
                    // whole run; the remaining generators still produce usable members.
                }
            }
        }

        return generators;
    }

    private static LanguageVersion ParseLanguageVersion(string? value) =>
        !string.IsNullOrWhiteSpace(value) &&
        LanguageVersionFacts.TryParse(value, out var parsed)
            ? parsed
            : LanguageVersion.Preview;

    private static string? ReadString(JsonElement root, string name) =>
        root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static List<string> ReadArray(JsonElement root, string name)
    {
        var result = new List<string>();
        if (!root.TryGetProperty(name, out var array) || array.ValueKind != JsonValueKind.Array)
        {
            return result;
        }

        foreach (var element in array.EnumerateArray())
        {
            if (element.ValueKind == JsonValueKind.String &&
                element.GetString() is { Length: > 0 } value)
            {
                result.Add(value);
            }
        }

        return result;
    }
}
