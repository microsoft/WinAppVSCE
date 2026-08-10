using System;
using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Workspace;

namespace WinUiXaml.LanguageServer;

internal static partial class CompletionProvider
{
    private readonly struct Context
    {
        public Context(ContextKind kind, string partial, int replaceStart, string? attributeName = null, string? bindPrefixPath = null, string? markupExtension = null, string? bindCastType = null, bool isClassicBinding = false, string? bindElementName = null, bool isUnquoted = false)
        {
            Kind = kind;
            Partial = partial;
            ReplaceStart = replaceStart;
            AttributeName = attributeName;
            BindPrefixPath = bindPrefixPath;
            MarkupExtension = markupExtension;
            BindCastType = bindCastType;
            IsClassicBinding = isClassicBinding;
            BindElementName = bindElementName;
            IsUnquoted = isUnquoted;
        }

        public ContextKind Kind { get; }
        public string Partial { get; }
        public int ReplaceStart { get; }

        /// <summary>For <see cref="ContextKind.AttributeValue"/>: the attribute whose value is completed.</summary>
        public string? AttributeName { get; }

        /// <summary>For <see cref="ContextKind.BindPath"/>: the dotted path segments already typed before the member being completed.</summary>
        public string? BindPrefixPath { get; }

        /// <summary>For <see cref="ContextKind.MarkupArg"/>: the markup extension name.</summary>
        public string? MarkupExtension { get; }

        /// <summary>For ContextKind.BindPath: a leading cast type (local:SmokePage from {x:Bind (local:SmokePage)Member}); completion binds against this type instead of the bind root.</summary>
        public string? BindCastType { get; }

        /// <summary>For ContextKind.BindPath: true when the path belongs to a classic {Binding} (design-time DataContext = the enclosing template's x:DataType) rather than a compiled {x:Bind} (rooted</summary>
        public bool IsClassicBinding { get; }

        /// <summary>For ContextKind.BindPath: the x:Name a classic {Binding ElementName=Foo, Path=…} roots its path at; completion binds against that element's type instead of the DataContext.</summary>
        public string? BindElementName { get; }

        /// <summary>For ContextKind.AttributeValue: true when the value position has NO surrounding quotes (the user typed Click=OnGo without "…").</summary>
        public bool IsUnquoted { get; }

        public static readonly Context None = new(ContextKind.None, string.Empty, 0);
    }

    /// <summary>Classifies the caret using the raw text: are we typing an element name just after &lt;, an attribute name later in a start tag, or a value inside a quoted attribute?</summary>
    private static Context Classify(string text, int offset)
    {
        if (offset <= 0 || offset > text.Length)
        {
            return Context.None;
        }

        // Suppress completions when the caret sits inside an XML comment or a CDATA section: an unclosed "" or "") and offers element names.
        var beforeCaret = text.Substring(0, offset);
        if (beforeCaret.LastIndexOf("<!--", StringComparison.Ordinal) >
                beforeCaret.LastIndexOf("-->", StringComparison.Ordinal) ||
            beforeCaret.LastIndexOf("<![CDATA[", StringComparison.Ordinal) >
                beforeCaret.LastIndexOf("]]>", StringComparison.Ordinal))
        {
            return Context.None;
        }

        int lt = text.LastIndexOf('<', offset - 1);
        int gt = text.LastIndexOf('>', offset - 1);
        if (lt < 0 || gt > lt)
        {
            return Context.None; // in element content, not inside a start tag
        }

        char after = lt + 1 < text.Length ? text[lt + 1] : '\0';
        if (after == '/')
        {
            // End tag "".
            int endNameStart = lt + 2;
            if (endNameStart > offset)
            {
                return Context.None; // caret sits between '<' and '/'
            }

            string endPartial = text.Substring(endNameStart, offset - endNameStart);
            foreach (var c in endPartial)
            {
                if (!IsNameChar(c))
                {
                    return Context.None; // past the name token (whitespace, '>', etc.)
                }
            }

            return new Context(ContextKind.CloseTag, endPartial, endNameStart);
        }

        if (after is '!' or '?')
        {
            return Context.None; // comment, CDATA, or processing instruction
        }

        string tag = text.Substring(lt + 1, offset - lt - 1);
        int ws = IndexOfWhitespace(tag);
        if (ws < 0)
        {
            // Still inside the element-name token.
            return new Context(ContextKind.ElementName, tag, lt + 1);
        }

        // Past the element name: attribute area — unless the caret sits inside a quoted value.
        var value = TryClassifyValue(text, lt, offset);
        if (value.HasValue)
        {
            return value.Value;
        }

        int wordStart = offset;
        while (wordStart > lt + 1 && IsNameChar(text[wordStart - 1]))
        {
            wordStart--;
        }

        return new Context(ContextKind.AttributeName, text.Substring(wordStart, offset - wordStart), wordStart);
    }

