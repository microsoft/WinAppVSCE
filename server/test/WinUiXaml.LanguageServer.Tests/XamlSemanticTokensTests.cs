using System.Collections.Generic;
using System.Linq;
using WinUiXaml.LanguageServer;
using WinUiXaml.LanguageServer.Lsp;
using Xunit;

namespace WinUiXaml.LanguageServer.Tests;

/// <summary>
/// Hermetic coverage for <see cref="XamlSemanticTokens"/> (textDocument/semanticTokens/full). Decodes the
/// LSP delta stream back into absolute tokens and asserts the covered text + classification for each name
/// role, plus the wire invariants VS Code requires: sorted, single-line, non-overlapping, non-negative
/// deltas. Purely syntactic — no running server, no project load.
/// </summary>
public class XamlSemanticTokensTests
{
    private const string Uri = "file:///C:/proj/Page.xaml";

    private sealed record Tok(int Line, int Char, int Length, string Type, string Covered, int Modifiers);

    private static (TextDocument Doc, List<Tok> Tokens) Parse(string text)
    {
        var doc = new TextDocument(Uri, text);
        var result = XamlSemanticTokens.Compute(doc);
        return (doc, Decode(doc, result));
    }

    private static List<Tok> Decode(TextDocument doc, SemanticTokens tokens)
    {
        var data = tokens.Data;
        Assert.True(data.Length % 5 == 0, "token data must be a whole number of 5-int records");

        var decoded = new List<Tok>();
        int line = 0;
        int ch = 0;
        for (int i = 0; i < data.Length; i += 5)
        {
            int deltaLine = data[i];
            int deltaChar = data[i + 1];
            int length = data[i + 2];
            int type = data[i + 3];
            int modifiers = data[i + 4];

            Assert.True(deltaLine >= 0, "deltaLine must be non-negative");
            Assert.True(deltaChar >= 0, "deltaStartChar must be non-negative");
            Assert.True(length > 0, "length must be positive");
            Assert.InRange(type, 0, XamlSemanticTokens.TokenTypes.Length - 1);
            // Only legend-declared modifier bits may be set.
            Assert.Equal(0, modifiers & ~((1 << XamlSemanticTokens.TokenModifiers.Length) - 1));

            if (deltaLine == 0)
            {
                ch += deltaChar;
            }
            else
            {
                line += deltaLine;
                ch = deltaChar;
            }

            int offset = doc.OffsetAt(new Lsp.Position(line, ch));
            decoded.Add(new Tok(line, ch, length, XamlSemanticTokens.TokenTypes[type], doc.Text.Substring(offset, length), modifiers));
        }

        return decoded;
    }

    private static void AssertToken(List<Tok> tokens, string covered, string type) =>
        Assert.True(tokens.Any(t => t.Covered == covered && t.Type == type),
            $"expected a '{type}' token covering '{covered}'; got [{string.Join(", ", tokens.Select(t => $"{t.Type}:'{t.Covered}'"))}]");

    private static void AssertNoToken(List<Tok> tokens, string covered) =>
        Assert.False(tokens.Any(t => t.Covered == covered),
            $"expected NO token covering '{covered}'; got [{string.Join(", ", tokens.Select(t => $"{t.Type}:'{t.Covered}'"))}]");

    // ---- role classification -------------------------------------------------

    [Fact]
    public void ElementTypeName_IsClass()
    {
        var (_, tokens) = Parse("<Grid />");
        AssertToken(tokens, "Grid", "class");
    }

    [Fact]
    public void PrefixedElement_SplitsIntoNamespaceAndClass()
    {
        var (_, tokens) = Parse("<local:MyControl />");
        AssertToken(tokens, "local", "namespace");
        AssertToken(tokens, "MyControl", "class");
    }

    [Fact]
    public void AttributeName_IsProperty()
    {
        var (_, tokens) = Parse("<Grid Background=\"Red\" />");
        AssertToken(tokens, "Grid", "class");
        AssertToken(tokens, "Background", "property");
    }

    [Fact]
    public void PrefixedAttribute_SplitsIntoNamespaceAndProperty()
    {
        var (_, tokens) = Parse("<Grid x:Name=\"Root\" />");
        AssertToken(tokens, "x", "namespace");
        AssertToken(tokens, "Name", "property");
    }

