using System.Collections.Generic;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;

namespace WinUiXaml.LanguageServer;

/// <summary>
/// Extracts a plain-text (lightly normalized) <c>&lt;summary&gt;</c> from a Roslyn documentation-comment
/// XML string (<see cref="Microsoft.CodeAnalysis.ISymbol.GetDocumentationCommentXml(System.Globalization.CultureInfo,bool,System.Threading.CancellationToken)"/>).
/// WinUI framework reference assemblies (Microsoft.WinUI.dll) and the user's own source both ship these docs,
/// so this powers quick-info for elements, attributes, members, enum values, and attached properties.
/// Pure and defensive: any malformed, doc-less, or summary-less input yields <see langword="null"/> and never throws.
/// </summary>
internal static class XmlDocSummary
{
    /// <summary>
    /// Returns the normalized single-line <c>&lt;summary&gt;</c> text of a documentation-comment XML document,
    /// or <see langword="null"/> when the input is empty, unparseable, has no summary, or the summary is blank.
    /// Inline doc elements are flattened to readable text: <c>&lt;see cref="P:...Foo"/&gt;</c> becomes
    /// <c>Foo</c>, <c>&lt;paramref name="x"/&gt;</c> becomes <c>x</c>, and <c>&lt;c&gt;</c>/other inline tags
    /// keep their inner text; runs of whitespace collapse to single spaces.
    /// </summary>
    public static string? Extract(string? docXml)
    {
        var dom = Parse(docXml);
        return dom is null ? null : FirstElementText(dom, "summary");
    }

    /// <summary>
    /// Extracts the quick-info-relevant sections of a documentation-comment XML document — the
    /// <c>&lt;summary&gt;</c>, the <c>&lt;returns&gt;</c>, and each documented <c>&lt;param&gt;</c> — each
    /// flattened and sanitized exactly like <see cref="Extract"/>. Returns <see cref="QuickInfoDoc.Empty"/> when
    /// the input is empty or unparseable. Powers method quick-info (event handlers, x:Bind function bindings).
    /// </summary>
    public static QuickInfoDoc ExtractQuickInfo(string? docXml)
    {
        var dom = Parse(docXml);
        if (dom is null)
        {
            return QuickInfoDoc.Empty;
        }

        return new QuickInfoDoc(
            FirstElementText(dom, "summary"),
            FirstElementText(dom, "returns"),
            ExtractParams(dom));
    }

    // GetDocumentationCommentXml yields a <member>…</member> document (or, defensively, some other fragment).
    // Parse without ever throwing back into the hover pipeline; null means empty or unparseable input.
    private static XmlDocument? Parse(string? docXml)
    {
        if (string.IsNullOrWhiteSpace(docXml))
        {
            return null;
        }

        var dom = new XmlDocument();
        try
        {
            dom.LoadXml(docXml);
        }
        catch (XmlException)
        {
            return null;
        }

        return dom;
    }

    // The flattened text of the FIRST element with the given tag, or null when absent/blank. A <member> doc
    // carries at most one <summary>/<returns>, so first-match is exact.
    private static string? FirstElementText(XmlDocument dom, string tag)
    {
        var nodes = dom.GetElementsByTagName(tag);
        return nodes.Count > 0 && nodes[0] is XmlElement element ? FlattenElement(element) : null;
    }

    // Each <param name="…">…</param> in document order, keeping only entries that carry a name (the text may be
    // null when the param element is empty — the caller decides whether to render a param with no prose).
    private static IReadOnlyList<XmlDocParam> ExtractParams(XmlDocument dom)
    {
        var nodes = dom.GetElementsByTagName("param");
        if (nodes.Count == 0)
        {
            return System.Array.Empty<XmlDocParam>();
        }

        var list = new List<XmlDocParam>(nodes.Count);
        foreach (XmlNode node in nodes)
        {
            if (node is XmlElement element)
            {
                var name = element.GetAttribute("name");
                if (!string.IsNullOrEmpty(name))
                {
                    list.Add(new XmlDocParam(name, FlattenElement(element)));
                }
            }
        }

        return list;
    }

    // Flatten an element's inline content to normalized, authoring-markup-stripped text; null when blank.
    private static string? FlattenElement(XmlElement element)
    {
        var sb = new StringBuilder();
        AppendInline(element, sb);
        var text = NormalizeWhitespace(StripAuthoringMarkup(sb.ToString()));
        return text.Length == 0 ? null : text;
    }

