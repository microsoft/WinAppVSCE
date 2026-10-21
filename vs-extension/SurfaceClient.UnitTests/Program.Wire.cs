#nullable enable

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using WinUIXamlPreview.Editor;
using WinUIXamlPreview.Protocol;

namespace WinUIXamlPreview.UnitTests;

/// <summary>Edge cases for the socket line framing and the caret/previewer source map.</summary>
internal static partial class Program
{
    // ------------------------------------------------------------ LineDecoder

    private static List<string> Feed(LineDecoder d, byte[] bytes, int? count = null) =>
        d.Push(bytes, count ?? bytes.Length).ToList();

    private static void LineDecoderTests()
    {
        var d = new LineDecoder();
        Eq("partial line yields nothing", 0, Feed(d, Encoding.UTF8.GetBytes("{\"type\":\"pi")).Count);
        var got = Feed(d, Encoding.UTF8.GetBytes("ng\"}\n"));
        Check("line split across chunks reassembles", got.Count == 1 && got[0] == "{\"type\":\"ping\"}", string.Join("|", got));

        got = Feed(new LineDecoder(), Encoding.UTF8.GetBytes("a\nb\n\nc"));
        Check("several lines in one chunk, empty line kept, tail buffered",
            got.SequenceEqual(new[] { "a", "b", "" }), string.Join("|", got));

        got = Feed(new LineDecoder(), Encoding.UTF8.GetBytes("crlf\r\nmid\rline\n"));
        Check("CRLF trimmed, lone CR inside a line kept", got.SequenceEqual(new[] { "crlf", "mid\rline" }), string.Join("|", got));

        got = Feed(new LineDecoder(), Encoding.UTF8.GetBytes("\r\n"));
        Check("bare CRLF -> empty line", got.Count == 1 && got[0] == "", string.Join("|", got));

        // A multi-byte character split at every possible chunk boundary still decodes.
        var text = "é😀✓";
        var bytes = Encoding.UTF8.GetBytes(text + "\n");
        bool allSplits = true;
        for (int cut = 1; cut < bytes.Length; cut++)
        {
            var dd = new LineDecoder();
            var first = Feed(dd, bytes.Take(cut).ToArray());
            var second = Feed(dd, bytes.Skip(cut).ToArray());
            var all = first.Concat(second).ToList();
            if (all.Count != 1 || all[0] != text) { allSplits = false; break; }
        }
        Check("multi-byte UTF-8 split at any byte boundary", allSplits);

        d = new LineDecoder();
        got = Feed(d, new byte[] { 0x61, 0xC3, 0x28, 0xFF, 0x62, (byte)'\n', 0x6F, 0x6B, (byte)'\n' });
        Check("invalid UTF-8 -> replacement chars, no throw, next line clean",
            got.Count == 2 && got[0].StartsWith("a") && got[0].EndsWith("b") && got[0].Contains('\uFFFD') && got[1] == "ok",
            string.Join("|", got));

        // Only the first `count` bytes of a reused receive buffer are consumed.
        var buf = new byte[16];
        Encoding.ASCII.GetBytes("hi\nstale\n").CopyTo(buf, 0);
        got = Feed(new LineDecoder(), buf, 3);
        Check("count bounds the consumed bytes", got.SequenceEqual(new[] { "hi" }), string.Join("|", got));

        got = Feed(new LineDecoder(), Array.Empty<byte>());
        Eq("empty chunk yields nothing", 0, got.Count);

        // A large frame (base64 PNG-sized) survives arbitrary chunking.
        var big = new string('A', 6 * 1024 * 1024);
        var bigBytes = Encoding.ASCII.GetBytes(big + "\n");
        d = new LineDecoder();
        var lines = new List<string>();
        for (int i = 0; i < bigBytes.Length; i += 65536)
        {
            int n = Math.Min(65536, bigBytes.Length - i);
            var chunk = new byte[65536];
            Array.Copy(bigBytes, i, chunk, 0, n);
            lines.AddRange(Feed(d, chunk, n));
        }
        Check("6 MB line across 64 KB chunks", lines.Count == 1 && lines[0].Length == big.Length);

        got = Feed(d, Encoding.UTF8.GetBytes("after\n"));
        Check("decoder buffer is reset after a line", got.SequenceEqual(new[] { "after" }), string.Join("|", got));
    }