    /// <summary>If the caret sits inside a quoted attribute value within the start tag opened at ltIndex</summary>
    private static Context? TryClassifyValue(string text, int ltIndex, int offset)
    {
        char quote = '\0';
        int valueStart = -1; // index just after the opening quote we're currently inside
        for (int i = ltIndex + 1; i < offset; i++)
        {
            char c = text[i];
            if (quote == '\0')
            {
                if (c is '"' or '\'')
                {
                    quote = c;
                    valueStart = i + 1;
                }
            }
            else if (c == quote)
            {
                quote = '\0';
                valueStart = -1;
            }
        }

        if (quote == '\0' || valueStart < 0)
        {
            return TryClassifyUnquotedValue(text, ltIndex, offset); // e.g. IsEnabled=| before quotes are typed
        }

        // Walk back from the opening quote over "= <ws>" to read the attribute name.
        int j = valueStart - 2; // char before the opening quote
        while (j > ltIndex && char.IsWhiteSpace(text[j]))
        {
            j--;
        }

        if (j <= ltIndex || text[j] != '=')
        {
            return null; // malformed: not an attribute value
        }

        j--;
        while (j > ltIndex && char.IsWhiteSpace(text[j]))
        {
            j--;
        }

        int nameEnd = j + 1;
        int nameStart = nameEnd;
        while (nameStart > ltIndex + 1 && IsNameChar(text[nameStart - 1]))
        {
            nameStart--;
        }

        if (nameStart >= nameEnd)
        {
            return null;
        }

        var attributeName = text.Substring(nameStart, nameEnd - nameStart);

        // Re-root the markup classifiers on the innermost markup extension still open at the caret so nested extensions classify correctly.
        int markupStart = InnermostOpenBrace(text, valueStart, offset);

        var markup = TryClassifyMarkupName(text, markupStart, offset);
        if (markup.HasValue)
        {
            return markup;
        }

        var bind = TryClassifyBind(text, markupStart, offset);
        if (bind.HasValue)
        {
            return bind;
        }

        var resource = TryClassifyResource(text, markupStart, offset, ResourceTargetAttribute(text, valueStart, markupStart, attributeName));
        if (resource.HasValue)
        {
            return resource;
        }

        var xReference = TryClassifyXReference(text, markupStart, offset);
        if (xReference.HasValue)
        {
            return xReference;
        }

        // Classify design-instance type arguments before generic markup arguments.
        var designInstance = TryClassifyDesignInstanceType(text, markupStart, offset);
        if (designInstance.HasValue)
        {
            return designInstance;
        }

        var templateBinding = TryClassifyTemplateBinding(text, markupStart, offset);
        if (templateBinding.HasValue)
        {
            return templateBinding;
        }

        var markupArg = TryClassifyMarkupArg(text, markupStart, offset);
        if (markupArg.HasValue)
        {
            return markupArg;
        }

        var markupArgName = TryClassifyMarkupArgName(text, markupStart, offset);
        if (markupArgName.HasValue)
        {
            return markupArgName;
        }

        // xmlns:foo="using:Clr.Namespace" — a namespace DECLARATION value (not a markup value), so it is classified here on the raw attribute name/value rather than through a markup brace. Offers the project's CLR namespaces once the "using:" scheme prefix is present.
        var usingNamespace = TryClassifyUsingNamespace(text, valueStart, offset, attributeName);
        if (usingNamespace.HasValue)
        {
            return usingNamespace;
        }

        // Offer framework URIs until the using: namespace classifier takes over.
        var xmlnsValue = TryClassifyXmlnsValue(text, valueStart, offset, attributeName);
        if (xmlnsValue.HasValue)
        {
            return xmlnsValue;
        }

        var partial = text.Substring(valueStart, offset - valueStart);
        return new Context(ContextKind.AttributeValue, partial, valueStart, attributeName);
    }

