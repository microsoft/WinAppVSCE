using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using WinUiXaml.LanguageServer;
using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Workspace;
using Xunit;
using Range = WinUiXaml.LanguageServer.Lsp.Range;
using Diagnostic = WinUiXaml.LanguageServer.Lsp.Diagnostic;

namespace WinUiXaml.LanguageServer.Tests;

/// <summary>
/// Hermetic coverage for <see cref="XamlCodeActions"/> (textDocument/codeAction). Feeds the pure
/// <see cref="XamlCodeActions.Compute"/> synthetic diagnostics carrying <see cref="DiagnosticData"/> and
/// asserts the resulting quick fixes: exact-span replace edits, title/kind/isPreferred, multi-suggestion
/// ordering, the <c>only</c> kind filter, the code allow-list, and that the payload is read from both the
/// in-process <see cref="DiagnosticData"/> and the round-tripped <see cref="JsonElement"/> wire shape.
/// </summary>
public class XamlCodeActionsTests
{
    private const string Uri = "file:///C:/proj/Page.xaml";

    private static Diagnostic Diag(string code, Range range, object? data) => new()
    {
        Code = code,
        Range = range,
        Severity = 2,
        Message = "unknown name",
        Data = data,
    };

    private static Range R(int line, int startChar, int endChar) =>
        new(new Position(line, startChar), new Position(line, endChar));

    private static CodeActionContext Context(params Diagnostic[] diagnostics) =>
        new() { Diagnostics = diagnostics.ToList() };

    private static DiagnosticData Data(string bad, params string[] suggestions) =>
        new() { Bad = bad, Suggestions = suggestions };

    [Fact]
    public void UnknownType_ProducesReplaceQuickFix()
    {
        var range = R(0, 1, 5);
        var ctx = Context(Diag(XamlValidator.UnknownTypeCode, range, Data("Bttn", "Button")));

        var actions = XamlCodeActions.Compute(Uri, null, ctx);

        var action = Assert.Single(actions);
        Assert.Equal("Change 'Bttn' to 'Button'", action.Title);
        Assert.Equal("quickfix", action.Kind);
        Assert.True(action.IsPreferred);
        Assert.Same(ctx.Diagnostics[0], Assert.Single(action.Diagnostics!));

        var edit = Assert.Single(action.Edit!.Changes[Uri]);
        Assert.Equal("Button", edit.NewText);
        Assert.Equal(range.Start, edit.Range.Start);
        Assert.Equal(range.End, edit.Range.End);
    }

    [Fact]
    public void MultipleSuggestions_OnlyFirstIsPreferred_OrderPreserved()
    {
        var ctx = Context(Diag(XamlValidator.UnknownAttributeCode, R(2, 8, 15), Data("Contnt", "Content", "ContextFlyout")));

        var actions = XamlCodeActions.Compute(Uri, null, ctx);

        Assert.Equal(2, actions.Count);
        Assert.Equal("Change 'Contnt' to 'Content'", actions[0].Title);
        Assert.True(actions[0].IsPreferred);
        Assert.Equal("Change 'Contnt' to 'ContextFlyout'", actions[1].Title);
        Assert.Null(actions[1].IsPreferred);
    }

    [Theory]
    [InlineData("WXAML9999")] // unknown code
    [InlineData("WXAML0007")] // duplicate x:Name
    public void NonSuggestibleCode_ProducesNoActions(string code)
    {
        var ctx = Context(Diag(code, R(0, 1, 5), Data("Bttn", "Button")));
        Assert.Empty(XamlCodeActions.Compute(Uri, null, ctx));
    }

    [Fact]
    public void AllSuggestibleCodes_AreHandled()
    {
        foreach (var code in new[]
                 {
                     XamlValidator.UnknownTypeCode,
                     XamlValidator.UnknownAttributeCode,
                     XamlValidator.UnknownAttachedPropertyCode,
                     XamlValidator.UnknownPropertyElementCode,
                     XamlValidator.UnknownBindMemberCode,
                     XamlValidator.UnknownResourceKeyCode,
                     XamlValidator.InvalidSetterPropertyCode,
                     XamlValidator.InvalidBindModeCode,
                 })
        {
            var ctx = Context(Diag(code, R(0, 1, 5), Data("Foo", "Bar")));
            Assert.Single(XamlCodeActions.Compute(Uri, null, ctx));
        }
    }