    [Fact]
    public void AttachedPropertyAttribute_IsProperty()
    {
        var (_, tokens) = Parse("<Border Grid.Row=\"1\" />");
        AssertToken(tokens, "Grid.Row", "property");
    }

    [Fact]
    public void PropertyElement_IsProperty()
    {
        var buffer =
            "<Grid>\n" +
            "  <Grid.RowDefinitions>\n" +
            "    <RowDefinition />\n" +
            "  </Grid.RowDefinitions>\n" +
            "</Grid>";
        var (_, tokens) = Parse(buffer);
        // The property-element open + end tag are members, not types.
        Assert.Equal(2, tokens.Count(t => t.Covered == "Grid.RowDefinitions" && t.Type == "property"));
        AssertToken(tokens, "RowDefinition", "class");
    }

    [Fact]
    public void MarkupExtensionName_IsMacro()
    {
        var (_, tokens) = Parse("<Grid Background=\"{StaticResource Accent}\" />");
        AssertToken(tokens, "StaticResource", "macro");
    }

    [Fact]
    public void MarkupExtensionNamedArgument_IsParameter()
    {
        var (_, tokens) = Parse("<TextBox Text=\"{Binding ElementName=Root}\" />");
        AssertToken(tokens, "Binding", "macro");
        AssertToken(tokens, "ElementName", "parameter");
    }

    [Fact]
    public void NestedMarkupExtension_TokenizesInnerNameAndArgs()
    {
        var (_, tokens) = Parse("<TextBox Text=\"{Binding Source={StaticResource Accent}, Path=Text}\" />");
        AssertToken(tokens, "Binding", "macro");
        AssertToken(tokens, "Source", "parameter");
        AssertToken(tokens, "StaticResource", "macro");
        AssertToken(tokens, "Path", "parameter");
    }

    [Fact]
    public void EndTagName_IsAlsoColored()
    {
        var (_, tokens) = Parse("<Grid></Grid>");
        Assert.Equal(2, tokens.Count(t => t.Covered == "Grid" && t.Type == "class"));
    }

    [Fact]
    public void XmlnsDeclaration_IsSkipped()
    {
        var (_, tokens) = Parse("<Page xmlns:local=\"using:App\" xmlns=\"http://x\" />");
        AssertToken(tokens, "Page", "class");
        // xmlns / xmlns:local are structural, not member/namespace tokens.
        AssertNoToken(tokens, "xmlns");
        AssertNoToken(tokens, "local");
    }

    // ---- wire invariants -----------------------------------------------------

    [Theory]
    [InlineData("<Grid x:Name=\"Root\" Background=\"{StaticResource A}\"><Button Click=\"OnGo\" /></Grid>")]
    [InlineData("<Page>\n  <Grid.RowDefinitions>\n    <RowDefinition Height=\"Auto\" />\n  </Grid.RowDefinitions>\n</Page>")]
    [InlineData("<local:Foo><x:String>hi</x:String></local:Foo>")]
    public void Tokens_AreSortedSingleLineAndNonOverlapping(string text)
    {
        var (_, tokens) = Parse(text);
        for (int i = 1; i < tokens.Count; i++)
        {
            var prev = tokens[i - 1];
            var cur = tokens[i];
            bool ordered = cur.Line > prev.Line || (cur.Line == prev.Line && cur.Char >= prev.Char + prev.Length);
            Assert.True(ordered, $"token {i} ('{cur.Covered}') overlaps or precedes the previous ('{prev.Covered}')");
        }
    }

    [Fact]
    public void MultiLine_UsesCorrectDeltaEncoding()
    {
        var buffer =
            "<Grid>\n" +
            "  <Button x:Name=\"Go\" />\n" +
            "</Grid>";
        var (_, tokens) = Parse(buffer);
        // Every token's covered text and line are recovered purely from the delta stream, proving the
        // encoding round-trips across line breaks (values like the x:Name "Go" are intentionally untokenized).
        Assert.Contains(tokens, t => t.Covered == "Grid" && t.Type == "class" && t.Line == 0);
        Assert.Contains(tokens, t => t.Covered == "Button" && t.Type == "class" && t.Line == 1);
        Assert.Contains(tokens, t => t.Covered == "Name" && t.Type == "property" && t.Line == 1);
        Assert.Contains(tokens, t => t.Covered == "Grid" && t.Type == "class" && t.Line == 2);
    }

