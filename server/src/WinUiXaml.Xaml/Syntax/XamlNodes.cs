using System.Collections.Generic;

namespace WinUiXaml.Xaml
{
    /// <summary>Base class for every node in the tolerant XAML syntax tree.</summary>
    public abstract class XamlNode
    {
        private protected XamlNode(TextSpan span)
        {
            Span = span;
        }

        /// <summary>The full source span covered by this node.</summary>
        public TextSpan Span { get; internal set; }

        /// <summary>The parent node, assigned after the tree is built. Null for the document root.</summary>
        public XamlNode? Parent { get; internal set; }

        public abstract XamlNodeKind Kind { get; }

        /// <summary>All structural child nodes in source order (attributes precede content on elements).</summary>
        public abstract IReadOnlyList<XamlNode> ChildNodes { get; }

        /// <summary>
        /// Returns the innermost node whose span contains <paramref name="position"/>, or null when
        /// the position falls outside this node. Uses inclusive end bounds so a caret sitting at the
        /// end of a token still maps into it.
        /// </summary>
        public XamlNode? FindNode(int position)
        {
            if (!Span.ContainsInclusive(position))
            {
                return null;
            }

            var children = ChildNodes;
            int low = 0;
            int high = children.Count - 1;
            int candidate = -1;
            while (low <= high)
            {
                int mid = low + ((high - low) / 2);
                if (children[mid].Span.Start <= position)
                {
                    candidate = mid;
                    low = mid + 1;
                }
                else
                {
                    high = mid - 1;
                }
            }

            if (candidate >= 0)
            {
                var hit = children[candidate].FindNode(position);
                if (hit != null)
                {
                    return hit;
                }
            }

            return this;
        }

        public IEnumerable<XamlNode> DescendantNodesAndSelf()
        {
            yield return this;
            var children = ChildNodes;
            for (int i = 0; i < children.Count; i++)
            {
                foreach (var d in children[i].DescendantNodesAndSelf())
                {
                    yield return d;
                }
            }
        }
    }

    /// <summary>The root of a parsed XAML document.</summary>
    public sealed class XamlDocument : XamlNode
    {
        public XamlDocument(
            string text,
            IReadOnlyList<XamlNode> contents,
            XamlElement? root,
            IReadOnlyList<XamlDiagnostic> diagnostics,
            TextSpan span)
            : base(span)
        {
            Text = text;
            Contents = contents;
            Root = root;
            Diagnostics = diagnostics;
        }

        /// <summary>The original source text.</summary>
        public string Text { get; }

        /// <summary>Top-level nodes: declaration, comments, whitespace, and the root element.</summary>
        public IReadOnlyList<XamlNode> Contents { get; }

        /// <summary>The first top-level element, if any.</summary>
        public XamlElement? Root { get; }

        public IReadOnlyList<XamlDiagnostic> Diagnostics { get; }

        public override XamlNodeKind Kind => XamlNodeKind.Document;

        public override IReadOnlyList<XamlNode> ChildNodes => Contents;
    }

    /// <summary>A XAML element: <c>&lt;Name ...&gt; ... &lt;/Name&gt;</c> or <c>&lt;Name .../&gt;</c>.</summary>
    public sealed class XamlElement : XamlNode
    {
        private readonly XamlNode[] _childNodes;

        public XamlElement(
            XamlName? name,
            IReadOnlyList<XamlAttribute> attributes,
            IReadOnlyList<XamlNode> content,
            bool isSelfClosing,
            bool hasEndTag,
            XamlName? endTagName,
            TextSpan openTagSpan,
            TextSpan? endTagSpan,
            TextSpan span)
            : base(span)
        {
            Name = name;
            Attributes = attributes;
            Content = content;
            IsSelfClosing = isSelfClosing;
            HasEndTag = hasEndTag;
            EndTagName = endTagName;
            OpenTagSpan = openTagSpan;
            EndTagSpan = endTagSpan;
            NamespaceScope = XamlNamespaceScope.Empty;

            var all = new XamlNode[attributes.Count + content.Count];
            for (int i = 0; i < attributes.Count; i++)
            {
                all[i] = attributes[i];
            }

            for (int i = 0; i < content.Count; i++)
            {
                all[attributes.Count + i] = content[i];
            }

            _childNodes = all;
        }