    // WinUI framework XML docs are authored for DocFX / learn.microsoft.com and embed authoring markup as
    // escaped text INSIDE <summary>: HTML tags (<img …/>, <sup>, <br/>), DocFX moniker zone fences
    // (":::" lines), and alert blockquotes ("> [!NOTE] …"). Left as-is these render as broken images or a
    // wall of noise that buries the real prose, so strip them to match VS quick-info's clean output. The rules
    // are line-anchored where a bare marker character is ambiguous, so genuine prose (including "<"/">" used as
    // comparison operators) is never corrupted.
    private static readonly Regex MonikerFenceLine = new(@"(?m)^[ \t]*:::.*$", RegexOptions.Compiled);
    private static readonly Regex BlockquoteMarker = new(@"(?m)^[ \t]*>+[ \t]?", RegexOptions.Compiled);
    private static readonly Regex AlertLabel = new(@"\[!\w+\]", RegexOptions.Compiled);
    private static readonly Regex EscapedHtmlTag = new(@"<[a-zA-Z/][^>]*>", RegexOptions.Compiled);

    private static string StripAuthoringMarkup(string text)
    {
        if (text.IndexOf(':') < 0 && text.IndexOf('>') < 0 && text.IndexOf('<') < 0 && text.IndexOf("[!", System.StringComparison.Ordinal) < 0)
        {
            // Fast path: the overwhelming majority of summaries carry none of these markers.
            return text;
        }

        text = MonikerFenceLine.Replace(text, " ");
        text = BlockquoteMarker.Replace(text, string.Empty);
        text = AlertLabel.Replace(text, " ");
        text = EscapedHtmlTag.Replace(text, " ");
        return text;
    }

    private static void AppendInline(XmlNode node, StringBuilder sb)
    {
        foreach (XmlNode child in node.ChildNodes)
        {
            switch (child)
            {
                case XmlText text:
                    sb.Append(text.Value);
                    break;
                case XmlCDataSection cdata:
                    sb.Append(cdata.Value);
                    break;
                case XmlElement element:
                    switch (element.LocalName)
                    {
                        case "see":
                        case "seealso":
                            sb.Append(ReferenceText(element));
                            break;
                        case "paramref":
                        case "typeparamref":
                            sb.Append(element.GetAttribute("name"));
                            break;
                        case "para":
                            sb.Append(' ');
                            AppendInline(element, sb);
                            sb.Append(' ');
                            break;
                        default:
                            // <c>, <b>, <i>, list/item, or any unknown inline element: keep the inner text.
                            AppendInline(element, sb);
                            break;
                    }

                    break;
            }
        }
    }

    /// <summary>
    /// Renders a <c>&lt;see&gt;</c>/<c>&lt;seealso&gt;</c> as a readable name: prefer explicit inner text,
    /// then <c>langword</c> (e.g. <c>null</c>/<c>true</c>), then the simple name from <c>cref</c> (stripping the
    /// leading <c>T:</c>/<c>P:</c>/<c>M:</c> documentation-ID prefix and any method parameter list, keeping the
    /// last dotted segment), falling back to <c>href</c>.
    /// </summary>
    private static string ReferenceText(XmlElement element)
    {
        if (!string.IsNullOrEmpty(element.InnerText))
        {
            return element.InnerText;
        }

        var langword = element.GetAttribute("langword");
        if (!string.IsNullOrEmpty(langword))
        {
            return langword;
        }

        var cref = element.GetAttribute("cref");
        if (string.IsNullOrEmpty(cref))
        {
            return element.GetAttribute("href");
        }

        // Strip a leading documentation-ID prefix ("T:", "P:", "M:", "!:", …).
        if (cref.Length > 1 && cref[1] == ':')
        {
            cref = cref[2..];
        }

        // Drop a method parameter list, then keep the last dotted segment.
        var paren = cref.IndexOf('(');
        if (paren >= 0)
        {
            cref = cref[..paren];
        }

        var dot = cref.LastIndexOf('.');
        return dot >= 0 ? cref[(dot + 1)..] : cref;
    }

    private static string NormalizeWhitespace(string value)
    {
        var sb = new StringBuilder(value.Length);
        var pendingSpace = false;
        foreach (var ch in value)
        {
            if (char.IsWhiteSpace(ch))
            {
                pendingSpace = sb.Length > 0;
                continue;
            }

            if (pendingSpace)
            {
                sb.Append(' ');
                pendingSpace = false;
            }

            sb.Append(ch);
        }

        return sb.ToString();
    }
}

/// <summary>
/// A single <c>&lt;param&gt;</c> entry from a documentation comment: its declared <paramref name="Name"/> and
/// flattened doc <paramref name="Text"/> (<see langword="null"/> when the param element carries no prose).
/// </summary>
internal readonly record struct XmlDocParam(string Name, string? Text);

/// <summary>
/// The quick-info-relevant sections of a documentation comment — <see cref="Summary"/>, <see cref="Returns"/>,
/// and <see cref="Parameters"/> — each flattened and sanitized like <see cref="XmlDocSummary.Extract"/>.
/// </summary>
internal readonly record struct QuickInfoDoc(string? Summary, string? Returns, IReadOnlyList<XmlDocParam> Parameters)
{
    /// <summary>An empty document: no summary, no returns, no parameters.</summary>
    public static QuickInfoDoc Empty { get; } = new(null, null, System.Array.Empty<XmlDocParam>());
}
