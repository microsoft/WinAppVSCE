using System.Collections.Generic;
using System.Linq;
using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Workspace;
using WinUiXaml.Xaml;

namespace WinUiXaml.LanguageServer;

/// <summary>
/// Computes <c>textDocument/semanticTokens/full</c> and <c>/range</c> for WinUI XAML. A purely
/// <em>syntactic</em> tokenizer over the tolerant parse tree — it classifies each name by its structural
/// role only (element type, attribute/member, name prefix, markup-extension name, markup-extension argument
/// name) and never resolves <em>symbols</em>, so it is fast, deterministic, and can never mis-color based on
/// a stale/failed project load. The one <c>defaultLibrary</c> modifier is derived only from the document's
/// own <c>xmlns</c> declarations (prefix → URI, pure text — NOT a compilation/symbol lookup), so it keeps
/// every one of those guarantees. It is read-only: VS Code merges these tokens over the TextMate grammar to
/// give richer, semantic colors.
/// <para>
/// Output is the LSP flat encoding: 5 ints per token (deltaLine, deltaStartChar, length, tokenType,
/// tokenModifiers), tokens sorted by position, single-line only, and non-overlapping — the invariants
/// VS Code requires or it renders garbage. The <c>/range</c> variant returns the same encoding limited to
/// tokens overlapping the requested range.
/// </para>
/// </summary>
internal static class XamlSemanticTokens
{
    // The LSP legend. The encoded tokenType of each token is its index into this array; Initialize()
    // advertises the same array so the client's mapping stays in lock-step with the encoder below.
    public static readonly string[] TokenTypes = { "namespace", "class", "property", "macro", "parameter" };

    // The one emitted modifier: defaultLibrary (see ModDefaultLibrary). Advertised for a complete legend.
    public static readonly string[] TokenModifiers = { "defaultLibrary" };

    private const int TypeNamespace = 0; // name prefixes: the "x" in x:Name, the "local" in local:Foo
    private const int TypeClass = 1;     // element type names: Grid, Button, MyControl
    private const int TypeProperty = 2;  // attribute / member names, incl. attached + property elements
    private const int TypeMacro = 3;     // markup-extension names: StaticResource, Binding
    private const int TypeParameter = 4; // markup-extension argument names: ElementName, Mode

    // Modifier bitmask: bit i set => TokenModifiers[i] applies. Only defaultLibrary (bit 0) is emitted,
    // marking names bound (via the document's own xmlns declarations) to a well-known framework namespace —
    // the WinUI presentation namespace or the XAML language namespace — so themes can distinguish framework
    // names (<Grid>, x:Name, {Binding}) from user names (<local:Foo>), exactly as C#/TS mark BCL symbols.
    private const int ModDefaultLibrary = 1 << 0;

    private readonly record struct Token(int Line, int StartChar, int Length, int Type, int Modifiers);

    public static SemanticTokens Compute(TextDocument doc) =>
        new() { Data = Encode(CollectTokens(doc)) };

    /// <summary>Tokens overlapping <paramref name="range"/> only, in the same encoding as the full set.</summary>
    public static SemanticTokens ComputeRange(TextDocument doc, Lsp.Range range) =>
        new() { Data = Encode(CollectTokens(doc).Where(t => Intersects(t, range)).ToList()) };

    private static List<Token> CollectTokens(TextDocument doc)
    {
        var tokens = new List<Token>();

        foreach (var node in doc.Parsed.DescendantNodesAndSelf())
        {
            switch (node)
            {
                case XamlElement element:
                    // A property element (<Grid.RowDefinitions>) is a member, not a type; a prefixed or
                    // simple element name is a type. The open and end tag names are colored the same. An
                    // unprefixed object-element name binds to the default xmlns (so <Grid> can be framework),
                    // but a property-element name is a member of its owner type — only an explicit framework
                    // prefix marks it.
                    var elementLocalType = element.IsPropertyElement ? TypeProperty : TypeClass;
                    var elementAllowsDefault = !element.IsPropertyElement;
                    AddName(element.Name, elementLocalType, element.NamespaceScope, elementAllowsDefault, tokens, doc);
                    AddName(element.EndTagName, elementLocalType, element.NamespaceScope, elementAllowsDefault, tokens, doc);
                    break;

                // xmlns / xmlns:foo declarations are structurally special (and already grammar-colored);
                // skip them so a prefix name is never mis-classified as an ordinary member. An unprefixed
                // attribute names a member of its owner element's type (not an xmlns), so only an explicit
                // framework prefix (x:Name, x:Key) earns defaultLibrary.
                case XamlAttribute attribute when !attribute.IsNamespaceDeclaration:
                    AddName(attribute.Name, TypeProperty, ScopeOf(attribute), allowDefaultNamespace: false, tokens, doc);
                    break;

                // A markup-extension name binds like an element name: unprefixed => the default xmlns.
                case XamlMarkupExtension extension:
                    AddName(extension.Name, TypeMacro, ScopeOf(extension), allowDefaultNamespace: true, tokens, doc);
                    break;

                case XamlMarkupExtensionArgument { IsNamed: true } argument:
                    AddName(argument.Name, TypeParameter, ScopeOf(argument), allowDefaultNamespace: false, tokens, doc);
                    break;
            }
        }

        return tokens;
    }