        /// <summary>The element name, or null when the open tag is malformed.</summary>
        public XamlName? Name { get; }

        public IReadOnlyList<XamlAttribute> Attributes { get; }

        /// <summary>Child elements, text, comments, and CDATA between the open and end tags.</summary>
        public IReadOnlyList<XamlNode> Content { get; }

        public bool IsSelfClosing { get; }

        public bool HasEndTag { get; }

        public XamlName? EndTagName { get; }

        /// <summary>Span of the open tag, from <c>&lt;</c> through <c>&gt;</c> (or <c>/&gt;</c>).</summary>
        public TextSpan OpenTagSpan { get; }

        /// <summary>Span of the end tag, if present.</summary>
        public TextSpan? EndTagSpan { get; }

        /// <summary>xmlns declarations in effect at this element (assigned after parsing).</summary>
        public XamlNamespaceScope NamespaceScope { get; internal set; }

        public bool IsClosed => IsSelfClosing || HasEndTag;

        /// <summary>True for a property element such as <c>&lt;Grid.RowDefinitions&gt;</c>.</summary>
        public bool IsPropertyElement => Name != null && !Name.HasPrefix && Name.IsDotted;

        public override XamlNodeKind Kind => XamlNodeKind.Element;

        public override IReadOnlyList<XamlNode> ChildNodes => _childNodes;

        public XamlAttribute? GetAttribute(string fullName)
        {
            for (int i = 0; i < Attributes.Count; i++)
            {
                if (string.Equals(Attributes[i].Name.FullName, fullName, System.StringComparison.Ordinal))
                {
                    return Attributes[i];
                }
            }

            return null;
        }
    }

    /// <summary>A name/value pair on an element's open tag.</summary>
    public sealed class XamlAttribute : XamlNode
    {
        private readonly XamlNode[] _childNodes;

        public XamlAttribute(XamlName name, TextSpan? equalsSpan, XamlAttributeValue? value, TextSpan span)
            : base(span)
        {
            Name = name;
            EqualsSpan = equalsSpan;
            Value = value;
            _childNodes = value is null ? System.Array.Empty<XamlNode>() : new XamlNode[] { value };
        }

        public XamlName Name { get; }

        public TextSpan? EqualsSpan { get; }

        public XamlAttributeValue? Value { get; }

        /// <summary>True for <c>xmlns</c> or <c>xmlns:foo</c>.</summary>
        public bool IsNamespaceDeclaration =>
            (Name.HasPrefix && Name.Prefix == "xmlns") || (!Name.HasPrefix && Name.LocalName == "xmlns");

        /// <summary>For <c>xmlns:foo</c> returns "foo"; for a default <c>xmlns</c> returns null.</summary>
        public string? DeclaredPrefix =>
            Name.HasPrefix && Name.Prefix == "xmlns" ? Name.LocalName : null;

        public override XamlNodeKind Kind => XamlNodeKind.Attribute;

        public override IReadOnlyList<XamlNode> ChildNodes => _childNodes;
    }

    /// <summary>The quoted value of an attribute, which may embed a markup extension.</summary>
    public sealed class XamlAttributeValue : XamlNode
    {
        private readonly XamlNode[] _childNodes;

        public XamlAttributeValue(char? quote, string text, TextSpan innerSpan, XamlMarkupExtension? markupExtension, TextSpan span)
            : base(span)
        {
            Quote = quote;
            Text = text;
            InnerSpan = innerSpan;
            MarkupExtension = markupExtension;
            _childNodes = markupExtension is null ? System.Array.Empty<XamlNode>() : new XamlNode[] { markupExtension };
        }

        /// <summary>The quote character used, or null for an unquoted/missing value.</summary>
        public char? Quote { get; }

        /// <summary>The raw inner text (without surrounding quotes).</summary>
        public string Text { get; }

        /// <summary>Span of the inner text only.</summary>
        public TextSpan InnerSpan { get; }

        public XamlMarkupExtension? MarkupExtension { get; }

        public bool IsMarkupExtension => MarkupExtension != null;

        public override XamlNodeKind Kind => XamlNodeKind.AttributeValue;

        public override IReadOnlyList<XamlNode> ChildNodes => _childNodes;
    }

