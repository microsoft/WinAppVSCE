using System.Collections.Immutable;
using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;

namespace WinUiXaml.GeneratorHost;

/// <summary>Runs source generators out-of-process so the Native AOT language server can parse generated output without Assembly.LoadFrom.</summary>
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
        var referenceAliases = ReadAliasMap(root, "referenceAliases");
        var embeddedInterop = new HashSet<string>(
            ReadArray(root, "embeddedInteropReferences"), StringComparer.OrdinalIgnoreCase);

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
            if (!File.Exists(reference))
            {
                continue;
            }

            // extern alias and embedded interop types are properties of the reference, not of the
            // compilation: a source file that says 'extern alias Foo;' does not compile without
            // them, and a generator reading such a compilation sees errors rather than symbols.
            var aliases = referenceAliases.TryGetValue(reference, out var found)
                ? found
                : ImmutableArray<string>.Empty;
            metadataReferences.Add(MetadataReference.CreateFromFile(
                reference,
                new MetadataReferenceProperties(
                    MetadataImageKind.Assembly, aliases, embeddedInterop.Contains(reference))));
        }

        // The request carries what the project's csc command line said. Defaults are used only for
        // a request that predates these fields; guessing them is what made the host's view of the
        // sources disagree with the server's over the same command line.
        var compilation = CSharpCompilation.Create(
            assemblyName,
            trees,
            metadataReferences,
            new CSharpCompilationOptions(
                ReadOutputKind(root, "outputKind"),
                allowUnsafe: ReadBoolean(root, "allowUnsafe", defaultValue: true),
                nullableContextOptions: ReadNullableContext(root, "nullableContext")));

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

    /// <summary>The manifest is the completion signal, preventing half-written output from looking complete.</summary>
    private static void WriteManifest(string outputDirectory, IReadOnlyCollection<string> files)
    {
        var manifest = Path.Combine(outputDirectory, "generated-files.txt");
        File.WriteAllLines(manifest, files);
    }

    /// <summary>Finds the already-loaded assembly LoadFrom collided with by simple name, since version skew is the collision and the loaded copy is what analyzers bind to.</summary>
    private static Assembly? TryResolveLoaded(string analyzerPath)
    {
        string simpleName;
        try
        {
            simpleName = AssemblyName.GetAssemblyName(analyzerPath).Name ?? string.Empty;
        }
        catch (Exception)
        {
            return null;
        }

        if (string.IsNullOrEmpty(simpleName))
        {
            return null;
        }

        foreach (var candidate in AssemblyLoadContext.Default.Assemblies)
        {
            if (string.Equals(candidate.GetName().Name, simpleName, StringComparison.OrdinalIgnoreCase))
            {
                return candidate;
            }
        }

        return null;
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
            catch (Exception ex)
            {
                // Analyzer directories ship dependencies that may already be loaded by the host or another analyzer.
                // LoadFrom reports that as a same-name collision, so inspect the loaded copy instead of losing real
                // generators or warning on generator-free support libraries.
                var loaded = TryResolveLoaded(analyzer);
                if (loaded is null)
                {
                    // Skipping quietly loses every generated member from this analyzer with no wire or log clue.
                    Console.Error.WriteLine(
                        $"[winui-xaml-genhost] analyzer '{analyzer}' could not be loaded: {ex.Message}. " +
                        "Generated members from this analyzer will not resolve.");
                    continue;
                }

                assembly = loaded;
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
            catch (Exception ex)
            {
                Console.Error.WriteLine(
                    $"[winui-xaml-genhost] analyzer '{analyzer}' could not be inspected: {ex.Message}. " +
                    "Generated members from this analyzer will not resolve.");
                continue;
            }

            foreach (var type in types)
            {
                // IsPublic is false for a public type nested in a public type, which csc loads
                // happily. IsVisible is the accessibility csc actually requires, so using IsPublic
                // silently drops nested generators with no diagnostic anywhere.
                if (type is null || type.IsAbstract || !type.IsVisible)
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
                    else
                    {
                        WarnOnRoslynVersionMismatch(type, analyzer);
                    }
                }
                catch (Exception ex)
                {
                    // Keep usable generators when one cannot construct, but report why because the symptom is missing members.
                    Console.Error.WriteLine(
                        $"[winui-xaml-genhost] generator '{type.FullName}' in '{analyzer}' could not be created: {ex.Message}");
                }
            }
        }

        return generators;
    }

    /// <summary>Reports a visible generator skipped because LoadFrom did not unify Roslyn identities, making its generator interface differ from the host's.</summary>
    private static void WarnOnRoslynVersionMismatch(Type type, string analyzer)
    {
        foreach (var contract in type.GetInterfaces())
        {
            if (contract.FullName is "Microsoft.CodeAnalysis.IIncrementalGenerator"
                or "Microsoft.CodeAnalysis.ISourceGenerator")
            {
                Console.Error.WriteLine(
                    $"[winui-xaml-genhost] '{type.FullName}' in '{analyzer}' implements {contract.FullName} " +
                    "from a different Microsoft.CodeAnalysis version than the helper hosts, so it was skipped. " +
                    "Generated members from this analyzer will not resolve.");
                return;
            }
        }
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

    /// <summary>Reads the per-reference <c>extern alias</c> names the command line declared.</summary>
    private static Dictionary<string, ImmutableArray<string>> ReadAliasMap(
        JsonElement root, string name)
    {
        var result = new Dictionary<string, ImmutableArray<string>>(StringComparer.OrdinalIgnoreCase);
        if (!root.TryGetProperty(name, out var map) || map.ValueKind != JsonValueKind.Object)
        {
            return result;
        }

        foreach (var property in map.EnumerateObject())
        {
            var aliases = ReadArray(map, property.Name);
            if (aliases.Count > 0)
            {
                result[property.Name] = aliases.ToImmutableArray();
            }
        }

        return result;
    }

    /// <summary>Reads a Roslyn enum name from the request, falling back instead of losing generated members over one unknown token.</summary>
    private static OutputKind ReadOutputKind(JsonElement root, string name) =>
        ReadString(root, name) is { Length: > 0 } text &&
        Enum.TryParse<OutputKind>(text, ignoreCase: true, out var parsed)
            ? parsed
            : OutputKind.DynamicallyLinkedLibrary;

    private static NullableContextOptions ReadNullableContext(JsonElement root, string name) =>
        ReadString(root, name) is { Length: > 0 } text &&
        Enum.TryParse<NullableContextOptions>(text, ignoreCase: true, out var parsed)
            ? parsed
            : NullableContextOptions.Disable;

    private static bool ReadBoolean(JsonElement root, string name, bool defaultValue) =>
        root.TryGetProperty(name, out var value) &&
        value.ValueKind is JsonValueKind.True or JsonValueKind.False
            ? value.GetBoolean()
            : defaultValue;

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