    /// <summary>The <c>xmlns</c> scope of the nearest enclosing element (for prefix → URI resolution).</summary>
    private static XamlNamespaceScope ScopeOf(XamlNode node)
    {
        for (var current = node; current != null; current = current.Parent)
        {
            if (current is XamlElement element)
            {
                return element.NamespaceScope;
            }
        }

        return XamlNamespaceScope.Empty;
    }

    /// <summary>The defaultLibrary bit when the name binds (via the document's xmlns) to a framework
    /// namespace. <paramref name="allowDefaultNamespace"/> controls whether an unprefixed name resolves
    /// against the default xmlns (true for object elements / markup extensions) or is left unmarked (true
    /// for members, whose namespace is their owner type, not an xmlns).</summary>
    private static int ModifiersFor(XamlName name, XamlNamespaceScope scope, bool allowDefaultNamespace)
    {
        string? prefix = name.HasPrefix ? name.Prefix : (allowDefaultNamespace ? string.Empty : null);
        if (prefix is null)
        {
            return 0;
        }

        return scope.TryResolvePrefix(prefix, out var uri) && IsFrameworkNamespace(uri)
            ? ModDefaultLibrary
            : 0;
    }

    private static bool IsFrameworkNamespace(string uri) =>
        uri == XamlTypeSystem.PresentationNamespace || uri == XamlTypeSystem.XamlLanguageNamespace;

    /// <summary>True when the single-line token overlaps the (possibly multi-line) range.</summary>
    private static bool Intersects(Token token, Lsp.Range range)
    {
        bool beforeRange = token.Line < range.Start.Line ||
            (token.Line == range.Start.Line && token.StartChar + token.Length <= range.Start.Character);
        bool afterRange = token.Line > range.End.Line ||
            (token.Line == range.End.Line && token.StartChar >= range.End.Character);
        return !beforeRange && !afterRange;
    }

    /// <summary>Emits a namespace token for the name's prefix (if any) and a role token for its local name.</summary>
    private static void AddName(XamlName? name, int localType, XamlNamespaceScope scope, bool allowDefaultNamespace, List<Token> tokens, TextDocument doc)
    {
        if (name is null)
        {
            return;
        }

        int modifiers = ModifiersFor(name, scope, allowDefaultNamespace);

        if (name.PrefixSpan is { } prefixSpan)
        {
            AddSpan(prefixSpan, TypeNamespace, modifiers, tokens, doc);
        }

        AddSpan(name.LocalNameSpan, localType, modifiers, tokens, doc);
    }

    /// <summary>Adds one token for a span, dropping empty or (defensively) multi-line spans since an LSP
    /// semantic token must be a single, non-empty, single-line run.</summary>
    private static void AddSpan(TextSpan span, int type, int modifiers, List<Token> tokens, TextDocument doc)
    {
        if (span.Length <= 0)
        {
            return;
        }

        var range = doc.RangeOf(span);
        if (range.Start.Line != range.End.Line)
        {
            return;
        }

        int length = range.End.Character - range.Start.Character;
        if (length <= 0)
        {
            return;
        }

        tokens.Add(new Token(range.Start.Line, range.Start.Character, length, type, modifiers));
    }

    /// <summary>Sorts by position and produces the LSP delta encoding, skipping any token that would
    /// overlap the previous one (the tolerant parser can synthesize odd spans on malformed input; an
    /// overlapping token would corrupt the whole stream).</summary>
    private static int[] Encode(List<Token> tokens)
    {
        tokens.Sort(static (a, b) => a.Line != b.Line ? a.Line.CompareTo(b.Line) : a.StartChar.CompareTo(b.StartChar));

        var data = new List<int>(tokens.Count * 5);
        int prevLine = 0;
        int prevChar = 0;
        int lastLine = -1;
        int lastEnd = 0;

        foreach (var token in tokens)
        {
            if (token.Line == lastLine && token.StartChar < lastEnd)
            {
                continue;
            }

            int deltaLine = token.Line - prevLine;
            int deltaChar = deltaLine == 0 ? token.StartChar - prevChar : token.StartChar;

            data.Add(deltaLine);
            data.Add(deltaChar);
            data.Add(token.Length);
            data.Add(token.Type);
            data.Add(token.Modifiers);

            prevLine = token.Line;
            prevChar = token.StartChar;
            lastLine = token.Line;
            lastEnd = token.StartChar + token.Length;
        }

        return data.ToArray();
    }
}
