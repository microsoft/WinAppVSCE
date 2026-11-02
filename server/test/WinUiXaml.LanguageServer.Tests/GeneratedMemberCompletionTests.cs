using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace WinUiXaml.LanguageServer.Tests;

public sealed class GeneratedMemberCompletionTests
{
    [Theory]
    [InlineData("CommunityToolkit.Mvvm.SourceGenerators.ObservablePropertyGenerator", false)]
    [InlineData("CommunityToolkit.Mvvm.SourceGenerators.RelayCommandGenerator", false)]
    [InlineData("Microsoft.UI.Xaml.Markup.Compiler", true)]
    public void OnlyMarkupCompilerPlumbingIsHidden(string generator, bool hidden)
    {
        var source = $$"""
            namespace System.CodeDom.Compiler
            {
                public class GeneratedCodeAttribute : System.Attribute
                {
                    public GeneratedCodeAttribute(string tool, string version) {}
                }
            }
            public class ViewModel
            {
                [System.CodeDom.Compiler.GeneratedCode("{{generator}}", "1.0")]
                public string Title => "";
            }
            """;
        var compilation = CSharpCompilation.Create("Generated",
            [CSharpSyntaxTree.ParseText(source, path: @"C:\generated\ViewModel.g.cs")],
            [MetadataReference.CreateFromFile(typeof(object).Assembly.Location)]);
        var member = compilation.GetTypeByMetadataName("ViewModel")!.GetMembers("Title").Single();
        Assert.Equal(hidden, CompletionProvider.IsBindCompletionNoise(member));
    }
}