    /// <summary>A <c>{Prefix:Name arg, Name=value}</c> markup extension.</summary>
    public sealed class XamlMarkupExtension : XamlNode
    {
        public XamlMarkupExtension(XamlName? name, IReadOnlyList<XamlMarkupExtensionArgument> arguments, bool isClosed, TextSpan span)
            : base(span)
        {
            Name = name;
            Arguments = arguments;
            IsClosed = isClosed;
        }

        public XamlName? Name { get; }

        public IReadOnlyList<XamlMarkupExtensionArgument> Arguments { get; }

        /// <summary>True when a closing <c>}</c> was found.</summary>
        public bool IsClosed { get; }

        public override XamlNodeKind Kind => XamlNodeKind.MarkupExtension;

        public override IReadOnlyList<XamlNode> ChildNodes => Arguments;
    }

    /// <summary>A single argument of a markup extension: positional or <c>Name=value</c>.</summary>
    public sealed class XamlMarkupExtensionArgument : XamlNode
    {
        private readonly XamlNode[] _childNodes;

        public XamlMarkupExtensionArgument(
            XamlName? name,
            TextSpan? equalsSpan,
            string? value,
            TextSpan? valueSpan,
            XamlMarkupExtension? nestedExtension,
            TextSpan span)
            : base(span)
        {
            Name = name;
            EqualsSpan = equalsSpan;
            Value = value;
            ValueSpan = valueSpan;
            NestedExtension = nestedExtension;
            _childNodes = nestedExtension is null ? System.Array.Empty<XamlNode>() : new XamlNode[] { nestedExtension };
        }

        /// <summary>The argument name for a named argument, or null for a positional argument.</summary>
        public XamlName? Name { get; }

        public TextSpan? EqualsSpan { get; }

        /// <summary>The scalar value text (trimmed), or null when the value is a nested extension.</summary>
        public string? Value { get; }

        public TextSpan? ValueSpan { get; }

        public XamlMarkupExtension? NestedExtension { get; }

        public bool IsNamed => Name != null;

        public override XamlNodeKind Kind => XamlNodeKind.MarkupExtensionArgument;

        public override IReadOnlyList<XamlNode> ChildNodes => _childNodes;
    }

    /// <summary>Literal text content between elements.</summary>
    public sealed class XamlText : XamlNode
    {
        public XamlText(string text, TextSpan span) : base(span)
        {
            Text = text;
        }

        public string Text { get; }

        public bool IsWhitespace => string.IsNullOrWhiteSpace(Text);

        public override XamlNodeKind Kind => XamlNodeKind.Text;

        public override IReadOnlyList<XamlNode> ChildNodes => System.Array.Empty<XamlNode>();
    }

    /// <summary>An <c>&lt;!-- ... --&gt;</c> comment. <see cref="Text"/> is the inner content.</summary>
    public sealed class XamlComment : XamlNode
    {
        public XamlComment(string text, TextSpan span) : base(span)
        {
            Text = text;
        }

        public string Text { get; }

        public override XamlNodeKind Kind => XamlNodeKind.Comment;

        public override IReadOnlyList<XamlNode> ChildNodes => System.Array.Empty<XamlNode>();
    }

    /// <summary>A processing instruction / XML declaration such as <c>&lt;?xml ... ?&gt;</c>.</summary>
    public sealed class XamlProcessingInstruction : XamlNode
    {
        public XamlProcessingInstruction(string text, TextSpan span) : base(span)
        {
            Text = text;
        }

        public string Text { get; }

        public override XamlNodeKind Kind => XamlNodeKind.ProcessingInstruction;

        public override IReadOnlyList<XamlNode> ChildNodes => System.Array.Empty<XamlNode>();
    }

    /// <summary>A <c>&lt;![CDATA[ ... ]]&gt;</c> section. <see cref="Text"/> is the inner content.</summary>
    public sealed class XamlCData : XamlNode
    {
        public XamlCData(string text, TextSpan span) : base(span)
        {
            Text = text;
        }

        public string Text { get; }

        public override XamlNodeKind Kind => XamlNodeKind.CData;

        public override IReadOnlyList<XamlNode> ChildNodes => System.Array.Empty<XamlNode>();
    }
}