    [Fact]
    public void EmptyDocument_EmitsNoTokens()
    {
        var (_, tokens) = Parse(string.Empty);
        Assert.Empty(tokens);
    }

    [Theory]
    [InlineData("<Grid x:Name=\"Root\"")]
    [InlineData("<Grid Background=\"{StaticResource Accent\" />")]
    [InlineData("<<>< <Grid></Broken>")]
    [InlineData("<Grid>")]
    public void MalformedMarkup_DoesNotThrowAndStaysWellFormed(string text)
    {
        var (_, tokens) = Parse(text);
        // The Parse/Decode helpers assert every wire invariant (non-negative deltas, positive length,
        // in-range type, only legend-declared modifier bits, whole records); reaching here without throwing
        // is the assertion.
        Assert.All(tokens, t => Assert.True(t.Length > 0));
    }

    [Fact]
    public void Compute_IsDeterministic()
    {
        var buffer = "<Grid x:Name=\"Root\" Background=\"{StaticResource A}\"><Button /></Grid>";
        var doc = new TextDocument(Uri, buffer);
        var first = XamlSemanticTokens.Compute(doc).Data;
        var second = XamlSemanticTokens.Compute(doc).Data;
        Assert.Equal(first, second);
    }

    [Fact]
    public void Legend_HasNoDuplicateTypesAndDeclaresDefaultLibrary()
    {
        Assert.Equal(XamlSemanticTokens.TokenTypes.Length, XamlSemanticTokens.TokenTypes.Distinct().Count());
        Assert.Equal(XamlSemanticTokens.TokenModifiers.Length, XamlSemanticTokens.TokenModifiers.Distinct().Count());
        Assert.Contains("defaultLibrary", XamlSemanticTokens.TokenModifiers);
    }

    // ---- defaultLibrary modifier ---------------------------------------------

    // A full WinUI namespace header: default => presentation, x => XAML language, local => a user CLR ns.
    private const string Ns =
        "xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" " +
        "xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\" " +
        "xmlns:local=\"using:App\"";

    private static readonly int DefaultLibraryBit =
        1 << System.Array.IndexOf(XamlSemanticTokens.TokenModifiers, "defaultLibrary");

    private static bool IsDefaultLibrary(Tok t) => (t.Modifiers & DefaultLibraryBit) != 0;

    private static void AssertDefaultLibrary(List<Tok> tokens, string covered, string type) =>
        Assert.True(tokens.Any(t => t.Covered == covered && t.Type == type && IsDefaultLibrary(t)),
            $"expected a defaultLibrary '{type}' token covering '{covered}'; got [{string.Join(", ", tokens.Select(t => $"{t.Type}:'{t.Covered}'{(IsDefaultLibrary(t) ? "*" : "")}"))}]");

    private static void AssertNotDefaultLibrary(List<Tok> tokens, string covered) =>
        Assert.True(tokens.Where(t => t.Covered == covered).All(t => !IsDefaultLibrary(t)),
            $"expected NO defaultLibrary token covering '{covered}'; got [{string.Join(", ", tokens.Where(t => t.Covered == covered).Select(t => $"{t.Type}:'{t.Covered}'{(IsDefaultLibrary(t) ? "*" : "")}"))}]");

    [Fact]
    public void FrameworkElement_InDefaultPresentationNamespace_IsDefaultLibrary()
    {
        var (_, tokens) = Parse($"<Page {Ns}><Grid /></Page>");
        AssertDefaultLibrary(tokens, "Grid", "class");
        AssertDefaultLibrary(tokens, "Page", "class");
    }

    [Fact]
    public void XDirective_InXamlLanguageNamespace_IsDefaultLibrary()
    {
        var (_, tokens) = Parse($"<Page {Ns}><Grid x:Name=\"Root\" /></Page>");
        // Both the prefix ("x") and the local name ("Name") of an x: directive are framework.
        AssertDefaultLibrary(tokens, "x", "namespace");
        AssertDefaultLibrary(tokens, "Name", "property");
    }

