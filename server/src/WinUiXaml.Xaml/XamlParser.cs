using System;
using System.Collections.Generic;

namespace WinUiXaml.Xaml
{
    /// <summary>A tolerant, non-throwing recursive-descent parser for XAML.</summary>
    public sealed class XamlParser
    {
        // Recursive descent uses roughly 1 KB of stack per level; 1024 overflowed a 1 MB thread.
        private const int MaxDepth = 512;
        private const int MaxMarkupDepth = 128;

        private readonly string _text;
        private readonly List<XamlDiagnostic> _diagnostics = new List<XamlDiagnostic>();
        private readonly List<string> _openTagStack = new List<string>();
        private int _pos;
        private int _depth;

        private XamlParser(string text)
        {
            _text = text;
        }

        /// <summary>Parses <paramref name="text"/> into a fully-linked <see cref="XamlDocument"/>.</summary>
        public static XamlDocument Parse(string text)
        {
            var parser = new XamlParser(text ?? string.Empty);
            return parser.ParseDocument();
        }

        private XamlDocument ParseDocument()
        {
            var contents = ParseNodes(topLevel: true);

            XamlElement? root = null;
            for (int i = 0; i < contents.Count; i++)
            {
                switch (contents[i])
                {
                    case XamlElement el when root == null:
                        root = el;
                        break;
                    case XamlElement extra:
                        AddDiagnostic(
                            XamlDiagnosticIds.MultipleRootElements,
                            "A XAML document can have only one root element.",
                            extra.Name?.Span ?? extra.OpenTagSpan);
                        break;
                    case XamlText text when !text.IsWhitespace:
                        AddDiagnostic(
                            XamlDiagnosticIds.TextOutsideRoot,
                            "Text is not allowed outside the root element.",
                            TrimSpan(text.Span));
                        break;
                    case XamlCData cdata:
                        AddDiagnostic(
                            XamlDiagnosticIds.TextOutsideRoot,
                            "CDATA is not allowed outside the root element.",
                            cdata.Span);
                        break;
                }
            }

            ReportInvalidCharacters();

            var span = TextSpan.FromBounds(0, _text.Length);
            var doc = new XamlDocument(_text, contents, root, _diagnostics, span);

            SetParents(doc);

            var rootScope = new Dictionary<string, string>(StringComparer.Ordinal);
            for (int i = 0; i < contents.Count; i++)
            {
                AssignScopes(contents[i], rootScope);
            }

            return doc;
        }

        // ---- content ----------------------------------------------------------------

        private List<XamlNode> ParseNodes(bool topLevel)
        {
            var nodes = new List<XamlNode>();

            while (_pos < _text.Length)
            {
                char c = _text[_pos];
                if (c != '<')
                {
                    nodes.Add(ParseText());
                    continue;
                }

                if (StartsWith("</"))
                {
                    string endKey = PeekEndTagKey();
                    if (!topLevel && EndTagMatchesOpenStack(endKey))
                    {
                        // Belongs to this element or an ancestor; hand control back up.
                        return nodes;
                    }

                    // Stray end tag with no matching open element: consume and report.
                    var (_, straySpan) = ReadEndTag();
                    AddDiagnostic(XamlDiagnosticIds.StrayEndTag, "Unexpected end tag.", straySpan, XamlDiagnosticSeverity.Warning);
                    continue;
                }

                if (StartsWith("<!--"))
                {
                    nodes.Add(ParseComment());
                }
                else if (StartsWith("<![CDATA["))
                {
                    nodes.Add(ParseCData());
                }
                else if (StartsWith("<?"))
                {
                    nodes.Add(ParseProcessingInstruction());
                }
                else if (StartsWith("<!"))
                {
                    nodes.Add(ParseBangDeclaration());
                }
                else
                {
                    nodes.Add(ParseElement());
                }
            }

            return nodes;
        }

        private XamlText ParseText()
        {
            int start = _pos;
            while (_pos < _text.Length && _text[_pos] != '<')
            {
                _pos++;
            }

            ValidateEntityReferences(start, _pos);
            return new XamlText(_text.Substring(start, _pos - start), TextSpan.FromBounds(start, _pos));
        }