    // ------------------------------------------------------------ XamlSourceMap

    private const string Pns = "xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" " +
                               "xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\" " +
                               "xmlns:d=\"http://schemas.microsoft.com/expression/blend/2008\" " +
                               "xmlns:mc=\"http://schemas.openxmlformats.org/markup-compatibility/2006\" " +
                               "xmlns:sys=\"using:System\" mc:Ignorable=\"d\"";

    private static string Names(XamlSourceMap? m) =>
        m == null ? "(null)" : string.Join(", ", m.Elements.Select(e => e.Path + "=" + e.Name.LocalName));

    /// <summary>The element at <paramref name="path"/> starts at the n-th occurrence of <paramref name="tag"/>.</summary>
    private static void SpanStartsAt(string name, XamlSourceMap? m, string text, string path, string tag, int occurrence = 0)
    {
        int at = -1;
        for (int i = 0; i <= occurrence; i++) at = text.IndexOf(tag, at + 1, StringComparison.Ordinal);
        int start = -1, end = -1;
        bool ok = m != null && m.TryGetSpan(path, out start, out end);
        Check(name, ok && start == at && end > start, $"path {path}: span [{start},{end}), expected start {at}");
    }

    private static void XamlSourceMapTests()
    {
        Check("null text -> null map", XamlSourceMap.Build(null) == null);
        Check("empty text -> null map", XamlSourceMap.Build("") == null);
        Check("malformed (mid-edit) -> null map", XamlSourceMap.Build("<Page " + Pns + "><Grid></Page>") == null);
        Check("unclosed tag -> null map", XamlSourceMap.Build("<Page " + Pns + "><Grid") == null);

        // Child ordering: comments, d:/mc: elements, x: primitives, text elements, System primitives and
        // non-content property elements are skipped; content property elements are walked into.
        var text =
            "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n" +
            "<!-- leading comment -->\n" +
            "<Page " + Pns + ">\n" +
            "  <StackPanel>\n" +
            "    <!-- a comment between children -->\n" +
            "    <d:DesignOnly/>\n" +
            "    <mc:AlternateContent/>\n" +
            "    <x:String>skip</x:String>\n" +
            "    <sys:Int32>3</sys:Int32>\n" +
            "    <Button Content=\"A\"/>\n" +
            "    <TextBlock><Run Text=\"r\"/><LineBreak/></TextBlock>\n" +
            "    <Grid>\n" +
            "      <Grid.RowDefinitions><RowDefinition/></Grid.RowDefinitions>\n" +
            "      <Grid.Children><Border/></Grid.Children>\n" +
            "      <Border><Border.Child><Rectangle/></Border.Child></Border>\n" +
            "    </Grid>\n" +
            "    <Button><Button.Content><Ellipse/></Button.Content></Button>\n" +
            "    <ListView><ListView.Items><ListViewItem/></ListView.Items></ListView>\n" +
            "  </StackPanel>\n" +
            "</Page>";
        var m = XamlSourceMap.Build(text);
        Check("well-formed page maps", m != null && m.HasContent);
        var expected = "0=Page, 0.0=StackPanel, 0.0.0=Button, 0.0.1=TextBlock, 0.0.2=Grid, 0.0.2.0=Border, 0.0.2.1=Border, " +
                       "0.0.2.1.0=Rectangle, 0.0.3=Button, 0.0.3.0=Ellipse, 0.0.4=ListView, 0.0.4.0=ListViewItem";
        Eq("authored tree skips non-elements and walks content properties", expected, Names(m));

        SpanStartsAt("root span starts at <Page (after prolog/comment)", m, text, "0", "<Page");
        SpanStartsAt("first authored child skips d:/x:/sys: siblings", m, text, "0.0.0", "<Button");
        SpanStartsAt("content-property child span", m, text, "0.0.2.1.0", "<Rectangle");
        SpanStartsAt("second Button span", m, text, "0.0.3", "<Button", 1);

        m!.TryGetSpan("0.0.0", out var bStart, out var bEnd);
        int btnTag = text.IndexOf("<Button Content=\"A\"/>", StringComparison.Ordinal);
        Eq("self-closing span ends just past '/>'", btnTag + "<Button Content=\"A\"/>".Length, bEnd);
        m.TryGetSpan("0.0.2", out _, out var gridEnd);
        Eq("element span ends just past its closing tag", text.IndexOf("</Grid>", StringComparison.Ordinal) + "</Grid>".Length, gridEnd);
        m.TryGetSpan("0", out _, out var rootEnd);
        Eq("root span ends at end of </Page>", text.Length, rootEnd);

        Check("unknown path -> false", !m.TryGetSpan("0.9.9", out _, out _));
        Check("null path -> false", !m.TryGetSpan(null, out _, out _));
        Check("empty path -> false", !m.TryGetSpan("", out _, out _));

        // Caret -> path.
        Eq("caret inside nested Rectangle -> innermost path", "0.0.2.1.0", m.PathForOffset(text.IndexOf("<Rectangle", StringComparison.Ordinal) + 3));
        Eq("caret on an attribute value -> owning element", "0.0.0", m.PathForOffset(text.IndexOf("\"A\"", StringComparison.Ordinal)));
        Eq("caret inside a skipped Run -> its TextBlock", "0.0.1", m.PathForOffset(text.IndexOf("<Run", StringComparison.Ordinal)));
        Eq("caret inside a skipped RowDefinitions -> the Grid", "0.0.2", m.PathForOffset(text.IndexOf("<RowDefinition/>", StringComparison.Ordinal)));
        Check("caret in the XML prolog -> null", m.PathForOffset(5) == null);
        // Closing tags belong to their own element (formerly a known limitation: the last descendant won).
        Eq("caret at closing </Page> -> the Page", "0", m.PathForOffset(text.LastIndexOf("</Page>", StringComparison.Ordinal)));
        Eq("caret inside </Grid> -> the Grid", "0.0.2", m.PathForOffset(text.IndexOf("</Grid>", StringComparison.Ordinal) + 3));
        Eq("caret inside </StackPanel> -> the StackPanel", "0.0", m.PathForOffset(text.IndexOf("</StackPanel>", StringComparison.Ordinal) + 3));
        Eq("caret just after '/>' -> that element", "0.0.0", m.PathForOffset(btnTag + "<Button Content=\"A\"/>".Length));
        Eq("caret in whitespace between children -> the parent", "0.0.2", m.PathForOffset(text.IndexOf("</Grid>", StringComparison.Ordinal) - 2));
        Check("caret past end -> null", m.PathForOffset(text.Length + 10) == null);
        Check("caret in trailing whitespace after the root -> null", XamlSourceMap.Build(text + "\n\n")!.PathForOffset(text.Length + 1) == null);

        // Tokenizer edge cases: '>' and '/>' inside quoted values, comments and CDATA must not end a tag.
        var tricky = "<Page " + Pns + "><StackPanel Tag=\"a>b/>\"><!-- <Button/> --><TextBlock><![CDATA[ </StackPanel> ]]></TextBlock>" +
                     "<Button Tag='x>'/></StackPanel></Page>";
        var mt = XamlSourceMap.Build(tricky);
        mt!.TryGetSpan("0.0", out var spS, out var spE);
        Eq("quoted '>' / comment / CDATA: StackPanel span is exact", tricky.IndexOf("</Page>", StringComparison.Ordinal), spE);
        Eq("quoted '>' / comment / CDATA: Button mapped", "0=Page, 0.0=StackPanel, 0.0.0=TextBlock, 0.0.1=Button", Names(mt));
        Eq("caret on </StackPanel> after tricky content -> StackPanel", "0.0", mt.PathForOffset(tricky.IndexOf("</StackPanel></Page>", StringComparison.Ordinal) + 2));

        // DOCTYPE with an internal subset is skipped; an entity that expands to markup makes the scan disagree
        // with the parser, so the map falls back to next-sibling ends (still usable, never wrong-element).
        var dtd = "<!DOCTYPE Page [ <!ENTITY e \"<Button/>\"> ]>\n<Page " + Pns + "><StackPanel>&e;<TextBlock/></StackPanel></Page>";
        var md = XamlSourceMap.Build(dtd);
        if (md != null)
        {
            Check("DTD entity markup: falls back, root still maps", md.HasContent && md.TryGetSpan("0", out _, out _));
        }
        else
        {
            Check("DTD entity markup: parser refused (no map)", true);
        }

        // CRLF line endings, tabs and non-BMP characters must not skew offsets.
        var crlf = text.Replace("\n", "\r\n").Replace("    <Button Content=\"A\"/>", "\t\t<Button Content=\"😀😀\"/>  <CheckBox/>");
        var mc = XamlSourceMap.Build(crlf);
        SpanStartsAt("CRLF: Rectangle span exact", mc, crlf, "0.0.3.1.0", "<Rectangle"); // CheckBox inserted below shifts siblings
        SpanStartsAt("tabs: Button span exact", mc, crlf, "0.0.0", "<Button");
        SpanStartsAt("emoji earlier on the line: CheckBox span exact", mc, crlf, "0.0.1", "<CheckBox");

        // Custom content property (bug D1): only the reported property is walked; CommandBar.Content is not.
        var cb =
            "<Page " + Pns + "><CommandBar>" +
            "<CommandBar.Content><TextBlock/></CommandBar.Content>" +
            "<CommandBar.PrimaryCommands><AppBarButton/><AppBarSeparator/></CommandBar.PrimaryCommands>" +
            "</CommandBar></Page>";
        Eq("custom content prop: only the reported property walked", "0=Page, 0.0=CommandBar, 0.0.0=AppBarButton, 0.0.1=AppBarSeparator",
            Names(XamlSourceMap.Build(cb, new Dictionary<string, string> { ["CommandBar"] = "PrimaryCommands" })));
        Eq("no content map: standard Content walked", "0=Page, 0.0=CommandBar, 0.0.0=TextBlock",
            Names(XamlSourceMap.Build(cb)));

        // A custom control in a user namespace sharing a text-element name is NOT skipped.
        var custom = "<Page " + Pns + " xmlns:my=\"using:My\"><StackPanel><my:Run/><Run/><Button/></StackPanel></Page>";
        Eq("custom element named Run is kept", "0=Page, 0.0=StackPanel, 0.0.0=Run, 0.0.1=Button", Names(XamlSourceMap.Build(custom)));

        // clr-namespace:System with an assembly qualifier is still a System primitive.
        var clr = "<Page " + Pns + " xmlns:s=\"clr-namespace:System;assembly=mscorlib\"><StackPanel><s:String>x</s:String><Button/></StackPanel></Page>";
        Eq("clr-namespace:System primitive skipped", "0=Page, 0.0=StackPanel, 0.0.0=Button", Names(XamlSourceMap.Build(clr)));

        var single = "<Grid " + Pns + "/>";
        var ms = XamlSourceMap.Build(single);
        Check("self-closing root maps to path 0 spanning the text",
            ms != null && ms.TryGetSpan("0", out var s0, out var e0) && s0 == 0 && e0 == single.Length && ms.Elements.Count == 1);
    }
}
