using System.Text.RegularExpressions;
using System.Xml;

namespace Surface;

/// <summary>
/// Readable text for XAML load failures. WinUI's <c>XamlReader.Load</c> usually loses the real message at the
/// native boundary and reports only "The text associated with this error code could not be found." plus a
/// line/position. When that happens we build our own message from the authored text: the System.Xml parser's
/// message for malformed XML, otherwise a description of the element or attribute at the reported position.
/// Pure (no WinUI types) so it is unit-tested in Surface.Tests.
/// </summary>
internal static class XamlErrorText
{
    internal const string OpaqueWinUiText = "The text associated with this error code could not be found.";

    private const int MaxValueLength = 60;

    private static readonly Regex Noise = new(
        @"\[Line:\s*\d+\s+Position:\s*\d+\]|\b\w*Exception:|->",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    // XML-spec constraint codes ("wfc: element type match", "vc: …") that WinUI sometimes reports as the only text.
    private static readonly Regex SpecCode = new(@"^(wfc|vc):", RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex Whitespace = new(@"\s+", RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex XmlPositionSuffix = new(
        @"\s*Line \d+, position \d+\.\s*$", RegexOptions.Compiled | RegexOptions.CultureInvariant);

    /// <summary>
    /// The useful part of a flattened exception message (e.g. "XamlParseException: The text associated… The
    /// property 'X' was not found in type 'Button'. [Line: 3 Position: 13]" -> "The property 'X' was not found in
    /// type 'Button'."), or null when nothing useful is left: only WinUI's placeholder, exception type names, a
    /// position suffix, or a bare XML-spec code like "wfc: element type match".
    /// </summary>
    public static string? Informative(string? flattened)
    {
        if (string.IsNullOrWhiteSpace(flattened))
        {
            return null;
        }

        var rest = flattened.Replace(OpaqueWinUiText, " ", StringComparison.Ordinal);
        rest = Noise.Replace(rest, " ");
        rest = Whitespace.Replace(rest, " ").Trim();
        return rest.Length == 0 || SpecCode.IsMatch(rest) ? null : rest;
    }

    /// <summary>True when <see cref="Informative"/> finds nothing useful in the message.</summary>
    public static bool IsOpaque(string? flattened) => Informative(flattened) is null;

    /// <summary>
    /// A replacement message (and possibly a more precise position) for an opaque failure loading
    /// <paramref name="xaml"/>. <paramref name="line"/>/<paramref name="column"/> are 1-based, as WinUI reports them.
    /// </summary>
    public static (string Message, int? Line, int? Column) Describe(string? xaml, int? line, int? column)
    {
        if (!string.IsNullOrEmpty(xaml) && TryXmlError(xaml, out var xmlMessage, out var xl, out var xc))
        {
            return ("XML error: " + xmlMessage, xl ?? line, xc ?? column);
        }

        if (!string.IsNullOrEmpty(xaml) && line is int l && column is int c && DescribeAt(xaml, l, c) is string at)
        {
            return (at, line, column);
        }

        return ("WinUI couldn't load this XAML and didn't report why.", line, column);
    }

    private static bool TryXmlError(string xaml, out string message, out int? line, out int? column)
    {
        message = "";
        line = null;
        column = null;
        try
        {
            var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Ignore, XmlResolver = null };
            using var reader = XmlReader.Create(new StringReader(xaml), settings);
            while (reader.Read())
            {
            }

            return false;
        }
        catch (XmlException xe)
        {
            message = XmlPositionSuffix.Replace(xe.Message, "").Trim();
            if (xe.LineNumber > 0)
            {
                line = xe.LineNumber;
                column = xe.LinePosition;
            }

            return message.Length > 0;
        }
    }

    /// <summary>Describes the element or attribute at a 1-based line/column, or null if nothing recognisable is there.</summary>
    internal static string? DescribeAt(string xaml, int line, int column)
    {
        int offset = OffsetOf(xaml, line, column);
        if (offset < 0 || offset >= xaml.Length)
        {
            return null;
        }

        // WinUI points either at the '<' or at the name after it; normalise to the name.
        if (xaml[offset] == '<')
        {
            offset++;
        }

        if (offset < xaml.Length && xaml[offset] == '/')
        {
            offset++;
        }

        string name = ReadName(xaml, offset);
        if (name.Length == 0)
        {
            return null;
        }

        int before = offset - 1;
        if (before >= 0 && (xaml[before] == '<' || (xaml[before] == '/' && before > 0 && xaml[before - 1] == '<')))
        {
            return $"WinUI couldn't create <{name}>. Check the element name and that its namespace is mapped.";
        }

        int i = offset + name.Length;
        while (i < xaml.Length && char.IsWhiteSpace(xaml[i])) i++;
        if (i >= xaml.Length || xaml[i] != '=')
        {
            return null;
        }

        i++;
        while (i < xaml.Length && char.IsWhiteSpace(xaml[i])) i++;
        string value = "";
        if (i < xaml.Length && (xaml[i] == '"' || xaml[i] == '\''))
        {
            int close = xaml.IndexOf(xaml[i], i + 1);
            value = close > i ? xaml.Substring(i + 1, close - i - 1) : "";
        }

        if (value.Length > MaxValueLength)
        {
            value = value.Substring(0, MaxValueLength) + "…";
        }

        string owner = OwningElement(xaml, offset);
        string where = owner.Length > 0 ? $" on <{owner}>" : "";
        return $"WinUI couldn't set {name}=\"{value}\"{where}. Check the property name and value.";
    }

    private static string OwningElement(string xaml, int offset)
    {
        int lt = xaml.LastIndexOf('<', offset);
        return lt < 0 ? "" : ReadName(xaml, lt + 1);
    }

    private static string ReadName(string text, int start)
    {
        int i = start;
        while (i < text.Length && (char.IsLetterOrDigit(text[i]) || text[i] == '_' || text[i] == ':' || text[i] == '.' || text[i] == '-'))
        {
            i++;
        }

        return text.Substring(start, i - start);
    }

    private static int OffsetOf(string text, int line, int column)
    {
        if (line < 1 || column < 1)
        {
            return -1;
        }

        int pos = 0;
        for (int l = 1; l < line; l++)
        {
            int nl = text.IndexOf('\n', pos);
            if (nl < 0)
            {
                return -1;
            }

            pos = nl + 1;
        }

        int end = pos + column - 1;
        int nextNl = text.IndexOf('\n', pos);
        return nextNl >= 0 && end > nextNl ? -1 : end;
    }
}