        private XamlElement ParseElement()
        {
            int start = _pos;
            _pos++; // consume '<'
            if (IsWhitespace(Peek(0)))
            {
                int whitespaceStart = _pos;
                SkipWhitespace();
                AddDiagnostic(
                    XamlDiagnosticIds.InvalidTagName,
                    "Whitespace is not allowed between '<' and the element name.",
                    TextSpan.FromBounds(whitespaceStart, _pos));
            }

            XamlName? name = TryParseName();
            if (name == null)
            {
                AddDiagnostic(XamlDiagnosticIds.InvalidTagName, "Expected an element name.", TextSpan.Empty(_pos));
            }

            var attributes = new List<XamlAttribute>();
            ParseAttributes(attributes);

            bool selfClosing = false;
            bool sawClose = false;
            if (Match("/>"))
            {
                selfClosing = true;
                sawClose = true;
            }
            else if (Peek(0) == '>')
            {
                _pos++;
                sawClose = true;
            }
            else
            {
                AddDiagnostic(XamlDiagnosticIds.MissingTagClose, "Expected '>' to close the tag.", TextSpan.Empty(_pos));
            }

            int openTagEnd = _pos;
            var openTagSpan = TextSpan.FromBounds(start, openTagEnd);

            if (selfClosing || !sawClose)
            {
                return new XamlElement(
                    name,
                    attributes,
                    Array.Empty<XamlNode>(),
                    isSelfClosing: selfClosing,
                    hasEndTag: false,
                    endTagName: null,
                    openTagSpan: openTagSpan,
                    endTagSpan: null,
                    span: TextSpan.FromBounds(start, openTagEnd));
            }

            string matchKey = name?.FullName ?? string.Empty;

            List<XamlNode> content;
            if (_depth >= MaxDepth)
            {
                // Skip the subtree in one flat pass so nesting cannot exhaust the stack or cascade
                // missing-end-tag diagnostics; the matching end tag is still read below.
                AddDiagnostic(
                    XamlDiagnosticIds.ElementTooDeep,
                    $"Element nesting exceeds the supported depth of {MaxDepth}; nested content is not analyzed.",
                    name?.Span ?? openTagSpan,
                    XamlDiagnosticSeverity.Warning);
                SkipNestedContent();
                content = new List<XamlNode>();
            }
            else
            {
                _openTagStack.Add(matchKey);
                _depth++;
                content = ParseNodes(topLevel: false);
                _depth--;
                _openTagStack.RemoveAt(_openTagStack.Count - 1);
            }

            bool hasEndTag = false;
            XamlName? endTagName = null;
            TextSpan? endTagSpan = null;

            if (_pos < _text.Length && StartsWith("</"))
            {
                string endKey = PeekEndTagKey();
                if (NamesMatch(endKey, matchKey))
                {
                    var (endName, span) = ReadEndTag();
                    hasEndTag = true;
                    endTagName = endName;
                    endTagSpan = span;
                }
                else
                {
                    // An ancestor's end tag; leave it for the caller. This element is unclosed.
                    AddDiagnostic(
                        XamlDiagnosticIds.MissingEndTag,
                        $"Element '{matchKey}' has no matching end tag.",
                        name?.Span ?? openTagSpan,
                        XamlDiagnosticSeverity.Warning);
                }
            }
            else
            {
                AddDiagnostic(
                    XamlDiagnosticIds.MissingEndTag,
                    $"Element '{matchKey}' has no matching end tag.",
                    name?.Span ?? openTagSpan,
                    XamlDiagnosticSeverity.Warning);
            }

            int elementEnd = hasEndTag ? endTagSpan!.Value.End : _pos;
            return new XamlElement(
                name,
                attributes,
                content,
                isSelfClosing: false,
                hasEndTag: hasEndTag,
                endTagName: endTagName,
                openTagSpan: openTagSpan,
                endTagSpan: endTagSpan,
                span: TextSpan.FromBounds(start, elementEnd));
        }

        private void ParseAttributes(List<XamlAttribute> attributes)
        {
            while (_pos < _text.Length)
            {
                SkipWhitespace();
                char c = Peek(0);
                if (c == '>' || c == '\0')
                {
                    break;
                }

                if (c == '/' && Peek(1) == '>')
                {
                    break;
                }

                if (c == '<')
                {
                    // A new tag started before this one closed; recover by ending the tag here.
                    break;
                }

                XamlName? name = TryParseName();
                if (name == null)
                {
                    AddDiagnostic(
                        XamlDiagnosticIds.UnexpectedCharacter,
                        $"Unexpected character '{c}'.",
                        new TextSpan(_pos, _pos + 1),
                        XamlDiagnosticSeverity.Warning);
                    _pos++; // guarantee progress
                    continue;
                }

                SkipWhitespace();

                TextSpan? equalsSpan = null;
                XamlAttributeValue? value = null;
                if (Peek(0) == '=')
                {
                    equalsSpan = new TextSpan(_pos, _pos + 1);
                    _pos++;
                    SkipWhitespace();
                    value = ParseAttributeValue();
                }

                int attrEnd = value != null
                    ? value.Span.End
                    : (equalsSpan?.End ?? name.Span.End);
                attributes.Add(new XamlAttribute(name, equalsSpan, value, TextSpan.FromBounds(name.Span.Start, attrEnd)));
            }
        }