    /// <summary>The XAML scheme prefix that maps an xmlns value to a CLR namespace.</summary>
    private const string UsingScheme = "using:";

    /// <summary>Classifies the caret inside a namespace-declaration value that opens with the using: scheme (xmlns:local="using:|" or xmlns="using:Foo.|").</summary>
    private static Context? TryClassifyUsingNamespace(string text, int valueStart, int offset, string attributeName)
    {
        // Only xmlns declarations carry a using: target: the default xmlns ("xmlns") or a prefixed one ("xmlns:local"). A same-named ordinary attribute cannot exist on an element, so this is exact.
        if (!(string.Equals(attributeName, "xmlns", StringComparison.Ordinal) ||
              attributeName.StartsWith("xmlns:", StringComparison.Ordinal)))
        {
            return null;
        }

        int nsStart = valueStart + UsingScheme.Length;
        if (offset < nsStart)
        {
            return null; // caret is still within the "using:" scheme text — nothing to complete yet
        }

        // The value must literally open with the using: scheme (ordinal — XAML's scheme is lowercase).
        if (string.CompareOrdinal(text, valueStart, UsingScheme, 0, UsingScheme.Length) != 0)
        {
            return null;
        }

        var partial = text.Substring(nsStart, offset - nsStart);
        return new Context(ContextKind.UsingNamespace, partial, nsStart);
    }

    /// <summary>Completes the CLR-namespace token of a using: xmlns value.</summary>
    private static CompletionList CompleteUsingNamespace(Context ctx, XamlTypeSystem typeSystem, Lsp.Range replaceRange)
    {
        var items = new List<CompletionItem>();
        AddUsingNamespaceItems(items, typeSystem.GetUsingNamespaces(), ctx.Partial, replaceRange, "0", "CLR namespace");
        AddUsingNamespaceItems(items, typeSystem.GetReferencedUsingNamespaces(), ctx.Partial, replaceRange, "1", "CLR namespace (referenced)");
        return Finish(items);
    }

    /// <summary>Adds one completion item per namespace in namespaces that starts with the typed partial. sortGroup prefixes the sort text so source namespaces (group 0) rank above referenced ones</summary>
    private static void AddUsingNamespaceItems(
        List<CompletionItem> items, IReadOnlyList<string> namespaces, string partial, Lsp.Range replaceRange, string sortGroup, string detail)
    {
        foreach (var ns in namespaces)
        {
            if (!StartsWith(ns, partial))
            {
                continue;
            }

            items.Add(new CompletionItem
            {
                Label = ns,
                Kind = CompletionItemKind.Module,
                Detail = detail,
                TextEdit = new TextEdit { Range = replaceRange, NewText = ns },
                FilterText = ns,
                SortText = sortGroup + ns,
            });
        }
    }

    /// <summary>The standard framework namespace URIs offered when completing an xmlns declaration value, in rank order (the WinUI presentation default first).</summary>
    private static readonly (string Value, string Detail)[] WellKnownXmlnsValues =
    {
        (XamlTypeSystem.PresentationNamespace, "WinUI presentation namespace"),
        (XamlTypeSystem.XamlLanguageNamespace, "XAML language namespace (x:)"),
        (XamlNamespaces.DesignTime2008, "Design-time namespace (d:)"),
        (XamlNamespaces.MarkupCompatibility, "Markup compatibility namespace (mc:)"),
    };

