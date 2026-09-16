using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using WinUiXaml.Workspace;

namespace WinUiXaml.Workspace.Tests;

/// <summary>Covers the csc command-line parser that defines the compilation the language server reasons about. A switch silently dropped here does not fail loudly: the compilation is still built, just with the wrong nullability, the wrong preprocessor symbols, or a missing reference. Types then resolve differently from the real build, and the resulting IntelliSense is wrong rather than absent -- the same class of failure as dropping the analyzer configs.</summary>
public class CscCommandLineParseTests
{
    private const string ProjectDirectory = @"C:\proj";

    private static CscCommandLine Parse(params string[] arguments) =>
        CscCommandLine.Parse(arguments, ProjectDirectory);

    [Fact]
    public void Parse_TreatsLinkAsAnEmbeddedInteropReference()
    {
        // MSBuild spells EmbedInteropTypes="true" as /link: on the csc command line. An embedded
        // interop reference carries no runtime assembly identity, so recording it as an ordinary
        // reference makes every COM/WinRT PIA type bind differently from the real build.
        var parsed = Parse(@"/link:C:\proj\Interop.dll", @"/reference:C:\proj\Plain.dll");

        Assert.Contains(@"C:\proj\Interop.dll", parsed.References);
        Assert.Contains(@"C:\proj\Plain.dll", parsed.References);
        Assert.Contains(@"C:\proj\Interop.dll", parsed.EmbeddedInteropReferences);
        Assert.DoesNotContain(@"C:\proj\Plain.dll", parsed.EmbeddedInteropReferences);
    }

    [Fact]
    public void Parse_AcceptsShortLinkForm()
    {
        var parsed = Parse(@"/l:C:\proj\Interop.dll");

        Assert.Contains(@"C:\proj\Interop.dll", parsed.References);
        Assert.Contains(@"C:\proj\Interop.dll", parsed.EmbeddedInteropReferences);
    }

    [Fact]
    public void Parse_KeepsAliasesOnLinkedReferences()
    {
        var parsed = Parse(@"/link:Interop=C:\proj\Interop.dll");

        Assert.Contains(@"C:\proj\Interop.dll", parsed.EmbeddedInteropReferences);
        Assert.Equal(
            new[] { "Interop" },
            parsed.ReferenceAliases[@"C:\proj\Interop.dll"]);
    }

    [Fact]
    public void Parse_LeavesEmbeddedInteropEmptyWhenNothingIsLinked()
    {
        var parsed = Parse(@"/reference:C:\proj\Plain.dll");

        Assert.Empty(parsed.EmbeddedInteropReferences);
    }

    [Fact]
    public void Parse_SplitsDefineOnSemicolons()
    {
        var parsed = Parse("/define:DEBUG;TRACE;WINDOWS");

        Assert.Equal(new[] { "DEBUG", "TRACE", "WINDOWS" }, parsed.PreprocessorSymbols);
    }

    [Theory]
    [InlineData("enable", NullableContextOptions.Enable)]
    [InlineData("", NullableContextOptions.Enable)]
    [InlineData("+", NullableContextOptions.Enable)]
    [InlineData("warnings", NullableContextOptions.Warnings)]
    [InlineData("annotations", NullableContextOptions.Annotations)]
    [InlineData("disable", NullableContextOptions.Disable)]
    public void Parse_MapsNullableContext(string value, NullableContextOptions expected)
    {
        var argument = value switch
        {
            "" => "/nullable",
            "+" => "/nullable+",
            _ => "/nullable:" + value,
        };

        Assert.Equal(expected, Parse(argument).NullableContext);
    }

    [Theory]
    [InlineData("exe", OutputKind.ConsoleApplication)]
    [InlineData("winexe", OutputKind.WindowsApplication)]
    [InlineData("module", OutputKind.NetModule)]
    [InlineData("library", OutputKind.DynamicallyLinkedLibrary)]
    public void Parse_MapsTarget(string value, OutputKind expected)
    {
        Assert.Equal(expected, Parse("/target:" + value).OutputKind);
    }

    [Fact]
    public void Parse_ResolvesRelativePathsAgainstTheProjectNotTheProcess()
    {
        var parsed = Parse(@"Views\MainPage.xaml.cs");

        Assert.Equal(
            Path.GetFullPath(Path.Combine(ProjectDirectory, @"Views\MainPage.xaml.cs")),
            Assert.Single(parsed.Sources));
    }