    [Fact]
    public void UnknownBindMember_ProducesReplaceQuickFix()
    {
        // A single-segment x:Bind path: the diagnostic span IS the token, so the edit replaces it whole.
        var doc = new TextDocument(Uri, "GreetingTexx");
        var ctx = Context(Diag(XamlValidator.UnknownBindMemberCode, R(0, 0, 12), Data("GreetingTexx", "GreetingText")));

        var action = Assert.Single(XamlCodeActions.Compute(Uri, doc, ctx));
        Assert.Equal("Change 'GreetingTexx' to 'GreetingText'", action.Title);
        Assert.True(action.IsPreferred);
        var edit = Assert.Single(action.Edit!.Changes[Uri]);
        Assert.Equal("GreetingText", edit.NewText);
        Assert.Equal(new Position(0, 0), edit.Range.Start);
        Assert.Equal(new Position(0, 12), edit.Range.End);
    }

    [Fact]
    public void UnknownBindMember_WideValueSpan_NarrowsEditToFirstSegment()
    {
        // The first-segment x:Bind diagnostic underlines the WHOLE value (GreetingTexx.Foo); the fix must
        // replace only the bad first segment so the trailing ".Foo" survives.
        var doc = new TextDocument(Uri, "GreetingTexx.Foo");
        var ctx = Context(Diag(XamlValidator.UnknownBindMemberCode, R(0, 0, 16), Data("GreetingTexx", "GreetingText")));

        var edit = Assert.Single(Assert.Single(XamlCodeActions.Compute(Uri, doc, ctx)).Edit!.Changes[Uri]);
        Assert.Equal("GreetingText", edit.NewText);
        Assert.Equal(new Position(0, 0), edit.Range.Start);
        Assert.Equal(new Position(0, 12), edit.Range.End); // exactly "GreetingTexx", not the ".Foo" tail
    }

    [Fact]
    public void UnknownBindMember_LeadingNegation_PreservesBang()
    {
        // A negated path (!GreetingTexx) squiggles the whole value; the fix must keep the leading '!'.
        var doc = new TextDocument(Uri, "!GreetingTexx");
        var ctx = Context(Diag(XamlValidator.UnknownBindMemberCode, R(0, 0, 13), Data("GreetingTexx", "GreetingText")));

        var edit = Assert.Single(Assert.Single(XamlCodeActions.Compute(Uri, doc, ctx)).Edit!.Changes[Uri]);
        Assert.Equal("GreetingText", edit.NewText);
        Assert.Equal(new Position(0, 1), edit.Range.Start); // starts AFTER the '!'
        Assert.Equal(new Position(0, 13), edit.Range.End);
    }

    [Fact]
    public void NullData_ProducesNoActions()
    {
        var ctx = Context(Diag(XamlValidator.UnknownTypeCode, R(0, 1, 5), data: null));
        Assert.Empty(XamlCodeActions.Compute(Uri, null, ctx));
    }

    [Fact]
    public void EmptySuggestions_ProduceNoActions()
    {
        var ctx = Context(Diag(XamlValidator.UnknownTypeCode, R(0, 1, 5), Data("Bttn")));
        Assert.Empty(XamlCodeActions.Compute(Uri, null, ctx));
    }

    [Fact]
    public void OnlyFilter_QuickfixRequested_ReturnsActions()
    {
        var ctx = new CodeActionContext
        {
            Diagnostics = new List<Diagnostic> { Diag(XamlValidator.UnknownTypeCode, R(0, 1, 5), Data("Bttn", "Button")) },
            Only = new[] { "quickfix" },
        };
        Assert.Single(XamlCodeActions.Compute(Uri, null, ctx));
    }

    [Fact]
    public void OnlyFilter_UnrelatedKind_ReturnsNothing()
    {
        var ctx = new CodeActionContext
        {
            Diagnostics = new List<Diagnostic> { Diag(XamlValidator.UnknownTypeCode, R(0, 1, 5), Data("Bttn", "Button")) },
            Only = new[] { "refactor.extract" },
        };
        Assert.Empty(XamlCodeActions.Compute(Uri, null, ctx));
    }

    [Fact]
    public void OnlyFilter_EmptyArray_ReturnsActions()
    {
        var ctx = new CodeActionContext
        {
            Diagnostics = new List<Diagnostic> { Diag(XamlValidator.UnknownTypeCode, R(0, 1, 5), Data("Bttn", "Button")) },
            Only = System.Array.Empty<string>(),
        };
        Assert.Single(XamlCodeActions.Compute(Uri, null, ctx));
    }

