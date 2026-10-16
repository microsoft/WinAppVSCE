using System.Collections.Generic;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;

namespace WinUiXaml.LanguageServer;

/// <summary>Extracts a plain-text (lightly normalized) &lt;summary&gt; from a Roslyn documentation-comment XML string</summary>
internal static class XmlDocSummary
{
    /// <summary>Returns the normalized single-line &lt;summary&gt; text of a documentation-comment XML document, or when the input is empty, unparseable, has no summary, or the summary is blank.</summary>
    public static string? Extract(string? docXml)
    {
        var dom = Parse(docXml);
        return dom is null ? null : FirstElementText(dom, "summary");
    }

    /// <summary>Extracts the quick-info-relevant sections of a documentation-comment XML document — the &lt;summary&gt;, the &lt;returns&gt;, and each documented &lt;param&gt</summary>
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

    // GetDocumentationCommentXml yields a <member>…</member> document (or, defensively, some other fragment). Parse without ever throwing back into the hover pipeline; null means empty or unparseable input.
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

    // The flattened text of the FIRST element with the given tag, or null when absent/blank. A <member> doc carries at most one <summary>/<returns>, so first-match is exact.
    private static string? FirstElementText(XmlDocument dom, string tag)
    {
        var nodes = dom.GetElementsByTagName(tag);
        return nodes.Count > 0 && nodes[0] is XmlElement element ? FlattenElement(element) : null;
    }

    // Each <param name="…">…</param> in document order, keeping only entries that carry a name (the text may be null when the param element is empty — the caller decides whether to render a param with no prose).
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

    // WinUI framework XML docs are authored for DocFX / learn.microsoft.com and embed authoring markup as escaped text INSIDE : HTML tags (, , )
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

    /// <summary>Renders a &lt;see&gt;/&lt;seealso&gt; as a readable name: prefer explicit inner text, then langword.</summary>
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

/// <summary>A single &lt;param&gt; entry from a documentation comment: its declared Name and flattened doc Text ( when the param element carries no prose).</summary>
internal readonly record struct XmlDocParam(string Name, string? Text);

/// <summary>The quick-info-relevant sections of a documentation comment — Summary, Returns, and Parameters — each flattened and sanitized like XmlDocSummary.Extract.</summary>
internal readonly record struct QuickInfoDoc(string? Summary, string? Returns, IReadOnlyList<XmlDocParam> Parameters)
{
    /// <summary>An empty document: no summary, no returns, no parameters.</summary>
    public static QuickInfoDoc Empty { get; } = new(null, null, System.Array.Empty<XmlDocParam>());
}