        private XamlAttributeValue ParseAttributeValue()
        {
            int start = _pos;
            char q = Peek(0);
            if (q == '"' || q == '\'')
            {
                _pos++; // consume opening quote
                int innerStart = _pos;
                // XML permits line breaks inside quoted attribute values. Keep scanning until the
                // matching quote; stopping at a newline produces false unterminated-value errors.
                while (_pos < _text.Length && _text[_pos] != q)
                {
                    _pos++;
                }

                int innerEnd = _pos;
                string inner = _text.Substring(innerStart, innerEnd - innerStart);
                bool terminated = _pos < _text.Length && _text[_pos] == q;
                if (terminated)
                {
                    _pos++; // consume closing quote
                    ValidateAttributeValueCharacters(innerStart, innerEnd);
                }
                else
                {
                    AddDiagnostic(XamlDiagnosticIds.UnterminatedString, "Unterminated attribute value.", TextSpan.FromBounds(start, _pos));
                }

                var innerSpan = TextSpan.FromBounds(innerStart, innerEnd);
                var markup = TryParseMarkupExtension(inner, innerStart);
                return new XamlAttributeValue(q, inner, innerSpan, markup, TextSpan.FromBounds(start, _pos));
            }

            // Unquoted value: read until whitespace, '>', or '/>'.
            int vstart = _pos;
            while (_pos < _text.Length)
            {
                char ch = _text[_pos];
                if (IsWhitespace(ch) || ch == '>' || (ch == '/' && Peek(1) == '>'))
                {
                    break;
                }

                _pos++;
            }

            int vend = _pos;
            if (vend == vstart)
            {
                AddDiagnostic(XamlDiagnosticIds.MissingAttributeValue, "Expected an attribute value.", TextSpan.Empty(_pos), XamlDiagnosticSeverity.Warning);
                return new XamlAttributeValue(null, string.Empty, TextSpan.Empty(_pos), null, TextSpan.Empty(_pos));
            }

            string unquoted = _text.Substring(vstart, vend - vstart);
            AddDiagnostic(XamlDiagnosticIds.UnquotedAttributeValue, "Attribute value should be quoted.", TextSpan.FromBounds(vstart, vend), XamlDiagnosticSeverity.Warning);
            var unquotedMarkup = TryParseMarkupExtension(unquoted, vstart);
            return new XamlAttributeValue(null, unquoted, TextSpan.FromBounds(vstart, vend), unquotedMarkup, TextSpan.FromBounds(vstart, vend));
        }

        // ---- markup extensions ------------------------------------------------------

        private XamlMarkupExtension? TryParseMarkupExtension(string inner, int innerStart)
        {
            if (inner.Length == 0 || inner[0] != '{')
            {
                return null;
            }

            // "{}" is the escape prefix for a literal value that begins with '{'.
            if (inner.Length >= 2 && inner[1] == '}')
            {
                return null;
            }

            int limit = innerStart + inner.Length;
            int p = innerStart;
            var markup = ParseMarkupExtension(ref p, limit);
            SkipWhitespace(ref p, limit);
            if (markup.IsClosed && p < limit)
            {
                AddDiagnostic(
                    XamlDiagnosticIds.MalformedMarkupExtension,
                    "Unexpected text after the end of the markup extension.",
                    TextSpan.FromBounds(p, TrimEnd(p, limit)));
            }

            return markup;
        }

        private XamlMarkupExtension ParseMarkupExtension(ref int p, int limit, int depth = 0)
        {
            int start = p;
            if (depth >= MaxMarkupDepth)
            {
                int braces = 0;
                char quote = '\0';
                do
                {
                    char c = _text[p++];
                    if (quote != '\0')
                    {
                        if (c == quote) quote = '\0';
                    }
                    else if (c == '\'' || c == '"')
                    {
                        quote = c;
                    }
                    else if (c == '{')
                    {
                        braces++;
                    }
                    else if (c == '}')
                    {
                        braces--;
                    }
                } while (p < limit && braces > 0);

                var span = TextSpan.FromBounds(start, p);
                AddDiagnostic(XamlDiagnosticIds.MarkupExtensionTooDeep,
                    "Markup extension nesting exceeds the supported depth of 128.", span);
                return new XamlMarkupExtension(null, Array.Empty<XamlMarkupExtensionArgument>(), braces == 0, span);
            }

            p++; // consume '{'
            SkipWhitespace(ref p, limit);
            XamlName? name = ParseNameBounded(ref p, limit);
            if (name == null && p < limit)
            {
                AddDiagnostic(
                    XamlDiagnosticIds.MalformedMarkupExtension,
                    "Expected a markup extension name after '{'.",
                    TextSpan.Empty(p));
            }

            var args = new List<XamlMarkupExtensionArgument>();
            bool closed = false;
            bool sawNamed = false;

            while (p < limit)
            {
                SkipWhitespace(ref p, limit);
                if (p >= limit)
                {
                    break;
                }

                char c = _text[p];
                if (c == '}')
                {
                    p++;
                    closed = true;
                    break;
                }

                if (c == ',')
                {
                    p++;
                    continue;
                }

                var arg = ParseMarkupArgument(ref p, limit, depth);
                if (arg == null)
                {
                    p++; // safety: guarantee progress
                }
                else
                {
                    if (arg.IsNamed)
                    {
                        sawNamed = true;
                    }
                    else if (sawNamed)
                    {
                        AddDiagnostic(
                            XamlDiagnosticIds.MalformedMarkupExtension,
                            "Positional arguments must come before named arguments.",
                            arg.Span);
                    }

                    args.Add(arg);
                }
            }

            if (!closed)
            {
                // A nested unterminated extension makes every enclosing one unterminated too; they all end at the same offset. Report only the innermost (first emitted) to avoid a duplicate cascade.
                bool alreadyReported = false;
                for (int i = _diagnostics.Count - 1; i >= 0; i--)
                {
                    if (_diagnostics[i].Id == XamlDiagnosticIds.UnterminatedMarkupExtension &&
                        _diagnostics[i].Span.End == p)
                    {
                        alreadyReported = true;
                        break;
                    }
                }

                if (!alreadyReported)
                {
                    AddDiagnostic(XamlDiagnosticIds.UnterminatedMarkupExtension, "Unterminated markup extension.", TextSpan.FromBounds(start, p));
                }
            }

            return new XamlMarkupExtension(name, args, closed, TextSpan.FromBounds(start, p));
        }

