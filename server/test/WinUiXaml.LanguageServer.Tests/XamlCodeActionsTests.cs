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
    public void UnknownType_PairedElement_UpdatesBothTagsAtomically()
    {
        var xaml = "<Page><Buton></Buton></Page>";
        var doc = new TextDocument(Uri, xaml, version: 4);
        int openAt = xaml.IndexOf("Buton", System.StringComparison.Ordinal);
        int closeAt = xaml.LastIndexOf("Buton", System.StringComparison.Ordinal);
        var diagnostic = Diag(
            XamlValidator.UnknownTypeCode, R(0, openAt, openAt + 5), Data("Buton", "Button"));

        var edits = Assert.Single(XamlCodeActions.Compute(Uri, doc, Context(diagnostic)))
            .Edit!.Changes[Uri];

        Assert.Equal(2, edits.Count);
        Assert.All(edits, edit => Assert.Equal("Button", edit.NewText));
        Assert.Contains(edits, edit => doc.OffsetAt(edit.Range.Start) == openAt);
        Assert.Contains(edits, edit => doc.OffsetAt(edit.Range.Start) == closeAt);
    }

    [Fact]
    public void UnknownType_SelfClosingElement_OnlyUpdatesOpeningTag()
    {
        var xaml = "<Page><Buton /></Page>";
        var doc = new TextDocument(Uri, xaml);
        int nameAt = xaml.IndexOf("Buton", System.StringComparison.Ordinal);
        var diagnostic = Diag(
            XamlValidator.UnknownTypeCode, R(0, nameAt, nameAt + 5), Data("Buton", "Button"));

        var edit = Assert.Single(Assert.Single(
            XamlCodeActions.Compute(Uri, doc, Context(diagnostic))).Edit!.Changes[Uri]);

        Assert.Equal("Button", edit.NewText);
        Assert.Equal(nameAt, doc.OffsetAt(edit.Range.Start));
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
                     XamlValidator.InvalidAttributeValueCode,
                 })
        {
            var ctx = Context(Diag(code, R(0, 1, 5), Data("Foo", "Bar")));
            Assert.Single(XamlCodeActions.Compute(Uri, null, ctx));
        }
    }

    [Fact]
    public void InvalidEnumValue_UsesValidatorSuggestions()
    {
        var doc = new TextDocument(Uri, "<Button HorizontalAlignment=\"Strech\" />");
        int valueAt = doc.Text.IndexOf("Strech", System.StringComparison.Ordinal);
        var diagnostic = Diag(
            XamlValidator.InvalidAttributeValueCode,
            R(0, valueAt, valueAt + "Strech".Length),
            Data("Strech", "Stretch"));

        var action = Assert.Single(
            XamlCodeActions.Compute(Uri, doc, Context(diagnostic)),
            item => item.Kind == "quickfix");

        Assert.Equal("Change 'Strech' to 'Stretch'", action.Title);
        Assert.Equal("Stretch", Assert.Single(action.Edit!.Changes[Uri]).NewText);
    }

    [Fact]
    public void MismatchedClosingTag_UsesInnermostParserEvidence()
    {
        var xaml = "<Grid><Button></Buton></Grid>";
        var doc = new TextDocument(Uri, xaml);
        var parserDiagnostic = Assert.Single(
            doc.Parsed.Diagnostics, item => item.Id == WinUiXaml.Xaml.XamlDiagnosticIds.StrayEndTag);
        var diagnostic = Diag(
            parserDiagnostic.Id, doc.RangeOf(parserDiagnostic.Span), data: null);

        var action = Assert.Single(
            XamlCodeActions.Compute(Uri, doc, Context(diagnostic)),
            item => item.Kind == "quickfix");
        var edit = Assert.Single(action.Edit!.Changes[Uri]);

        Assert.Equal("Change closing tag 'Buton' to 'Button'", action.Title);
        Assert.Equal("Button", edit.NewText);
        Assert.Equal(xaml.IndexOf("Buton", System.StringComparison.Ordinal), doc.OffsetAt(edit.Range.Start));
    }

    [Fact]
    public void DataTypeDiagnostic_WithoutAuthoritativeType_ProducesNoUnsafeFix()
    {
        var xaml = "<DataTemplate><TextBlock Text=\"{x:Bind Name}\" /></DataTemplate>";
        var doc = new TextDocument(Uri, xaml);
        int bindAt = xaml.IndexOf("x:Bind", System.StringComparison.Ordinal);
        var diagnostic = Diag(
            XamlValidator.DataTemplateDataTypeRequiredCode,
            R(0, bindAt, bindAt + "x:Bind".Length),
            data: null);

        Assert.DoesNotContain(
            XamlCodeActions.Compute(Uri, doc, Context(diagnostic)),
            item => item.Kind == "quickfix");
    }

    [Theory]
    [InlineData(XamlValidator.DataTemplateDataTypeRequiredCode)]
    [InlineData(XamlValidator.BindingDataTypeRecommendedCode)]
    public void DataTypeDiagnostic_UniqueAuthoritativeType_InsertsOnEnclosingTemplate(string code)
    {
        var xaml =
            "<Page xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\" " +
            "xmlns:models=\"using:Sample.Models\"><DataTemplate><TextBlock Text=\"{x:Bind Name}\" />" +
            "</DataTemplate></Page>";
        var doc = new TextDocument(Uri, xaml);
        int bindAt = xaml.IndexOf("x:Bind", System.StringComparison.Ordinal);
        var diagnostic = Diag(
            code,
            R(0, bindAt, bindAt + "x:Bind".Length),
            Data("using:Sample.Models", "models:Person"));

        var action = Assert.Single(
            XamlCodeActions.Compute(Uri, doc, Context(diagnostic)),
            item => item.Kind == "quickfix");
        var edit = Assert.Single(action.Edit!.Changes[Uri]);
        int templateClose = xaml.IndexOf(
            '>', xaml.IndexOf("<DataTemplate", System.StringComparison.Ordinal));

        Assert.Equal("Set x:DataType to 'models:Person'", action.Title);
        Assert.Equal(" x:DataType=\"models:Person\"", edit.NewText);
        Assert.Equal(templateClose, doc.OffsetAt(edit.Range.Start));
        Assert.Equal(edit.Range.Start, edit.Range.End);
    }

    [Fact]
    public void DataTypeDiagnostic_StaleActionDoesNotReplaceExistingValue()
    {
        var xaml =
            "<DataTemplate xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\" " +
            "xmlns:models=\"using:Sample.Models\" x:DataType=\"models:Old\">" +
            "<TextBlock Text=\"{x:Bind Name}\" /></DataTemplate>";
        var doc = new TextDocument(Uri, xaml);
        int bindAt = xaml.IndexOf("x:Bind", System.StringComparison.Ordinal);
        var diagnostic = Diag(
            XamlValidator.DataTemplateDataTypeRequiredCode,
            R(0, bindAt, bindAt + "x:Bind".Length),
            Data("using:Sample.Models", "models:Person"));

        Assert.DoesNotContain(
            XamlCodeActions.Compute(Uri, doc, Context(diagnostic)),
            item => item.Kind == "quickfix");
    }

    [Fact]
    public void DataTypeDiagnostic_ReplacesExistingEmptyValue()
    {
        var xaml =
            "<DataTemplate xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\" " +
            "xmlns:models=\"using:Sample.Models\" x:DataType=\"\">" +
            "<TextBlock Text=\"{x:Bind Name}\" /></DataTemplate>";
        var doc = new TextDocument(Uri, xaml);
        int bindAt = xaml.IndexOf("x:Bind", System.StringComparison.Ordinal);
        var diagnostic = Diag(
            XamlValidator.DataTemplateDataTypeRequiredCode,
            R(0, bindAt, bindAt + "x:Bind".Length),
            Data("using:Sample.Models", "models:Person"));

        var action = Assert.Single(
            XamlCodeActions.Compute(Uri, doc, Context(diagnostic)),
            item => item.Kind == "quickfix");
        var edit = Assert.Single(action.Edit!.Changes[Uri]);

        Assert.Equal("models:Person", edit.NewText);
        Assert.Equal(edit.Range.Start, edit.Range.End);
    }

    [Fact]
    public void DataTypeDiagnostic_AmbiguousTypes_OffersPromptedAction()
    {
        var xaml =
            "<DataTemplate xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\" " +
            "xmlns:models=\"using:Sample.Models\"><TextBlock Text=\"{x:Bind Name}\" /></DataTemplate>";
        var doc = new TextDocument(Uri, xaml, version: 4);
        int bindAt = xaml.IndexOf("x:Bind", System.StringComparison.Ordinal);
        var diagnostic = Diag(
            XamlValidator.DataTemplateDataTypeRequiredCode,
            R(0, bindAt, bindAt + "x:Bind".Length),
            Data("using:Sample.Models", "models:Person", "models:Account"));

        var action = Assert.Single(
            XamlCodeActions.Compute(Uri, doc, Context(diagnostic)),
            item => item.Kind == "quickfix");
        Assert.Equal("Set x:DataType...", action.Title);
        Assert.Equal(XamlCodeActions.PromptTextEditCommand, action.Command!.Name);
        Assert.Null(action.Edit);
        var arguments = PromptArguments(action);
        Assert.Equal(Uri, arguments.DocumentUri);
        var range = arguments.Range;
        Assert.Equal(xaml.IndexOf('>', xaml.IndexOf("<DataTemplate", System.StringComparison.Ordinal)),
            doc.OffsetAt(range.Start));
        Assert.Equal(range.Start, range.End);
        Assert.Equal("Enter the XAML type for this template", arguments.Prompt);
        Assert.Equal("models:Item", arguments.PlaceHolder);
        Assert.Equal(string.Empty, arguments.InitialValue);
        Assert.Equal(" x:DataType=\"", arguments.Prefix);
        Assert.Equal("\"", arguments.Suffix);
        Assert.Equal(4, arguments.ExpectedVersion);
        Assert.Equal(string.Empty, arguments.ExpectedText);
        Assert.Equal(new[] { "models:Person", "models:Account" }, arguments.Choices);
        Assert.Equal("Enter another type...", arguments.CustomChoiceLabel);
        Assert.Equal(@"(?:[\p{L}_][\p{L}\p{N}_.-]*:)?[\p{L}_][\p{L}\p{N}_]*", arguments.ValidationPattern);
        Assert.Equal("Enter a XAML type name such as models:Item.", arguments.ValidationMessage);
        using var payload = JsonDocument.Parse(JsonSerializer.Serialize(action.Command, LspJson.Options));
        var request = Assert.Single(payload.RootElement.GetProperty("arguments").EnumerateArray());
        Assert.Equal(Uri, request.GetProperty("documentUri").GetString());
        Assert.Equal("models:Item", request.GetProperty("placeHolder").GetString());
        Assert.Equal(13, request.EnumerateObject().Count());
    }

    [Fact]
    public void DataTypeDiagnostic_AmbiguousTypes_ReplacesExistingEmptyValue()
    {
        var xaml =
            "<DataTemplate xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\" " +
            "xmlns:models=\"using:Sample.Models\" x:DataType=\"\">" +
            "<TextBlock Text=\"{x:Bind Name}\" /></DataTemplate>";
        var doc = new TextDocument(Uri, xaml, version: 6);
        int bindAt = xaml.IndexOf("x:Bind", System.StringComparison.Ordinal);
        var diagnostic = Diag(
            XamlValidator.DataTemplateDataTypeRequiredCode,
            R(0, bindAt, bindAt + "x:Bind".Length),
            Data("using:Sample.Models", "models:Person", "models:Account"));

        var arguments = PromptArguments(Assert.Single(
            XamlCodeActions.Compute(Uri, doc, Context(diagnostic)),
            item => item.Kind == "quickfix"));

        Assert.Equal(string.Empty, arguments.Prefix);
        Assert.Equal(string.Empty, arguments.Suffix);
        Assert.Equal(string.Empty, arguments.ExpectedText);
        Assert.Equal(
            xaml.IndexOf("x:DataType=\"", System.StringComparison.Ordinal) + "x:DataType=\"".Length,
            doc.OffsetAt(arguments.Range.Start));
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
        var doc = new TextDocument(Uri, xaml, version: 5);
        int prefixAt = xaml.IndexOf($"<{prefix}:") + 1;
        var ctx = Context(Diag(
            XamlValidator.UndeclaredPrefixCode,
            R(0, prefixAt, prefixAt + prefix.Length),
            Data(prefix, uri)));

        var action = Assert.Single(XamlCodeActions.Compute(Uri, doc, ctx));
        Assert.Equal($"Add xmlns:{prefix}=\"{uri}\"", action.Title);
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
        var ctx = Context(Diag(
            XamlValidator.UndeclaredPrefixCode,
            R(0, prefixAt, prefixAt + 1),
            Data("d", "http://schemas.microsoft.com/expression/blend/2008")));

        var edit = Assert.Single(Assert.Single(XamlCodeActions.Compute(Uri, doc, ctx)).Edit!.Changes[Uri]);
        Assert.Equal(" xmlns:d=\"http://schemas.microsoft.com/expression/blend/2008\"", edit.NewText);
        Assert.Equal(xaml.IndexOf('>'), doc.OffsetAt(edit.Range.Start));   // after "Page", before '>'
    }

    [Fact]
    public void UndeclaredCustomPrefix_OffersPromptedAction()
    {
        // A custom prefix has no namespace to infer, so ask instead of guessing.
        var xaml = "<Page xmlns=\"P\"><local:Foo /></Page>";
        var doc = new TextDocument(Uri, xaml, version: 5);
        int prefixAt = xaml.IndexOf("<local:") + 1;
        var ctx = Context(Diag(XamlValidator.UndeclaredPrefixCode, R(0, prefixAt, prefixAt + 5), data: null));

        var action = Assert.Single(XamlCodeActions.Compute(Uri, doc, ctx));
        Assert.Equal("Add xmlns:local...", action.Title);
        Assert.Equal(XamlCodeActions.PromptTextEditCommand, action.Command!.Name);
        var arguments = PromptArguments(action);
        var range = arguments.Range;
        Assert.Equal(xaml.IndexOf('>'), doc.OffsetAt(range.Start));
        Assert.Equal(range.Start, range.End);
        Assert.Equal("Enter the namespace URI for 'local'", arguments.Prompt);
        Assert.Equal("using:MyApp.Controls", arguments.PlaceHolder);
        Assert.Equal(string.Empty, arguments.InitialValue);
        Assert.Equal(" xmlns:local=\"", arguments.Prefix);
        Assert.Equal("\"", arguments.Suffix);
        Assert.Equal(5, arguments.ExpectedVersion);
        Assert.Equal(string.Empty, arguments.ExpectedText);
        Assert.Empty(arguments.Choices);
        Assert.Equal("Enter another namespace URI...", arguments.CustomChoiceLabel);
        Assert.Equal(
            @"(?:using:[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*|https?://[^\s""'&<>]+)",
            arguments.ValidationPattern);
        Assert.Equal(
            "Enter a using: namespace or an http(s) namespace URI without whitespace or XML metacharacters.",
            arguments.ValidationMessage);
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
            Diag(XamlValidator.UndeclaredPrefixCode, R(0, firstAt, firstAt + 1),
                Data("d", "http://schemas.microsoft.com/expression/blend/2008")),
            Diag(XamlValidator.UndeclaredPrefixCode, R(0, secondAt, secondAt + 1),
                Data("d", "http://schemas.microsoft.com/expression/blend/2008")));

        var action = Assert.Single(XamlCodeActions.Compute(Uri, doc, ctx));
        Assert.Equal(
            "Add xmlns:d=\"http://schemas.microsoft.com/expression/blend/2008\"",
            action.Title);
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

    private static XamlTypeSystem BuildNameTypeSystem() =>
        BuildTypeSystem("""
            namespace Microsoft.UI.Xaml
            {
                public class FrameworkElement
                {
                    public string Name { get; set; } = "";
                    public object? Tag { get; set; }
                }
                public class FrameworkTemplate { }
                public class ControlTemplate : FrameworkTemplate { }
                public class Page : FrameworkElement { }
                public class Button : FrameworkElement { }
            }
            namespace Microsoft.UI.Xaml.Markup
            {
                public abstract class MarkupExtension { }
            }
            namespace Microsoft.UI.Xaml.Data
            {
                public class Binding : Microsoft.UI.Xaml.Markup.MarkupExtension { }
            }
            """);

    private static XamlTypeSystem BuildScalarContentTypeSystem() =>
        BuildTypeSystem("""
            namespace Microsoft.UI.Xaml.Markup
            {
                [System.AttributeUsage(System.AttributeTargets.Class)]
                public sealed class ContentPropertyAttribute : System.Attribute
                {
                    public ContentPropertyAttribute(string name) { }
                }
            }
            namespace Microsoft.UI.Xaml
            {
                [Microsoft.UI.Xaml.Markup.ContentProperty("Child")]
                public class Border { public object Child { get; set; } = new object(); }
                public class TextBlock { }
                public class Button { }
            }
            """);

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
    public void UndeclaredCustomPrefix_UniqueDiagnosticSuggestion_AddsUsingNamespace()
    {
        // local:MyPanel names one of the project's own source types -> offer xmlns:local="using:<ns>".
        var ts = BuildTypeSystem("namespace SampleApp { public class MyPanel { } }");
        var xaml = "<Page xmlns=\"P\"><local:MyPanel /></Page>";
        var doc = new TextDocument(Uri, xaml);
        int prefixAt = xaml.IndexOf("<local:") + 1;
        var ctx = Context(Diag(
            XamlValidator.UndeclaredPrefixCode,
            R(0, prefixAt, prefixAt + 5),
            Data("local", "using:SampleApp")));

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
    public void UndeclaredCustomPrefix_AmbiguousDiagnosticSuggestions_OffersPromptedAction()
    {
        // The same simple name is declared in two namespaces -> offer both, neither preferred (ambiguous).
        var ts = BuildTypeSystem(
            "namespace Alpha { public class Widget { } } namespace Beta { public class Widget { } }");
        var xaml = "<Page xmlns=\"P\"><local:Widget /></Page>";
        var doc = new TextDocument(Uri, xaml);
        int prefixAt = xaml.IndexOf("<local:") + 1;
        var ctx = Context(Diag(
            XamlValidator.UndeclaredPrefixCode,
            R(0, prefixAt, prefixAt + 5),
            Data("local", "using:Alpha", "using:Beta")));

        var action = Assert.Single(XamlCodeActions.Compute(Uri, doc, ctx, ts));
        Assert.Equal(XamlCodeActions.PromptTextEditCommand, action.Command!.Name);
        var arguments = PromptArguments(action);
        Assert.Equal(
            new[] { "using:Alpha", "using:Beta" },
            arguments.Choices);
        Assert.Equal("Enter another namespace URI...", arguments.CustomChoiceLabel);
    }

    [Fact]
    public void UndeclaredCustomPrefix_WithTypeSystem_UnknownType_OffersPromptedAction()
    {
        // The prefixed element names no source type -> prompt for the namespace (never guess one).
        var ts = BuildTypeSystem("namespace SampleApp { public class MyPanel { } }");
        var xaml = "<Page xmlns=\"P\"><local:Nope /></Page>";
        var doc = new TextDocument(Uri, xaml);
        int prefixAt = xaml.IndexOf("<local:") + 1;
        var ctx = Context(Diag(XamlValidator.UndeclaredPrefixCode, R(0, prefixAt, prefixAt + 5), data: null));

        var action = Assert.Single(XamlCodeActions.Compute(Uri, doc, ctx, ts));
        Assert.Equal(XamlCodeActions.PromptTextEditCommand, action.Command!.Name);
    }

    [Fact]
    public void UndeclaredCustomPrefix_OnAttribute_WithTypeSystem_OffersPromptedAction()
    {
        // A custom prefix on an attribute cannot be inferred from a type name, so prompt for the URI.
        var ts = BuildTypeSystem("namespace SampleApp { public class Tag { } }");
        var xaml = "<Page xmlns=\"P\" local:Tag=\"x\"></Page>";
        var doc = new TextDocument(Uri, xaml);
        int prefixAt = xaml.IndexOf("local:");
        var ctx = Context(Diag(XamlValidator.UndeclaredPrefixCode, R(0, prefixAt, prefixAt + 5), data: null));

        var action = Assert.Single(XamlCodeActions.Compute(Uri, doc, ctx, ts));
        Assert.Equal(XamlCodeActions.PromptTextEditCommand, action.Command!.Name);
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
        var ctx = Context(Diag(
            XamlValidator.UndeclaredPrefixCode,
            R(0, prefixAt, prefixAt + 1),
            Data("d", "http://schemas.microsoft.com/expression/blend/2008")));

        var action = Assert.Single(XamlCodeActions.Compute(Uri, doc, ctx, ts));
        Assert.Equal(
            "Add xmlns:d=\"http://schemas.microsoft.com/expression/blend/2008\"",
            action.Title);
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

    [Theory]
    [InlineData(XamlValidator.UnknownBindMemberCode, "Replace x:Bind member...")]
    [InlineData(XamlValidator.InvalidSetterPropertyCode, "Replace Setter property...")]
    public void UnknownMemberWithoutSuggestion_OffersPromptedReplacement(string code, string title)
    {
        var doc = new TextDocument(Uri, "NoSuchMember", version: 7);
        var diagnostic = Diag(code, R(0, 0, 12), Data("NoSuchMember"));

        var action = Assert.Single(
            XamlCodeActions.Compute(Uri, doc, Context(diagnostic)),
            item => item.Kind == "quickfix");

        Assert.Equal(title, action.Title);
        Assert.Equal(XamlCodeActions.PromptTextEditCommand, action.Command!.Name);
        Assert.Null(action.Edit);
        var arguments = PromptArguments(action);
        Assert.Equal(Uri, arguments.DocumentUri);
        Assert.Equal(R(0, 0, 12), arguments.Range);
        Assert.Equal(
            code == XamlValidator.InvalidSetterPropertyCode
                ? "Enter a property on the style target type"
                : "Enter a bindable member name",
            arguments.Prompt);
        Assert.Equal("NoSuchMember", arguments.PlaceHolder);
        Assert.Equal("NoSuchMember", arguments.InitialValue);
        Assert.Equal(string.Empty, arguments.Prefix);
        Assert.Equal(string.Empty, arguments.Suffix);
        Assert.Equal(7, arguments.ExpectedVersion);
        Assert.Equal("NoSuchMember", arguments.ExpectedText);
        Assert.Empty(arguments.Choices);
        Assert.Equal("Enter another value...", arguments.CustomChoiceLabel);
        Assert.Equal(
            code == XamlValidator.InvalidSetterPropertyCode
                ? @"(?:(?:[\p{L}_][\p{L}\p{N}_.-]*:)?[\p{L}_][\p{L}\p{N}_]*\.)?[\p{L}_][\p{L}\p{N}_]*"
                : @"[\p{L}_][\p{L}\p{N}_]*",
            arguments.ValidationPattern);
        Assert.Equal(
            code == XamlValidator.InvalidSetterPropertyCode
                ? "Enter a property name such as Width or Grid.Row."
                : "Enter a valid XAML identifier.",
            arguments.ValidationMessage);
    }

    [Fact]
    public void DataTypeDiagnostic_AlternateXamlPrefix_UsesMappedDirectiveName()
    {
        var xaml =
            "<DataTemplate xmlns:q=\"http://schemas.microsoft.com/winfx/2006/xaml\" " +
            "xmlns:models=\"using:Sample.Models\"><TextBlock Text=\"{q:Bind Name}\" /></DataTemplate>";
        var doc = new TextDocument(Uri, xaml);
        int bindAt = xaml.IndexOf("q:Bind", System.StringComparison.Ordinal);
        var diagnostic = Diag(
            XamlValidator.DataTemplateDataTypeRequiredCode,
            R(0, bindAt, bindAt + "q:Bind".Length),
            Data("using:Sample.Models", "models:Person"));

        var action = Assert.Single(
            XamlCodeActions.Compute(Uri, doc, Context(diagnostic)),
            item => item.Kind == "quickfix");
        var edit = Assert.Single(action.Edit!.Changes[Uri]);

        Assert.Equal("Set q:DataType to 'models:Person'", action.Title);
        Assert.Equal(" q:DataType=\"models:Person\"", edit.NewText);
    }

    [Fact]
    public void DataTypeDiagnostic_AmbiguousTypesWithAlternatePrefix_UsesMappedDirectiveName()
    {
        var xaml =
            "<DataTemplate xmlns:q=\"http://schemas.microsoft.com/winfx/2006/xaml\" " +
            "xmlns:models=\"using:Sample.Models\"><TextBlock Text=\"{q:Bind Name}\" /></DataTemplate>";
        var doc = new TextDocument(Uri, xaml, version: 8);
        int bindAt = xaml.IndexOf("q:Bind", System.StringComparison.Ordinal);
        var diagnostic = Diag(
            XamlValidator.DataTemplateDataTypeRequiredCode,
            R(0, bindAt, bindAt + "q:Bind".Length),
            Data("using:Sample.Models", "models:Person", "models:Account"));

        var action = Assert.Single(
            XamlCodeActions.Compute(Uri, doc, Context(diagnostic)),
            item => item.Kind == "quickfix");
        var arguments = PromptArguments(action);

        Assert.Equal("Set q:DataType...", action.Title);
        Assert.Equal(" q:DataType=\"", arguments.Prefix);
        Assert.Equal("\"", arguments.Suffix);
        Assert.Equal(new[] { "models:Person", "models:Account" }, arguments.Choices);
        Assert.Equal(8, arguments.ExpectedVersion);
    }

    [Fact]
    public void DuplicateName_RenamesLaterDeclarationUniquely()
    {
        var typeSystem = BuildNameTypeSystem();
        var xaml = "<Page xmlns=\"using:Microsoft.UI.Xaml\" xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\"><Button x:Name=\"Same\"/><Button x:Name=\"Same\"/></Page>";
        var doc = new TextDocument(Uri, xaml);
        int valueAt = xaml.LastIndexOf("Same", System.StringComparison.Ordinal);
        var diagnostic = Diag(XamlValidator.DuplicateNameCode, R(0, valueAt, valueAt + 4), null);

        var edit = Assert.Single(GuardedEdits(
            Assert.Single(XamlCodeActions.Compute(Uri, doc, Context(diagnostic), typeSystem)),
            doc));

        Assert.Equal("Same2", edit.NewText);
        Assert.Equal(valueAt, doc.OffsetAt(edit.Range.Start));
        Assert.Equal(
            "<Page xmlns=\"using:Microsoft.UI.Xaml\" xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\"><Button x:Name=\"Same\"/><Button x:Name=\"Same2\"/></Page>",
            ApplyEdit(doc, edit));
    }

    [Fact]
    public void DuplicateName_UsesMappedDirectivePrefixAndApplicableNameScope()
    {
        var typeSystem = BuildTypeSystem("""
            namespace Microsoft.UI.Xaml
            {
                public class FrameworkElement { public string Name { get; set; } = ""; }
                public class FrameworkTemplate { }
                public class ControlTemplate : FrameworkTemplate { }
                public class Page : FrameworkElement { }
                public class Button : FrameworkElement { }
            }
            """);
        var xaml =
            "<Page xmlns=\"using:Microsoft.UI.Xaml\" xmlns:q=\"http://schemas.microsoft.com/winfx/2006/xaml\">" +
            "<Button q:Name=\"Same\"/><Button q:Name=\"Same2\"/>" +
            "<ControlTemplate><Button q:Name=\"Same\"/><Button q:Name=\"Same\"/></ControlTemplate></Page>";
        var doc = new TextDocument(Uri, xaml);
        int valueAt = xaml.LastIndexOf("Same", System.StringComparison.Ordinal);
        var diagnostic = Diag(XamlValidator.DuplicateNameCode, R(0, valueAt, valueAt + 4), null);

        var edit = Assert.Single(GuardedEdits(
            Assert.Single(XamlCodeActions.Compute(Uri, doc, Context(diagnostic), typeSystem)),
            doc));

        Assert.Equal("Same2", edit.NewText);
    }

    [Fact]
    public void InvalidName_SanitizesDeclaration()
    {
        var typeSystem = BuildNameTypeSystem();
        var xaml = "<Page xmlns=\"using:Microsoft.UI.Xaml\" xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\" x:Name=\"2 bad-name\"/>";
        var doc = new TextDocument(Uri, xaml);
        int valueAt = xaml.IndexOf("2 bad-name", System.StringComparison.Ordinal);
        var diagnostic = Diag(XamlValidator.InvalidNameCode, R(0, valueAt, valueAt + 10), null);

        var edit = Assert.Single(GuardedEdits(
            Assert.Single(XamlCodeActions.Compute(Uri, doc, Context(diagnostic), typeSystem)),
            doc));

        Assert.Equal("_2_bad_name", edit.NewText);
        Assert.Equal(
            "<Page xmlns=\"using:Microsoft.UI.Xaml\" xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\" x:Name=\"_2_bad_name\"/>",
            ApplyEdit(doc, edit));
    }

    [Fact]
    public void InvalidName_RenamesReferencesInTheSameNamescope()
    {
        var typeSystem = BuildNameTypeSystem();
        var xaml =
            "<Page xmlns=\"using:Microsoft.UI.Xaml\" " +
            "xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\" " +
            "xmlns:data=\"using:Microsoft.UI.Xaml.Data\">" +
            "<Button x:Name=\"bad-name\"/><Button Tag=\"{data:Binding ElementName=bad-name}\"/></Page>";
        var doc = new TextDocument(Uri, xaml);
        int declarationAt = xaml.IndexOf("bad-name", System.StringComparison.Ordinal);
        var diagnostic = Diag(
            XamlValidator.InvalidNameCode,
            R(0, declarationAt, declarationAt + "bad-name".Length),
            null);

        var edits = Assert.Single(
            Assert.Single(XamlCodeActions.Compute(Uri, doc, Context(diagnostic), typeSystem))
                .Edit!.Changes);

        Assert.Equal(2, edits.Value.Count);
        Assert.All(edits.Value, edit => Assert.Equal("bad_name", edit.NewText));
    }

    [Fact]
    public void InvalidName_RenamesOnlyReferencesInTheOwningNestedNamescope()
    {
        var typeSystem = BuildNameTypeSystem();
        var xaml =
            "<Page xmlns=\"using:Microsoft.UI.Xaml\" " +
            "xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\" " +
            "xmlns:data=\"using:Microsoft.UI.Xaml.Data\">" +
            "<Button x:Name=\"bad-name\"/><Button Tag=\"{data:Binding ElementName=bad-name}\"/>" +
            "<ControlTemplate><Button x:Name=\"bad-name\"/>" +
            "<Button Tag=\"{data:Binding ElementName=bad-name}\"/></ControlTemplate></Page>";
        var doc = new TextDocument(Uri, xaml);
        int innerDeclarationAt = xaml.LastIndexOf(
            "x:Name=\"bad-name\"",
            System.StringComparison.Ordinal) + "x:Name=\"".Length;
        int innerReferenceAt = xaml.LastIndexOf(
            "ElementName=bad-name",
            System.StringComparison.Ordinal) + "ElementName=".Length;
        int outerDeclarationAt = xaml.IndexOf(
            "x:Name=\"bad-name\"",
            System.StringComparison.Ordinal) + "x:Name=\"".Length;
        int outerReferenceAt = xaml.IndexOf(
            "ElementName=bad-name",
            System.StringComparison.Ordinal) + "ElementName=".Length;
        var diagnostic = Diag(
            XamlValidator.InvalidNameCode,
            R(0, innerDeclarationAt, innerDeclarationAt + "bad-name".Length),
            null);

        var edits = GuardedEdits(
            Assert.Single(XamlCodeActions.Compute(Uri, doc, Context(diagnostic), typeSystem)),
            doc);

        Assert.Equal(
            new[] { innerDeclarationAt, innerReferenceAt },
            edits.Select(edit => doc.OffsetAt(edit.Range.Start)).OrderBy(offset => offset));
        Assert.DoesNotContain(edits, edit =>
            doc.OffsetAt(edit.Range.Start) is var offset &&
            (offset == outerDeclarationAt || offset == outerReferenceAt));
        Assert.All(edits, edit => Assert.Equal("bad_name", edit.NewText));
    }

    [Fact]
    public void InvalidDuplicateNames_RepairsOnlyTheTargetDeclaration()
    {
        var typeSystem = BuildNameTypeSystem();
        var xaml =
            "<Page xmlns=\"using:Microsoft.UI.Xaml\" " +
            "xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\">" +
            "<Button x:Name=\"bad-name\"/><Button x:Name=\"bad-name\"/></Page>";
        var doc = new TextDocument(Uri, xaml);
        int targetAt = xaml.LastIndexOf("bad-name", System.StringComparison.Ordinal);
        var diagnostic = Diag(
            XamlValidator.InvalidNameCode,
            R(0, targetAt, targetAt + "bad-name".Length),
            null);

        var edits = GuardedEdits(
            Assert.Single(XamlCodeActions.Compute(Uri, doc, Context(diagnostic), typeSystem)),
            doc);

        var edit = Assert.Single(edits);
        Assert.Equal(targetAt, doc.OffsetAt(edit.Range.Start));
        Assert.Equal("bad_name", edit.NewText);
    }

    [Fact]
    public void InvalidName_SanitizesUnicodeUsingRenameGrammar()
    {
        var typeSystem = BuildNameTypeSystem();
        var xaml = "<Page xmlns=\"using:Microsoft.UI.Xaml\" xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\" x:Name=\"Náme\"/>";
        var doc = new TextDocument(Uri, xaml);
        int valueAt = xaml.IndexOf("Náme", System.StringComparison.Ordinal);
        var diagnostic = Diag(XamlValidator.InvalidNameCode, R(0, valueAt, valueAt + 4), null);

        var edit = Assert.Single(
            Assert.Single(XamlCodeActions.Compute(Uri, doc, Context(diagnostic), typeSystem))
                .Edit!.Changes[Uri]);

        Assert.Equal("N_me", edit.NewText);
        Assert.True(XamlRename.IsValidName(edit.NewText));
    }

    [Fact]
    public void DuplicateAttribute_RemovesLaterAttribute()
    {
        var xaml = "<Page Width=\"1\" Width=\"2\"/>";
        var doc = new TextDocument(Uri, xaml);
        int nameAt = xaml.LastIndexOf("Width", System.StringComparison.Ordinal);
        var diagnostic = Diag(XamlValidator.DuplicateAttributeCode, R(0, nameAt, nameAt + 5), null);

        var edit = Assert.Single(
            Assert.Single(XamlCodeActions.Compute(Uri, doc, Context(diagnostic))).Edit!.Changes[Uri]);

        Assert.Equal(string.Empty, edit.NewText);
        Assert.Equal(" Width=\"2\"", RangeText(doc, edit.Range));
        Assert.Equal("<Page Width=\"1\"/>", ApplyEdit(doc, edit));
    }

    [Fact]
    public void MechanicalFix_SerializesOnlyGuardedCommandWithVersionAndExpectedText()
    {
        var xaml = "<Page Width=\"1\" Width=\"2\"/>";
        var doc = new TextDocument(Uri, xaml, version: 12);
        int secondAt = xaml.LastIndexOf("Width", System.StringComparison.Ordinal);
        var diagnostic = Diag(
            XamlValidator.DuplicateAttributeCode,
            R(0, secondAt, secondAt + "Width".Length),
            null);
        var action = Assert.Single(XamlCodeActions.Compute(Uri, doc, Context(diagnostic)));

        using var payload = JsonDocument.Parse(JsonSerializer.Serialize(action, LspJson.Options));
        Assert.False(payload.RootElement.TryGetProperty("edit", out _));
        Assert.Equal(
            XamlCodeActions.ApplyGuardedTextEditsCommand,
            payload.RootElement.GetProperty("command").GetProperty("command").GetString());
        var arguments = Assert.Single(
            payload.RootElement.GetProperty("command").GetProperty("arguments").EnumerateArray());
        Assert.Equal(Uri, arguments.GetProperty("documentUri").GetString());
        Assert.Equal(12, arguments.GetProperty("expectedVersion").GetInt32());
        var edit = Assert.Single(arguments.GetProperty("edits").EnumerateArray());
        Assert.Equal(" Width=\"2\"", edit.GetProperty("expectedText").GetString());
        Assert.Equal(string.Empty, edit.GetProperty("newText").GetString());
    }

    [Fact]
    public void DuplicateAttribute_EquivalentExpandedNames_RemovesLaterAttribute()
    {
        var xaml =
            "<Page xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\" " +
            "xmlns:y=\"http://schemas.microsoft.com/winfx/2006/xaml\" x:Name=\"First\" y:Name=\"Second\"/>";
        var doc = new TextDocument(Uri, xaml);
        int nameAt = xaml.IndexOf("y:Name", System.StringComparison.Ordinal);
        var diagnostic = Diag(
            XamlValidator.DuplicateAttributeCode,
            R(0, nameAt, nameAt + "y:Name".Length),
            null);

        var edit = Assert.Single(
            Assert.Single(XamlCodeActions.Compute(Uri, doc, Context(diagnostic)))
                .Edit!.Changes[Uri]);

        Assert.Equal(" y:Name=\"Second\"", RangeText(doc, edit.Range));
        Assert.Equal(
            "<Page xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\" " +
            "xmlns:y=\"http://schemas.microsoft.com/winfx/2006/xaml\" x:Name=\"First\"/>",
            ApplyEdit(doc, edit));
    }

    [Fact]
    public void MultipleScalarChildren_RemovesExtraChild()
    {
        var typeSystem = BuildScalarContentTypeSystem();
        var xaml = "<Border xmlns=\"using:Microsoft.UI.Xaml\"><TextBlock/><Button/></Border>";
        var doc = new TextDocument(Uri, xaml);
        int nameAt = xaml.IndexOf("Button", System.StringComparison.Ordinal);
        var diagnostic = Diag(XamlValidator.MultipleScalarChildrenCode, R(0, nameAt, nameAt + 6), null);

        var action = Assert.Single(
            XamlCodeActions.Compute(Uri, doc, Context(diagnostic), typeSystem),
            item => item.Kind == "quickfix");
        var edit = Assert.Single(action.Edit!.Changes[Uri]);

        Assert.Equal("Remove extra 'Button'", action.Title);
        Assert.Equal("<Button/>", RangeText(doc, edit.Range));
        Assert.Equal(
            "<Border xmlns=\"using:Microsoft.UI.Xaml\"><TextBlock/></Border>",
            ApplyEdit(doc, edit));
    }

    [Fact]
    public void MultipleScalarChildren_InPropertyElement_RemovesExtraChild()
    {
        var typeSystem = BuildScalarContentTypeSystem();
        var xaml =
            "<Border xmlns=\"using:Microsoft.UI.Xaml\"><Border.Child>" +
            "<TextBlock/><Button/></Border.Child></Border>";
        var doc = new TextDocument(Uri, xaml);
        int nameAt = xaml.IndexOf("Button", System.StringComparison.Ordinal);
        var diagnostic = Diag(
            XamlValidator.MultipleScalarChildrenCode,
            R(0, nameAt, nameAt + "Button".Length),
            null);

        var edit = Assert.Single(GuardedEdits(
            Assert.Single(XamlCodeActions.Compute(Uri, doc, Context(diagnostic), typeSystem)),
            doc));

        Assert.Equal("<Button/>", RangeText(doc, edit.Range));
        Assert.Equal(
            "<Border xmlns=\"using:Microsoft.UI.Xaml\"><Border.Child>" +
            "<TextBlock/></Border.Child></Border>",
            ApplyEdit(doc, edit));
    }

    [Fact]
    public void InvalidNumericLiteral_ReplacesWithZero()
    {
        var typeSystem = BuildWinUiTypeSystem("""
            namespace TestApp
            {
                public class Page : Microsoft.UI.Xaml.DependencyObject
                {
                    public double Width { get; set; }
                }
            }
            """);
        var xaml = "<Page xmlns=\"using:TestApp\" Width=\"NaNn\"/>";
        var doc = new TextDocument(Uri, xaml);
        int valueAt = xaml.IndexOf("NaNn", System.StringComparison.Ordinal);
        var diagnostic = Diag(XamlValidator.InvalidAttributeValueCode, R(0, valueAt, valueAt + 4), null);

        var edit = Assert.Single(
            Assert.Single(XamlCodeActions.Compute(Uri, doc, Context(diagnostic), typeSystem))
                .Edit!.Changes[Uri]);

        Assert.Equal("0", edit.NewText);
        Assert.Equal("<Page xmlns=\"using:TestApp\" Width=\"0\"/>", ApplyEdit(doc, edit));
    }

    [Fact]
    public void InvalidBooleanLiteral_ReplacesWithFalse()
    {
        var typeSystem = BuildWinUiTypeSystem("""
            namespace TestApp
            {
                public class Page : Microsoft.UI.Xaml.DependencyObject
                {
                    public bool IsEnabled { get; set; }
                }
            }
            """);
        var xaml = "<Page xmlns=\"using:TestApp\" IsEnabled=\"maybe\"/>";
        var doc = new TextDocument(Uri, xaml);
        int valueAt = xaml.IndexOf("maybe", System.StringComparison.Ordinal);
        var diagnostic = Diag(
            XamlValidator.InvalidAttributeValueCode,
            R(0, valueAt, valueAt + "maybe".Length),
            null);

        var edit = Assert.Single(
            Assert.Single(XamlCodeActions.Compute(Uri, doc, Context(diagnostic), typeSystem))
                .Edit!.Changes[Uri]);

        Assert.Equal("False", edit.NewText);
        Assert.Equal(valueAt, doc.OffsetAt(edit.Range.Start));
        Assert.Equal("<Page xmlns=\"using:TestApp\" IsEnabled=\"False\"/>", ApplyEdit(doc, edit));
    }

    [Theory]
    [InlineData("byte", "0")]
    [InlineData("sbyte", "0")]
    [InlineData("short", "0")]
    [InlineData("ushort", "0")]
    [InlineData("int", "0")]
    [InlineData("uint", "0")]
    [InlineData("long", "0")]
    [InlineData("ulong", "0")]
    [InlineData("float", "0")]
    [InlineData("double?", "0")]
    [InlineData("decimal?", "0")]
    [InlineData("bool?", "False")]
    public void InvalidPrimitiveLiteral_UsesTypeDefault(string propertyType, string expected)
    {
        var typeSystem = BuildWinUiTypeSystem($$"""
            namespace TestApp
            {
                public class Page : Microsoft.UI.Xaml.DependencyObject
                {
                    public {{propertyType}} Value { get; set; }
                }
            }
            """);
        var xaml = "<Page xmlns=\"using:TestApp\" Value=\"invalid\"/>";
        var doc = new TextDocument(Uri, xaml);
        int valueAt = xaml.IndexOf("invalid", System.StringComparison.Ordinal);
        var diagnostic = Diag(
            XamlValidator.InvalidAttributeValueCode,
            R(0, valueAt, valueAt + "invalid".Length),
            null);

        var edit = Assert.Single(
            Assert.Single(XamlCodeActions.Compute(Uri, doc, Context(diagnostic), typeSystem))
                .Edit!.Changes[Uri]);

        Assert.Equal(expected, edit.NewText);
    }

    [Fact]
    public void InvalidNonPrimitiveLiteral_HasNoMechanicalDefault()
    {
        var typeSystem = BuildWinUiTypeSystem("""
            namespace TestApp
            {
                public class Page : Microsoft.UI.Xaml.DependencyObject
                {
                    public System.DateTime Value { get; set; }
                }
            }
            """);
        var xaml = "<Page xmlns=\"using:TestApp\" Value=\"invalid\"/>";
        var doc = new TextDocument(Uri, xaml);
        int valueAt = xaml.IndexOf("invalid", System.StringComparison.Ordinal);
        var diagnostic = Diag(
            XamlValidator.InvalidAttributeValueCode,
            R(0, valueAt, valueAt + "invalid".Length),
            null);

        Assert.Empty(XamlCodeActions.Compute(Uri, doc, Context(diagnostic), typeSystem));
    }

    [Fact]
    public void AmbiguousNamespaceSuggestions_AreNotPreferred()
    {
        var xaml = "<Page xmlns:local=\"using:Sample.Modles\"/>";
        var doc = new TextDocument(Uri, xaml);
        int valueAt = xaml.IndexOf("using:", System.StringComparison.Ordinal);
        var diagnostic = Diag(
            XamlValidator.UnknownNamespaceDeclarationCode,
            R(0, valueAt, valueAt + "using:Sample.Modles".Length),
            Data("using:Sample.Modles", "using:Sample.Models", "using:Sample.Modules"));

        var actions = XamlCodeActions.Compute(Uri, doc, Context(diagnostic))
            .Where(action => action.Kind == "quickfix")
            .ToArray();

        Assert.Equal(2, actions.Length);
        Assert.All(actions, action => Assert.NotEqual(true, action.IsPreferred));
    }

    [Fact]
    public void UnknownNamespaceDeclaration_WithCloseKnownNamespace_ReplacesUri()
    {
        var xaml = "<Page xmlns:local=\"using:Sample.Open_Source.Models\"/>";
        var doc = new TextDocument(Uri, xaml);
        int valueAt = xaml.IndexOf("using:", System.StringComparison.Ordinal);
        const string replacement = "using:Sample.OpenSource.Models";
        var diagnostic = Diag(
            XamlValidator.UnknownNamespaceDeclarationCode,
            R(0, valueAt, valueAt + "using:Sample.Open_Source.Models".Length),
            Data("using:Sample.Open_Source.Models", replacement));

        var action = Assert.Single(
            XamlCodeActions.Compute(Uri, doc, Context(diagnostic)),
            item => item.Kind == "quickfix");
        var edit = Assert.Single(action.Edit!.Changes[Uri]);

        Assert.Equal(replacement, edit.NewText);
        Assert.True(action.IsPreferred);
        Assert.Equal("<Page xmlns:local=\"using:Sample.OpenSource.Models\"/>", ApplyEdit(doc, edit));
    }

    [Fact]
    public void StaleDiagnostics_DoNotOfferMechanicalOrPromptedFixes()
    {
        var validName = new TextDocument(
            Uri,
            "<Page xmlns=\"using:Microsoft.UI.Xaml\" xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\" x:Name=\"Valid\"/>");
        var nameTypeSystem = BuildNameTypeSystem();
        int validAt = validName.Text.IndexOf("Valid", System.StringComparison.Ordinal);
        Assert.Empty(XamlCodeActions.Compute(
            Uri,
            validName,
            Context(Diag(XamlValidator.InvalidNameCode, R(0, validAt, validAt + 5), null)),
            nameTypeSystem));

        var uniqueName = new TextDocument(
            Uri,
            "<Page xmlns=\"using:Microsoft.UI.Xaml\" xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\"><Button x:Name=\"Only\"/></Page>");
        int uniqueAt = uniqueName.Text.IndexOf("Only", System.StringComparison.Ordinal);
        Assert.Empty(XamlCodeActions.Compute(
            Uri,
            uniqueName,
            Context(Diag(XamlValidator.DuplicateNameCode, R(0, uniqueAt, uniqueAt + 4), null)),
            nameTypeSystem));

        var currentMember = new TextDocument(Uri, "CurrentMember");
        Assert.Empty(XamlCodeActions.Compute(
            Uri,
            currentMember,
            Context(Diag(
                XamlValidator.UnknownBindMemberCode,
                R(0, 0, "CurrentMember".Length),
                Data("OldMember")))));

        var currentNamespace = new TextDocument(
            Uri,
            "<Page xmlns:local=\"using:Sample.Current\"/>");
        int namespaceAt = currentNamespace.Text.IndexOf("using:", System.StringComparison.Ordinal);
        Assert.DoesNotContain(
            XamlCodeActions.Compute(
                Uri,
                currentNamespace,
                Context(Diag(
                    XamlValidator.UnknownNamespaceDeclarationCode,
                    R(0, namespaceAt, namespaceAt + "using:Sample.Current".Length),
                    Data("using:Sample.Old", "using:Sample.New")))),
            action => action.Kind == "quickfix");

        var singleAttribute = new TextDocument(Uri, "<Page Width=\"1\"/>");
        int widthAt = singleAttribute.Text.IndexOf("Width", System.StringComparison.Ordinal);
        Assert.Empty(XamlCodeActions.Compute(
            Uri,
            singleAttribute,
            Context(Diag(
                XamlValidator.DuplicateAttributeCode,
                R(0, widthAt, widthAt + 5),
                null))));

        var singleChild = new TextDocument(
            Uri,
            "<Border xmlns=\"using:Microsoft.UI.Xaml\"><TextBlock/></Border>");
        int childAt = singleChild.Text.IndexOf("TextBlock", System.StringComparison.Ordinal);
        Assert.Empty(XamlCodeActions.Compute(
            Uri,
            singleChild,
            Context(Diag(
                XamlValidator.MultipleScalarChildrenCode,
                R(0, childAt, childAt + "TextBlock".Length),
                null)),
            BuildScalarContentTypeSystem()));

        var validLiteralTypeSystem = BuildWinUiTypeSystem("""
            namespace TestApp
            {
                public class Page : Microsoft.UI.Xaml.DependencyObject
                {
                    public double Width { get; set; }
                }
            }
            """);
        var validLiteral = new TextDocument(Uri, "<Page xmlns=\"using:TestApp\" Width=\"1\"/>");
        int literalAt = validLiteral.Text.IndexOf("\"1\"", System.StringComparison.Ordinal) + 1;
        Assert.Empty(XamlCodeActions.Compute(
            Uri,
            validLiteral,
            Context(Diag(
                XamlValidator.InvalidAttributeValueCode,
                R(0, literalAt, literalAt + 1),
                null)),
            validLiteralTypeSystem));

        var declaredPrefix = new TextDocument(
            Uri,
            "<Page xmlns:local=\"using:Sample.Controls\"><local:Widget/></Page>");
        int localAt = declaredPrefix.Text.IndexOf("local:Widget", System.StringComparison.Ordinal);
        Assert.DoesNotContain(
            XamlCodeActions.Compute(
                Uri,
                declaredPrefix,
                Context(Diag(
                    XamlValidator.UndeclaredPrefixCode,
                    R(0, localAt, localAt + "local".Length),
                    Data("local", "using:Sample.Controls")))),
            action => action.Kind == "quickfix");
    }

    [Fact]
    public void EmptyInvalidName_UsesNamesFromOwningScope()
    {
        var typeSystem = BuildNameTypeSystem();
        var xaml =
            "<Page xmlns=\"using:Microsoft.UI.Xaml\" " +
            "xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\">" +
            "<Button x:Name=\"Element\"/><Button x:Name=\"\"/></Page>";
        var doc = new TextDocument(Uri, xaml);
        int valueAt = xaml.LastIndexOf("\"\"", System.StringComparison.Ordinal) + 1;
        var diagnostic = Diag(XamlValidator.InvalidNameCode, R(0, valueAt, valueAt), null);

        var edit = Assert.Single(
            Assert.Single(XamlCodeActions.Compute(Uri, doc, Context(diagnostic), typeSystem))
                .Edit!.Changes[Uri]);

        Assert.Equal("Element2", edit.NewText);
    }

    private static string RangeText(TextDocument document, Range range)
    {
        int start = document.OffsetAt(range.Start);
        int end = document.OffsetAt(range.End);
        return document.Text.Substring(start, end - start);
    }

    private static PromptedTextEditCommandArguments PromptArguments(CodeAction action)
    {
        var arguments = action.Command!.Arguments!;
        return Assert.IsType<PromptedTextEditCommandArguments>(Assert.Single(arguments));
    }

    private static List<TextEdit> GuardedEdits(CodeAction action, TextDocument document)
    {
        Assert.Equal(XamlCodeActions.ApplyGuardedTextEditsCommand, action.Command!.Name);
        var arguments = Assert.IsType<GuardedTextEditCommandArguments>(
            Assert.Single(action.Command.Arguments!));
        Assert.Equal(document.Uri, arguments.DocumentUri);
        Assert.Equal(document.Version, arguments.ExpectedVersion);
        return arguments.Edits.Select(edit =>
        {
            Assert.Equal(RangeText(document, edit.Range), edit.ExpectedText);
            return new TextEdit { Range = edit.Range, NewText = edit.NewText };
        }).ToList();
    }

    private static string ApplyEdit(TextDocument document, TextEdit edit)
    {
        int start = document.OffsetAt(edit.Range.Start);
        int end = document.OffsetAt(edit.Range.End);
        return document.Text.Substring(0, start) + edit.NewText + document.Text.Substring(end);
    }
}
