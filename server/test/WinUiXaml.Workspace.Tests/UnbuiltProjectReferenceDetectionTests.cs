using WinUiXaml.Workspace;

namespace WinUiXaml.Workspace.Tests;

/// <summary>D3: on a fresh clone the referenced projects have never been built, so the WinUI markup compiler aborts with WMC1006 and MSBuild exits non-zero before CoreCompile runs. No compilation is produced, which takes out completions, hovers and diagnostics together -- including framework types that have nothing to do with the referenced project. Detecting this specific failure is what lets the server say "build once" instead of serving silence.</summary>
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

    // Peer-suggested corner: one reference is built and a sibling is not; WMC1006 names only unresolved assemblies, so the prompt must not send users to rebuild what already works.
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

    // True negative: ReferenceOutputAssembly="false" intentionally emits no assembly and succeeds, so this case must not make the server demand a needless build.
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
        Assert.Contains("could not be produced", exception.Message);
    }

    [Fact]
    public void TheExceptionStaysReadableWhenNoProjectCouldBeNamed()
    {
        var exception = new ProjectBuildRequiredException(@"C:\src\App\App.csproj", []);

        Assert.Contains("a referenced project", exception.Message);
        Assert.DoesNotContain("()", exception.Message);
    }

    [Fact]
    public void ADegradedResolutionCarriesTheUnresolvedReferencesForward()
    {
        // The fallback load succeeds, so nothing throws and the server has no exception to read
        // the unresolved list from. It travels on the resolution instead, and dropping it here
        // would restore the silent outage the prompt exists to prevent.
        var compilation = Microsoft.CodeAnalysis.CSharp.CSharpCompilation.Create("Probe");
        var resolution = new XamlResolution(
            @"C:\src\App\MainWindow.xaml",
            @"C:\src\App\App.csproj",
            className: "App.MainWindow",
            classSymbol: null,
            compilation,
            System.Collections.Immutable.ImmutableArray<Microsoft.CodeAnalysis.IAssemblySymbol>.Empty,
            System.Collections.Immutable.ImmutableArray<string>.Empty,
            applicationDefinitionPath: null,
            System.Collections.Immutable.ImmutableArray.Create("MiddleLib"));

        Assert.Equal(new[] { "MiddleLib" }, resolution.UnresolvedProjectReferences);

        // WithClassName runs on every XML-only edit. If it dropped the list the prompt would
        // survive the first keystroke and vanish on the second.
        Assert.Equal(
            new[] { "MiddleLib" },
            resolution.WithClassName("App.MainWindow").UnresolvedProjectReferences);
    }

    [Fact]
    public void AHealthyResolutionReportsNoUnresolvedReferences()
    {
        var compilation = Microsoft.CodeAnalysis.CSharp.CSharpCompilation.Create("Probe");
        var resolution = new XamlResolution(
            @"C:\src\App\MainWindow.xaml",
            @"C:\src\App\App.csproj",
            className: null,
            classSymbol: null,
            compilation,
            System.Collections.Immutable.ImmutableArray<Microsoft.CodeAnalysis.IAssemblySymbol>.Empty,
            System.Collections.Immutable.ImmutableArray<string>.Empty,
            applicationDefinitionPath: null);

        Assert.False(resolution.UnresolvedProjectReferences.IsDefault);
        Assert.Empty(resolution.UnresolvedProjectReferences);
    }

    private const string ReferenceBuildFailureOutput = """
        C:\src\BrokenLib\Broken.cs(1,21): error CS1519: Invalid token 'this' in a member declaration [C:\src\BrokenLib\BrokenLib.csproj]
        C:\src\BrokenLib\Broken.cs(2,1): error CS1002: ; expected [C:\src\BrokenLib\BrokenLib.csproj]
        """;

    [Fact]
    public void AnErrorAttributedToAReferencedProjectNamesThatProject()
    {
        // MSBuild tags each diagnostic with the project that produced it, so an error carrying a
        // project other than the one requested is a referenced project that failed to build.
        var names = RoslynProjectWorkspace.ExtractFailedReferencedProjects(
            ReferenceBuildFailureOutput, @"C:\src\App\App.csproj");

        Assert.Equal(new[] { "BrokenLib" }, names);
    }

    [Fact]
    public void ErrorsFromTheRequestedProjectAreNotReportedAsReferenceFailures()
    {
        // The user's own compile errors are ordinary diagnostics, not a build prompt.
        Assert.Empty(RoslynProjectWorkspace.ExtractFailedReferencedProjects(
            @"C:\src\App\Program.cs(1,1): error CS1002: ; expected [C:\src\App\App.csproj]",
            @"C:\src\App\App.csproj"));
    }

    [Fact]
    public void AMultiTargetedReferenceIsReportedOnce()
    {
        // MSBuild tags an inner build as `Lib.csproj::TargetFramework=net9.0`.
        var names = RoslynProjectWorkspace.ExtractFailedReferencedProjects(
            """
            a.cs(1,1): error CS1002: ; expected [C:\src\Lib\Lib.csproj::TargetFramework=net9.0]
            a.cs(2,1): error CS1002: ; expected [C:\src\Lib\Lib.csproj::TargetFramework=net10.0]
            """,
            @"C:\src\App\App.csproj");

        Assert.Equal(new[] { "Lib" }, names);
    }

    [Fact]
    public void WarningsFromAReferencedProjectAreNotAReferenceFailure()
    {
        Assert.Empty(RoslynProjectWorkspace.ExtractFailedReferencedProjects(
            @"a.cs(1,1): warning CS0168: unused [C:\src\Lib\Lib.csproj]",
            @"C:\src\App\App.csproj"));
    }
}
