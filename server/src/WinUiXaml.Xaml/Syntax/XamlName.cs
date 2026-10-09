namespace WinUiXaml.Xaml
{
    /// <summary> A possibly-qualified XAML name (<c>prefix:local</c> or just <c>local</c>) with precise spans for the prefix and local parts so features can target exactly the right text run.</summary>
    public sealed class XamlName
    {
        public XamlName(string? prefix, string localName, TextSpan span, TextSpan? prefixSpan, TextSpan localNameSpan)
        {
            Prefix = prefix;
            LocalName = localName;
            Span = span;
            PrefixSpan = prefixSpan;
            LocalNameSpan = localNameSpan;
        }

        /// <summary>The namespace prefix, or null when the name is unqualified.</summary>
        public string? Prefix { get; }

        /// <summary>The local name (may be empty for malformed input).</summary>
        public string LocalName { get; }

        /// <summary>Full span covering prefix, colon, and local name.</summary>
        public TextSpan Span { get; }

        public TextSpan? PrefixSpan { get; }

        public TextSpan LocalNameSpan { get; }

        public bool HasPrefix => !string.IsNullOrEmpty(Prefix);

        /// <summary>True when the local name contains a dotted member.</summary>
        public bool IsDotted => LocalName.IndexOf('.') >= 0;

        public string FullName => HasPrefix ? Prefix + ":" + LocalName : LocalName;

        public override string ToString() => FullName;
    }
}