    [Fact]
    public void MissingBad_FallsBackToDocumentRangeText()
    {
        // No 'bad' in the payload -> the title text is read from the document over the diagnostic range.
        var doc = new TextDocument(Uri, "<Bttn />\n");
        var ctx = Context(Diag(XamlValidator.UnknownTypeCode, R(0, 1, 5), Data("", "Button")));

        var action = Assert.Single(XamlCodeActions.Compute(Uri, doc, ctx));
        Assert.Equal("Change 'Bttn' to 'Button'", action.Title);
    }

    [Fact]
    public void WireShape_DataAsJsonElement_IsReadIdentically()
    {
        // Simulate the client round-trip: Diagnostic.Data comes back as a JsonElement, not a DiagnosticData.
        var json = JsonSerializer.SerializeToElement(Data("Bttn", "Button"), LspJson.Options);
        var ctx = Context(Diag(XamlValidator.UnknownTypeCode, R(0, 1, 5), json));

        var action = Assert.Single(XamlCodeActions.Compute(Uri, null, ctx));
        Assert.Equal("Change 'Bttn' to 'Button'", action.Title);
        Assert.Equal("Button", Assert.Single(action.Edit!.Changes[Uri]).NewText);
    }

    [Fact]
    public void MultipleDiagnostics_EachContributeIndependently()
    {
        var ctx = Context(
            Diag(XamlValidator.UnknownTypeCode, R(0, 1, 5), Data("Bttn", "Button")),
            Diag("WXAML0001", R(1, 1, 5), Data("x", "y")),               // needs a doc to fix; null doc -> ignored
            Diag(XamlValidator.UnknownAttributeCode, R(2, 3, 9), Data("Contnt", "Content")));

        var actions = XamlCodeActions.Compute(Uri, null, ctx);
        Assert.Equal(2, actions.Count);
        Assert.Contains(actions, a => a.Title == "Change 'Bttn' to 'Button'");
        Assert.Contains(actions, a => a.Title == "Change 'Contnt' to 'Content'");
    }

    // ── WXAML0001: "Add xmlns:… declaration" quick fix ──────────────────────────────────────────────

    [Theory]
    [InlineData("d", "http://schemas.microsoft.com/expression/blend/2008")]
    [InlineData("x", "http://schemas.microsoft.com/winfx/2006/xaml")]
    [InlineData("mc", "http://schemas.openxmlformats.org/markup-compatibility/2006")]
    public void UndeclaredWellKnownPrefix_AddsXmlnsAfterExisting(string prefix, string uri)
    {
        // Root already declares the default xmlns -> the new declaration groups right after it (just
        // before the root's '>'), as a single zero-width insertion.
        var xaml = $"<Page xmlns=\"P\"><{prefix}:Foo /></Page>";
        var doc = new TextDocument(Uri, xaml);
        int prefixAt = xaml.IndexOf($"<{prefix}:") + 1;
        var ctx = Context(Diag(XamlValidator.UndeclaredPrefixCode, R(0, prefixAt, prefixAt + prefix.Length), data: null));

        var action = Assert.Single(XamlCodeActions.Compute(Uri, doc, ctx));
        Assert.Equal($"Add xmlns:{prefix} declaration", action.Title);
        Assert.Equal("quickfix", action.Kind);
        Assert.True(action.IsPreferred);
        var edit = Assert.Single(action.Edit!.Changes[Uri]);
        Assert.Equal($" xmlns:{prefix}=\"{uri}\"", edit.NewText);
        Assert.Equal(edit.Range.Start, edit.Range.End);                    // zero-width insertion
        Assert.Equal(xaml.IndexOf('>'), doc.OffsetAt(edit.Range.Start));   // after xmlns="P", before '>'
    }

    [Fact]
    public void UndeclaredPrefix_NoExistingXmlns_InsertsAfterRootName()
    {
        // No xmlns on the root -> the declaration lands right after the element name.
        var xaml = "<Page><d:Foo /></Page>";
        var doc = new TextDocument(Uri, xaml);
        int prefixAt = xaml.IndexOf("<d:") + 1;
        var ctx = Context(Diag(XamlValidator.UndeclaredPrefixCode, R(0, prefixAt, prefixAt + 1), data: null));

        var edit = Assert.Single(Assert.Single(XamlCodeActions.Compute(Uri, doc, ctx)).Edit!.Changes[Uri]);
        Assert.Equal(" xmlns:d=\"http://schemas.microsoft.com/expression/blend/2008\"", edit.NewText);
        Assert.Equal(xaml.IndexOf('>'), doc.OffsetAt(edit.Range.Start));   // after "Page", before '>'
    }

