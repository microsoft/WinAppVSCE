using Xunit;

namespace WinUiXaml.LanguageServer.Tests;

/// <summary>
/// Hermetic coverage for <see cref="XmlDocSummary"/>, the pure extractor that turns a Roslyn
/// documentation-comment XML string (as returned by <c>ISymbol.GetDocumentationCommentXml()</c>) into a
/// single normalized <c>&lt;summary&gt;</c> paragraph for hover quick-info. The correctness concerns are:
/// (1) the summary text is pulled out of the surrounding &lt;member&gt; envelope; (2) inline doc tags flatten to
/// readable text (see-cref simplified to a simple name, paramref/typeparamref to the name, &lt;c&gt; kept);
/// (3) whitespace collapses to a clean single line; (4) absent/empty/malformed input yields null, never a throw.
/// </summary>
public class XmlDocSummaryTests
{
    private const string Member = "T:Microsoft.UI.Xaml.Controls.Button";

    private static string Doc(string summaryInner) =>
        $"<member name=\"{Member}\">\n            <summary>{summaryInner}</summary>\n        </member>";

    [Fact]
    public void PlainSummary_ReturnsText()
    {
        var result = XmlDocSummary.Extract(Doc("Represents a templated button control."));
        Assert.Equal("Represents a templated button control.", result);
    }

    [Fact]
    public void MultiLineSummary_CollapsesWhitespaceToSingleLine()
    {
        var result = XmlDocSummary.Extract(Doc("\n            Gets or sets the content.\n            The default is null.\n        "));
        Assert.Equal("Gets or sets the content. The default is null.", result);
    }

    [Fact]
    public void SeeCref_UsesLastSegmentAndStripsDocIdPrefix()
    {
        var result = XmlDocSummary.Extract(Doc("See <see cref=\"P:Microsoft.UI.Xaml.Controls.ContentControl.Content\"/> for details."));
        Assert.Equal("See Content for details.", result);
    }

    [Fact]
    public void SeeCref_TypePrefix_UsesSimpleTypeName()
    {
        var result = XmlDocSummary.Extract(Doc("A <see cref=\"T:Microsoft.UI.Xaml.UIElement\"/> child."));
        Assert.Equal("A UIElement child.", result);
    }

    [Fact]
    public void SeeCref_MethodWithParameterList_DropsParameters()
    {
        var result = XmlDocSummary.Extract(Doc("Call <see cref=\"M:Foo.Bar.Baz(System.Int32,System.String)\"/> first."));
        Assert.Equal("Call Baz first.", result);
    }

    [Fact]
    public void See_InnerTextPreferredOverCref()
    {
        var result = XmlDocSummary.Extract(Doc("Use <see cref=\"T:Foo.Bar\">the bar</see> now."));
        Assert.Equal("Use the bar now.", result);
    }

    [Fact]
    public void See_Langword_UsesLangword()
    {
        var result = XmlDocSummary.Extract(Doc("Defaults to <see langword=\"null\"/>."));
        Assert.Equal("Defaults to null.", result);
    }

    [Fact]
    public void Paramref_UsesName()
    {
        var result = XmlDocSummary.Extract(Doc("Adds <paramref name=\"item\"/> to the list."));
        Assert.Equal("Adds item to the list.", result);
    }

    [Fact]
    public void Typeparamref_UsesName()
    {
        var result = XmlDocSummary.Extract(Doc("A list of <typeparamref name=\"T\"/> values."));
        Assert.Equal("A list of T values.", result);
    }

    [Fact]
    public void CElement_KeepsInnerText()
    {
        var result = XmlDocSummary.Extract(Doc("Pass <c>true</c> to enable."));
        Assert.Equal("Pass true to enable.", result);
    }

    [Fact]
    public void Para_FlattensToSpacedText()
    {
        var result = XmlDocSummary.Extract(Doc("<para>First.</para><para>Second.</para>"));
        Assert.Equal("First. Second.", result);
    }

    [Fact]
    public void UnknownInlineTag_KeepsInnerText()
    {
        var result = XmlDocSummary.Extract(Doc("Very <b>bold</b> claim."));
        Assert.Equal("Very bold claim.", result);
    }