    /// <summary>Classifies the caret inside an xmlns declaration value that has NOT yet reached a completable using: CLR-namespace token — i.e. an empty value (xmlns:foo="|")</summary>
    private static Context? TryClassifyXmlnsValue(string text, int valueStart, int offset, string attributeName)
    {
        if (!(string.Equals(attributeName, "xmlns", StringComparison.Ordinal) ||
              attributeName.StartsWith("xmlns:", StringComparison.Ordinal)))
        {
            return null;
        }

        var partial = text.Substring(valueStart, offset - valueStart);
        return new Context(ContextKind.XmlnsValue, partial, valueStart);
    }

    /// <summary>Completes an xmlns declaration value with the well-known framework namespace URIs (WellKnownXmlnsValues) and the using: scheme</summary>
    private static CompletionList CompleteXmlnsValue(Context ctx, Lsp.Range replaceRange)
    {
        var items = new List<CompletionItem>();
        int rank = 0;
        foreach (var (value, detail) in WellKnownXmlnsValues)
        {
            if (StartsWith(value, ctx.Partial))
            {
                items.Add(MakeXmlnsValueItem(value, detail, replaceRange, rank));
            }

            rank++;
        }

        // The using: scheme ranks after the standard URIs; accepting it opens CLR-namespace completion.
        if (StartsWith(UsingScheme, ctx.Partial))
        {
            items.Add(MakeXmlnsValueItem(UsingScheme, "CLR namespace reference", replaceRange, rank));
        }

        return Finish(items);
    }

    private static CompletionItem MakeXmlnsValueItem(string value, string detail, Lsp.Range replaceRange, int rank) =>
        new CompletionItem
        {
            Label = value,
            Kind = CompletionItemKind.Value,
            Detail = detail,
            TextEdit = new TextEdit { Range = replaceRange, NewText = value },
            FilterText = value,
            SortText = ((char)('0' + rank)).ToString(),
        };

    /// <summary>Classifies the caret at an unquoted attribute-value position (IsEnabled=|) — a state XAML tolerates while the value is being typed before quotes are added.</summary>
    private static Context? TryClassifyUnquotedValue(string text, int ltIndex, int offset)
    {
        // Trailing run of value characters already typed (empty when the caret is right after '=').
        int valueStart = offset;
        while (valueStart > ltIndex && IsUnquotedValueChar(text[valueStart - 1]))
        {
            valueStart--;
        }

        // The value token must be immediately preceded by '=' (allowing surrounding whitespace).
        int j = valueStart - 1;
        while (j > ltIndex && char.IsWhiteSpace(text[j]))
        {
            j--;
        }

        if (j <= ltIndex || text[j] != '=')
        {
            return null;
        }

        j--;
        while (j > ltIndex && char.IsWhiteSpace(text[j]))
        {
            j--;
        }

        int nameEnd = j + 1;
        int nameStart = nameEnd;
        while (nameStart > ltIndex + 1 && IsNameChar(text[nameStart - 1]))
        {
            nameStart--;
        }

        if (nameStart >= nameEnd)
        {
            return null;
        }

        var attributeName = text.Substring(nameStart, nameEnd - nameStart);
        var partial = text.Substring(valueStart, offset - valueStart);
        return new Context(ContextKind.AttributeValue, partial, valueStart, attributeName, isUnquoted: true);
    }

    private static bool IsUnquotedValueChar(char c) =>
        char.IsLetterOrDigit(c) || c is '_' or '.' or '-' or ':' or '+';

    /// <summary>Returns the index of the innermost markup-extension { that is still open at offset (matching } not yet seen), or valueStart when the caret is not inside any brace.</summary>
    private static int InnermostOpenBrace(string text, int valueStart, int offset)
    {
        var open = new Stack<int>();
        for (int i = valueStart; i < offset; i++)
        {
            if (text[i] == '{')
            {
                open.Push(i);
            }
            else if (text[i] == '}' && open.Count > 0)
            {
                open.Pop();
            }
        }

        return open.Count > 0 ? open.Peek() : valueStart;
    }

