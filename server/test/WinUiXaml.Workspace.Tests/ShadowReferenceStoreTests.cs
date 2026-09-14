using System.Collections.Generic;
using System.IO;
using System.Threading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using WinUiXaml.Workspace;

namespace WinUiXaml.Workspace.Tests;

/// <summary>
/// The markup compiler runs out of process and resolves references off disk, so a referenced
/// project that has never been built takes out code generation for the whole project -- no
/// <c>InitializeComponent</c>, no <c>x:Name</c> fields. Roslyn needs none of this, which is why the
/// gap was invisible from the compilation side. These tests pin the stand-in assemblies that close
/// it, and the properties that point a design-time build at them.
/// </summary>
public sealed class ShadowReferenceStoreTests
{
    private static Compilation CompilationOf(string assemblyName, string source) =>
        CSharpCompilation.Create(
            assemblyName,
            [CSharpSyntaxTree.ParseText(source)],
            [MetadataReference.CreateFromFile(typeof(object).Assembly.Location)],
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

    [Fact]
    public void NothingToSynthesizeProducesNoInjection()
    {
        Assert.Null(
            ShadowReferenceStore.Create(
                Path.Combine(Path.GetTempPath(), "winuixaml-shadow-empty", "App.csproj"),
                [],
                chainedCustomAfterTargets: null,
                CancellationToken.None));
    }

    [Fact]
    public void EachCompilationIsWrittenUnderItsAssemblyName()
    {
        var injection = ShadowReferenceStore.Create(
            Path.Combine(Path.GetTempPath(), "winuixaml-shadow-named", "App.csproj"),
            [CompilationOf("Lib", "namespace Lib; public class Greeter { public string Text => \"hi\"; }")],
            chainedCustomAfterTargets: null,
            CancellationToken.None);

        Assert.NotNull(injection);
        var assembly = Path.Combine(injection!.Directory, "Lib.dll");
        Assert.True(File.Exists(assembly));
        // MSBuild matches these by file name, so an empty file would be picked up and then fail
        // the markup compiler in a way that reads like a corrupt reference.
        Assert.True(new FileInfo(assembly).Length > 0);
    }

    [Fact]
    public void SourceThatDoesNotCompileStillYieldsAReference()
    {
        // Half-written code is the normal state while editing. Metadata-only emit skips method
        // bodies, so the types a XAML file names stay resolvable through an error the developer
        // has not finished typing.
        var injection = ShadowReferenceStore.Create(
            Path.Combine(Path.GetTempPath(), "winuixaml-shadow-broken", "App.csproj"),
            [CompilationOf("Broken", "namespace Broken; public class Widget { public int N() { return; } }")],
            chainedCustomAfterTargets: null,
            CancellationToken.None);

        Assert.NotNull(injection);
        Assert.True(File.Exists(Path.Combine(injection!.Directory, "Broken.dll")));
    }

    [Fact]
    public void StaleAssembliesDoNotSurviveALaterSynthesis()
    {
        var root = Path.Combine(Path.GetTempPath(), "winuixaml-shadow-stale", "App.csproj");
        var first = ShadowReferenceStore.Create(
            root,
            [CompilationOf("Gone", "public class Gone { }")],
            chainedCustomAfterTargets: null,
            CancellationToken.None);
        Assert.NotNull(first);
        Assert.True(File.Exists(Path.Combine(first!.Directory, "Gone.dll")));

        var second = ShadowReferenceStore.Create(
            root,
            [CompilationOf("Kept", "public class Kept { }")],
            chainedCustomAfterTargets: null,
            CancellationToken.None);

        Assert.NotNull(second);
        Assert.Equal(first.Directory, second!.Directory);
        // A reference that outlived the project reference that produced it would resolve types
        // the workspace no longer contains, which is worse than not resolving them at all.
        Assert.False(File.Exists(Path.Combine(second.Directory, "Gone.dll")));
        Assert.True(File.Exists(Path.Combine(second.Directory, "Kept.dll")));
    }

    [Fact]
    public void TheInjectedTargetsReImportTheHookItBorrows()
    {
        // CustomAfterMicrosoftCommonTargets holds one path. Claiming it without re-importing the
        // project's own value would silently delete part of the user's build.
        var injection = ShadowReferenceStore.Create(
            Path.Combine(Path.GetTempPath(), "winuixaml-shadow-chain", "App.csproj"),
            [CompilationOf("Chained", "public class Chained { }")],
            chainedCustomAfterTargets: @"C:\repo\Custom.After.targets",
            CancellationToken.None);

        Assert.NotNull(injection);
        var targets = File.ReadAllText(injection!.TargetsFile);
        Assert.Contains("$(WinUiXamlChainedCustomAfterTargets)", targets);
        Assert.Contains("<Import Project=", targets);

        var arguments = new List<string>();
        injection.AppendTo(arguments);
        Assert.Contains($"-p:CustomAfterMicrosoftCommonTargets={injection.TargetsFile}", arguments);
        Assert.Contains($"-p:WinUiXamlShadowReferenceDir={injection.Directory}", arguments);
        Assert.Contains(
            @"-p:WinUiXamlChainedCustomAfterTargets=C:\repo\Custom.After.targets", arguments);
    }

    [Fact]
    public void AProjectWithNoCustomHookPassesNoChainedValue()
    {
        var injection = ShadowReferenceStore.Create(
            Path.Combine(Path.GetTempPath(), "winuixaml-shadow-nochain", "App.csproj"),
            [CompilationOf("Plain", "public class Plain { }")],
            chainedCustomAfterTargets: null,
            CancellationToken.None);

        Assert.NotNull(injection);
        var arguments = new List<string>();
        injection!.AppendTo(arguments);
        Assert.DoesNotContain(
            arguments, argument => argument.StartsWith("-p:WinUiXamlChainedCustomAfterTargets="));
    }

    [Fact]
    public void OnlyUnresolvableReferencesAreSubstituted()
    {
        var injection = ShadowReferenceStore.Create(
            Path.Combine(Path.GetTempPath(), "winuixaml-shadow-substitute", "App.csproj"),
            [CompilationOf("Sub", "public class Sub { }")],
            chainedCustomAfterTargets: null,
            CancellationToken.None);

        Assert.NotNull(injection);
        var targets = File.ReadAllText(injection!.TargetsFile);
        // A stand-in that displaced a real, built reference would serve types from source while
        // the rest of the build used the compiled assembly.
        Assert.Contains("!Exists('%(ReferencePath.FullPath)')", targets);
        Assert.Contains("BeforeTargets=\"DesignTimeMarkupCompilationCT;MarkupCompilePass1\"", targets);
    }
}
