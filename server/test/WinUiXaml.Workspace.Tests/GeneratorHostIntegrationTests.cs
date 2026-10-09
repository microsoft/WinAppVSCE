using System.Collections.Immutable;
using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;
using WinUiXaml.Workspace;

namespace WinUiXaml.Workspace.Tests;

/// <summary>Drives the real out-of-process generator host with a real source generator. No fixture in the repo referenced a source generator, so <see cref="GeneratorHostRunner"/>'s analyzer short-circuit skipped the entire out-of-proc path in every other test. That gap is why a deadlock in the host's output draining shipped past a green suite. These tests compile a generator in memory -- no NuGet restore, no <c>dotnet build</c> -- and run it through the same subprocess the product uses.</summary>
public sealed class GeneratorHostIntegrationTests : IDisposable
{
    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        "winuixaml-genhost-tests",
        Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(_root))
            {
                Directory.Delete(_root, recursive: true);
            }
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    /// <summary>M3: MSBuild passes <c>build_property.*</c> to generators through a generated global analyzer config. Dropping it does not make generated members disappear -- they resolve to the wrong names, which is far harder to notice.</summary>
    [Fact]
    public void Run_PassesBuildPropertiesFromAnalyzerConfigToGenerators()
    {
        var project = CreateProject("PropertyProbe");
        var analyzer = CompileGenerator(
            project,
            """
            var ns = ctx.GlobalOptions
                .TryGetValue("build_property.RootNamespace", out var v) ? v : "MISSING";
            spc.AddSource("Probe.g.cs", $"namespace {ns} {{ public static class Probe {{ }} }}");
            """);

        WriteGlobalConfig(project, "build_property.RootNamespace = Resolved.From.Config");

        var generated = RunHost(project, analyzer);

        Assert.NotEmpty(generated);
        var text = string.Concat(generated.Select(File.ReadAllText));
        Assert.Contains("namespace Resolved.From.Config", text);
        Assert.DoesNotContain("MISSING", text);
    }

    /// <summary>H1: a generator writing enough to stderr must not fill the pipe buffer and deadlock the host, which would block project load entirely -- even hand-written members would stop resolving. The volume is the only variable between this test and the quiet case.</summary>
    [Fact]
    public void Run_WithGeneratorFloodingStandardError_StillReturnsGeneratedFiles()
    {
        var project = CreateProject("NoisyProbe");
        var analyzer = CompileGenerator(
            project,
            """
            for (var i = 0; i < 4096; i++)
            {
                System.Console.Error.WriteLine(new string('x', 64));
            }

            spc.AddSource("Noisy.g.cs", "public static class NoisyMarker { }");
            """);

        var generated = RunHost(project, analyzer);

        Assert.NotEmpty(generated);
        Assert.Contains(
            "NoisyMarker",
            string.Concat(generated.Select(File.ReadAllText)));
    }

    /// <summary>M6: the host was told which sources to compile but not how, so it guessed a library with unsafe on and nullable <em>disabled</em>. Nullable is the guess that shows: generators annotate what they emit from the nullable context -- <c>[ObservableProperty]</c> is the common case -- so the guess decided whether a generated property came back as <c>string</c> or <c>string?</c>, and that is the type <c>{x:Bind}</c> is checked against. The generated members are all present either way, which is what made it hard to see.</summary>
    [Fact]
    public void Run_CompilesGeneratorsAgainstTheProjectsRealCompilationOptions()
    {
        var project = CreateProject("OptionsProbe");
        var analyzer = CompileCompilationGenerator(
            project,
            """
            var options = (Microsoft.CodeAnalysis.CSharp.CSharpCompilationOptions)ctx.Options;
            spc.AddSource(
                "Options.g.cs",
                "// nullable=" + options.NullableContextOptions
                    + " kind=" + options.OutputKind
                    + " unsafe=" + options.AllowUnsafe
                    + System.Environment.NewLine
                    + "public static class OptionsMarker { }");
            """);

        // Every one of these differs from the host's default, so a regression cannot pass by
        // coincidence.
        var generated = RunHost(project, analyzer, "/nullable:enable", "/target:exe", "/unsafe-");

        Assert.NotEmpty(generated);
        var text = string.Concat(generated.Select(File.ReadAllText));
        Assert.Contains("nullable=Enable", text);
        Assert.Contains("kind=ConsoleApplication", text);
        Assert.Contains("unsafe=False", text);
    }

    /// <summary>Generators that read <c>AdditionalFiles</c> produce different members depending on file contents, so a request that carries the paths but loses the text degrades to members that silently disagree with the project's own build.</summary>
    [Fact]
    public void Run_PassesAdditionalFileContentsToGenerators()
    {
        var project = CreateProject("AdditionalProbe");
        var analyzer = CompileAdditionalTextGenerator(
            project,
            """
            var text = ctx.GetText()?.ToString().Trim() ?? "MISSING";
            spc.AddSource(
                System.IO.Path.GetFileNameWithoutExtension(ctx.Path) + ".g.cs",
                "namespace " + text + " { public static class AdditionalMarker { } }");
            """);

        var additionalFile = Path.Combine(project, "Probe.txt");
        File.WriteAllText(additionalFile, "Resolved.From.AdditionalFile");

        var generated = RunHost(project, analyzer, "/additionalfile:" + additionalFile);

        Assert.NotEmpty(generated);
        var text = string.Concat(generated.Select(File.ReadAllText));
        Assert.Contains("namespace Resolved.From.AdditionalFile", text);
        Assert.DoesNotContain("MISSING", text);
    }

    /// <summary>Roslyn captures a throwing generator into the run result rather than propagating it, so the host once wrote a manifest and exited 0. The project then looked healthy while the generated members an x:Bind path needs were absent -- the exact silent gap the failure channel exists to prevent.</summary>
    [Fact]
    public void Run_WithThrowingGenerator_ReportsFailureInsteadOfSucceedingWithNoFiles()
    {
        var project = CreateProject("ThrowingProbe");
        var analyzer = CompileGenerator(
            project,
            """
            throw new System.InvalidOperationException("probe generator exploded");
            """);

        var result = RunHostForResult(project, analyzer);

        Assert.Empty(result.Files);
        Assert.NotNull(result.FailureReason);
    }

    private string CreateProject(string name)
    {
        var directory = Path.Combine(_root, name);
        Directory.CreateDirectory(directory);
        File.WriteAllText(
            Path.Combine(directory, "Program.cs"),
            "public sealed class HandWritten { }");
        return directory;
    }

    private static void WriteGlobalConfig(string projectDirectory, string body)
    {
        File.WriteAllText(
            Path.Combine(projectDirectory, "generated.globalconfig"),
            "is_global = true" + Environment.NewLine + body + Environment.NewLine);
    }

    private ImmutableArray<string> RunHost(
        string projectDirectory,
        string analyzerPath,
        params string[] extraArguments) =>
        RunHostForResult(projectDirectory, analyzerPath, extraArguments).Files;

    private GeneratorHostRunner.GeneratorRunResult RunHostForResult(
        string projectDirectory,
        string analyzerPath,
        params string[] extraArguments)
    {
        var arguments = new List<string>
        {
            "/analyzer:" + analyzerPath,
            "/out:Probe.dll",
        };

        arguments.AddRange(extraArguments);
        arguments.Add(Path.Combine(projectDirectory, "Program.cs"));

        var globalConfig = Path.Combine(projectDirectory, "generated.globalconfig");
        if (File.Exists(globalConfig))
        {
            arguments.Add("/analyzerconfig:" + globalConfig);
        }

        foreach (var reference in ReferencePaths())
        {
            arguments.Add("/reference:" + reference);
        }

        var commandLine = CscCommandLine.Parse(arguments, projectDirectory);
        Assert.False(commandLine.Analyzers.IsDefaultOrEmpty);

        using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        return GeneratorHostRunner.Run(
            Path.Combine(projectDirectory, "Probe.csproj"),
            "Probe",
            commandLine,
            cts.Token);
    }


    /// <summary>
    /// A generator observing the analyzer config, which is where <c>build_property.*</c> arrives.
    /// </summary>
    private string CompileGenerator(string projectDirectory, string body) =>
        EmitGenerator(projectDirectory, "AnalyzerConfigOptionsProvider", body);

    /// <summary>Same as <see cref="CompileGenerator"/>, but the generator observes the <see cref="Compilation"/> rather than the analyzer config, which is where the compilation options the host chose are visible.</summary>
    private string CompileCompilationGenerator(string projectDirectory, string body) =>
        EmitGenerator(projectDirectory, "CompilationProvider", body);

    /// <summary>Compiles a generator to a DLL the host can <c>Assembly.LoadFrom</c>. Building it in memory keeps the suite free of a NuGet restore while still exercising a genuine analyzer reference, which is what the short-circuit keys on.</summary>
    /// <summary>Same as <see cref="CompileGenerator"/>, but the generator observes <c>AdditionalFiles</c>, which arrive as their own request field rather than through the compilation or the analyzer config.</summary>
    private string CompileAdditionalTextGenerator(string projectDirectory, string body) =>
        EmitGenerator(projectDirectory, "AdditionalTextsProvider", body);

    private string EmitGenerator(string projectDirectory, string provider, string body)
    {
        var source = $$"""
            using Microsoft.CodeAnalysis;

            [Generator]
            public sealed class ProbeGenerator : IIncrementalGenerator
            {
                public void Initialize(IncrementalGeneratorInitializationContext context)
                {
                    var options = context.{{provider}};
                    context.RegisterSourceOutput(options, static (spc, ctx) =>
                    {
            {{body}}
                    });
                }
            }
            """;

        var compilation = CSharpCompilation.Create(
            "ProbeGenerator",
            new[] { CSharpSyntaxTree.ParseText(SourceText.From(source)) },
            ReferencePaths().Select(path => MetadataReference.CreateFromFile(path)),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var path = Path.Combine(projectDirectory, "ProbeGenerator.dll");
        var result = compilation.Emit(path);
        Assert.True(
            result.Success,
            "generator fixture failed to compile: " +
            string.Join(
                Environment.NewLine,
                result.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)));

        return path;
    }

    /// <summary>Uses this test process's own loaded assemblies as references so the generator compiles against exactly the Roslyn version the host will load it into.</summary>
    private static IReadOnlyList<string> ReferencePaths()
    {
        var trusted = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        var paths = new List<string>();
        if (!string.IsNullOrEmpty(trusted))
        {
            paths.AddRange(trusted.Split(Path.PathSeparator).Where(p => p.EndsWith(".dll")));
        }

        foreach (var assembly in new[]
        {
            typeof(IIncrementalGenerator).Assembly,
            typeof(CSharpCompilation).Assembly,
        })
        {
            if (!string.IsNullOrEmpty(assembly.Location) && !paths.Contains(assembly.Location))
            {
                paths.Add(assembly.Location);
            }
        }

        return paths;
    }
}
