using System;
using System.IO;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using WinUiXaml.LanguageServer;
using Xunit;

namespace WinUiXaml.LanguageServer.Tests;

public sealed class EventHandlerSignatureTests
{
    [Theory]
    [InlineData("object sender, Controls.Input.PointerRoutedEventArgs e")]
    [InlineData("Controls.Input.PointerRoutedEventArgs @event, ref int count")]
    [InlineData("System.Collections.Generic.List<Controls.Input.PointerRoutedEventArgs?> items")]
    public void GeneratedSignatureCompilesWithoutImports(string parameters)
    {
        var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator).Select(path => MetadataReference.CreateFromFile(path));
        var source = $$"""
            #nullable enable
            namespace Controls.Input { public class PointerRoutedEventArgs {} }
            namespace Events { public delegate void Handler({{parameters}}); }
            namespace App { public partial class Page {} }
            """;
        var compilation = CSharpCompilation.Create("HandlerTest",
            [CSharpSyntaxTree.ParseText(source)], references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var invoke = compilation.GetTypeByMetadataName("Events.Handler")!.DelegateInvokeMethod!;
        var signature = XamlLanguageServer.BuildParameterList(invoke);
        var edited = compilation.AddSyntaxTrees(CSharpSyntaxTree.ParseText($$"""
            #nullable enable
            namespace App
            {
                public partial class Page
                {
                    public void Generated({{signature}}) {}
                    public Events.Handler GetHandler() => Generated;
                }
            }
            """));
        Assert.Empty(edited.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error));
        Assert.Contains("global::", signature);
    }
}