    /// <summary>If the attribute value beginning at valueStart is a {StaticResource ...}, {ThemeResource ...} or {CustomResource ...} reference and the caret sits in its key (first positional)</summary>
    private static Context? TryClassifyResource(string text, int valueStart, int offset, string? targetAttribute = null)
    {
        int i = valueStart;
        while (i < offset && char.IsWhiteSpace(text[i]))
        {
            i++;
        }

        if (i >= offset || text[i] != '{')
        {
            return null;
        }

        i++; // past '{'
        while (i < offset && char.IsWhiteSpace(text[i]))
        {
            i++;
        }

        int nameStart = i;
        while (i < offset && (char.IsLetterOrDigit(text[i]) || text[i] == ':'))
        {
            i++;
        }

        var extName = text.Substring(nameStart, i - nameStart);
        if (extName != "StaticResource" && extName != "ThemeResource" && extName != "CustomResource")
        {
            return null;
        }

        // A space must separate the name from the key (so "{StaticResource" alone is name completion).
        if (i >= offset || !char.IsWhiteSpace(text[i]))
        {
            return null;
        }

        while (i < offset && char.IsWhiteSpace(text[i]))
        {
            i++;
        }

        // The key is the first positional argument: any delimiter/whitespace means it has ended.
        var keySoFar = text.Substring(i, offset - i);
        foreach (var ch in keySoFar)
        {
            if (ch is '}' or ',' or '=' || char.IsWhiteSpace(ch))
            {
                return null;
            }
        }

        return new Context(ContextKind.ResourceKey, keySoFar, i, attributeName: targetAttribute);
    }

    /// <summary>The attribute name whose property type should scope resource-key completion, or null to offer every key.</summary>
    private static string? ResourceTargetAttribute(string text, int valueStart, int markupStart, string attributeName)
    {
        for (int k = valueStart; k < markupStart; k++)
        {
            if (text[k] == '{')
            {
                return null;
            }
        }

        return attributeName;
    }

    /// <summary>If the attribute value is an {x:Type ...} or {x:Static ...} reference and the caret sits in its (first positional) argument</summary>
    private static Context? TryClassifyXReference(string text, int valueStart, int offset)
    {
        int i = valueStart;
        while (i < offset && char.IsWhiteSpace(text[i]))
        {
            i++;
        }

        if (i >= offset || text[i] != '{')
        {
            return null;
        }

        i++; // past '{'
        while (i < offset && char.IsWhiteSpace(text[i]))
        {
            i++;
        }

        int nameStart = i;
        while (i < offset && (char.IsLetterOrDigit(text[i]) || text[i] == ':'))
        {
            i++;
        }

        var extName = text.Substring(nameStart, i - nameStart);
        bool isType = extName == "x:Type";
        bool isStatic = extName == "x:Static";
        if (!isType && !isStatic)
        {
            return null;
        }

        // A space must separate the name from the argument (so "{x:Type" alone is name completion).
        if (i >= offset || !char.IsWhiteSpace(text[i]))
        {
            return null;
        }

        while (i < offset && char.IsWhiteSpace(text[i]))
        {
            i++;
        }

        // The reference is the first positional argument: any delimiter/whitespace means it has ended.
        int argStart = i;
        var argSoFar = text.Substring(argStart, offset - argStart);
        foreach (var ch in argSoFar)
        {
            if (ch is '}' or ',' or '=' || char.IsWhiteSpace(ch))
            {
                return null;
            }
        }

        // {x:Static Owner.member}: once a dot is typed, complete the owner type's static members.
        if (isStatic)
        {
            int dot = argSoFar.LastIndexOf('.');
            if (dot >= 0)
            {
                var owner = argSoFar.Substring(0, dot);
                var memberPartial = argSoFar.Substring(dot + 1);
                return new Context(ContextKind.StaticMember, memberPartial, argStart + dot + 1, bindPrefixPath: owner);
            }
        }

        // {x:Type TypeName} or {x:Static Owner} (no dot yet): complete type names.
        return new Context(ContextKind.TypeName, argSoFar, argStart);
    }