    [Fact]
    public void UndeclaredCustomPrefix_ProducesNoAction()
    {
        // A custom prefix (local) has no unambiguous namespace to add -> no fix, no guess.
        var xaml = "<Page xmlns=\"P\"><local:Foo /></Page>";
        var doc = new TextDocument(Uri, xaml);
        int prefixAt = xaml.IndexOf("<local:") + 1;
        var ctx = Context(Diag(XamlValidator.UndeclaredPrefixCode, R(0, prefixAt, prefixAt + 5), data: null));

        Assert.Empty(XamlCodeActions.Compute(Uri, doc, ctx));
    }

    [Fact]
    public void UndeclaredPrefix_NullDoc_ProducesNoAction()
    {
        // The fix needs the document to locate the insertion point; with none, it stays silent.
        var ctx = Context(Diag(XamlValidator.UndeclaredPrefixCode, R(0, 1, 2), data: null));
        Assert.Empty(XamlCodeActions.Compute(Uri, null, ctx));
    }

    [Fact]
    public void UndeclaredPrefix_RootlessDoc_ProducesNoAction()
    {
        // No root element -> nowhere to hang the declaration -> no action (defensive guard).
        var doc = new TextDocument(Uri, "d");
        var ctx = Context(Diag(XamlValidator.UndeclaredPrefixCode, R(0, 0, 1), data: null));
        Assert.Empty(XamlCodeActions.Compute(Uri, doc, ctx));
    }

    [Fact]
    public void UndeclaredPrefix_SamePrefixTwice_ProducesSingleAction()
    {
        // Two uses of the same undeclared prefix -> one declaration fixes both, so offer it once.
        var xaml = "<Page xmlns=\"P\"><d:Foo /><d:Bar /></Page>";
        var doc = new TextDocument(Uri, xaml);
        int firstAt = xaml.IndexOf("<d:") + 1;
        int secondAt = xaml.IndexOf("<d:", firstAt) + 1;
        var ctx = Context(
            Diag(XamlValidator.UndeclaredPrefixCode, R(0, firstAt, firstAt + 1), data: null),
            Diag(XamlValidator.UndeclaredPrefixCode, R(0, secondAt, secondAt + 1), data: null));

        var action = Assert.Single(XamlCodeActions.Compute(Uri, doc, ctx));
        Assert.Equal("Add xmlns:d declaration", action.Title);
    }

    // ── WXAML0001: custom-prefix using: inference (needs the type system) ────────────────────────────