    [Fact]
    public void NoSummaryElement_ReturnsNull()
    {
        var xml = $"<member name=\"{Member}\"><remarks>Only remarks here.</remarks></member>";
        Assert.Null(XmlDocSummary.Extract(xml));
    }

    [Fact]
    public void EmptySummary_ReturnsNull()
    {
        Assert.Null(XmlDocSummary.Extract(Doc(string.Empty)));
    }

    [Fact]
    public void WhitespaceOnlySummary_ReturnsNull()
    {
        Assert.Null(XmlDocSummary.Extract(Doc("   \n   \t  ")));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void NullOrBlankInput_ReturnsNull(string? input)
    {
        Assert.Null(XmlDocSummary.Extract(input));
    }

    [Fact]
    public void MalformedXml_ReturnsNull()
    {
        Assert.Null(XmlDocSummary.Extract("<member><summary>Unclosed"));
    }

    [Fact]
    public void SummaryWithCData_KeepsContent()
    {
        var result = XmlDocSummary.Extract(Doc("<![CDATA[a < b && c > d]]>"));
        Assert.Equal("a < b && c > d", result);
    }

    [Fact]
    public void BareSummaryFragment_WithoutMemberEnvelope_StillExtracts()
    {
        var result = XmlDocSummary.Extract("<summary>Direct fragment.</summary>");
        Assert.Equal("Direct fragment.", result);
    }

    // --- Authoring-markup sanitization (WinUI framework docs embed DocFX/HTML cruft as escaped text) ---

    [Fact]
    public void EscapedHtmlImageTag_IsStripped()
    {
        // Framework docs embed <img .../> with a relative src that would render as a broken image in the hover.
        var result = XmlDocSummary.Extract(Doc("Focus moves down. &lt;img alt=\"nav\" src=\"./images/nav.png\" /&gt; See the diagram."));
        Assert.DoesNotContain("<img", result);
        Assert.DoesNotContain("src=", result);
        Assert.Equal("Focus moves down. See the diagram.", result);
    }

    [Fact]
    public void EscapedSupTag_KeepsInnerText()
    {
        var result = XmlDocSummary.Extract(Doc("Uses the formula f(t) = t&lt;sup&gt;3&lt;/sup&gt;."));
        Assert.DoesNotContain("<sup", result);
        Assert.Contains("3", result!);
    }

    [Fact]
    public void EscapedBreakTag_DoesNotJoinWords()
    {
        var result = XmlDocSummary.Extract(Doc("First line.&lt;br/&gt;Second line."));
        Assert.DoesNotContain("<br", result);
        Assert.Equal("First line. Second line.", result);
    }

    [Fact]
    public void DocFxMonikerFences_AreStripped_LeavingRealSummary()
    {
        var inner = "::: moniker range=\"winui-3.0-preview\"\n&gt; [!CAUTION]\n&gt; Experimental API.\n::: moniker-end\nRepresents an expander control.";
        var result = XmlDocSummary.Extract(Doc(inner));
        Assert.DoesNotContain(":::", result);
        Assert.DoesNotContain("moniker", result);
        Assert.DoesNotContain("[!CAUTION]", result);
        Assert.DoesNotContain(">", result);
        Assert.Contains("Experimental API.", result!);
        Assert.Contains("Represents an expander control.", result!);
    }

    [Fact]
    public void DocFxAlertBlockquote_MarkersStripped_TextKept()
    {
        var inner = "&gt; [!NOTE]\n&gt; A composed character is a single visual object.\nGets the character.";
        var result = XmlDocSummary.Extract(Doc(inner));
        Assert.DoesNotContain("[!NOTE]", result);
        Assert.DoesNotContain(">", result);
        Assert.Equal("A composed character is a single visual object. Gets the character.", result);
    }

    [Fact]
    public void ComparisonOperatorsWithSpaces_ArePreserved()
    {
        // The strip rules must not eat genuine prose: a spaced "<"/">" is a comparison operator, not a tag.
        var result = XmlDocSummary.Extract(Doc("True when a &lt; b and b &gt; c."));
        Assert.Equal("True when a < b and b > c.", result);
    }

    [Fact]
    public void CleanSummary_WithNoAuthoringMarkup_IsUnchanged()
    {
        var result = XmlDocSummary.Extract(Doc("Gets or sets the content of a ContentControl."));
        Assert.Equal("Gets or sets the content of a ContentControl.", result);
    }

    // --- ExtractQuickInfo: method <returns>/<param> quick-info (round 70) ---

    private static string MethodDoc(string summary, string? returns, params (string Name, string Body)[] parameters)
    {
        var sb = new System.Text.StringBuilder();
        sb.Append($"<member name=\"M:Foo.Bar.Baz\">\n            <summary>{summary}</summary>\n");
        foreach (var (name, body) in parameters)
        {
            sb.Append($"            <param name=\"{name}\">{body}</param>\n");
        }

        if (returns is not null)
        {
            sb.Append($"            <returns>{returns}</returns>\n");
        }

        sb.Append("        </member>");
        return sb.ToString();
    }

    [Fact]
    public void ExtractQuickInfo_MethodWithSummaryReturnsParams_ExtractsAll()
    {
        var doc = XmlDocSummary.ExtractQuickInfo(MethodDoc(
            "Handles the click.",
            "The processed value.",
            ("sender", "The source of the event."),
            ("e", "The event data.")));

        Assert.Equal("Handles the click.", doc.Summary);
        Assert.Equal("The processed value.", doc.Returns);
        Assert.Equal(2, doc.Parameters.Count);
        Assert.Equal("sender", doc.Parameters[0].Name);
        Assert.Equal("The source of the event.", doc.Parameters[0].Text);
        Assert.Equal("e", doc.Parameters[1].Name);
        Assert.Equal("The event data.", doc.Parameters[1].Text);
    }

    [Fact]
    public void ExtractQuickInfo_ReturnsAndParams_AreFlattenedAndSanitized()
    {
        // Returns/params run through the SAME inline flattening + authoring-markup strip as the summary.
        var doc = XmlDocSummary.ExtractQuickInfo(MethodDoc(
            "S.",
            "A <see cref=\"T:Microsoft.UI.Xaml.UIElement\"/>\n            child.",
            ("value", "Pass <c>true</c> to &lt;br/&gt;enable.")));

        Assert.Equal("A UIElement child.", doc.Returns);
        Assert.Equal("Pass true to enable.", doc.Parameters[0].Text);
    }

    [Fact]
    public void ExtractQuickInfo_ParamWithEmptyBody_HasNullText()
    {
        var doc = XmlDocSummary.ExtractQuickInfo(MethodDoc("S.", null, ("sender", ""), ("e", "The data.")));

        Assert.Equal(2, doc.Parameters.Count);
        Assert.Equal("sender", doc.Parameters[0].Name);
        Assert.Null(doc.Parameters[0].Text);
        Assert.Equal("The data.", doc.Parameters[1].Text);
    }

    [Fact]
    public void ExtractQuickInfo_SummaryOnly_HasNoReturnsOrParams()
    {
        var doc = XmlDocSummary.ExtractQuickInfo(Doc("Gets or sets the content."));

        Assert.Equal("Gets or sets the content.", doc.Summary);
        Assert.Null(doc.Returns);
        Assert.Empty(doc.Parameters);
    }

    [Fact]
    public void ExtractQuickInfo_SummaryMatchesExtract_ByteForByte()
    {
        // The refactor must keep the summary path byte-identical to Extract (rounds 66-69 depend on it).
        var xml = MethodDoc("Gets or sets the <c>content</c>.", "The value.", ("x", "An input."));
        Assert.Equal(XmlDocSummary.Extract(xml), XmlDocSummary.ExtractQuickInfo(xml).Summary);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("<member><summary>Unclosed")]
    public void ExtractQuickInfo_BlankOrMalformedInput_ReturnsEmpty(string? input)
    {
        var doc = XmlDocSummary.ExtractQuickInfo(input);

        Assert.Null(doc.Summary);
        Assert.Null(doc.Returns);
        Assert.Empty(doc.Parameters);
    }

    [Fact]
    public void ExtractQuickInfo_ParamWithoutName_IsSkipped()
    {
        var xml = "<member name=\"M:Foo.Bar.Baz\"><summary>S.</summary><param>orphan</param><param name=\"ok\">Kept.</param></member>";
        var doc = XmlDocSummary.ExtractQuickInfo(xml);

        Assert.Single(doc.Parameters);
        Assert.Equal("ok", doc.Parameters[0].Name);
    }
}