        private XamlMarkupExtensionArgument ParseMarkupArgument(ref int p, int limit, int depth)
        {
            int start = p;

            // A nested markup extension used as a positional value.
            if (_text[p] == '{')
            {
                var nested = ParseMarkupExtension(ref p, limit, depth + 1);
                return new XamlMarkupExtensionArgument(null, null, null, null, nested, TextSpan.FromBounds(start, p));
            }

            XamlName? name = ParseNameBounded(ref p, limit);
            SkipWhitespace(ref p, limit);

            if (name != null && p < limit && _text[p] == '=')
            {
                var equalsSpan = new TextSpan(p, p + 1);
                p++; // consume '='
                SkipWhitespace(ref p, limit);

                if (p < limit && _text[p] == '{')
                {
                    var nested = ParseMarkupExtension(ref p, limit, depth + 1);
                    return new XamlMarkupExtensionArgument(name, equalsSpan, null, null, nested, TextSpan.FromBounds(start, p));
                }

                int valStart = p;
                ScanMarkupValue(ref p, limit, stopAtOpenBrace: false);

                int valEnd = TrimEnd(valStart, p);
                string val = _text.Substring(valStart, valEnd - valStart);
                return new XamlMarkupExtensionArgument(name, equalsSpan, val, TextSpan.FromBounds(valStart, valEnd), null, TextSpan.FromBounds(start, p));
            }

            // Positional scalar argument: everything up to ',', '}', or a nested '{'. A comma inside parentheses is kept, so a function binding (Method(a, b)) is one positional path argument.
            p = start;
            int posStart = p;
            if (_text[p] == '=')
            {
                AddDiagnostic(
                    XamlDiagnosticIds.MalformedMarkupExtension,
                    "Expected a property name before '='.",
                    new TextSpan(p, p + 1));
            }

            ScanMarkupValue(ref p, limit, stopAtOpenBrace: true);

            int posEnd = TrimEnd(posStart, p);
            string positional = _text.Substring(posStart, posEnd - posStart);
            return new XamlMarkupExtensionArgument(null, null, positional, TextSpan.FromBounds(posStart, posEnd), null, TextSpan.FromBounds(posStart, p));
        }

        /// <summary>Advances to the ',' or '}' ending a markup value, skipping parenthesized commas, escapes, and quoted text.</summary>
        private void ScanMarkupValue(ref int p, int limit, bool stopAtOpenBrace)
        {
            int valueStart = p;
            int parenDepth = 0;
            while (p < limit)
            {
                char c = _text[p];
                if (c == '\\')
                {
                    p = Math.Min(p + 2, limit);
                    continue;
                }

                // Quotes delimit a value only at its start, or as x:Bind function string arguments.
                // The text is still XML-escaped, so any spelling of the quote character counts.
                if ((p == valueStart || parenDepth > 0) && TryReadQuote(p, limit, out char quote, out int openLength))
                {
                    int close = p + openLength;
                    int closeLength = 0;
                    while (close < limit &&
                           !(TryReadQuote(close, limit, out char closing, out closeLength) && closing == quote))
                    {
                        close += _text[close] == '\\' ? 2 : 1;
                    }

                    p = close < limit ? close + closeLength : p + 1;
                    continue;
                }

                if (c == '}' || (stopAtOpenBrace && c == '{'))
                {
                    break;
                }

                if (c == '(')
                {
                    parenDepth++;
                }
                else if (c == ')')
                {
                    if (parenDepth > 0)
                    {
                        parenDepth--;
                    }
                }
                else if (c == ',' && parenDepth == 0)
                {
                    break;
                }

                p++;
            }
        }

        private bool StartsWithAt(int p, int limit, string s) =>
            p + s.Length <= limit && string.CompareOrdinal(_text, p, s, 0, s.Length) == 0;

        /// <summary>Reads a quote written literally, as &amp;apos;/&amp;quot;, or as a decimal or hex character reference.</summary>
        private bool TryReadQuote(int p, int limit, out char quote, out int length)
        {
            quote = '\0';
            length = 0;
            char c = _text[p];
            if (c == '\'' || c == '"')
            {
                quote = c;
                length = 1;
                return true;
            }

            if (c != '&')
            {
                return false;
            }

            if (StartsWithAt(p, limit, "&apos;") || StartsWithAt(p, limit, "&quot;"))
            {
                quote = _text[p + 1] == 'a' ? '\'' : '"';
                length = 6;
                return true;
            }

            if (!StartsWithAt(p, limit, "&#"))
            {
                return false;
            }

            int i = p + 2;
            bool hex = i < limit && (_text[i] == 'x' || _text[i] == 'X');
            if (hex)
            {
                i++;
            }

            int digitsStart = i;
            int value = 0;
            while (i < limit && i - digitsStart < 8 &&
                   (hex ? Uri.IsHexDigit(_text[i]) : _text[i] >= '0' && _text[i] <= '9'))
            {
                value = (value * (hex ? 16 : 10)) + (hex ? Uri.FromHex(_text[i]) : _text[i] - '0');
                i++;
            }

            if (i == digitsStart || i >= limit || _text[i] != ';' || (value != '\'' && value != '"'))
            {
                return false;
            }

            quote = (char)value;
            length = i + 1 - p;
            return true;
        }