    private static XamlTypeSystem BuildTypeSystem(string source)
    {
        // A minimal source-only compilation is enough: FindNamespacesForTypeName searches the compilation's
        // declaration table (source types), never referenced metadata.
        var compilation = CSharpCompilation.Create(
            "TestApp",
            new[] { CSharpSyntaxTree.ParseText(source) },
            new[] { MetadataReference.CreateFromFile(typeof(object).Assembly.Location) },
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        return XamlTypeSystem.FromCompilation(compilation, ImmutableArray<IAssemblySymbol>.Empty);
    }

    private static XamlTypeSystem BuildWinUiTypeSystem(string controls)
    {
        var source = $$"""
            namespace Microsoft.UI.Xaml
            {
                public class DependencyObject { }
            }
            {{controls}}
            """;
        return BuildTypeSystem(source);
    }

    private static XamlTypeSystem BuildReferencedWinUiTypeSystem(string controls)
    {
        var frameworkReference = MetadataReference.CreateFromFile(typeof(object).Assembly.Location);
        var library = CSharpCompilation.Create(
            "ControlLibrary",
            new[] { CSharpSyntaxTree.ParseText($$"""
                namespace Microsoft.UI.Xaml
                {
                    public class DependencyObject { }
                }
                {{controls}}
                """) },
            new[] { frameworkReference },
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        using var image = new MemoryStream();
        var emit = library.Emit(image);
        Assert.True(emit.Success, string.Join("; ", emit.Diagnostics));
        var libraryReference = MetadataReference.CreateFromImage(image.ToArray());
        var consumer = CSharpCompilation.Create(
            "TestApp",
            references: new[] { frameworkReference, libraryReference },
            options: new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var libraryAssembly = Assert.IsAssignableFrom<IAssemblySymbol>(
            consumer.GetAssemblyOrModuleSymbol(libraryReference));
        return XamlTypeSystem.FromCompilation(consumer, ImmutableArray.Create(libraryAssembly));
    }

    [Fact]
    public void UndeclaredCustomPrefix_WithTypeSystem_InfersUsingForSourceType()
    {
        // local:MyPanel names one of the project's own source types -> offer xmlns:local="using:<ns>".
        var ts = BuildTypeSystem("namespace SampleApp { public class MyPanel { } }");
        var xaml = "<Page xmlns=\"P\"><local:MyPanel /></Page>";
        var doc = new TextDocument(Uri, xaml);
        int prefixAt = xaml.IndexOf("<local:") + 1;
        var ctx = Context(Diag(XamlValidator.UndeclaredPrefixCode, R(0, prefixAt, prefixAt + 5), data: null));

        var action = Assert.Single(XamlCodeActions.Compute(Uri, doc, ctx, ts));
        Assert.Equal("Add xmlns:local=\"using:SampleApp\"", action.Title);
        Assert.Equal("quickfix", action.Kind);
        Assert.True(action.IsPreferred);                                  // single candidate -> preferred
        var edit = Assert.Single(action.Edit!.Changes[Uri]);
        Assert.Equal(" xmlns:local=\"using:SampleApp\"", edit.NewText);
        Assert.Equal(edit.Range.Start, edit.Range.End);                   // zero-width insertion
        Assert.Equal(xaml.IndexOf('>'), doc.OffsetAt(edit.Range.Start));  // grouped after xmlns="P"
    }

    [Fact]
    public void UndeclaredCustomPrefix_WithTypeSystem_TwoNamespaces_OffersEachNotPreferred()
    {
        // The same simple name is declared in two namespaces -> offer both, neither preferred (ambiguous).
        var ts = BuildTypeSystem(
            "namespace Alpha { public class Widget { } } namespace Beta { public class Widget { } }");
        var xaml = "<Page xmlns=\"P\"><local:Widget /></Page>";
        var doc = new TextDocument(Uri, xaml);
        int prefixAt = xaml.IndexOf("<local:") + 1;
        var ctx = Context(Diag(XamlValidator.UndeclaredPrefixCode, R(0, prefixAt, prefixAt + 5), data: null));

        var actions = XamlCodeActions.Compute(Uri, doc, ctx, ts);
        Assert.Equal(2, actions.Count);
        var alpha = actions.Single(a => a.Title.Contains("Alpha"));
        var beta = actions.Single(a => a.Title.Contains("Beta"));
        Assert.Equal("Add xmlns:local=\"using:Alpha\"", alpha.Title);
        Assert.Equal("Add xmlns:local=\"using:Beta\"", beta.Title);
        Assert.Equal(" xmlns:local=\"using:Alpha\"", Assert.Single(alpha.Edit!.Changes[Uri]).NewText);
        Assert.All(actions, a => Assert.NotEqual(true, a.IsPreferred));   // ambiguous -> none preferred
    }

    [Fact]
    public void UndeclaredCustomPrefix_WithTypeSystem_UnknownType_ProducesNoAction()
    {
        // The prefixed element names no source type -> nothing to infer, no action (never guesses a namespace).
        var ts = BuildTypeSystem("namespace SampleApp { public class MyPanel { } }");
        var xaml = "<Page xmlns=\"P\"><local:Nope /></Page>";
        var doc = new TextDocument(Uri, xaml);
        int prefixAt = xaml.IndexOf("<local:") + 1;
        var ctx = Context(Diag(XamlValidator.UndeclaredPrefixCode, R(0, prefixAt, prefixAt + 5), data: null));

        Assert.Empty(XamlCodeActions.Compute(Uri, doc, ctx, ts));
    }

    [Fact]
    public void UndeclaredCustomPrefix_OnAttribute_WithTypeSystem_ProducesNoAction()
    {
        // A custom prefix on an ATTRIBUTE names a member, not a type -> no using: inference even when a
        // source type of that name exists (the fix is offered only for element/type usages).
        var ts = BuildTypeSystem("namespace SampleApp { public class Tag { } }");
        var xaml = "<Page xmlns=\"P\" local:Tag=\"x\"></Page>";
        var doc = new TextDocument(Uri, xaml);
        int prefixAt = xaml.IndexOf("local:");
        var ctx = Context(Diag(XamlValidator.UndeclaredPrefixCode, R(0, prefixAt, prefixAt + 5), data: null));

        Assert.Empty(XamlCodeActions.Compute(Uri, doc, ctx, ts));
    }

    [Fact]
    public void UndeclaredWellKnownPrefix_WithTypeSystem_StillUsesStandardDeclaration()
    {
        // A well-known prefix stays the standard declaration form even with a type system available
        // (never re-interpreted as a using: guess).
        var ts = BuildTypeSystem("namespace SampleApp { public class Foo { } }");
        var xaml = "<Page xmlns=\"P\"><d:Foo /></Page>";
        var doc = new TextDocument(Uri, xaml);
        int prefixAt = xaml.IndexOf("<d:") + 1;
        var ctx = Context(Diag(XamlValidator.UndeclaredPrefixCode, R(0, prefixAt, prefixAt + 1), data: null));

        var action = Assert.Single(XamlCodeActions.Compute(Uri, doc, ctx, ts));
        Assert.Equal("Add xmlns:d declaration", action.Title);
        Assert.Equal(
            " xmlns:d=\"http://schemas.microsoft.com/expression/blend/2008\"",
            Assert.Single(action.Edit!.Changes[Uri]).NewText);
    }

    // ── WXAML0002: import an unresolved unprefixed element type ─────────────────────────────────────

    [Fact]
    public void UnknownUnprefixedType_SelfClosing_AddsNamespaceAndQualifiesElement()
    {
        var ts = BuildWinUiTypeSystem(
            "namespace SampleApp.Controls { public class InfoCard : Microsoft.UI.Xaml.DependencyObject { } }");
        var xaml = "<Page xmlns=\"P\"><InfoCard /></Page>";
        var doc = new TextDocument(Uri, xaml);
        int nameAt = xaml.IndexOf("InfoCard");
        var diagnostic = Diag(
            XamlValidator.UnknownTypeCode, R(0, nameAt, nameAt + "InfoCard".Length), Data("InfoCard"));

        var action = Assert.Single(XamlCodeActions.Compute(Uri, doc, Context(diagnostic), ts));

        Assert.Equal("Import 'InfoCard' from 'SampleApp.Controls'", action.Title);
        Assert.True(action.IsPreferred);
        var edits = action.Edit!.Changes[Uri];
        Assert.Contains(edits, edit => edit.NewText == " xmlns:controls=\"using:SampleApp.Controls\"");
        var qualifier = Assert.Single(edits, edit => edit.NewText == "controls:");
        Assert.Equal(nameAt, doc.OffsetAt(qualifier.Range.Start));
    }

    [Fact]
    public void UnknownUnprefixedProjectType_DiagnosticDrivesImport()
    {
        var ts = BuildWinUiTypeSystem(
            "namespace SampleApp.Controls { public class CustomButton : Microsoft.UI.Xaml.DependencyObject { } }");
        const string xaml = """
            <DependencyObject xmlns="using:Microsoft.UI.Xaml">
              <CustomButton />
            </DependencyObject>
            """;
        var doc = new TextDocument(Uri, xaml);
        var diagnostic = Assert.Single(
            XamlValidator.Validate(doc, ts),
            item => item.Code == XamlValidator.UnknownTypeCode);

        var action = Assert.Single(XamlCodeActions.Compute(Uri, doc, Context(diagnostic), ts));

        Assert.Equal(1, diagnostic.Severity);
        Assert.Equal("Import 'CustomButton' from 'SampleApp.Controls'", action.Title);
        Assert.True(action.IsPreferred);
    }

    [Fact]
    public void UnknownUnprefixedType_MultilineNamespaces_AddsAlignedLine()
    {
        var ts = BuildWinUiTypeSystem(
            "namespace SampleApp.Controls { public class InfoCard : Microsoft.UI.Xaml.DependencyObject { } }");
        const string xaml = """
            <Page
                xmlns="P"
                xmlns:x="X"
                x:Class="SampleApp.Page">
              <InfoCard />
            </Page>
            """;
        var doc = new TextDocument(Uri, xaml);
        int nameAt = xaml.IndexOf("InfoCard", System.StringComparison.Ordinal);
        var diagnostic = Diag(
            XamlValidator.UnknownTypeCode,
            doc.RangeOf(new WinUiXaml.Xaml.TextSpan(nameAt, nameAt + "InfoCard".Length)),
            Data("InfoCard"));

        var edit = XamlCodeActions.Compute(Uri, doc, Context(diagnostic), ts)
            .Single()
            .Edit!.Changes[Uri]
            .Single(item => item.NewText.Contains("xmlns:controls", System.StringComparison.Ordinal));
        var xmlnsX = doc.Parsed.Root!.Attributes.Single(
            attribute => attribute.Name.FullName == "xmlns:x");

        Assert.Equal(
            System.Environment.NewLine + "    xmlns:controls=\"using:SampleApp.Controls\"",
            edit.NewText);
        Assert.Equal(xmlnsX.Span.End, doc.OffsetAt(edit.Range.Start));
    }

    [Fact]
    public void UnknownUnprefixedType_PairedElement_QualifiesOpeningAndClosingTags()
    {
        var ts = BuildWinUiTypeSystem(
            "namespace SampleApp.Controls { public class InfoCard : Microsoft.UI.Xaml.DependencyObject { } }");
        var xaml = "<Page xmlns=\"P\"><InfoCard></InfoCard></Page>";
        var doc = new TextDocument(Uri, xaml);
        int openAt = xaml.IndexOf("InfoCard");
        int closeAt = xaml.LastIndexOf("InfoCard");
        var diagnostic = Diag(
            XamlValidator.UnknownTypeCode, R(0, openAt, openAt + "InfoCard".Length), Data("InfoCard"));

        var edits = XamlCodeActions.Compute(Uri, doc, Context(diagnostic), ts)
            .Single(action => action.Kind == "quickfix")
            .Edit!.Changes[Uri];
        var qualifiers = edits.Where(edit => edit.NewText == "controls:").ToList();

        Assert.Equal(2, qualifiers.Count);
        Assert.Contains(qualifiers, edit => doc.OffsetAt(edit.Range.Start) == openAt);
        Assert.Contains(qualifiers, edit => doc.OffsetAt(edit.Range.Start) == closeAt);
    }

    [Fact]
    public void UnknownUnprefixedType_ReusesExistingNamespacePrefix()
    {
        var ts = BuildWinUiTypeSystem(
            "namespace SampleApp.Controls { public class InfoCard : Microsoft.UI.Xaml.DependencyObject { } }");
        var xaml =
            "<Page xmlns=\"P\" xmlns:kit=\"using:SampleApp.Controls\"><InfoCard /></Page>";
        var doc = new TextDocument(Uri, xaml);
        int nameAt = xaml.IndexOf("InfoCard");
        var diagnostic = Diag(
            XamlValidator.UnknownTypeCode, R(0, nameAt, nameAt + "InfoCard".Length), Data("InfoCard"));

        var edits = XamlCodeActions.Compute(Uri, doc, Context(diagnostic), ts)
            .Single(action => action.Kind == "quickfix")
            .Edit!.Changes[Uri];

        Assert.Single(edits);
        Assert.Equal("kit:", edits[0].NewText);
    }

    [Fact]
    public void UnknownUnprefixedType_ConflictingGeneratedPrefixGetsNumericSuffix()
    {
        var ts = BuildWinUiTypeSystem(
            "namespace SampleApp.Controls { public class InfoCard : Microsoft.UI.Xaml.DependencyObject { } }");
        var xaml = "<Page xmlns=\"P\" xmlns:controls=\"using:Other.Controls\"><InfoCard /></Page>";
        var doc = new TextDocument(Uri, xaml);
        int nameAt = xaml.IndexOf("InfoCard");
        var diagnostic = Diag(
            XamlValidator.UnknownTypeCode, R(0, nameAt, nameAt + "InfoCard".Length), Data("InfoCard"));

        var edits = XamlCodeActions.Compute(Uri, doc, Context(diagnostic), ts)
            .Single(action => action.Kind == "quickfix")
            .Edit!.Changes[Uri];

        Assert.Contains(edits, edit => edit.NewText == "controls2:");
        Assert.Contains(
            edits,
            edit => edit.NewText == " xmlns:controls2=\"using:SampleApp.Controls\"");
    }

    [Fact]
    public void UnknownUnprefixedType_AmbiguousNamespaces_OffersOneNonPreferredActionPerNamespace()
    {
        var ts = BuildWinUiTypeSystem("""
            namespace Alpha.Controls
            {
                public class InfoCard : Microsoft.UI.Xaml.DependencyObject { }
            }
            namespace Beta.Controls
            {
                public class InfoCard : Microsoft.UI.Xaml.DependencyObject { }
            }
            """);
        var xaml = "<Page xmlns=\"P\"><InfoCard /></Page>";
        var doc = new TextDocument(Uri, xaml);
        int nameAt = xaml.IndexOf("InfoCard");
        var diagnostic = Diag(
            XamlValidator.UnknownTypeCode, R(0, nameAt, nameAt + "InfoCard".Length), Data("InfoCard"));

        var actions = XamlCodeActions.Compute(Uri, doc, Context(diagnostic), ts);

        Assert.Equal(2, actions.Count);
        Assert.Contains(actions, action => action.Title == "Import 'InfoCard' from 'Alpha.Controls'");
        Assert.Contains(actions, action => action.Title == "Import 'InfoCard' from 'Beta.Controls'");
        Assert.All(actions, action => Assert.NotEqual(true, action.IsPreferred));
    }

    [Fact]
    public void UnknownUnprefixedType_ReferencedControl_IsImportable()
    {
        var ts = BuildReferencedWinUiTypeSystem(
            "namespace Contoso.Controls { public class InfoCard : Microsoft.UI.Xaml.DependencyObject { } }");
        var xaml = "<Page xmlns=\"P\"><InfoCard /></Page>";
        var doc = new TextDocument(Uri, xaml);
        int nameAt = xaml.IndexOf("InfoCard");
        var diagnostic = Diag(
            XamlValidator.UnknownTypeCode, R(0, nameAt, nameAt + "InfoCard".Length), Data("InfoCard"));

        var action = Assert.Single(XamlCodeActions.Compute(Uri, doc, Context(diagnostic), ts));

        Assert.Equal("Import 'InfoCard' from 'Contoso.Controls'", action.Title);
        Assert.Contains(
            action.Edit!.Changes[Uri],
            edit => edit.NewText == " xmlns:controls=\"using:Contoso.Controls\"");
    }

    [Fact]
    public void UnknownUnprefixedType_NonWinUiClass_ProducesNoImportAction()
    {
        var ts = BuildWinUiTypeSystem("namespace SampleApp.Controls { public class InfoCard { } }");
        var xaml = "<Page xmlns=\"P\"><InfoCard /></Page>";
        var doc = new TextDocument(Uri, xaml);
        int nameAt = xaml.IndexOf("InfoCard");
        var diagnostic = Diag(
            XamlValidator.UnknownTypeCode, R(0, nameAt, nameAt + "InfoCard".Length), Data("InfoCard"));

        Assert.Empty(XamlCodeActions.Compute(Uri, doc, Context(diagnostic), ts));
    }

    [Fact]
    public void UnknownUnprefixedType_IncompleteOpenTag_StillOffersImport()
    {
        var ts = BuildWinUiTypeSystem(
            "namespace SampleApp.Controls { public class InfoCard : Microsoft.UI.Xaml.DependencyObject { } }");
        var xaml = "<InfoCard";
        var doc = new TextDocument(Uri, xaml);
        var diagnostic = Diag(
            XamlValidator.UnknownTypeCode, R(0, 1, 9), Data("InfoCard"));

        var action = Assert.Single(XamlCodeActions.Compute(Uri, doc, Context(diagnostic), ts));

        Assert.Equal("Import 'InfoCard' from 'SampleApp.Controls'", action.Title);
        Assert.Contains(action.Edit!.Changes[Uri], edit => edit.NewText == "controls:");
        Assert.Contains(
            action.Edit.Changes[Uri],
            edit => edit.NewText == " xmlns:controls=\"using:SampleApp.Controls\"");
    }

    [Fact]
    public void UnknownUnprefixedType_ImportAndSpellingFix_HaveSinglePreferredAction()
    {
        var ts = BuildWinUiTypeSystem(
            "namespace SampleApp.Controls { public class InfoCard : Microsoft.UI.Xaml.DependencyObject { } }");
        var xaml = "<Page xmlns=\"P\"><InfoCard /></Page>";
        var doc = new TextDocument(Uri, xaml);
        int nameAt = xaml.IndexOf("InfoCard");
        var diagnostic = Diag(
            XamlValidator.UnknownTypeCode,
            R(0, nameAt, nameAt + "InfoCard".Length),
            Data("InfoCard", "InfoBar"));

        var actions = XamlCodeActions.Compute(Uri, doc, Context(diagnostic), ts);
        var import = actions.Single(action => action.Title.StartsWith("Import ", System.StringComparison.Ordinal));
        var spelling = actions.Single(action => action.Title.StartsWith("Change ", System.StringComparison.Ordinal));

        Assert.True(import.IsPreferred);
        Assert.NotEqual(true, spelling.IsPreferred);
    }
}
