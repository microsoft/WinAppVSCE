using System;
using System.IO;
using System.Linq;
using System.Threading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using WinUiXaml.Workspace;

namespace WinUiXaml.Workspace.Tests;

/// <summary>Pins which compilation stage carries XML documentation. This is invisible in the completion code -- <c>CompletionProvider</c> is byte-identical to the base branch -- because it changes the data feeding the provider rather than the provider itself. The base design got documentation implicitly from MSBuildWorkspace for the authoritative compilation and never had it on the framework stage. Replacing MSBuildWorkspace for Native AOT routed both stages through one code path, which silently gave the framework stage documentation too, and that is what makes VS Code open its details pane beside the suggestion list as soon as a file opens.</summary>
public class CscCommandLineDocumentationTests
{
    [Fact]
    public void TheFrameworkStageCarriesNoDocumentation()
    {
        var root = CreateTemporaryDirectory();
        try
        {
            var documented = ResolveDocumentedType(root, includeDocumentation: false);

            Assert.True(
                string.IsNullOrWhiteSpace(documented.GetDocumentationCommentXml()),
                "Completion items are built from the symbol's own documentation, so the early "
                    + "stage must stay bare to match the base branch.");
        }
        finally
        {
            TryDelete(root);
        }
    }

    [Fact]
    public void TheAuthoritativeStageStillCarriesDocumentation()
    {
        // The other half of the invariant. Without it, deleting the documentation provider outright
        // would also pass, and the smoke suite's completion-documentation assertions -- which exist
        // unchanged in the base branch -- would be the only thing left to catch it.
        var root = CreateTemporaryDirectory();
        try
        {
            var documented = ResolveDocumentedType(root, includeDocumentation: true);

            Assert.Contains(
                "Documented fixture type.",
                documented.GetDocumentationCommentXml());
        }
        finally
        {
            TryDelete(root);
        }
    }

    [Fact]
    public void TheSiblingDocumentationFileIsRealSoTheAbsenceIsMeaningful()
    {
        // Without this, TheFrameworkStageCarriesNoDocumentation would also pass if the fixture
        // simply failed to write any XML -- a check that cannot fail.
        var root = CreateTemporaryDirectory();
        try
        {
            var assemblyPath = WriteLibraryWithSiblingDocumentation(root);
            var xmlPath = Path.ChangeExtension(assemblyPath, ".xml");

            Assert.True(File.Exists(xmlPath));
            Assert.Contains("Documented fixture type.", File.ReadAllText(xmlPath));
        }
        finally
        {
            TryDelete(root);
        }
    }

    [Fact]
    public void TheFrameworkStageActuallyOptsOut()
    {
        // The stage tests above call CreateMetadataReferences directly, so they keep passing even
        // if MsBuildFrameworkProject stops asking for the bare references -- the exact shape of a
        // check that cannot fail. This harvests the real call site instead.
        var source = File.ReadAllText(
            Path.Combine(WorkspaceSourceDirectory(), "MsBuildFrameworkProject.cs"));

        Assert.Contains("CreateMetadataReferences(includeDocumentation: false)", source);
        Assert.DoesNotContain("CreateMetadataReferences(includeDocumentation: true)", source);
    }

    private static string WorkspaceSourceDirectory()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null)
        {
            var candidate = Path.Combine(
                directory.FullName,
                "server",
                "src",
                "WinUiXaml.Workspace");
            if (Directory.Exists(candidate))
            {
                return candidate;
            }

            directory = directory.Parent;
        }

        throw new DirectoryNotFoundException(
            "Could not locate server/src/WinUiXaml.Workspace from " + AppContext.BaseDirectory);
    }

    private static INamedTypeSymbol ResolveDocumentedType(string root, bool includeDocumentation)
    {
        var assemblyPath = WriteLibraryWithSiblingDocumentation(root);
        var parsed = CscCommandLine.Parse(new[] { "/reference:" + assemblyPath }, root);
        var compilation = CSharpCompilation.Create(
            "Consumer",
            Array.Empty<SyntaxTree>(),
            parsed.CreateMetadataReferences(includeDocumentation));

        var documented = compilation.GetTypeByMetadataName("Fixture.Documented");

        // Guard the guard: an unresolved type would make the documentation assertions pass against
        // null and prove nothing.
        Assert.NotNull(documented);
        return documented!;
    }

    private static string WriteLibraryWithSiblingDocumentation(string root)
    {
        const string source = """
            namespace Fixture
            {
                /// <summary>Documented fixture type.</summary>
                public class Documented { }
            }
            """;

        var compilation = CSharpCompilation.Create(
            "Fixture",
            new[] { CSharpSyntaxTree.ParseText(source) },
            new[] { MetadataReference.CreateFromFile(typeof(object).Assembly.Location) },
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var assemblyPath = Path.Combine(root, "Fixture.dll");
        var result = compilation.Emit(assemblyPath);
        Assert.True(
            result.Success,
            string.Join(Environment.NewLine, result.Diagnostics.Select(d => d.ToString())));

        File.WriteAllText(Path.ChangeExtension(assemblyPath, ".xml"), """
            <doc><members>
              <member name="T:Fixture.Documented">
                <summary>Documented fixture type.</summary>
              </member>
            </members></doc>
            """);

        return assemblyPath;
    }

    private static string CreateTemporaryDirectory()
    {
        var path = Path.Combine(Path.GetTempPath(), "winui-xaml-doc-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }

    /// <summary>Cleanup must never be able to fail an otherwise passing test.</summary>
    private static void TryDelete(string path)
    {
        for (var attempt = 0; attempt < 3; attempt++)
        {
            try
            {
                Directory.Delete(path, recursive: true);
                return;
            }
            catch (IOException)
            {
                Thread.Sleep(100);
            }
            catch (UnauthorizedAccessException)
            {
                Thread.Sleep(100);
            }
        }
    }
}
