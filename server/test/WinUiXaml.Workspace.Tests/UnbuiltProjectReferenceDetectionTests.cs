using WinUiXaml.Workspace;

namespace WinUiXaml.Workspace.Tests;

/// <summary>
/// D3: on a fresh clone the referenced projects have never been built, so the WinUI markup compiler
/// aborts with WMC1006 and MSBuild exits non-zero before CoreCompile runs. No compilation is
/// produced, which takes out completions, hovers and diagnostics together -- including framework
/// types that have nothing to do with the referenced project. Detecting this specific failure is
/// what lets the server say "build once" instead of serving silence.
/// </summary>
public sealed class UnbuiltProjectReferenceDetectionTests
{
    private const string Wmc1006Output = """
        C:\src\App\MainWindow.xaml : XamlCompiler error WMC1006: Cannot resolve Assembly or Windows Metadata file 'C:\src\MiddleLib\bin\Debug\net10.0\MiddleLib.dll'
        C:\src\App\MainWindow.xaml : XamlCompiler error WMC1006: Cannot resolve Assembly or Windows Metadata file 'C:\src\SharedLib\bin\Debug\net10.0\SharedLib.dll'
        """;

    [Fact]
    public void Wmc1006OutputIsRecognizedAsAnUnbuiltProjectReference()
    {
        Assert.True(RoslynProjectWorkspace.IsUnbuiltProjectReferenceFailure(Wmc1006Output));
    }

    [Fact]
    public void UnbuiltDetectionMatchesTheMessageWhenTheCodeIsAbsent()
    {
        // Localized MSBuild output can drop the bare code from the line we capture, so the prose
        // has to match on its own.
        Assert.True(RoslynProjectWorkspace.IsUnbuiltProjectReferenceFailure(
            "Cannot resolve Assembly or Windows Metadata file 'C:\\src\\SharedLib.dll'"));
    }

    [Fact]
    public void UnrelatedBuildFailuresAreNotReportedAsUnbuiltReferences()
    {
        // A generic failure must stay generic: telling the user to build would send them to fix
        // something that is not broken.
        Assert.False(RoslynProjectWorkspace.IsUnbuiltProjectReferenceFailure(
            "CSC error CS1002: ; expected"));
        Assert.False(RoslynProjectWorkspace.IsUnbuiltProjectReferenceFailure(string.Empty));
    }

    [Fact]
    public void RestoreAndBuildFailuresAreNotConfusedForEachOther()
    {
        Assert.False(RoslynProjectWorkspace.IsMissingRestoreFailure(Wmc1006Output));
        Assert.False(RoslynProjectWorkspace.IsUnbuiltProjectReferenceFailure(
            "error NETSDK1004: Assets file 'project.assets.json' not found."));
    }

    [Fact]
    public void EveryUnresolvedProjectIsNamedOnceInOrder()
    {
        var names = RoslynProjectWorkspace.ExtractUnresolvedAssemblies(Wmc1006Output);

        Assert.Equal(new[] { "MiddleLib", "SharedLib" }, names);
    }

    [Fact]
    public void RepeatedFailuresForOneProjectAreReportedOnce()
    {
        // The markup compiler emits one WMC1006 per XAML file, so a project with several pages
        // would otherwise be named several times in the prompt.
        var repeated = Wmc1006Output + "\n" + Wmc1006Output;

        Assert.Equal(new[] { "MiddleLib", "SharedLib" },
            RoslynProjectWorkspace.ExtractUnresolvedAssemblies(repeated));
    }

    [Fact]
    public void MalformedCompilerOutputYieldsNoNamesRatherThanThrowing()
    {
        Assert.Empty(RoslynProjectWorkspace.ExtractUnresolvedAssemblies(
            "Cannot resolve Assembly or Windows Metadata file ''"));
        Assert.Empty(RoslynProjectWorkspace.ExtractUnresolvedAssemblies("no matches here"));
    }

    // Peer-suggested corner of the detection matrix: one referenced project is built and a sibling
    // is not. The compiler only emits WMC1006 for what it could not resolve, so the prompt must
    // name the missing sibling alone -- telling a user to build a project that is already built
    // sends them to fix something that is not broken, which is the failure mode the prompt exists
    // to avoid.
    [Fact]
    public void APartiallyBuiltSolutionNamesOnlyTheUnbuiltSibling()
    {
        const string partial =
            @"C:\src\App\MainWindow.xaml : XamlCompiler error WMC1006: Cannot resolve Assembly or Windows Metadata file 'C:\src\SharedLib\bin\Debug\net10.0\SharedLib.dll'";

        Assert.True(RoslynProjectWorkspace.IsUnbuiltProjectReferenceFailure(partial));

        var names = RoslynProjectWorkspace.ExtractUnresolvedAssemblies(partial);

        Assert.Equal(new[] { "SharedLib" }, names);
        Assert.DoesNotContain("MiddleLib", names);
    }

    // The detector's true negative: a ProjectReference carrying ReferenceOutputAssembly="false"
    // produces no assembly by design, so nothing is unresolved and the build succeeds. Every other
    // case in this matrix makes the detector fire; this one must not, or the server would demand a
    // build for a solution that is already correct.
    [Fact]
    public void AReferenceThatProducesNoAssemblyDoesNotDemandABuild()
    {
        const string succeeded = """
            Build succeeded.
                0 Warning(s)
                0 Error(s)
            """;

        Assert.False(RoslynProjectWorkspace.IsUnbuiltProjectReferenceFailure(succeeded));
        Assert.Empty(RoslynProjectWorkspace.ExtractUnresolvedAssemblies(succeeded));
    }

    [Fact]
    public void TheExceptionNamesTheProjectsAndTellsTheUserWhatToDo()
    {
        var exception = new ProjectBuildRequiredException(
            @"C:\src\App\App.csproj",
            RoslynProjectWorkspace.ExtractUnresolvedAssemblies(Wmc1006Output));

        Assert.Equal(@"C:\src\App\App.csproj", exception.ProjectPath);
        Assert.Contains("MiddleLib", exception.Message);
        Assert.Contains("SharedLib", exception.Message);
        Assert.Contains("Build the solution", exception.Message);
    }

    [Fact]
    public void TheExceptionStaysReadableWhenNoProjectCouldBeNamed()
    {
        var exception = new ProjectBuildRequiredException(@"C:\src\App\App.csproj", []);

        Assert.Contains("a referenced project", exception.Message);
        Assert.DoesNotContain("()", exception.Message);
    }
}