    [Fact]
    public void Parse_CapturesExternAliases()
    {
        var parsed = Parse(@"/reference:Alpha,Beta=C:\packages\Foo.dll");

        var path = Assert.Single(parsed.References);
        Assert.Equal(@"C:\packages\Foo.dll", path);
        Assert.Equal(new[] { "Alpha", "Beta" }, parsed.ReferenceAliases[path]);
    }

    /// <summary>A rooted Windows path contains '=' at no index, but the guard keys on index 1, which is where the ':' of a drive letter sits. Getting this wrong turns every rooted reference into an alias named after its drive.</summary>
    [Fact]
    public void Parse_TreatsADriveLetterAsAPathNotAnAlias()
    {
        var parsed = Parse(@"/reference:C:\packages\Foo.dll");

        Assert.Equal(@"C:\packages\Foo.dll", Assert.Single(parsed.References));
        Assert.Empty(parsed.ReferenceAliases);
    }

    [Fact]
    public void Parse_StripsQuotesFromPaths()
    {
        var parsed = Parse("/reference:\"C:\\path with spaces\\Foo.dll\"");

        Assert.Equal(@"C:\path with spaces\Foo.dll", Assert.Single(parsed.References));
    }

    [Fact]
    public void Parse_CapturesAnalyzerConfigsAndAdditionalFiles()
    {
        var parsed = Parse(
            @"/analyzerconfig:obj\Debug\App.GeneratedMSBuildEditorConfig.editorconfig",
            @"/additionalfile:Strings.resx");

        Assert.Equal(
            Path.GetFullPath(Path.Combine(
                ProjectDirectory, @"obj\Debug\App.GeneratedMSBuildEditorConfig.editorconfig")),
            Assert.Single(parsed.AnalyzerConfigs));
        Assert.Equal(
            Path.GetFullPath(Path.Combine(ProjectDirectory, "Strings.resx")),
            Assert.Single(parsed.AdditionalFiles));
    }

    [Fact]
    public void Parse_PropagatesLanguageVersionToParseOptions()
    {
        var parsed = Parse("/langversion:preview");

        Assert.Equal("preview", parsed.LanguageVersion);
        Assert.Equal(LanguageVersion.Preview, parsed.CreateParseOptions().LanguageVersion);
    }

    /// <summary>csc parses doc comments only under /doc, which MSBuild omits unless the project emits an XML file -- but quick info for the user's own members is read off these syntax trees, so DocumentationMode.None makes every summary on their types vanish while framework prose keeps working. That reads as a documentation problem, not a parse option.</summary>
    [Fact]
    public void Parse_KeepsDocCommentsEvenWithoutTheDocSwitch()
    {
        var parsed = Parse("MainPage.xaml.cs");

        Assert.NotEqual(
            DocumentationMode.None,
            parsed.CreateParseOptions().DocumentationMode);
    }

    [Fact]
    public void Parse_IgnoresNonSourceBareArguments()    {
        var parsed = Parse("MainPage.xaml.cs", "readme.txt", "App.xaml");

        Assert.Equal(
            Path.GetFullPath(Path.Combine(ProjectDirectory, "MainPage.xaml.cs")),
            Assert.Single(parsed.Sources));
    }

    [Fact]
    public void Parse_TakesAssemblyNameFromOutWithoutItsExtension()
    {
        Assert.Equal(@"MyApp", Parse(@"/out:obj\Debug\MyApp.dll").AssemblyName);
    }

    [Fact]
    public void Parse_AcceptsShortFormSwitches()
    {
        var parsed = Parse(
            @"/r:C:\packages\Foo.dll",
            @"/a:C:\analyzers\Gen.dll",
            "/d:DEBUG");

        Assert.Equal(@"C:\packages\Foo.dll", Assert.Single(parsed.References));
        Assert.Equal(@"C:\analyzers\Gen.dll", Assert.Single(parsed.Analyzers));
        Assert.Equal("DEBUG", Assert.Single(parsed.PreprocessorSymbols));
    }

    [Fact]
    public void Parse_TreatsUnsafeMinusAsDisabled()
    {
        Assert.True(Parse("/unsafe").AllowUnsafe);
        Assert.True(Parse("/unsafe+").AllowUnsafe);
        Assert.False(Parse("/unsafe-").AllowUnsafe);
    }
}