    [Fact]
    public void UserType_UnderLocalPrefix_IsNotDefaultLibrary()
    {
        var (_, tokens) = Parse($"<Page {Ns}><local:MyControl /></Page>");
        AssertNotDefaultLibrary(tokens, "local");
        AssertNotDefaultLibrary(tokens, "MyControl");
    }

    [Fact]
    public void UnprefixedMember_IsNotDefaultLibrary()
    {
        // An unprefixed attribute names a member of its owner type, not an xmlns, so it is never marked
        // (we cannot know the owner's origin without symbol resolution) — even on a framework element.
        var (_, tokens) = Parse($"<Page {Ns}><Grid Background=\"Red\" /></Page>");
        AssertNotDefaultLibrary(tokens, "Background");
    }

    [Fact]
    public void FrameworkMarkupExtension_IsDefaultLibrary_UserExtensionIsNot()
    {
        var (_, tokens) = Parse($"<Page {Ns}><Grid Background=\"{{StaticResource A}}\" Tag=\"{{local:MyExt}}\" /></Page>");
        AssertDefaultLibrary(tokens, "StaticResource", "macro");
        AssertNotDefaultLibrary(tokens, "MyExt");
    }

    [Fact]
    public void WithoutXmlnsDeclarations_NothingIsDefaultLibrary()
    {
        // No xmlns in scope => no prefix resolves => the modifier is never emitted.
        var (_, tokens) = Parse("<Grid x:Name=\"Root\"><Button /></Grid>");
        Assert.All(tokens, t => Assert.False(IsDefaultLibrary(t)));
    }

    [Fact]
    public void RemappedDefaultNamespace_DoesNotMarkElements()
    {
        // If the default xmlns is a user namespace, an unprefixed element is NOT framework.
        var (_, tokens) = Parse("<Page xmlns=\"using:App\"><Grid /></Page>");
        AssertNotDefaultLibrary(tokens, "Grid");
        AssertNotDefaultLibrary(tokens, "Page");
    }

    // ---- semanticTokens/range ------------------------------------------------

    private static List<Tok> ParseRange(string text, Lsp.Range range)
    {
        var doc = new TextDocument(Uri, text);
        return Decode(doc, XamlSemanticTokens.ComputeRange(doc, range));
    }

    [Fact]
    public void Range_ReturnsOnlyTokensOverlappingTheRange()
    {
        var buffer =
            "<Grid>\n" +          // line 0
            "  <Button />\n" +    // line 1
            "  <TextBox />\n" +   // line 2
            "</Grid>";            // line 3
        // Request line 1 only.
        var range = new Lsp.Range { Start = new Lsp.Position(1, 0), End = new Lsp.Position(2, 0) };
        var tokens = ParseRange(buffer, range);
        AssertToken(tokens, "Button", "class");
        AssertNoToken(tokens, "TextBox");
        // Grid open (line 0) and end tag (line 3) are outside the range.
        Assert.DoesNotContain(tokens, t => t.Covered == "Grid");
    }

    [Fact]
    public void Range_IsASubsetOfFull_WithIdenticalDecoding()
    {
        var buffer = $"<Page {Ns}>\n  <Grid x:Name=\"Root\" />\n  <local:Foo />\n</Page>";
        var doc = new TextDocument(Uri, buffer);
        var full = Decode(doc, XamlSemanticTokens.Compute(doc));
        // A range covering only line 1 (the Grid) must yield exactly the full tokens on that line.
        var range = new Lsp.Range { Start = new Lsp.Position(1, 0), End = new Lsp.Position(1, 100) };
        var ranged = ParseRange(buffer, range);
        var expected = full.Where(t => t.Line == 1).ToList();
        Assert.Equal(expected, ranged);
    }

    [Fact]
    public void Range_EmptyWhenNoTokensOverlap()
    {
        var buffer = "<Grid>\n  <Button />\n</Grid>";
        // A range over the blank tail of line 1 (after </Button>) — no name tokens there.
        var range = new Lsp.Range { Start = new Lsp.Position(1, 11), End = new Lsp.Position(1, 12) };
        var tokens = ParseRange(buffer, range);
        Assert.Empty(tokens);
    }
}
