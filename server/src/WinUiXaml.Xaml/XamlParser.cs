using System;
using System.Collections.Generic;

namespace WinUiXaml.Xaml
{
    /// <summary>A tolerant, non-throwing recursive-descent parser for XAML.</summary>
    public sealed class XamlParser
    {
        private const int MaxDepth = 500;

        private readonly string _text;
        private readonly List<XamlDiagnostic> _diagnostics = new List<XamlDiagnostic>();
        private readonly List<string> _openTagStack = new List<string>();
        private int _pos;
        private int _depth;

        private XamlParser(string text)
        {
            _text = text ?? string.Empty;
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
                if (contents[i] is XamlElement el)
                {
                    root = el;
                    break;
                }
            }

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

            return new XamlText(_text.Substring(start, _pos - start), TextSpan.FromBounds(start, _pos));
        }

        private XamlElement ParseElement()
        {
            int start = _pos;
            _pos++; // consume '<'
            SkipWhitespace();

            XamlName? name = TryParseName();

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
            return ParseMarkupExtension(ref p, limit);
        }

        private XamlMarkupExtension ParseMarkupExtension(ref int p, int limit)
        {
            int start = p;
            p++; // consume '{'
            SkipWhitespace(ref p, limit);
            XamlName? name = ParseNameBounded(ref p, limit);

            var args = new List<XamlMarkupExtensionArgument>();
            bool closed = false;

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

                var arg = ParseMarkupArgument(ref p, limit);
                if (arg == null)
                {
                    p++; // safety: guarantee progress
                }
                else
                {
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

        private XamlMarkupExtensionArgument ParseMarkupArgument(ref int p, int limit)
        {
            int start = p;

            // A nested markup extension used as a positional value.
            if (_text[p] == '{')
            {
                var nested = ParseMarkupExtension(ref p, limit);
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
                    var nested = ParseMarkupExtension(ref p, limit);
                    return new XamlMarkupExtensionArgument(name, equalsSpan, null, null, nested, TextSpan.FromBounds(start, p));
                }

                int valStart = p;
                int valParenDepth = 0;
                while (p < limit)
                {
                    char vc = _text[p];
                    if (vc == '}')
                    {
                        break;
                    }

                    if (vc == '(')
                    {
                        valParenDepth++;
                    }
                    else if (vc == ')')
                    {
                        if (valParenDepth > 0)
                        {
                            valParenDepth--;
                        }
                    }
                    else if (vc == ',' && valParenDepth == 0)
                    {
                        break;
                    }

                    p++;
                }

                int valEnd = TrimEnd(valStart, p);
                string val = _text.Substring(valStart, valEnd - valStart);
                return new XamlMarkupExtensionArgument(name, equalsSpan, val, TextSpan.FromBounds(valStart, valEnd), null, TextSpan.FromBounds(start, p));
            }

            // Positional scalar argument: everything up to ',', '}', or a nested '{'. A comma inside parentheses is kept, so a function binding (Method(a, b)) is one positional path argument.
            p = start;
            int posStart = p;
            int posParenDepth = 0;
            while (p < limit)
            {
                char pc = _text[p];
                if (pc == '}' || pc == '{')
                {
                    break;
                }

                if (pc == '(')
                {
                    posParenDepth++;
                }
                else if (pc == ')')
                {
                    if (posParenDepth > 0)
                    {
                        posParenDepth--;
                    }
                }
                else if (pc == ',' && posParenDepth == 0)
                {
                    break;
                }

                p++;
            }

            int posEnd = TrimEnd(posStart, p);
            string positional = _text.Substring(posStart, posEnd - posStart);
            return new XamlMarkupExtensionArgument(null, null, positional, TextSpan.FromBounds(posStart, posEnd), null, TextSpan.FromBounds(posStart, p));
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
            }
            else
            {
                innerEnd = idx;
                _pos = idx + 2;
            }

            return new XamlProcessingInstruction(_text.Substring(innerStart, innerEnd - innerStart), TextSpan.FromBounds(start, _pos));
        }

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
            SkipWhitespace();
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