        // ---- comments / cdata / pi --------------------------------------------------

        private XamlComment ParseComment()
        {
            int start = _pos;
            _pos += 4; // consume "<!--"
            int innerStart = _pos;
            int idx = _text.IndexOf("-->", _pos, StringComparison.Ordinal);
            if (idx < 0)
            {
                int innerEndEof = _text.Length;
                _pos = _text.Length;
                AddDiagnostic(XamlDiagnosticIds.UnterminatedComment, "Unterminated comment.", TextSpan.FromBounds(start, _pos));
                return new XamlComment(_text.Substring(innerStart, innerEndEof - innerStart), TextSpan.FromBounds(start, _pos));
            }

            string inner = _text.Substring(innerStart, idx - innerStart);
            _pos = idx + 3;
            return new XamlComment(inner, TextSpan.FromBounds(start, _pos));
        }

        private XamlCData ParseCData()
        {
            int start = _pos;
            _pos += 9; // consume "<![CDATA["
            int innerStart = _pos;
            int idx = _text.IndexOf("]]>", _pos, StringComparison.Ordinal);
            if (idx < 0)
            {
                int innerEndEof = _text.Length;
                _pos = _text.Length;
                return new XamlCData(_text.Substring(innerStart, innerEndEof - innerStart), TextSpan.FromBounds(start, _pos));
            }

            string inner = _text.Substring(innerStart, idx - innerStart);
            _pos = idx + 3;
            return new XamlCData(inner, TextSpan.FromBounds(start, _pos));
        }

        private XamlProcessingInstruction ParseProcessingInstruction()
        {
            int start = _pos;
            _pos += 2; // consume "<?"
            int innerStart = _pos;
            int idx = _text.IndexOf("?>", _pos, StringComparison.Ordinal);
            int innerEnd;
            if (idx < 0)
            {
                innerEnd = _text.Length;
                _pos = _text.Length;
                AddDiagnostic(XamlDiagnosticIds.InvalidXmlDeclaration, "Unterminated processing instruction; expected '?>'.", TextSpan.FromBounds(start, _pos));
            }
            else
            {
                innerEnd = idx;
                _pos = idx + 2;
            }

            ValidateProcessingInstruction(start, innerStart, innerEnd);
            return new XamlProcessingInstruction(_text.Substring(innerStart, innerEnd - innerStart), TextSpan.FromBounds(start, _pos));
        }

        private static readonly string[] XmlDeclarationAttributeOrder = { "version", "encoding", "standalone" };

