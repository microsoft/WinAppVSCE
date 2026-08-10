namespace WinUiXaml.Xaml
{
    public enum XamlDiagnosticSeverity
    {
        Hidden,
        Info,
        Warning,
        Error
    }

    /// <summary>A parser-produced diagnostic.</summary>
    public sealed class XamlDiagnostic
    {
        public XamlDiagnostic(string id, string message, TextSpan span, XamlDiagnosticSeverity severity = XamlDiagnosticSeverity.Error)
        {
            Id = id;
            Message = message;
            Span = span;
            Severity = severity;
        }

        public string Id { get; }

        public string Message { get; }

        public TextSpan Span { get; }

        public XamlDiagnosticSeverity Severity { get; }

        public override string ToString() => $"{Severity} {Id} {Span}: {Message}";
    }

    /// <summary>Well-known parser diagnostic ids.</summary>
    public static class XamlDiagnosticIds
    {
        public const string UnexpectedCharacter = "XAML0001";
        public const string MissingEndTag = "XAML0002";
        public const string StrayEndTag = "XAML0003";
        public const string UnterminatedString = "XAML0004";
        public const string UnterminatedMarkupExtension = "XAML0005";
        public const string UnterminatedComment = "XAML0006";
        public const string MissingTagClose = "XAML0007";
        public const string UnquotedAttributeValue = "XAML0008";
        public const string MissingAttributeValue = "XAML0009";
    }
}