    /// <summary>If the value is a {d:DesignInstance …} extension (a design-time DataContext hint) and the caret sits in its TYPE argument</summary>
    private static Context? TryClassifyDesignInstanceType(string text, int valueStart, int offset)
    {
        int i = valueStart;
        while (i < offset && char.IsWhiteSpace(text[i]))
        {
            i++;
        }

        if (i >= offset || text[i] != '{')
        {
            return null;
        }

        i++; // past '{'
        while (i < offset && char.IsWhiteSpace(text[i]))
        {
            i++;
        }

        int nameStart = i;
        while (i < offset && (char.IsLetterOrDigit(text[i]) || text[i] == ':'))
        {
            i++;
        }

        var extName = text.Substring(nameStart, i - nameStart);
        if (LocalPart(extName) != "DesignInstance")
        {
            return null;
        }

        // DesignInstance is always prefixed (its prefix is a design-time namespace); an unprefixed {DesignInstance …} is not the extension we complete.
        var extPrefix = PrefixPart(extName);
        if (extPrefix.Length == 0)
        {
            return null;
        }

        // A space must separate the name from its arguments (so "{d:DesignInstance" alone is name completion).
        if (i >= offset || !char.IsWhiteSpace(text[i]))
        {
            return null;
        }

        // Walk the top-level (depth-0) comma-separated arguments between the name and the caret; the caret lies in the last segment. A depth-0 '}' means the extension closed before the caret.
        int segStart = i;
        int argIndex = 0;
        int depth = 0;
        for (int j = i; j < offset; j++)
        {
            char ch = text[j];
            if (ch is '(' or '{' or '[')
            {
                depth++;
            }
            else if (ch is ')' or ']')
            {
                if (depth > 0)
                {
                    depth--;
                }
            }
            else if (ch == '}')
            {
                if (depth > 0)
                {
                    depth--;
                }
                else
                {
                    return null;
                }
            }
            else if (ch == ',' && depth == 0)
            {
                segStart = j + 1;
                argIndex++;
            }
        }

        // The current segment (text[segStart..offset)) is either a Name=value named arg or a positional one.
        int s = segStart;
        while (s < offset && char.IsWhiteSpace(text[s]))
        {
            s++;
        }

        int eq = -1;
        int eqDepth = 0;
        for (int j = s; j < offset; j++)
        {
            char ch = text[j];
            if (ch is '(' or '{' or '[')
            {
                eqDepth++;
            }
            else if (ch is ')' or '}' or ']')
            {
                if (eqDepth > 0)
                {
                    eqDepth--;
                }
            }
            else if (ch == '=' && eqDepth == 0)
            {
                eq = j;
                break;
            }
        }

        int typeStart;
        if (eq >= 0)
        {
            // Named argument: only Type= carries the type; IsDesignTimeCreatable= etc. are not type refs.
            if (text.Substring(s, eq - s).Trim() != "Type")
            {
                return null;
            }

            typeStart = eq + 1;
            while (typeStart < offset && char.IsWhiteSpace(text[typeStart]))
            {
                typeStart++;
            }
        }
        else
        {
            // Positional: only the FIRST argument is the type (positional args precede named ones in XAML).
            if (argIndex != 0)
            {
                return null;
            }

            typeStart = s;
        }

        // The type token runs to the caret and must not have ended (a delimiter/whitespace/nested brace).
        var partial = text.Substring(typeStart, offset - typeStart);
        foreach (var ch in partial)
        {
            if (ch is '}' or ',' or '=' or '{' || char.IsWhiteSpace(ch))
            {
                return null;
            }
        }

        return new Context(ContextKind.DesignInstanceType, partial, typeStart, bindPrefixPath: extPrefix);
    }

    /// <summary>Completes the type argument of a {d:DesignInstance …} hint.</summary>
}