        /// <summary>Reports a missing or reserved target and validates an XML declaration's placement and pseudo-attributes.</summary>
        private void ValidateProcessingInstruction(int start, int innerStart, int innerEnd)
        {
            int p = innerStart;
            while (p < innerEnd && !IsWhitespace(_text[p]))
            {
                p++;
            }

            string target = _text.Substring(innerStart, p - innerStart);
            var targetSpan = TextSpan.FromBounds(innerStart, p);
            if (target.Length == 0)
            {
                AddDiagnostic(XamlDiagnosticIds.InvalidXmlDeclaration, "Expected a processing instruction target after '<?'.", TextSpan.Empty(innerStart));
                return;
            }

            if (!string.Equals(target, "xml", StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            if (!string.Equals(target, "xml", StringComparison.Ordinal))
            {
                AddDiagnostic(XamlDiagnosticIds.InvalidXmlDeclaration, $"The processing instruction target '{target}' is reserved.", targetSpan);
                return;
            }

            if (start != 0)
            {
                AddDiagnostic(XamlDiagnosticIds.InvalidXmlDeclaration, "The XML declaration must be at the very beginning of the document.", targetSpan);
                return;
            }

            int nextAttribute = 0;
            bool sawVersion = false;
            while (true)
            {
                int beforeWhitespace = p;
                SkipWhitespace(ref p, innerEnd);
                if (p >= innerEnd)
                {
                    break;
                }

                int nameStart = p;
                while (p < innerEnd && (IsNameChar(_text[p]) || _text[p] == ':'))
                {
                    p++;
                }

                string name = _text.Substring(nameStart, p - nameStart);
                if (name.Length == 0 || p == beforeWhitespace)
                {
                    AddDiagnostic(XamlDiagnosticIds.InvalidXmlDeclaration, "Malformed XML declaration.", TextSpan.FromBounds(nameStart, innerEnd));
                    return;
                }

                var nameSpan = TextSpan.FromBounds(nameStart, p);
                SkipWhitespace(ref p, innerEnd);
                if (p < innerEnd && _text[p] == '=')
                {
                    p++;
                    SkipWhitespace(ref p, innerEnd);
                }
                else
                {
                    p = innerEnd;
                }

                char quote = p < innerEnd ? _text[p] : '\0';
                if (quote != '"' && quote != '\'')
                {
                    AddDiagnostic(XamlDiagnosticIds.InvalidXmlDeclaration, $"Expected a quoted value for '{name}'.", nameSpan);
                    return;
                }

                int valueStart = p + 1;
                int valueEnd = _text.IndexOf(quote, valueStart, innerEnd - valueStart);
                if (valueEnd < 0)
                {
                    AddDiagnostic(XamlDiagnosticIds.InvalidXmlDeclaration, $"Unterminated value for '{name}'.", TextSpan.FromBounds(nameStart, innerEnd));
                    return;
                }

                p = valueEnd + 1;
                string value = _text.Substring(valueStart, valueEnd - valueStart);
                var valueSpan = TextSpan.FromBounds(valueStart, valueEnd);
                int order = Array.IndexOf(XmlDeclarationAttributeOrder, name);
                if (order < nextAttribute)
                {
                    AddDiagnostic(
                        XamlDiagnosticIds.InvalidXmlDeclaration,
                        order < 0
                            ? $"'{name}' is not allowed in the XML declaration; expected version, encoding, or standalone."
                            : $"'{name}' is duplicated or out of order in the XML declaration.",
                        nameSpan);
                    return;
                }

                nextAttribute = order + 1;
                string? error = name switch
                {
                    "version" when !IsXmlVersion(value) => "The XML version must be '1.0'.",
                    "encoding" when !IsEncodingName(value) => $"'{value}' is not a valid encoding name.",
                    "standalone" when value != "yes" && value != "no" => "The standalone value must be 'yes' or 'no'.",
                    _ => null,
                };
                if (error != null)
                {
                    AddDiagnostic(XamlDiagnosticIds.InvalidXmlDeclaration, error, valueSpan);
                    return;
                }

                sawVersion |= order == 0;
            }

            if (!sawVersion)
            {
                AddDiagnostic(XamlDiagnosticIds.InvalidXmlDeclaration, "The XML declaration must specify a version.", targetSpan);
            }
        }

        private static bool IsXmlVersion(string value)
        {
            if (value.Length < 3 || value[0] != '1' || value[1] != '.')
            {
                return false;
            }

            for (int i = 2; i < value.Length; i++)
            {
                if (value[i] < '0' || value[i] > '9')
                {
                    return false;
                }
            }

            return true;
        }

        private static bool IsEncodingName(string value)
        {
            if (value.Length == 0 || !IsAsciiLetter(value[0]))
            {
                return false;
            }

            for (int i = 1; i < value.Length; i++)
            {
                char c = value[i];
                if (!IsAsciiLetter(c) && (c < '0' || c > '9') && c != '.' && c != '_' && c != '-')
                {
                    return false;
                }
            }

            return true;
        }

        private static bool IsAsciiLetter(char c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');

        private XamlProcessingInstruction ParseBangDeclaration()
        {
            int start = _pos;
            _pos++; // consume '<' (leave '!' in the captured text)
            while (_pos < _text.Length && _text[_pos] != '>')
            {
                _pos++;
            }

            if (_pos < _text.Length)
            {
                _pos++; // consume '>'
            }

            return new XamlProcessingInstruction(_text.Substring(start, _pos - start), TextSpan.FromBounds(start, _pos));
        }

        // ---- end tags ---------------------------------------------------------------

        private (XamlName? name, TextSpan span) ReadEndTag()
        {
            int start = _pos;
            _pos += 2; // consume "</"
            if (IsWhitespace(Peek(0)))
            {
                int whitespaceStart = _pos;
                SkipWhitespace();
                AddDiagnostic(
                    XamlDiagnosticIds.InvalidTagName,
                    "Whitespace is not allowed between '</' and the element name.",
                    TextSpan.FromBounds(whitespaceStart, _pos));
            }

            var name = TryParseName();
            SkipWhitespace();
            if (Peek(0) == '>')
            {
                _pos++;
            }
            else
            {
                AddDiagnostic(XamlDiagnosticIds.MissingTagClose, "Expected '>' to close the end tag.", TextSpan.Empty(_pos));
            }

            return (name, TextSpan.FromBounds(start, _pos));
        }

        private string PeekEndTagKey()
        {
            int p = _pos + 2; // skip "</"
            while (p < _text.Length && IsWhitespace(_text[p]))
            {
                p++;
            }

            int nameStart = p;
            while (p < _text.Length && (IsNameChar(_text[p]) || _text[p] == ':'))
            {
                p++;
            }

            return _text.Substring(nameStart, p - nameStart);
        }

        private bool EndTagMatchesOpenStack(string endKey)
        {
            for (int i = 0; i < _openTagStack.Count; i++)
            {
                if (NamesMatch(_openTagStack[i], endKey))
                {
                    return true;
                }
            }

            return false;
        }

        // ---- names ------------------------------------------------------------------

        private XamlName? TryParseName()
        {
            int p = _pos;
            var name = ParseNameBounded(ref p, _text.Length);
            _pos = p;
            return name;
        }

        private XamlName? ParseNameBounded(ref int p, int limit)
        {
            if (p >= limit || !IsNameStartChar(_text[p]))
            {
                return null;
            }

            int firstStart = p;
            while (p < limit && IsNameChar(_text[p]))
            {
                p++;
            }

            int firstEnd = p;
            string first = _text.Substring(firstStart, firstEnd - firstStart);

            if (p < limit && _text[p] == ':')
            {
                p++; // consume ':'
                int localStart = p;
                while (p < limit && IsNameChar(_text[p]))
                {
                    p++;
                }

                int localEnd = p;
                string local = _text.Substring(localStart, localEnd - localStart);
                return new XamlName(
                    first,
                    local,
                    TextSpan.FromBounds(firstStart, localEnd),
                    TextSpan.FromBounds(firstStart, firstEnd),
                    TextSpan.FromBounds(localStart, localEnd));
            }

            var span = TextSpan.FromBounds(firstStart, firstEnd);
            return new XamlName(null, first, span, null, span);
        }

        // ---- post-processing --------------------------------------------------------

        private static void SetParents(XamlNode node)
        {
            var children = node.ChildNodes;
            for (int i = 0; i < children.Count; i++)
            {
                children[i].Parent = node;
                SetParents(children[i]);
            }
        }

        private static void AssignScopes(XamlNode node, Dictionary<string, string> inherited)
        {
            if (node is XamlElement el)
            {
                Dictionary<string, string> effective = inherited;
                Dictionary<string, string>? local = null;
                for (int i = 0; i < el.Attributes.Count; i++)
                {
                    var attr = el.Attributes[i];
                    if (!attr.IsNamespaceDeclaration)
                    {
                        continue;
                    }

                    local ??= new Dictionary<string, string>(inherited, StringComparer.Ordinal);
                    string key = attr.DeclaredPrefix ?? string.Empty;
                    local[key] = attr.Value?.Text ?? string.Empty;
                }

                if (local != null)
                {
                    effective = local;
                }

                el.NamespaceScope = new XamlNamespaceScope(effective);

                for (int i = 0; i < el.Content.Count; i++)
                {
                    AssignScopes(el.Content[i], effective);
                }
            }
            else
            {
                var children = node.ChildNodes;
                for (int i = 0; i < children.Count; i++)
                {
                    AssignScopes(children[i], inherited);
                }
            }
        }

        // ---- well-formedness checks ---------------------------------------------------

        /// <summary>Consumes content nested past <see cref="MaxDepth"/>, stopping before the end tag that closes the current element.</summary>
        private void SkipNestedContent()
        {
            int level = 0;
            while (_pos < _text.Length)
            {
                int lt = _text.IndexOf('<', _pos);
                if (lt < 0)
                {
                    _pos = _text.Length;
                    return;
                }

                _pos = lt;
                if (StartsWith("<!--"))
                {
                    _pos = IndexAfter("-->");
                }
                else if (StartsWith("<![CDATA["))
                {
                    _pos = IndexAfter("]]>");
                }
                else if (StartsWith("<?"))
                {
                    _pos = IndexAfter("?>");
                }
                else if (StartsWith("</"))
                {
                    if (level == 0)
                    {
                        return;
                    }

                    level--;
                    _pos += 2;
                    SkipPastTagEnd();
                }
                else
                {
                    bool bang = lt + 1 < _text.Length && _text[lt + 1] == '!';
                    _pos++;
                    if (!SkipPastTagEnd() && !bang)
                    {
                        level++;
                    }
                }
            }
        }

        /// <summary>Advances past the '>' ending a tag, ignoring quoted text; returns true for "/>".</summary>
        private bool SkipPastTagEnd()
        {
            char quote = '\0';
            while (_pos < _text.Length)
            {
                char c = _text[_pos];
                if (quote != '\0')
                {
                    if (c == quote)
                    {
                        quote = '\0';
                    }
                }
                else if (c == '"' || c == '\'')
                {
                    quote = c;
                }
                else if (c == '<')
                {
                    return false; // malformed: a new tag began before this one closed
                }
                else if (c == '>')
                {
                    _pos++;
                    return _text[_pos - 2] == '/';
                }

                _pos++;
            }

            return false;
        }

        private int IndexAfter(string terminator)
        {
            int idx = _text.IndexOf(terminator, _pos, StringComparison.Ordinal);
            return idx < 0 ? _text.Length : idx + terminator.Length;
        }

        /// <summary>Reports a raw '&lt;' and malformed entity references in a quoted attribute value.</summary>
        private void ValidateAttributeValueCharacters(int start, int end)
        {
            for (int i = start; i < end; i++)
            {
                if (_text[i] == '<')
                {
                    AddDiagnostic(
                        XamlDiagnosticIds.InvalidAttributeValueCharacter,
                        "'<' is not allowed in an attribute value; use '&lt;'.",
                        new TextSpan(i, i + 1));
                }
            }

            ValidateEntityReferences(start, end);
        }

        /// <summary>Reports each '&amp;' that does not begin a predefined entity or a valid character reference.</summary>
        private void ValidateEntityReferences(int start, int end)
        {
            for (int i = start; i < end; i++)
            {
                if (_text[i] != '&')
                {
                    continue;
                }

                int j = i + 1;
                bool valid;
                string? message = null;
                if (j < end && _text[j] == '#')
                {
                    j++;
                    bool hex = j < end && _text[j] == 'x';
                    if (hex)
                    {
                        j++;
                    }

                    int digitsStart = j;
                    long value = 0;
                    while (j < end && (hex ? Uri.IsHexDigit(_text[j]) : _text[j] >= '0' && _text[j] <= '9'))
                    {
                        value = Math.Min(value * (hex ? 16 : 10) + (hex ? Uri.FromHex(_text[j]) : _text[j] - '0'), 0x110000);
                        j++;
                    }

                    valid = j > digitsStart && j < end && _text[j] == ';';
                    if (valid && !IsXmlCharValue(value))
                    {
                        valid = false;
                        message = $"Character reference '{_text.Substring(i, j + 1 - i)}' is not a valid XML character.";
                    }
                }
                else
                {
                    while (j < end && IsNameChar(_text[j]))
                    {
                        j++;
                    }

                    valid = j > i + 1 && j < end && _text[j] == ';';
                    if (valid)
                    {
                        string entity = _text.Substring(i + 1, j - i - 1);
                        if (entity != "lt" && entity != "gt" && entity != "amp" && entity != "apos" && entity != "quot")
                        {
                            valid = false;
                            message = $"Unknown entity '&{entity};'. XAML supports only &lt; &gt; &amp; &apos; &quot; and character references.";
                        }
                    }
                }

                if (valid)
                {
                    i = j;
                    continue;
                }

                if (message != null)
                {
                    AddDiagnostic(XamlDiagnosticIds.InvalidEntityReference, message, TextSpan.FromBounds(i, j + 1));
                    i = j;
                }
                else
                {
                    AddDiagnostic(
                        XamlDiagnosticIds.InvalidEntityReference,
                        "'&' must be escaped as '&amp;'.",
                        new TextSpan(i, i + 1));
                }
            }
        }

        /// <summary>Reports each run of characters outside the XML 1.0 Char production, including unpaired surrogates.</summary>
        private void ReportInvalidCharacters()
        {
            int runStart = -1;
            int i = 0;
            while (i <= _text.Length)
            {
                int width = 1;
                bool invalid = false;
                if (i < _text.Length)
                {
                    char c = _text[i];
                    if (char.IsHighSurrogate(c) && i + 1 < _text.Length && char.IsLowSurrogate(_text[i + 1]))
                    {
                        width = 2;
                    }
                    else
                    {
                        invalid = !IsXmlCharValue(c);
                    }
                }

                if (invalid && runStart < 0)
                {
                    runStart = i;
                }
                else if (!invalid && runStart >= 0)
                {
                    AddDiagnostic(
                        XamlDiagnosticIds.InvalidCharacter,
                        $"Character U+{(int)_text[runStart]:X4} is not allowed in XML.",
                        TextSpan.FromBounds(runStart, i));
                    runStart = -1;
                }

                i += width;
            }
        }

        private static bool IsXmlCharValue(long value) =>
            value == 0x9 || value == 0xA || value == 0xD ||
            (value >= 0x20 && value <= 0xD7FF) ||
            (value >= 0xE000 && value <= 0xFFFD) ||
            (value >= 0x10000 && value <= 0x10FFFF);

        private TextSpan TrimSpan(TextSpan span)
        {
            int start = span.Start;
            while (start < span.End && IsWhitespace(_text[start]))
            {
                start++;
            }

            return TextSpan.FromBounds(start, TrimEnd(start, span.End));
        }

        // ---- primitives -------------------------------------------------------------

        private void AddDiagnostic(string id, string message, TextSpan span, XamlDiagnosticSeverity severity = XamlDiagnosticSeverity.Error)
        {
            _diagnostics.Add(new XamlDiagnostic(id, message, span, severity));
        }

        private char Peek(int offset)
        {
            int i = _pos + offset;
            return i >= 0 && i < _text.Length ? _text[i] : '\0';
        }

        private bool StartsWith(string s)
        {
            if (_pos + s.Length > _text.Length)
            {
                return false;
            }

            for (int i = 0; i < s.Length; i++)
            {
                if (_text[_pos + i] != s[i])
                {
                    return false;
                }
            }

            return true;
        }

        private bool Match(string s)
        {
            if (!StartsWith(s))
            {
                return false;
            }

            _pos += s.Length;
            return true;
        }

        private void SkipWhitespace()
        {
            while (_pos < _text.Length && IsWhitespace(_text[_pos]))
            {
                _pos++;
            }
        }

        private void SkipWhitespace(ref int p, int limit)
        {
            while (p < limit && IsWhitespace(_text[p]))
            {
                p++;
            }
        }

        private int TrimEnd(int start, int end)
        {
            while (end > start && IsWhitespace(_text[end - 1]))
            {
                end--;
            }

            return end;
        }

        private static bool NamesMatch(string a, string b) => string.Equals(a, b, StringComparison.Ordinal);

        private static bool IsWhitespace(char c) => c == ' ' || c == '\t' || c == '\r' || c == '\n';

        private static bool IsNameStartChar(char c) => char.IsLetter(c) || c == '_';

        private static bool IsNameChar(char c) => char.IsLetterOrDigit(c) || c == '_' || c == '-' || c == '.';
    }
}
