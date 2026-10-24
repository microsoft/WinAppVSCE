using System.Xml.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Surface
{
    /// <summary>Test stand-in for the Surface's App.Log (SampleListFiller logs through it).</summary>
    internal static class App
    {
        public static void Log(string message)
        {
        }
    }
}

namespace Surface.Tests.Fixtures
{
    // Custom roots: XamlReader.Load can't construct any non-framework root, so Rule 1b rebases them.
    public class CustomPage : Page
    {
        public string? PageOnlyProp { get; set; }
    }

    public abstract class AbstractPage : Page
    {
    }

    public class CustomUserControl : UserControl
    {
    }

    // A resolvable custom control: its "Closed" is a PROPERTY (kept), its "Pinged" is an EVENT (stripped).
    public class Widget : Control
    {
        public string? Closed { get; set; }

        public event EventHandler? Pinged;

        internal void Raise() => Pinged?.Invoke(this, EventArgs.Empty);
    }

    // SampleObjects fixtures: app-style models built by reflection.
    public enum FlightState { Healthy, Attention, Maintenance }

    public class Plane
    {
        public string Tail { get; init; } = string.Empty;
        public int Cycles { get; init; }
        public string NextCheck { get; init; } = "A-check";
        public FlightState State { get; set; }
        public DateTime LastSeen { get; set; }
        public Engine? Engine { get; set; }
        public List<string> Notes { get; set; } = null!;
        public System.Collections.ObjectModel.ObservableCollection<Engine> Spares { get; } = new();
        public bool IsHero => Tail == "X";
    }

    public class Engine
    {
        public Engine(string serial, double hours) { Serial = serial; Hours = hours; }
        public string Serial { get; }
        public double Hours { get; }
    }

    public class Exploding
    {
        public Exploding() => throw new InvalidOperationException("boom");
    }

    public class Card
    {
        public List<string> Lines { get; set; } = new();
    }

    public class Member
    {
        public string Name { get; set; } = "";
    }

    /// <summary>A group that is its own item list, like <c>class Grouping : List&lt;Person&gt;</c>.</summary>
    public class MemberGroup : List<Member>
    {
        public string Key { get; set; } = "";
    }

    /// <summary>A group whose items sit under an ItemsPath property.</summary>
    public class Team
    {
        public string Key { get; set; } = "";
        public List<Member> Members { get; set; } = new();
    }

    public class SeriesFilledChart
    {
        public List<double> Series { get; } = new() { 1, 2, 3 };
        public List<double> ItemsSource { get; set; } = new();
    }

    public class EmptyChart
    {
        public List<double>? Series { get; set; }
        public double[] Values { get; set; } = Array.Empty<double>();
    }

    public class NotAChart
    {
        public string Title { get; set; } = "";
    }
}

namespace Surface.Tests
{
    /// <summary>
    /// Rule-by-rule tests for <see cref="XamlCleaner"/>. Each check feeds a small XAML document through
    /// <c>Clean</c> and asserts on the re-parsed output. Prints PASS/FAIL per check and a
    /// "===== CLEANER: N passed, M failed =====" summary; exit code 0 only when every check passes.
    /// </summary>
    internal static class Program
    {
        private const string PresNs = "http://schemas.microsoft.com/winfx/2006/xaml/presentation";
        private const string XNs = "http://schemas.microsoft.com/winfx/2006/xaml";
        private static readonly XNamespace Pres = PresNs;
        private static readonly XNamespace X = XNs;

        private const string Ns =
            "xmlns=\"" + PresNs + "\" xmlns:x=\"" + XNs + "\" " +
            "xmlns:d=\"http://schemas.microsoft.com/expression/blend/2008\" " +
            "xmlns:mc=\"http://schemas.openxmlformats.org/markup-compatibility/2006\" mc:Ignorable=\"d\" " +
            "xmlns:f=\"using:Surface.Tests.Fixtures\" xmlns:good=\"using:Good\" xmlns:bad=\"using:Bad\"";

        private static int s_pass;
        private static int s_fail;
        private static readonly List<string> s_failures = new();

        private static int Main()
        {
            Run("Robustness", Robustness);
            Run("R1 x:Class", Rule1);
            Run("R1b root rebase", Rule1b);
            Run("R2 x:Bind", Rule2);
            Run("R2 sample data", Rule2SampleData);
            Run("R2 sample data (source-typed)", SampleDataTyped);
            Run("R2 sample data (code-behind is add-only)", SampleDataCodeBehindAddOnly);
            Run("R2 sample data (icon glyphs)", SampleDataGlyphs);
            Run("R2 sample data (typed objects)", SampleDataObjects);
            Run("R2 sample data (charts)", SampleDataCharts);
            Run("R2 sample data (initial state, functions, list forms)", SampleDataStates);
            Run("R2 sample data (grouped lists, type model, chart helpers)", SampleDataGroupsAndModel);
            Run("R2 TryParseBind/BindPathLabel", BindParsing);
            Run("R3 x: directives", Rule3);
            Run("R4 events", Rule4);
            Run("R5 design namespaces", Rule5);
            Run("R6 resources", Rule6);
            Run("R7 unmapped custom types", Rule7);
            Run("R7 WinUI types newer than the host", Rule7NewerFrameworkTypes);
            Run("R7a/b/c attached, extensions, converters", Rule7abc);
            Run("DTD grammar", DtdGrammar);
            Run("DTD source paths + file prep", DtdPaths);
            Run("XAML error text", ErrorText);
            Run("XAML error positions map to the user's file", ErrorPositionMapping);
            Run("Zoom anchoring", ZoomAnchoring);

            foreach (var f in s_failures)
            {
                Console.WriteLine("  FAILED: " + f);
            }
            Console.WriteLine($"===== CLEANER: {s_pass} passed, {s_fail} failed =====");
            return s_fail == 0 ? 0 : 1;
        }

        // ------------------------------------------------------------ harness

        private static void ZoomAnchoring()
        {
            // 400px page in an 800px viewport at 50%: board is 200px, centred with 300px padding, offset 0.
            // Zooming in to 400% about the viewport centre must keep the page centre under it (not jump past it).
            double off = ZoomMath.AnchoredOffset(0, 800, 400, 0.5, 4.0, 400);
            Check("zoom in from centred: page centre stays at the anchor", Math.Abs(off - (200 * 4.0 - 400)) < 0.001, off.ToString());

            // Old code computed (0 + 400) / 0.5 * 4 - 400 = 2800 -> past the 800px max extent; must clamp in range.
            Check("zoom in from centred: offset within the scrollable range", off >= 0 && off <= 400 * 4.0 - 800, off.ToString());

            // Board smaller than the viewport after the zoom: it is centred, offset is 0.
            Check("zoom out to smaller-than-viewport: offset 0", ZoomMath.AnchoredOffset(500, 800, 400, 4.0, 1.0, 400) == 0);

            // Large board, anchor at a content point: the point stays under the anchor.
            double o2 = ZoomMath.AnchoredOffset(100, 800, 1000, 1.0, 2.0, 200);
            Check("large board: content under the anchor is preserved", Math.Abs(((o2 + 200) / 2.0) - 300) < 0.001, o2.ToString());

            // Reset (top-left anchor) from a centred small board: page starts at the left edge.
            Check("reset at top-left: offset 0", ZoomMath.AnchoredOffset(0, 800, 1000, 0.5, 1.0, 0) == 0);

            // Anchor in the padding pins the nearest page edge rather than producing a negative content point.
            double o3 = ZoomMath.AnchoredOffset(0, 800, 400, 0.5, 4.0, 0);
            Check("anchor in padding: clamps to the page edge", o3 == 0, o3.ToString());

            Check("degenerate viewport: 0", ZoomMath.AnchoredOffset(10, 0, 400, 1, 2, 0) == 0);
        }

        private static void ErrorText()
        {
            const string Opaque = "XamlParseException: " + XamlErrorText.OpaqueWinUiText;
            Check("opaque: placeholder + type name", XamlErrorText.IsOpaque(Opaque));
            Check("opaque: with position suffix and chain", XamlErrorText.IsOpaque(Opaque + " [Line: 3 Position: 13] -> COMException: " + XamlErrorText.OpaqueWinUiText));
            Check("opaque: empty", XamlErrorText.IsOpaque(""));
            const string ChartsPage = "<Page xmlns:charts=\"using:Microsoft.UI.Xaml.Controls.Charts\"><charts:Chart /></Page>";
            const string MissingChartsKey = "XamlParseException: Cannot find a Resource with the Name/Key ChartsControlBackgroundBrush [Line: 1 Position: 70]";
            var hint = XamlErrorText.ChartsHint(MissingChartsKey, ChartsPage, chartsResourcesLoaded: false);
            Check("charts hint: names the missing key and the fix", hint is not null && hint.Contains("ChartsControlBackgroundBrush") && hint.Contains("XamlChartsResources"), hint);
            Check("charts hint: opaque failure on a charts page", XamlErrorText.ChartsHint(Opaque, ChartsPage, false)?.Contains("XamlChartsResources") == true);
            Check("charts hint: none when styles loaded", XamlErrorText.ChartsHint(MissingChartsKey, ChartsPage, true) is null);
            Check("charts hint: none without charts", XamlErrorText.ChartsHint(MissingChartsKey, "<Page><Grid /></Page>", false) is null);
            Check("charts hint: none for an unrelated real error", XamlErrorText.ChartsHint("XamlParseException: The property 'Foo' was not found in type 'Chart'.", ChartsPage, false) is null);
            Check("not opaque: real WinUI text kept", !XamlErrorText.IsOpaque("XamlParseException: Cannot find a Resource with the Name/Key Foo [Line: 2 Position: 4]"));
            Check("opaque: bare wfc code (as WinUI really reports)", XamlErrorText.IsOpaque(Opaque + "\r\n\r\nwfc: element type match [Line: 5 Position: 5]"));
            Eq("informative: real text extracted from the WinUI shape", "The property 'NotAProperty' was not found in type 'Button'.",
                XamlErrorText.Informative(Opaque + "\r\n\r\nThe property 'NotAProperty' was not found in type 'Button'. [Line: 3 Position: 13]"));

            var unclosed = "<Page>\n  <StackPanel>\n    <TextBlock Text=\"a\"/>\n    <Border>\n  </StackPanel>\n</Page>";
            var (m, l, c) = XamlErrorText.Describe(unclosed, 5, 5);
            Check("malformed XML: uses the XML parser's message", m.StartsWith("XML error: ", StringComparison.Ordinal) && m.Contains("Border") && m.Contains("StackPanel"), m);
            Check("malformed XML: no duplicate position suffix", !m.Contains("Line 5, position"), m);
            Check("malformed XML: position kept", l == 5 && c == 5, $"{l},{c}");
            Check("MalformedXml: null for well-formed", XamlErrorText.MalformedXml("<Page>\n<Grid/>\n</Page>") is null);
            const string StaleKey = Opaque + "\r\n\r\nCannot find a Resource with the Name/Key NoSuchBrushKey [Line: 3 Position: 13]";
            Check("stale: key absent from the document -> not informative",
                XamlErrorText.Informative(StaleKey, "<Page>\n<Button Width=\"wide\"/>\n</Page>") is null);
            Check("current: key present in the document -> kept",
                XamlErrorText.Informative(StaleKey, "<Page>\n<Border Background=\"{StaticResource NoSuchBrushKey}\"/>\n</Page>") is not null);
            const string StaleProp = Opaque + "\r\n\r\nThe property 'NotAProperty' was not found in type 'Microsoft.UI.Xaml.Controls.Button'. [Line: 3 Position: 13]";
            Check("current: quoted names (short type name) present -> kept",
                XamlErrorText.Informative(StaleProp, "<Page>\n<Button NotAProperty=\"1\"/>\n</Page>") is not null);
            Check("stale: quoted property absent -> not informative",
                XamlErrorText.Informative(StaleProp, "<Page>\n<Button Width=\"wide\"/>\n</Page>") is null);
            Check("MalformedXml: message and position", XamlErrorText.MalformedXml(unclosed) is var (mm, ml, _)
                && mm.StartsWith("XML error: ", StringComparison.Ordinal) && ml == 5, $"{XamlErrorText.MalformedXml(unclosed)}");

            var badValue = "<Page>\n  <StackPanel>\n    <Button Width=\"wide\" Content=\"x\"/>\n  </StackPanel>\n</Page>";
            (m, l, c) = XamlErrorText.Describe(badValue, 3, 13);
            Eq("bad value: names attribute, value and element", "WinUI couldn't set Width=\"wide\" on <Button>. Check the property name and value.", m);
            Check("bad value: position unchanged", l == 3 && c == 13, $"{l},{c}");

            var attached = "<Page>\n  <Grid>\n    <Button Grid.Row='x'/>\n  </Grid>\n</Page>";
            Eq("attached property, single quotes", "WinUI couldn't set Grid.Row=\"x\" on <Button>. Check the property name and value.",
                XamlErrorText.Describe(attached, 3, 13).Message);

            var crlf = badValue.Replace("\n", "\r\n");
            Eq("CRLF line endings", "WinUI couldn't set Width=\"wide\" on <Button>. Check the property name and value.",
                XamlErrorText.Describe(crlf, 3, 13).Message);

            var unknownEl = "<Page>\n  <StackPanel>\n    <Buton/>\n  </StackPanel>\n</Page>";
            Eq("unknown element at the name", "WinUI couldn't create <Buton>. Check the element name and that its namespace is mapped.",
                XamlErrorText.Describe(unknownEl, 3, 6).Message);
            Eq("unknown element at the '<'", "WinUI couldn't create <Buton>. Check the element name and that its namespace is mapped.",
                XamlErrorText.Describe(unknownEl, 3, 5).Message);
            Eq("prefixed element", "WinUI couldn't create <local:Thing>. Check the element name and that its namespace is mapped.",
                XamlErrorText.Describe("<Page xmlns:local=\"using:App\">\n<local:Thing/>\n</Page>", 2, 2).Message);
            Check("undeclared prefix is an XML error", XamlErrorText.Describe("<Page>\n<local:Thing/>\n</Page>", 2, 2).Message.Contains("'local' is an undeclared prefix"));

            var longValue = "<Page>\n<Button Tag=\"" + new string('v', 200) + "\"/>\n</Page>";
            var lm = XamlErrorText.Describe(longValue, 2, 9).Message;
            Check("long value is truncated", lm.Length < 160 && lm.Contains("…"), lm);

            const string Fallback = "WinUI couldn't load this XAML and didn't report why.";
            Eq("no position -> generic", Fallback, XamlErrorText.Describe(badValue, null, null).Message);
            Eq("position in whitespace -> generic", Fallback, XamlErrorText.Describe(badValue, 3, 2).Message);
            Eq("position past the line end -> generic", Fallback, XamlErrorText.Describe(badValue, 3, 200).Message);
            Eq("line past the end -> generic", Fallback, XamlErrorText.Describe(badValue, 99, 1).Message);
            Eq("null xaml -> generic", Fallback, XamlErrorText.Describe(null, 1, 1).Message);
        }

        private static void ErrorPositionMapping()
        {
            const string raw =
                "<Page xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\"\n" +
                "      xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\"\n" +
                "      xmlns:d=\"http://schemas.microsoft.com/expression/blend/2008\">\n" +
                "  <d:DesignData>\n" +
                "    <TextBlock />\n" +
                "  </d:DesignData>\n" +
                "  <StackPanel>\n" +
                "    <Button Content=\"A\" />\n" +
                "    <Button x:Name=\"B\" Content=\"B\" Width=\"oops\" />\n" +
                "  </StackPanel>\n" +
                "</Page>";
            const string cleaned =
                "<Page xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\">\n" +
                "  <StackPanel>\n" +
                "    <Button Content=\"A\" />\n" +
                "    <Button x:Name=\"B\" Content=\"B\" Width=\"oops\" />\n" +
                "  </StackPanel>\n" +
                "</Page>";

            // Attribute "Width" on cleaned line 4 -> raw line 9, at the same attribute.
            int col = cleaned.Split('\n')[3].IndexOf("Width", StringComparison.Ordinal) + 1;
            var attr = XamlErrorText.MapToSource(cleaned, raw, 4, col);
            Eq("attribute maps to the user's line", "9", attr?.Line.ToString());
            Eq("attribute maps to the user's column", (raw.Split('\n')[8].IndexOf("Width", StringComparison.Ordinal) + 1).ToString(), attr?.Column.ToString());
            Eq("mapped position still describes the attribute",
                XamlErrorText.DescribeAt(cleaned, 4, col), XamlErrorText.DescribeAt(raw, attr!.Value.Line, attr.Value.Column));

            // The first Button (no x:Name) is found by its attributes and order.
            var first = XamlErrorText.MapToSource(cleaned, raw, 3, 6);
            Eq("element maps to the user's line", "8", first?.Line.ToString());

            // A column past the end of the line (WinUI does this) still lands on that line's element.
            Eq("column past the line end clamps", "7", XamlErrorText.MapToSource(cleaned, raw, 2, 200)?.Line.ToString());

            Check("unchanged document -> no mapping", XamlErrorText.MapToSource(raw, raw, 9, 5) is null);
            Check("malformed cleaned text -> no mapping", XamlErrorText.MapToSource("<Page>", raw, 1, 1) is null);

            // A placeholder Border with no counterpart falls back to its parent's position.
            const string withPlaceholder =
                "<Page xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\">\n" +
                "  <Grid x:Name=\"G\" xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\">\n" +
                "    <Border Tag=\"__wxp_placeholder\"><TextBlock Text=\"Chart\" /></Border>\n" +
                "  </Grid>\n" +
                "</Page>";
            const string rawWithCustom =
                "<Page xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" xmlns:local=\"using:App\">\n" +
                "\n" +
                "\n" +
                "  <Grid x:Name=\"G\" xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\">\n" +
                "    <local:Chart />\n" +
                "  </Grid>\n" +
                "</Page>";
            Eq("no counterpart -> nearest matching ancestor", "4", XamlErrorText.MapToSource(withPlaceholder, rawWithCustom, 3, 6)?.Line.ToString());
        }

        private static void Rule7NewerFrameworkTypes()
        {
            var raw = Doc(
                "<StackPanel x:Name=\"Host\">" +
                "<ItemsView x:Name=\"IV\"><ItemsView.Layout><FlowLayout MinItemSpacing=\"12\" /></ItemsView.Layout></ItemsView>" +
                "<ItemsRepeater x:Name=\"IR\"><ItemsRepeater.Layout><StackLayout /></ItemsRepeater.Layout></ItemsRepeater>" +
                "<FlowLayout x:Name=\"Direct\" Grid.Row=\"1\" />" +
                "<ContentControl><ContentControl.Content><FlowLayout x:Name=\"InContent\" /></ContentControl.Content></ContentControl>" +
                "<Grid><Grid.ChildrenTransitions><TransitionCollection><FlowLayout /><EntranceThemeTransition /></TransitionCollection></Grid.ChildrenTransitions></Grid>" +
                "<StackPanel.Resources><FlowLayout x:Key=\"SharedLayout\" /></StackPanel.Resources>" +
                "<good:FlowLayout x:Name=\"Custom\" />" +
                "</StackPanel>");
            var missing = new HashSet<string> { "FlowLayout" };
            var r = CleanRoot(raw, provider: _ => true, newer: missing);

            Check("typed slot: missing type removed with its empty property element",
                First(Named(r, "IV")!, "ItemsView.Layout") is null && !Named(r, "IV")!.Descendants().Any());
            Check("other layouts untouched", First(Named(r, "IR")!, "StackLayout") is not null);
            Eq("visual position -> placeholder", Pres + "Border", Named(r, "Direct")?.Name.ToString());
            Eq("placeholder keeps attached layout", "1", Attr(Named(r, "Direct"), "Grid.Row"));
            Eq("content slot -> placeholder", Pres + "Border", Named(r, "InContent")?.Name.ToString());
            var transitions = First(r, "TransitionCollection")!;
            Eq("collection: only the missing entry removed", "EntranceThemeTransition", string.Join(",", transitions.Elements().Select(e => e.Name.LocalName)));
            Check("resource entry dropped", !r.Descendants().Any(e => e.Attribute(X + "Key")?.Value == "SharedLayout"));
            Eq("same name in a custom xmlns untouched", "{using:Good}FlowLayout", Named(r, "Custom")?.Name.ToString());

            var none = CleanRoot(raw, provider: _ => true);
            Check("no missing set: framework elements untouched", none.Descendants().Count(e => e.Name == Pres + "FlowLayout") == 5, none.Descendants().Count(e => e.Name == Pres + "FlowLayout").ToString());
        }

        // ------------------------------------------------------------ harness

        private static void Run(string group, Action body)
        {
            Console.WriteLine($"--- {group}");
            try
            {
                body();
            }
            catch (Exception ex)
            {
                Check($"{group}: no unexpected exception", false, ex.ToString());
            }
        }

        private static void Check(string name, bool ok, string? detail = null)
        {
            if (ok)
            {
                s_pass++;
                Console.WriteLine("PASS " + name);
            }
            else
            {
                s_fail++;
                var line = detail is null ? name : $"{name} ({detail})";
                s_failures.Add(line);
                Console.WriteLine("FAIL " + line);
            }
        }

        private static void Eq(string name, string? expected, string? actual) =>
            Check(name, string.Equals(expected, actual, StringComparison.Ordinal), $"expected '{expected}', got '{actual}'");

        private static void Eq(string name, XName expected, string? actual) => Eq(name, expected.ToString(), actual);

        private static string Doc(string inner, string root = "Page", string rootAttrs = "") =>
            $"<{root} {Ns} {rootAttrs}>{inner}</{root}>";

        private static XElement CleanRoot(
            string xaml,
            Func<string, bool>? known = null,
            Func<string, bool>? provider = null,
            ISet<string>? force = null,
            bool sample = false,
            ISet<string>? missing = null,
            SampleTypeModel? types = null,
            ISet<string>? newer = null) =>
            XDocument.Parse(XamlCleaner.Clean(xaml, known, provider, force, sample, missing, null, types, null, newer)).Root!;

        private static XElement? First(XElement root, string localName) =>
            root.DescendantsAndSelf().FirstOrDefault(e => e.Name.LocalName == localName);

        private static XElement? Named(XElement root, string xName) =>
            root.DescendantsAndSelf().FirstOrDefault(e => (string?)e.Attribute(X + "Name") == xName);

        private static string? Attr(XElement? el, string name) => el?.Attribute(name)?.Value;

        // Whitespace inside a markup extension is insignificant to XamlReader; compare it collapsed.
        private static string? Squash(string? s) =>
            s is null ? null : System.Text.RegularExpressions.Regex.Replace(s, @"\s+", " ");

        // ------------------------------------------------------------ robustness

        private static void Robustness()
        {
            Check("null in -> null out", XamlCleaner.Clean(null!) is null);
            Eq("empty in -> empty out", "", XamlCleaner.Clean(""));
            Eq("whitespace in -> unchanged", "  \n ", XamlCleaner.Clean("  \n "));
            const string malformed = "<Page xmlns=\"" + PresNs + "\"><Grid></Page>";
            Eq("malformed XML -> original returned", malformed, XamlCleaner.Clean(malformed));
            const string undeclared = "<Page><x:Foo /></Page>";
            Eq("undeclared prefix -> original returned", undeclared, XamlCleaner.Clean(undeclared));

            const string plain = "<Grid xmlns=\"" + PresNs + "\"><TextBlock Text=\"Hi\" /></Grid>";
            var once = XamlCleaner.Clean(plain);
            Check("framework-only document is semantically unchanged",
                XNode.DeepEquals(XElement.Parse(plain), XElement.Parse(once)), once);

            var busy = Doc(
                "<Grid x:Name=\"G\" Loaded=\"OnLoaded\" d:Background=\"Red\">" +
                "<TextBlock Text=\"{x:Bind Vm.Name}\" Foreground=\"{StaticResource Missing}\" x:Uid=\"U\" />" +
                "<bad:Thing Grid.Row=\"1\" /></Grid>", rootAttrs: "x:Class=\"A.B\" d:DesignWidth=\"400\"");
            Func<string, bool> provider = n => n.StartsWith("Good.", StringComparison.Ordinal);
            var c1 = XamlCleaner.Clean(busy, providerMapsFullName: provider, sampleData: true);
            var c2 = XamlCleaner.Clean(c1, providerMapsFullName: provider, sampleData: true);
            Eq("idempotent: cleaning twice == cleaning once", c1, c2);
        }

        // ------------------------------------------------------------ R1

        private static void Rule1()
        {
            var r = CleanRoot(Doc(
                "<Page.Resources><ResourceDictionary x:Class=\"App.Inner\" /></Page.Resources>" +
                "<Grid x:Name=\"Root\" />", rootAttrs: "x:Class=\"App.MainPage\""));
            Check("x:Class removed from root", r.Attribute(X + "Class") is null);
            Check("x:Class removed from nested element", First(r, "ResourceDictionary")?.Attribute(X + "Class") is null);
            Check("x:Name kept", Named(r, "Root") is not null);
        }

        // ------------------------------------------------------------ R1b

        private static void Rule1b()
        {
            var r = CleanRoot(Doc(
                "<f:CustomPage.Resources><SolidColorBrush x:Key=\"B\" Color=\"Red\" /></f:CustomPage.Resources>" +
                "<Grid />",
                root: "f:CustomPage",
                rootAttrs: "x:Class=\"App.P\" PageOnlyProp=\"x\" Width=\"300\" Grid.Row=\"1\" f:Widget.Closed=\"y\""));
            Eq("custom concrete root -> Page", Pres + "Page", r.Name.ToString());
            Check("root property element rewritten to Page.Resources", r.Elements(Pres + "Page.Resources").Any(),
                string.Join(",", r.Elements().Select(e => e.Name.LocalName)));
            Check("custom-only root property dropped", r.Attribute("PageOnlyProp") is null);
            Eq("inherited framework property kept", "300", Attr(r, "Width"));
            Eq("framework attached property kept", "1", Attr(r, "Grid.Row"));
            Check("custom-namespaced root attribute dropped",
                !r.Attributes().Any(a => a.Name.NamespaceName == "using:Surface.Tests.Fixtures"));
            Check("children preserved", First(r, "Grid") is not null);

            Eq("abstract custom root -> Page", Pres + "Page", CleanRoot(Doc("", root: "f:AbstractPage")).Name.ToString());
            Eq("custom UserControl root -> UserControl", Pres + "UserControl", CleanRoot(Doc("", root: "f:CustomUserControl")).Name.ToString());
            Eq("framework root untouched", Pres + "UserControl", CleanRoot(Doc("", root: "UserControl")).Name.ToString());
            Eq("unresolvable custom root untouched", "{using:Bad}Nowhere", CleanRoot(Doc("", root: "bad:Nowhere")).Name.ToString());
        }

        // ------------------------------------------------------------ R2

        private static void Rule2()
        {
            var r = CleanRoot(Doc(
                "<StackPanel xmlns:xx=\"" + XNs + "\" xmlns:notx=\"using:Other\">" +
                "<TextBlock x:Name=\"A\" Text=\"{x:Bind Vm.Name, Mode=OneWay}\" />" +
                "<TextBlock x:Name=\"B\" Text=\"{Binding Name}\" />" +
                "<TextBlock x:Name=\"C\" Text=\"{xx:Bind Vm.Name}\" />" +
                "<TextBlock x:Name=\"D\" Tag=\"{notx:Bind Foo}\" />" +
                "<TextBlock x:Name=\"E\" Text=\"  {x:Bind Vm.Name}\" />" +
                "<ListView x:Name=\"L\" ItemsSource=\"{x:Bind Items}\" />" +
                "</StackPanel>"));
            Check("{x:Bind} dropped", Attr(Named(r, "A"), "Text") is null);
            Eq("{Binding} kept", "{Binding Name}", Attr(Named(r, "B"), "Text"));
            Check("{x:Bind} via alias prefix dropped", Attr(Named(r, "C"), "Text") is null);
            Eq("{prefix:Bind} in another namespace kept", "{notx:Bind Foo}", Attr(Named(r, "D"), "Tag"));
            Check("leading whitespace before {x:Bind} still dropped", Attr(Named(r, "E"), "Text") is null);
            Check("sample data off: no list marker", Attr(Named(r, "L"), "Tag") is null && Attr(Named(r, "L"), "ItemsSource") is null);
        }

        private static void Rule2SampleData()
        {
            var r = CleanRoot(Doc(
                "<StackPanel>" +
                "<TextBlock x:Name=\"Path\" Text=\"{x:Bind ViewModel.User.Name, Mode=OneWay}\" />" +
                "<TextBlock x:Name=\"Fallback\" Text=\"{x:Bind Name, FallbackValue='Hello, world'}\" />" +
                "<TextBlock x:Name=\"NullValue\" Text=\"{x:Bind Name, TargetNullValue=Nothing}\" />" +
                "<TextBlock x:Name=\"Func\" Text=\"{x:Bind local:Fmt.Format(Value, 'x'), Mode=OneWay}\" />" +
                "<Button x:Name=\"Btn\" Content=\"{x:Bind Label}\" />" +
                "<TextBlock x:Name=\"Width\" Width=\"{x:Bind W}\" />" +
                "<TextBlock x:Name=\"DWins\" Text=\"{x:Bind Name}\" d:Text=\"Design value\" />" +
                "<TextBlock x:Name=\"Unparsable\" Text=\"{x:Bind A, B}\" />" +
                "<ListView x:Name=\"List\" ItemsSource=\"{x:Bind ViewModel.Orders}\" />" +
                "<ListView x:Name=\"Tagged\" Tag=\"Mine\" ItemsSource=\"{x:Bind Orders}\" />" +
                "<Border x:Name=\"NoItems\" Tag=\"{x:Bind T}\" />" +
                "</StackPanel>"), sample: true);
            Eq("untyped path -> humanized last segment", "Name", Attr(Named(r, "Path"), "Text"));
            Eq("FallbackValue wins (single quotes stripped)", "Hello, world", Attr(Named(r, "Fallback"), "Text"));
            Eq("TargetNullValue used", "Nothing", Attr(Named(r, "NullValue"), "Text"));
            Eq("formatter function -> named from its argument", "Value", Attr(Named(r, "Func"), "Text"));
            Eq("object-typed Content gets a sample", "Label", Attr(Named(r, "Btn"), "Content"));
            Eq("Width gets a sample size", "120", Attr(Named(r, "Width"), "Width"));
            Eq("d: value wins over x:Bind placeholder", "Design value", Attr(Named(r, "DWins"), "Text"));
            Check("unparsable binding (positional after first) dropped", Attr(Named(r, "Unparsable"), "Text") is null);
            Check("bound list: ItemsSource dropped", Attr(Named(r, "List"), "ItemsSource") is null);
            Eq("bound list: sample marker with rows in Tag", SampleListFiller.TagPrefix + "Orders|[\"Order\",\"Order 2\",\"Order 3\"]", Attr(Named(r, "List"), "Tag"));
            Eq("bound list with existing Tag: Tag untouched", "Mine", Attr(Named(r, "Tagged"), "Tag"));
            Check("x:Bind Tag on non-list just dropped", Attr(Named(r, "NoItems"), "Tag") is null);
        }

        private static void SampleDataTyped()
        {
            var types = SampleTypeModel.FromSources(
                "using System; using System.Collections.ObjectModel;\n" +
                "namespace App1 {\n" +
                "public sealed partial class MainPage {\n" +
                "  public MainViewModel ViewModel { get; } = new();\n" +
                "  public MainPage() { Greeting.Text = $\"Hello, {ViewModel.Count} orders\"; }\n" +
                "  private void OnClick(object sender, RoutedEventArgs e) { Status.Text = \"Clicked\"; }\n" +
                "}\n" +
                "public class MainViewModel { public int Count { get; set; } public DateTime Due { get; set; } public bool IsReady { get; set; }\n" +
                "  public ObservableCollection<Order> Orders { get; } = new(); }\n" +
                "public class Order { public string Customer { get; set; } public decimal Total { get; set; } public OrderState State { get; set; } }\n" +
                "public enum OrderState { InProgress, Done }\n" +
                "}");
            var r = CleanRoot(Doc(
                "<StackPanel>" +
                "<TextBlock x:Name=\"Greeting\" />" +
                "<TextBlock x:Name=\"Status\" />" +
                "<TextBlock x:Name=\"Kept\" Text=\"Markup wins\" />" +
                "<TextBlock x:Name=\"Num\" Text=\"{x:Bind ViewModel.Count}\" />" +
                "<TextBlock x:Name=\"When\" Text=\"{x:Bind ViewModel.Due}\" />" +
                "<TextBlock x:Name=\"Ref\" Text=\"{x:Bind Greeting.Text}\" />" +
                "<ListView x:Name=\"List\" ItemsSource=\"{x:Bind ViewModel.Orders}\"><ListView.ItemTemplate>" +
                "<DataTemplate x:DataType=\"local:Order\"><StackPanel>" +
                "<TextBlock x:Name=\"Cust\" Text=\"{x:Bind Customer}\" /><TextBlock x:Name=\"St\" Text=\"{x:Bind State}\" />" +
                "</StackPanel></DataTemplate></ListView.ItemTemplate></ListView>" +
                "</StackPanel>",
                rootAttrs: "x:Class=\"App1.MainPage\" xmlns:local=\"using:App1\""), sample: true, types: types);
            Eq("code-behind interpolation typed", $"Hello, {SamplePlanner.IntByName("Count", 0):N0} orders", Attr(Named(r, "Greeting"), "Text"));
            Check("event-handler assignment skipped", Attr(Named(r, "Status"), "Text") is null, Attr(Named(r, "Status"), "Text"));
            Eq("markup value never overwritten", "Markup wins", Attr(Named(r, "Kept"), "Text"));
            Eq("int member -> number", SamplePlanner.IntByName("Count", 0).ToString("N0"), Attr(Named(r, "Num"), "Text"));
            Eq("DateTime member -> as the app shows it", SamplePlanner.SampleDate(0).ToString(System.Globalization.CultureInfo.CurrentCulture), Attr(Named(r, "When"), "Text"));
            Check("binding to a named element dropped", Attr(Named(r, "Ref"), "Text") is null, Attr(Named(r, "Ref"), "Text"));
            var tag = Attr(Named(r, "List"), "Tag") ?? "";
            Check("typed list rows carry template fields", tag.StartsWith(SampleListFiller.TagPrefix + "Orders|", StringComparison.Ordinal)
                && tag.Contains("\"Customer\":\"Avery Chen\"") && tag.Contains("\"State\":\"InProgress\""), tag);
            Check("template x:Bind -> {Binding} into the row", (Attr(Named(r, "Cust"), "Text") ?? "").StartsWith("{Binding Customer", StringComparison.Ordinal), Attr(Named(r, "Cust"), "Text"));

            var rows = SampleListFiller.BuildRows(tag[SampleListFiller.TagPrefix.Length..], 2, out var label);
            Eq("filler label", "Orders", label);
            Check("filler rows are dictionaries capped to max", rows.Count == 2 && rows[0] is Dictionary<string, object> d && d.ContainsKey("Customer"));
            var plain = SampleListFiller.BuildRows("Items", 3, out label);
            Check("bare label -> repeated strings", plain.Count == 3 && (string)plain[0] == "Items" && label == "Items");
        }

        private static void SampleDataCodeBehindAddOnly()
        {
            // The AI Dev Gallery APIPage shape: cards hidden in the "data is missing" branch of the load code.
            var types = SampleTypeModel.FromSources(
                "using System; using System.Collections.Generic; using Microsoft.UI.Xaml;\n" +
                "namespace App1 {\n" +
                "public sealed partial class ApiPage {\n" +
                "  public string Snippet { get; set; }\n" +
                "  public List<Item> Samples { get; } = new();\n" +
                "  public ApiPage() {\n" +
                "    if (Snippet != null) { CodeText.Text = Snippet; } else { CodeCard.Visibility = Visibility.Collapsed; }\n" +
                "    if (Samples.Count == 0) { EmptyState.Visibility = Visibility.Visible; }\n" +
                "    SaveButton.IsEnabled = false;\n" +
                "    Progress.Value = 100;\n" +
                "    Header.Text = \"Overview\";\n" +
                "    SampleList.ItemsSource = Samples;\n" +
                "  }\n" +
                "}\n" +
                "public class Item { public string Name { get; set; } }\n" +
                "}");
            var r = CleanRoot(Doc(
                "<StackPanel>" +
                "<TextBlock x:Name=\"Header\" />" +
                "<Border x:Name=\"CodeCard\"><TextBlock x:Name=\"CodeText\" /></Border>" +
                "<TextBlock x:Name=\"EmptyState\" Text=\"Nothing here\" Visibility=\"Collapsed\" />" +
                "<Button x:Name=\"SaveButton\" Content=\"Save\" />" +
                "<ProgressBar x:Name=\"Progress\" />" +
                "<ListView x:Name=\"SampleList\"><ListView.ItemTemplate>" +
                "<DataTemplate x:DataType=\"local:Item\"><TextBlock Text=\"{x:Bind Name}\" /></DataTemplate>" +
                "</ListView.ItemTemplate></ListView>" +
                "</StackPanel>",
                rootAttrs: "x:Class=\"App1.ApiPage\" xmlns:local=\"using:App1\""), sample: true, types: types);
            Check("collapsed in code-behind -> stays visible", Attr(Named(r, "CodeCard"), "Visibility") is null, Attr(Named(r, "CodeCard"), "Visibility"));
            Eq("visible in code-behind -> markup value kept", "Collapsed", Attr(Named(r, "EmptyState"), "Visibility"));
            Check("IsEnabled from code-behind not applied", Attr(Named(r, "SaveButton"), "IsEnabled") is null, Attr(Named(r, "SaveButton"), "IsEnabled"));
            Check("Value from code-behind not applied", Attr(Named(r, "Progress"), "Value") is null, Attr(Named(r, "Progress"), "Value"));
            Eq("text from code-behind still added", "Overview", Attr(Named(r, "Header"), "Text"));
            Check("text from a conditional branch still added", !string.IsNullOrEmpty(Attr(Named(r, "CodeText"), "Text")), Attr(Named(r, "CodeText"), "Text"));
            Check("ItemsSource from code-behind still filled", (Attr(Named(r, "SampleList"), "Tag") ?? "").StartsWith(SampleListFiller.TagPrefix, StringComparison.Ordinal), Attr(Named(r, "SampleList"), "Tag"));

            // WinUI Gallery SampleCodePresenter shape: code-behind sets Content on elements whose markup already
            // supplies it as a child, a property element, or text. Adding Content="…" too fails Load.
            var types2 = SampleTypeModel.FromSources(
                "namespace App1 {\n" +
                "public sealed partial class ContentPage {\n" +
                "  public ContentPage() {\n" +
                "    Sv.Content = \"from code\"; Pe.Content = \"from code\"; Tx.Content = \"from code\";\n" +
                "    Bd.Child = null; Run1.Text = \"from code\"; Empty.Content = \"Code label\";\n" +
                "  }\n" +
                "}\n" +
                "}");
            var r2 = CleanRoot(Doc(
                "<StackPanel>" +
                "<ScrollViewer x:Name=\"Sv\"><ContentPresenter /></ScrollViewer>" +
                "<Button x:Name=\"Pe\"><Button.Content><TextBlock Text=\"a\" /></Button.Content></Button>" +
                "<Button x:Name=\"Tx\">literal</Button>" +
                "<TextBlock><Run x:Name=\"Run1\">authored</Run></TextBlock>" +
                "<Button x:Name=\"Empty\" />" +
                "</StackPanel>",
                rootAttrs: "x:Class=\"App1.ContentPage\""), sample: true, types: types2);
            Check("child content -> no Content attr", Attr(Named(r2, "Sv"), "Content") is null, Attr(Named(r2, "Sv"), "Content"));
            Check("property element -> no Content attr", Attr(Named(r2, "Pe"), "Content") is null, Attr(Named(r2, "Pe"), "Content"));
            Check("text content -> no Content attr", Attr(Named(r2, "Tx"), "Content") is null, Attr(Named(r2, "Tx"), "Content"));
            Check("Run text content -> no Text attr", Attr(Named(r2, "Run1"), "Text") is null, Attr(Named(r2, "Run1"), "Text"));
            Eq("empty element still gets code-behind Content", "Code label", Attr(Named(r2, "Empty"), "Content"));
            Check("SetsAsElement ignores unrelated property elements",
                !SamplePlanner.MarkupSetsAsElement(XElement.Parse("<Button><Button.Flyout><Flyout /></Button.Flyout></Button>"), "Content"));
        }

        private static void SampleDataGlyphs()
        {
            // AI Dev Gallery shape: icon codes bound to FontIcon.Glyph get a real icon, not a word drawn as tofu boxes.
            var types = SampleTypeModel.FromSources(
                "using System.Collections.Generic;\n" +
                "namespace App1 {\n" +
                "public sealed partial class IconPage {\n" +
                "  public string Icon { get; set; }\n" +
                "  public string Label { get; set; }\n" +
                "  public List<Api> Apis { get; } = new();\n" +
                "  public IconPage() { CodeIcon.Glyph = Icon; Custom.Glyph = Icon; Literal.Glyph = \"\\uE8A5\"; }\n" +
                "}\n" +
                "public class Api { public string IconGlyph { get; set; } public string Name { get; set; } }\n" +
                "}");
            var r = CleanRoot(Doc(
                "<StackPanel>" +
                "<FontIcon x:Name=\"Bound\" Glyph=\"{x:Bind Icon}\" />" +
                "<FontIcon x:Name=\"CodeIcon\" /><FontIcon x:Name=\"Literal\" />" +
                "<FontIcon x:Name=\"Custom\" FontFamily=\"ms-appx:///Assets/MyIcons.ttf#MyIcons\" />" +
                "<TextBlock x:Name=\"SymbolText\" FontFamily=\"{ThemeResource SymbolThemeFontFamily}\" Text=\"{x:Bind Icon}\" />" +
                "<TextBlock x:Name=\"PlainText\" Text=\"{x:Bind Label}\" />" +
                "<ListView x:Name=\"ApiList\" ItemsSource=\"{x:Bind Apis}\"><ListView.ItemTemplate>" +
                "<DataTemplate x:DataType=\"local:Api\"><StackPanel>" +
                "<FontIcon x:Name=\"RowIcon\" Glyph=\"{x:Bind IconGlyph}\" /><TextBlock Text=\"{x:Bind Name}\" />" +
                "</StackPanel></DataTemplate></ListView.ItemTemplate></ListView>" +
                "</StackPanel>",
                rootAttrs: "x:Class=\"App1.IconPage\" xmlns:local=\"using:App1\""), sample: true, types: types);
            Eq("bound FontIcon.Glyph -> sample glyph", SamplePlanner.SampleGlyph, Attr(Named(r, "Bound"), "Glyph"));
            Eq("code-behind Glyph -> sample glyph", SamplePlanner.SampleGlyph, Attr(Named(r, "CodeIcon"), "Glyph"));
            Eq("code-behind literal glyph kept", "\uE8A5", Attr(Named(r, "Literal"), "Glyph"));
            Check("app icon font -> left empty", Attr(Named(r, "Custom"), "Glyph") is null or "", Attr(Named(r, "Custom"), "Glyph"));
            Eq("Text in the symbol font -> sample glyph", SamplePlanner.SampleGlyph, Attr(Named(r, "SymbolText"), "Text"));
            Check("plain text unaffected", Attr(Named(r, "PlainText"), "Text") is { Length: > 0 } t && t != SamplePlanner.SampleGlyph, Attr(Named(r, "PlainText"), "Text"));
            Check("row glyph binding falls back to the sample glyph", (Attr(Named(r, "RowIcon"), "Glyph") ?? "").Contains(SamplePlanner.SampleGlyph), Attr(Named(r, "RowIcon"), "Glyph"));
            var tag = Attr(Named(r, "ApiList"), "Tag") ?? "";
            Check("row glyphs are the sample glyph", tag.Contains("\"IconGlyph\":\"\\uE7C3\"", StringComparison.OrdinalIgnoreCase) || tag.Contains("\"IconGlyph\":\"" + SamplePlanner.SampleGlyph + "\""), tag);
            Check("row text still generated", tag.Contains("\"Name\":\"Api 2\"") || tag.Contains("\"Name\":"), tag);
            Check("GlyphSample: plain TextBlock.Text -> null", SamplePlanner.GlyphSample(new XElement("TextBlock"), "Text") is null);

            // ScenarioOverviewPage shape: the icon is in a list nested in each typed row, which SampleObjects fills.
            var nestedTypes = SampleTypeModel.FromSources(
                "using System.Collections.Generic;\n" +
                "namespace App1 {\n" +
                "public sealed partial class CatPage { public List<Category> Categories { get; } = new(); }\n" +
                "public class Category { public string Name { get; set; } public List<Scenario> Scenarios { get; set; } }\n" +
                "public class Scenario { public string Icon { get; set; } public string Name { get; set; } }\n" +
                "}");
            var nested = CleanRoot(Doc(
                "<ItemsControl x:Name=\"Cats\" ItemsSource=\"{x:Bind Categories}\"><ItemsControl.ItemTemplate>" +
                "<DataTemplate x:DataType=\"local:Category\"><StackPanel><TextBlock Text=\"{x:Bind Name}\" />" +
                "<ItemsControl ItemsSource=\"{x:Bind Scenarios}\"><ItemsControl.ItemTemplate><DataTemplate x:DataType=\"local:Scenario\">" +
                "<FontIcon Glyph=\"{x:Bind Icon}\" /></DataTemplate></ItemsControl.ItemTemplate></ItemsControl>" +
                "</StackPanel></DataTemplate></ItemsControl.ItemTemplate></ItemsControl>",
                rootAttrs: "x:Class=\"App1.CatPage\" xmlns:local=\"using:App1\""), sample: true, types: nestedTypes);
            var catTag = Attr(Named(nested, "Cats"), "Tag") ?? "";
            Eq("nested icon member travels with the typed marker", "Icon",
                string.Join(",", SampleListFiller.GlyphMembersOf(catTag[SampleListFiller.TagPrefix.Length..])));
            using (SampleObjects.GlyphMembers(new[] { "Icon" }))
            {
                Eq("typed rows: icon member -> sample glyph", SamplePlanner.SampleGlyph, SampleObjects.ValueFor(typeof(string), "Icon", 1, 1) as string);
                Check("typed rows: other text unaffected", SampleObjects.ValueFor(typeof(string), "Name", 1, 1) is string s && s != SamplePlanner.SampleGlyph);
            }
            Check("glyph scope ends", SampleObjects.ValueFor(typeof(string), "Icon", 1, 1) is string after && after != SamplePlanner.SampleGlyph);
            Eq("untyped marker: no glyph list", "", string.Join(",", SampleListFiller.GlyphMembersOf("Rows|[\"a\"]")));
        }

        private static void SampleDataStates()
        {
            var types = SampleTypeModel.FromSources(
                "using System; using System.Collections.Generic; using System.Collections.ObjectModel; using Microsoft.UI.Xaml;\n" +
                "namespace App1 {\n" +
                "public sealed partial class StatesPage {\n" +
                "  public double Quantity { get; set; } = 3;\n" +
                "  public double Volume { get; set; } = 40;\n" +
                "  public bool? Agreed { get; set; }\n" +
                "  public bool IsLoading { get; set; } = true;\n" +
                "  public bool IsBusy { get; set; }\n" +
                "  public bool HasOrders { get; set; }\n" +
                "  public Visibility EmptyVisibility { get; set; } = Visibility.Collapsed;\n" +
                "  public string Draft { get; set; } = \"\";\n" +
                "  public string Query { get; set; } = \"rivets\";\n" +
                "  public Person Owner { get; } = new();\n" +
                "  public List<string> Tags { get; } = new();\n" +
                "  public ObservableCollection<Order> Orders { get; } = new();\n" +
                "  public ObservableCollection<string> Tabs { get; } = new();\n" +
                "  public static string Initials(string name) => name;\n" +
                "  public static string FormatPrice(decimal price) => price.ToString();\n" +
                "  public string GetTitle() => \"\";\n" +
                "  public StatesPage() { Summary.Text = string.Join(\", \", Tags); }\n" +
                "  private void OnLoaded(object sender, RoutedEventArgs e) { IsLoading = false; HasOrders = true; }\n" +
                "  private void Refresh_Click(object sender, RoutedEventArgs e) { IsBusy = true; Status.Text = \"Refreshed!\"; }\n" +
                "  private void OnStageChanged(object? sender, bool on) { Toggle.IsChecked = on; }\n" +
                "  private void SetQuery(string query) { Search2.Text = query; }\n" +
                "}\n" +
                "public class Person { public string Name { get; set; } public string City { get; set; } }\n" +
                "public class Order { public string Name { get; set; } public string Customer { get; set; } public decimal Price { get; set; } public bool IsRush { get; set; } public bool IsDone { get; set; } }\n" +
                "}");
            var r = CleanRoot(Doc(
                "<StackPanel>" +
                "<NumberBox x:Name=\"Qty\" Value=\"{x:Bind Quantity}\" />" +
                "<Slider x:Name=\"Vol\" Value=\"{x:Bind Volume}\" />" +
                "<CheckBox x:Name=\"Agree\" IsChecked=\"{x:Bind Agreed}\" />" +
                "<ProgressRing x:Name=\"Spin\" IsActive=\"{x:Bind IsLoading}\" />" +
                "<ProgressBar x:Name=\"Busy\" IsIndeterminate=\"{x:Bind IsBusy}\" />" +
                "<StackPanel x:Name=\"Empty\" Visibility=\"{x:Bind EmptyVisibility}\" />" +
                "<ListView x:Name=\"Filled\" Visibility=\"{x:Bind HasOrders}\" />" +
                "<TextBox x:Name=\"DraftBox\" Text=\"{x:Bind Draft}\" />" +
                "<AutoSuggestBox x:Name=\"Search\" Text=\"{x:Bind Query}\" />" +
                "<TextBlock x:Name=\"OwnerName\" Text=\"{x:Bind Owner.Name}\" />" +
                "<TextBlock x:Name=\"OwnerCity\" Text=\"{x:Bind Owner.City}\" />" +
                "<TextBlock x:Name=\"Init\" Text=\"{x:Bind local:StatesPage.Initials(Owner.Name)}\" />" +
                "<TextBlock x:Name=\"Title\" Text=\"{x:Bind GetTitle()}\" />" +
                "<TextBlock x:Name=\"Summary\" />" +
                "<TextBlock x:Name=\"Status\" />" +
                "<ToggleButton x:Name=\"Toggle\" /><TextBox x:Name=\"Search2\" />" +
                "<ListView x:Name=\"List\" ItemsSource=\"{x:Bind Orders}\"><ListView.ItemTemplate>" +
                "<DataTemplate x:DataType=\"local:Order\"><StackPanel>" +
                "<TextBlock x:Name=\"Price\" Text=\"{x:Bind local:StatesPage.FormatPrice(Price)}\" />" +
                "<Border x:Name=\"Rush\" Visibility=\"{x:Bind IsRush}\" />" +
                "<CheckBox x:Name=\"Done\" IsChecked=\"{x:Bind IsDone}\" />" +
                "</StackPanel></DataTemplate></ListView.ItemTemplate></ListView>" +
                "<ItemsControl x:Name=\"TagList\" ItemsSource=\"{x:Bind Tags}\"><ItemsControl.ItemTemplate>" +
                "<DataTemplate x:DataType=\"x:String\"><TextBlock x:Name=\"TagText\" Text=\"{x:Bind}\" /></DataTemplate>" +
                "</ItemsControl.ItemTemplate></ItemsControl>" +
                "<TabView x:Name=\"Tabs\" TabItemsSource=\"{x:Bind Tabs}\" />" +
                "<ListView x:Name=\"Classic\" ItemsSource=\"{Binding Orders}\" />" +
                "</StackPanel>",
                rootAttrs: "x:Class=\"App1.StatesPage\" xmlns:local=\"using:App1\""), sample: true, types: types);

            // Initial state comes from the page's own initializers and load code, not from interaction handlers.
            Eq("number initializer (NumberBox)", "3", Attr(Named(r, "Qty"), "Value"));
            Eq("number initializer (Slider)", "40", Attr(Named(r, "Vol"), "Value"));
            Check("unset bool? -> not checked", Attr(Named(r, "Agree"), "IsChecked") is null or "False", Attr(Named(r, "Agree"), "IsChecked"));
            Eq("bool cleared in Loaded handler", "False", Attr(Named(r, "Spin"), "IsActive"));
            Eq("bool set only in a click handler stays false", "False", Attr(Named(r, "Busy"), "IsIndeterminate"));
            Eq("Visibility.Collapsed initializer", "Collapsed", Attr(Named(r, "Empty"), "Visibility"));
            Eq("bool set in Loaded -> Visible", "Visible", Attr(Named(r, "Filled"), "Visibility"));
            Check("empty-string TextBox -> no prefill", Attr(Named(r, "DraftBox"), "Text") is null or "", Attr(Named(r, "DraftBox"), "Text"));
            Eq("input box shows its known initial text", "rivets", Attr(Named(r, "Search"), "Text"));

            // Vocabulary: names read as what they are.
            Eq("Person.Name -> a person's name", "Avery Chen", Attr(Named(r, "OwnerName"), "Text"));
            Eq("City -> a city", "Seattle", Attr(Named(r, "OwnerCity"), "Text"));
            Eq("TextByName: Customer", "Avery Chen", SamplePlanner.TextByName("Customer", 0));
            Eq("TextByName: Name on Order", "Order 2", SamplePlanner.TextByName("Name", 1, "Order"));
            Eq("TextByName: Name on a page stays generic", "Name", SamplePlanner.TextByName("Name", 0, "MainPage"));
            Check("TextByName: Description -> a sentence", SamplePlanner.TextByName("Description", 0).EndsWith('.'), SamplePlanner.TextByName("Description", 0));

            // Functions show what they compute, not their own name.
            Eq("Initials(Name) -> initials", "AC", Attr(Named(r, "Init"), "Text"));
            Eq("GetTitle() -> Title", "Title", Attr(Named(r, "Title"), "Text"));
            Check("FormatPrice(Price) -> the price", Attr(Named(r, "Price"), "Text") is { } price && !price.Contains("Format", StringComparison.OrdinalIgnoreCase) &&
                System.Text.RegularExpressions.Regex.IsMatch(price, @"\d"), Attr(Named(r, "Price"), "Text"));
            Eq("string.Join(\", \", Tags) -> joined sample tags", "Tag, Tag 2, Tag 3", Attr(Named(r, "Summary"), "Text"));
            Check("text set in Refresh_Click is interaction, not initial", Attr(Named(r, "Status"), "Text") is null, Attr(Named(r, "Status"), "Text"));
            Check("(object? sender, bool) handler is interaction", Attr(Named(r, "Toggle"), "IsChecked") is null, Attr(Named(r, "Toggle"), "IsChecked"));
            Check("input box set from a parameter stays empty", Attr(Named(r, "Search2"), "Text") is null, Attr(Named(r, "Search2"), "Text"));

            // Row templates bind each row's own values.
            Eq("row Visibility -> converter binding", "{Binding IsRush, Converter={StaticResource __wxpSampleVisibility}}", Attr(Named(r, "Rush"), "Visibility"));
            Eq("row bool -> binding", "{Binding IsDone}", Attr(Named(r, "Done"), "IsChecked"));
            Eq("{x:Bind} of a string row -> {Binding}", "{Binding}", Attr(Named(r, "TagText"), "Text"));
            var tag = Attr(Named(r, "List"), "Tag") ?? "";
            Check("row bools vary", tag.Contains("\"IsRush\":true") && tag.Contains("\"IsRush\":false"), tag);
            Check("TabItemsSource filled", (Attr(Named(r, "Tabs"), "Tag") ?? "").StartsWith(SampleListFiller.TagPrefix, StringComparison.Ordinal), Attr(Named(r, "Tabs"), "Tag"));
            Check("classic {Binding} ItemsSource filled", (Attr(Named(r, "Classic"), "Tag") ?? "").StartsWith(SampleListFiller.TagPrefix, StringComparison.Ordinal), Attr(Named(r, "Classic"), "Tag"));
            Check("string list rows are readable", (Attr(Named(r, "TagList"), "Tag") ?? "").Contains("\"Tag 2\""), Attr(Named(r, "TagList"), "Tag"));

            // Typed objects: an empty "= new()" collection is filled like a null one.
            var withLines = SampleObjects.Create(typeof(Fixtures.Card), null, 0) as Fixtures.Card;
            Check("empty initialized list filled", withLines?.Lines.Count > 0, withLines?.Lines.Count.ToString());

            // S20: a template's x:DataType wins over an unrelated same-named source element type.
            var dupTypes = SampleTypeModel.FromSources(
                "using System.Collections.Generic;\n" +
                "namespace App1 { public sealed partial class DupPage { public List<App1.Models.Item> Items { get; } = new(); } public class Item { public string Title { get; set; } } }\n" +
                "namespace App1.Models { public class Item { public string Name { get; set; } } }");
            var dup = CleanRoot(Doc(
                "<ListView x:Name=\"Dup\" ItemsSource=\"{x:Bind Items}\"><ListView.ItemTemplate><DataTemplate x:DataType=\"local:Item\">" +
                "<TextBlock Text=\"{x:Bind Title}\" /></DataTemplate></ListView.ItemTemplate></ListView>",
                rootAttrs: "x:Class=\"App1.DupPage\" xmlns:local=\"using:App1\""), sample: true, types: dupTypes);
            var dupTag = Attr(Named(dup, "Dup"), "Tag") ?? "";
            Check("S20: rows typed by the template's x:DataType", dupTag.Contains("\"type\":\"App1.Item\"") && dupTag.Contains("\"Title\":\"Title 2\""), dupTag);

            // Project discovery: a folder with several projects picks the WinUI app.
            var dir = Directory.CreateTempSubdirectory("wxp-proj-").FullName;
            try
            {
                File.WriteAllText(Path.Combine(dir, "A.Tests.csproj"), "<Project><PropertyGroup /></Project>");
                File.WriteAllText(Path.Combine(dir, "Zeta.csproj"), "<Project><PropertyGroup><UseWinUI>true</UseWinUI></PropertyGroup></Project>");
                Eq("FindProject prefers <UseWinUI>", Path.Combine(dir, "Zeta.csproj"), SampleTypeModel.FindProject(Path.Combine(dir, "MainPage.xaml")));
            }
            finally
            {
                Directory.Delete(dir, true);
            }
        }

        private static void SampleDataGroupsAndModel()
        {
            // Grouped lists: a ListView over {Binding Source={StaticResource Cvs}} gets a grouped marker.
            var types = SampleTypeModel.FromSources(
                "using System.Collections.Generic;\n" +
                "namespace App1 {\n" +
                "public sealed partial class GroupsPage {\n" +
                "  public List<PersonGroup> Groups { get; } = new();\n" +
                "  public List<Team> Teams { get; } = new();\n" +
                "  public GroupsPage() { CodeCvs.Source = Groups; }\n" +
                "}\n" +
                "public class Person { public string Name { get; set; } }\n" +
                "public class PersonGroup : List<Person> { public string Key { get; set; } }\n" +
                "public class Team { public string Key { get; set; } public List<Person> Members { get; set; } }\n" +
                "}");
            const string template = "<ListView.ItemTemplate><DataTemplate x:DataType=\"local:Person\"><TextBlock Text=\"{x:Bind Name}\" /></DataTemplate></ListView.ItemTemplate>";
            string List(string name, string cvs) =>
                $"<ListView x:Name=\"{name}\" ItemsSource=\"{{Binding Source={{StaticResource {cvs}}}}}\">{template}</ListView>";
            var r = CleanRoot(Doc(
                "<Grid><Grid.Resources>" +
                "<CollectionViewSource x:Key=\"BindCvs\" Source=\"{x:Bind Groups}\" IsSourceGrouped=\"True\" />" +
                "<CollectionViewSource x:Key=\"PathCvs\" Source=\"{x:Bind Teams}\" IsSourceGrouped=\"True\" ItemsPath=\"Members\" />" +
                "<CollectionViewSource x:Key=\"CodeCvs\" x:Name=\"CodeCvs\" IsSourceGrouped=\"True\" />" +
                "<CollectionViewSource x:Key=\"DesignCvs\" d:Source=\"{d:DesignInstance local:Person}\" IsSourceGrouped=\"True\" />" +
                "<CollectionViewSource x:Key=\"LiteralCvs\" IsSourceGrouped=\"True\"><CollectionViewSource.Source><x:Array Type=\"x:String\" /></CollectionViewSource.Source></CollectionViewSource>" +
                "</Grid.Resources><StackPanel>" +
                List("ByBind", "BindCvs") + List("ByPath", "PathCvs") + List("ByCode", "CodeCvs") +
                List("ByDesign", "DesignCvs") + List("ByLiteral", "LiteralCvs") +
                "</StackPanel></Grid>",
                rootAttrs: "x:Class=\"App1.GroupsPage\" xmlns:local=\"using:App1\""), sample: true, types: types);

            var bind = Attr(Named(r, "ByBind"), "Tag") ?? "";
            Check("CVS x:Bind Source -> grouped marker", bind.StartsWith(SampleListFiller.TagPrefix, StringComparison.Ordinal) && bind.Contains("\"grouped\":true"), bind);
            Check("grouped: group type from List<PersonGroup>", bind.Contains("\"groupType\":\"App1.PersonGroup\""), bind);
            Check("grouped: item type from the group's element type", bind.Contains("\"type\":\"App1.Person\""), bind);
            Check("grouped: two keyed groups", bind.Contains("\"Key\":\"Group 1\"") && bind.Contains("\"Key\":\"Group 2\"") && !bind.Contains("\"Group 3\""), bind);
            Check("grouped: rows carry template fields", bind.Contains("\"Name\":"), bind);

            var byPath = Attr(Named(r, "ByPath"), "Tag") ?? "";
            Check("ItemsPath: group type Team", byPath.Contains("\"groupType\":\"App1.Team\""), byPath);
            Check("ItemsPath: item type via Team.Members", byPath.Contains("\"type\":\"App1.Person\""), byPath);
            Check("ItemsPath carried in payload", byPath.Contains("\"itemsPath\":\"Members\""), byPath);
            Check("ItemsPath: keys from the Teams label", byPath.Contains("\"Key\":\"Team 1\""), byPath);

            var byCode = Attr(Named(r, "ByCode"), "Tag") ?? "";
            Check("Source assigned in code-behind -> typed groups", byCode.Contains("\"grouped\":true") && byCode.Contains("\"groupType\":\"App1.PersonGroup\""), byCode);
            Check("d:Source -> no marker", Attr(Named(r, "ByDesign"), "Tag") is null, Attr(Named(r, "ByDesign"), "Tag"));
            Check("literal Source -> no marker", Attr(Named(r, "ByLiteral"), "Tag") is null, Attr(Named(r, "ByLiteral"), "Tag"));

            // Without a type model the marker is still grouped, with plain groups.
            var untyped = CleanRoot(Doc(
                "<Grid><Grid.Resources><CollectionViewSource x:Key=\"Cvs\" Source=\"{x:Bind Groups}\" IsSourceGrouped=\"True\" /></Grid.Resources>" +
                "<ListView x:Name=\"L\" ItemsSource=\"{Binding Source={StaticResource Cvs}}\" /></Grid>"), sample: true);
            var untypedTag = Attr(Named(untyped, "L"), "Tag") ?? "";
            Check("no type model -> plain grouped marker", untypedTag.Contains("\"grouped\":true") && !untypedTag.Contains("groupType"), untypedTag);

            // BuildGroups turns the payload into the app's own group objects when it can.
            const string rows = "\"rows\":[{\"Key\":\"Member 1\",\"Items\":[{\"Name\":\"A\"},{\"Name\":\"B\"}]},{\"Key\":\"Member 2\",\"Items\":[{\"Name\":\"C\"}]}]";
            var listGroups = SampleListFiller.BuildGroups(
                "Members|{\"grouped\":true,\"groupType\":\"Surface.Tests.Fixtures.MemberGroup\",\"type\":\"Surface.Tests.Fixtures.Member\"," + rows + "}",
                out var label, out var typed, out var path);
            Eq("BuildGroups label", "Members", label);
            Check("List-subclass group -> typed", typed && listGroups.Count == 2 && listGroups[0] is Fixtures.MemberGroup, $"{typed} {listGroups.FirstOrDefault()?.GetType().Name}");
            var mg = listGroups.FirstOrDefault() as Fixtures.MemberGroup;
            Eq("typed group keeps its Key", "Member 1", mg?.Key);
            Check("typed group holds typed rows", mg is { Count: 2 } && mg[0] is { Name: "A" }, mg?.Count.ToString());
            Check("no ItemsPath for a List-subclass group", path is null, path);

            var teamGroups = SampleListFiller.BuildGroups(
                "Teams|{\"grouped\":true,\"groupType\":\"Surface.Tests.Fixtures.Team\",\"type\":\"Surface.Tests.Fixtures.Member\",\"itemsPath\":\"Members\"," + rows + "}",
                out _, out var teamTyped, out var teamPath);
            Check("ItemsPath group -> typed Team", teamTyped && teamGroups.FirstOrDefault() is Fixtures.Team { Key: "Member 1" }, teamGroups.FirstOrDefault()?.GetType().Name);
            Check("ItemsPath group's collection filled", teamGroups.FirstOrDefault() is Fixtures.Team { Members.Count: > 0 }, null);
            Eq("ItemsPath returned", "Members", teamPath);

            var plain = SampleListFiller.BuildGroups(
                "X|{\"grouped\":true,\"groupType\":\"Nope.Missing\"," + rows + "}", out _, out var plainTyped, out _);
            Check("unknown group type -> plain item lists", !plainTyped && plain.Count == 2 && plain[0] is List<object> { Count: 2 } && plain[1] is List<object> { Count: 1 },
                plain.FirstOrDefault()?.GetType().Name);

            // Project watcher: only the project's own sources, never build output.
            var proj = Directory.CreateTempSubdirectory("wxp-proj-").FullName;
            Check("IsBuildOutput: bin\\", SampleTypeModel.IsBuildOutput(proj, Path.Combine(proj, "bin", "Debug", "x.cs")), null);
            Check("IsBuildOutput: obj\\", SampleTypeModel.IsBuildOutput(proj, Path.Combine(proj, "obj", "x.g.cs")), null);
            Check("IsBuildOutput: nested Sub\\obj\\", SampleTypeModel.IsBuildOutput(proj, Path.Combine(proj, "Sub", "OBJ", "x.cs")), null);
            Check("IsBuildOutput: .vs\\", SampleTypeModel.IsBuildOutput(proj, Path.Combine(proj, ".vs", "x.cs")), null);
            Check("IsBuildOutput: Objects\\ is source", !SampleTypeModel.IsBuildOutput(proj, Path.Combine(proj, "Objects", "x.cs")), null);
            Check("IsBuildOutput: root file is source", !SampleTypeModel.IsBuildOutput(proj, Path.Combine(proj, "Binary.cs")), null);
            try
            {
                File.WriteAllText(Path.Combine(proj, "Watch.csproj"), "<Project><PropertyGroup><UseWinUI>true</UseWinUI></PropertyGroup></Project>");
                File.WriteAllText(Path.Combine(proj, "Alpha.cs"), "namespace W { public class Alpha { public string Name { get; set; } } }");
                Directory.CreateDirectory(Path.Combine(proj, "obj"));
                File.WriteAllText(Path.Combine(proj, "obj", "Gen.g.cs"), "namespace W { public class Generated { } }");
                var page = Path.Combine(proj, "MainPage.xaml");
                var first = SampleTypeModel.ForDocument(page, TimeSpan.FromMilliseconds(1));
                Check("first build waited for (FirstBuildWait)", first?.FindType("W.Alpha") is not null, first is null ? "null model" : "no Alpha");
                Check("obj\\ sources excluded", first?.FindType("W.Generated") is null, null);

                File.WriteAllText(Path.Combine(proj, "Beta.cs"), "namespace W { public class Beta { } }");
                SampleTypeModel? next = null;
                var sw = System.Diagnostics.Stopwatch.StartNew();
                while (sw.Elapsed < TimeSpan.FromSeconds(5) && next?.FindType("W.Beta") is null)
                {
                    Thread.Sleep(100);
                    next = SampleTypeModel.ForDocument(page, TimeSpan.FromSeconds(2));
                }
                Check("watcher picks up a new .cs file", next?.FindType("W.Beta") is not null, $"after {sw.ElapsedMilliseconds} ms");

                File.WriteAllText(Path.Combine(proj, "obj", "Later.g.cs"), "namespace W { public class Later { } }");
                Thread.Sleep(500);
                var after = SampleTypeModel.ForDocument(page, TimeSpan.FromSeconds(2));
                Check("watcher ignores later obj\\ writes", after?.FindType("W.Later") is null && after?.FindType("W.Beta") is not null, null);
            }
            finally
            {
                try { Directory.Delete(proj, true); } catch (IOException) { }
            }

            // Chart helpers.
            Check("HasEmptyData: Series filled, ItemsSource empty -> has data", !SampleChartFiller.HasEmptyData(new Fixtures.SeriesFilledChart()), null);
            Check("HasEmptyData: all data properties empty -> empty", SampleChartFiller.HasEmptyData(new Fixtures.EmptyChart()), null);
            Check("HasEmptyData: no data properties -> not a chart", !SampleChartFiller.HasEmptyData(new Fixtures.NotAChart()), null);
            foreach (var round in new[] { "PieChart", "DonutChart", "DoughnutSeries", "RadialGauge", "SunburstChart", "piechart" })
            {
                Check($"IsRoundChart({round})", SampleChartFiller.IsRoundChart(round), null);
            }
            foreach (var flat in new[] { "LineChart", "BarChart", "Sparkline", "CartesianChart", "Chart" })
            {
                Check($"!IsRoundChart({flat})", !SampleChartFiller.IsRoundChart(flat), null);
            }
        }

        private static void SampleDataCharts()
        {
            var types = SampleTypeModel.FromSources(
                "using System.Collections.Generic; using Microsoft.UI.Xaml;\n" +
                "namespace App1 {\n" +
                "public sealed partial class ChartsPage {\n" +
                "  public string[] Months { get; } = [\"Jan\", \"Feb\", \"Mar\"];\n" +
                "  public double[] Profits { get; } = new[] { 1.5, 2, 3.25 };\n" +
                "  public List<double> Coded { get; } = new();\n" +
                "  public List<string> Regions { get; } = new();\n" +
                "  public bool ShowTrend { get; set; }\n" +
                "  public bool ShowLive { get; set; }\n" +
                "  public bool ShowInit { get; set; } = true;\n" +
                "  public Visibility HiddenVis { get; } = Visibility.Collapsed;\n" +
                "  public bool ShowLabel { get; set; }\n" +
                "  public ChartsPage() { ShowLive = Compute(); Coded.Add(1); }\n" +
                "}\n" +
                "}");
            var fixups = new List<ChartFixup>();
            var xaml = Doc(
                "<StackPanel>" +
                "<charts:Chart x:Name=\"R1\" Visibility=\"{x:Bind ShowInit}\">" +
                "<charts:Chart.Data>" +
                "<charts:Samples x:Name=\"Month\" ItemsSource=\"{x:Bind Months}\" />" +
                "<charts:Samples x:Name=\"Profit\" ItemsSource=\"{x:Bind Profits}\" />" +
                "<charts:Samples ItemsSource=\"{x:Bind Coded}\" />" +
                "<charts:Samples x:Name=\"Region\" ItemsSource=\"{x:Bind Regions}\" />" +
                "</charts:Chart.Data>" +
                "<charts:Chart.Axes><charts:CategoryAxis x:Name=\"MonthX\" /><charts:LinearAxis x:Name=\"ProfitY\" /></charts:Chart.Axes>" +
                "<charts:Chart.Series><charts:LineSeries x:Name=\"Line\" XAxis=\"{x:Bind MonthX}\" YAxis=\"{x:Bind ProfitY}\" " +
                "XValues=\"{x:Bind Month}\" YValues=\"{x:Bind Profit}\" Title=\"{x:Bind Missing}\" />" +
                "<charts:LineSeries XValues=\"{x:Bind Month}\" />" +
                "</charts:Chart.Series></charts:Chart>" +
                "<charts:Chart x:Name=\"Trend\" Visibility=\"{x:Bind ShowTrend}\" />" +
                "<charts:Chart x:Name=\"Live\" Visibility=\"{x:Bind ShowLive}\" />" +
                "<charts:Chart x:Name=\"Hidden\" Visibility=\"{x:Bind HiddenVis}\" />" +
                "<charts:Chart x:Name=\"Conv\" Visibility=\"{x:Bind ShowTrend, Converter={StaticResource C}}\" />" +
                "<TextBlock x:Name=\"Label\" Visibility=\"{x:Bind ShowLabel}\" />" +
                "</StackPanel>",
                rootAttrs: "x:Class=\"App1.ChartsPage\" xmlns:charts=\"using:Microsoft.UI.Xaml.Controls.Charts\"");
            var r = XDocument.Parse(XamlCleaner.Clean(xaml, sampleData: true, sampleTypes: types, chartFixups: fixups)).Root!;
            ChartFixup? Fix(string element, string prop) => fixups.FirstOrDefault(f => f.Element == element && f.Property == prop);

            Eq("axis reference -> fixup", "MonthX", Fix("Line", "XAxis")?.RefName);
            Eq("samples reference -> fixup", "Profit", Fix("Line", "YValues")?.RefName);
            Check("reference attributes dropped", Attr(Named(r, "Line"), "XAxis") is null && Attr(Named(r, "Line"), "YValues") is null);
            Check("non-reference scalar falls through (dropped/placeholdered, not a fixup)", Fix("Line", "Title") is null);
            var month = Fix("Month", "ItemsSource");
            Check("string[] literal kept", month is { Numeric: false } && string.Join(",", month.Values!) == "Jan,Feb,Mar", string.Join(",", month?.Values ?? []));
            var profit = Fix("Profit", "ItemsSource");
            Check("double[] literal kept", profit is { Numeric: true } && string.Join(",", profit.Values!) == "1.5,2,3.25", string.Join(",", profit?.Values ?? []));
            Check("samples ItemsSource attribute dropped", Attr(Named(r, "Month"), "ItemsSource") is null);
            var coded = fixups.FirstOrDefault(f => f.Element.StartsWith("__wxpChart", StringComparison.Ordinal) && f.Property == "ItemsSource");
            Check("unnamed samples gets a generated name", coded is not null && Named(r, coded.Element) is { Name.LocalName: "Samples" }, coded?.Element);
            Check("code-filled List<double> -> typed wave", coded is { Numeric: true } && coded.Values!.Count == SamplePlanner.ChartPoints);
            var region = Fix("Region", "ItemsSource");
            Check("List<string> -> month categories", region is { Numeric: false } && region.Values!.Count == SamplePlanner.ChartPoints && region.Values[0] == "Jan", string.Join(",", region?.Values ?? []));
            var unnamedSeries = fixups.Where(f => f.Element.StartsWith("__wxpChart", StringComparison.Ordinal) && f.Property == "XValues").ToList();
            Check("unnamed series reference gets its own generated name", unnamedSeries.Count == 1 && unnamedSeries[0].Element != coded?.Element);

            Eq("bool with true initializer -> Visible", "Visible", Attr(Named(r, "R1"), "Visibility"));
            Eq("never-assigned bool -> Collapsed (default false)", "Collapsed", Attr(Named(r, "Trend"), "Visibility"));
            Eq("bool assigned in code -> shown", "Visible", Attr(Named(r, "Live"), "Visibility") ?? "Visible");
            Eq("Visibility.Collapsed initializer", "Collapsed", Attr(Named(r, "Hidden"), "Visibility"));
            Check("converter -> not planned as hidden", Attr(Named(r, "Conv"), "Visibility") != "Collapsed", Attr(Named(r, "Conv"), "Visibility"));
            Eq("non-chart Visibility follows its never-assigned bool", "Collapsed", Attr(Named(r, "Label"), "Visibility"));

            var noSample = new List<ChartFixup>();
            XamlCleaner.Clean(xaml, sampleData: false, sampleTypes: types, chartFixups: noSample);
            Check("sample data off -> no fixups", noSample.Count == 0, noSample.Count.ToString());

            var noTypes = new List<ChartFixup>();
            XamlCleaner.Clean(Doc(
                "<charts:Chart><charts:Chart.Data><charts:Samples x:Name=\"X\" ItemsSource=\"{x:Bind Xs}\" /><charts:Samples x:Name=\"Y\" ItemsSource=\"{x:Bind Ys}\" /></charts:Chart.Data>" +
                "<charts:Chart.Axes><charts:CategoryAxis x:Name=\"Cat\" /></charts:Chart.Axes>" +
                "<charts:Chart.Series><charts:BarSeries XAxis=\"{x:Bind Cat}\" XValues=\"{x:Bind X}\" YValues=\"{x:Bind Y}\" /></charts:Chart.Series></charts:Chart>",
                rootAttrs: "xmlns:charts=\"using:Microsoft.UI.Xaml.Controls.Charts\""), sampleData: true, chartFixups: noTypes);
            Check("untyped samples on a category axis -> month labels", noTypes.FirstOrDefault(f => f.Element == "X") is { Numeric: false } x && x.Values![0] == "Jan");
            Check("untyped Y samples -> numbers", noTypes.FirstOrDefault(f => f.Element == "Y") is { Numeric: true });

            Check("series values deterministic", SamplePlanner.ChartSeriesValues("A").SequenceEqual(SamplePlanner.ChartSeriesValues("A")));
            Check("series values in 20..80", SamplePlanner.ChartSeriesValues("B").All(v => v is >= 20 and <= 80));
            var pinned = SamplePlanner.ChartSeriesValues("C", 30, 94, 100);
            Check("series values scale into a pinned range", pinned.Length == 30 && pinned.All(v => v is >= 94 and <= 100), string.Join(",", pinned));
            var twelve = SamplePlanner.ChartSeriesValues("D", 12);
            var line = SamplePlanner.ChartSeriesValues("D", SamplePlanner.ChartLinePoints);
            Check("12 and 24 points trace the same wave", twelve[0] == line[0] && twelve[^1] == line[^1]);
            Check("twelve month categories", string.Join(",", SamplePlanner.ChartCategories()) == "Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec");
        }

        private static void SampleDataObjects()
        {
            var types = SampleTypeModel.FromSources(
                "using System.Collections.Generic;\n" +
                "namespace App1 {\n" +
                "public sealed partial class MainPage { public List<Order> Orders { get; } = new(); }\n" +
                "public class Order { public string Customer { get; set; } public Order Parent { get; set; } }\n" +
                "public class Tile { public Order Item { get; set; } public string Caption { get; set; } }\n" +
                "public class Outer { public class Inner { } }\n" +
                "}");
            var r = CleanRoot(Doc(
                "<StackPanel>" +
                "<local:Tile x:Name=\"PageTile\" Item=\"{x:Bind Orders}\" />" +
                "<ListView x:Name=\"List\" ItemsSource=\"{x:Bind Orders}\"><ListView.ItemTemplate>" +
                "<DataTemplate x:DataType=\"local:Order\"><StackPanel>" +
                "<local:Tile x:Name=\"Whole\" Item=\"{x:Bind Mode=OneWay}\" />" +
                "<local:Tile x:Name=\"Member\" Item=\"{x:Bind Parent}\" />" +
                "<local:Tile x:Name=\"Call\" Item=\"{x:Bind Pick(Parent)}\" />" +
                "</StackPanel></DataTemplate></ListView.ItemTemplate></ListView>" +
                "</StackPanel>",
                rootAttrs: "x:Class=\"App1.MainPage\" xmlns:local=\"using:App1\""), sample: true, types: types);
            Eq("template whole-row object binding -> {Binding}", "{Binding}", Attr(Named(r, "Whole"), "Item"));
            Eq("template member object binding -> {Binding path}", "{Binding Parent}", Attr(Named(r, "Member"), "Item"));
            Check("template function object binding dropped", Attr(Named(r, "Call"), "Item") is null, Attr(Named(r, "Call"), "Item"));
            Check("page-level object binding dropped", Attr(Named(r, "PageTile"), "Item") is null, Attr(Named(r, "PageTile"), "Item"));
            var tag = Attr(Named(r, "List"), "Tag") ?? "";
            Check("list marker names the item type", tag.Contains("\"type\":\"App1.Order\"") && tag.Contains("\"rows\":["), tag);
            var rows = SampleListFiller.BuildRows(tag[SampleListFiller.TagPrefix.Length..], 3, out var label, out var typeName);
            Check("typed payload parses", label == "Orders" && typeName == "App1.Order" && rows.Count == 3, $"{label} {typeName} {rows.Count}");
            Eq("nested type reflection name", "App1.Outer+Inner", SamplePlanner.ReflectionName(types.FindType("App1.Outer.Inner")!));

            Check("resolve type across loaded assemblies", SampleObjects.ResolveType(typeof(Fixtures.Plane).FullName!) == typeof(Fixtures.Plane));
            var row = new Dictionary<string, object> { ["Tail"] = "N123AB" };
            var planes = Enumerable.Range(0, 3).Select(i => SampleObjects.Create(typeof(Fixtures.Plane), i == 0 ? row : null, i) as Fixtures.Plane).ToList();
            var p0 = planes[0]!;
            Eq("row string wins", "N123AB", p0.Tail);
            Eq("generated identifier by name", "T-1042", planes[1]!.Tail);
            Check("init int generated", p0.Cycles > 0, p0.Cycles.ToString());
            Eq("type's own default kept", "A-check", p0.NextCheck);
            Check("enum varies by row", p0.State == Fixtures.FlightState.Healthy && planes[1]!.State == Fixtures.FlightState.Attention, $"{p0.State} {planes[1]!.State}");
            Check("DateTime generated", p0.LastSeen != default, p0.LastSeen.ToString("o"));
            Check("nested object via parameterized ctor", p0.Engine is { Serial: "Serial", Hours: > 0 }, p0.Engine?.Serial);
            Check("list property generated", p0.Notes is { Count: 3 } && p0.Notes[0].Length > 0 && p0.Notes[0] != p0.Notes[1], string.Join(",", p0.Notes ?? new()));
            Check("get-only collection filled", p0.Spares.Count == 3);
            Check("throwing ctor -> null, no throw", SampleObjects.Create(typeof(Fixtures.Exploding), null, 0) is null);

            var types2 = SampleTypeModel.FromSources(
                "namespace App1 {\n" +
                "public sealed partial class MainPage { public MainPage() { Coded.ItemsSource = Unknown.Wrap(null); } }\n" +
                "public class Order { public string Customer { get; set; } }\n" +
                "}");
            const string Tmpl = "<DataTemplate x:DataType=\"local:Order\"><TextBlock Text=\"{x:Bind Customer}\" /></DataTemplate>";
            var u = CleanRoot(Doc(
                "<StackPanel>" +
                $"<ListView x:Name=\"Coded\"><ListView.ItemTemplate>{Tmpl}</ListView.ItemTemplate></ListView>" +
                $"<ListView x:Name=\"Unbound\"><ListView.ItemTemplate>{Tmpl}</ListView.ItemTemplate></ListView>" +
                $"<ListView x:Name=\"Inline\"><ListView.ItemTemplate>{Tmpl}</ListView.ItemTemplate><ListViewItem /></ListView>" +
                "<ListView x:Name=\"Untyped\" />" +
                "</StackPanel>",
                rootAttrs: "x:Class=\"App1.MainPage\" xmlns:local=\"using:App1\""), sample: true, types: types2);
            var coded = Attr(Named(u, "Coded"), "Tag") ?? "";
            Check("code-behind source of unknown type -> rows typed by template", coded.Contains("\"type\":\"App1.Order\"") && coded.Contains("\"Customer\""), coded);
            var unbound = Attr(Named(u, "Unbound"), "Tag") ?? "";
            Check("no ItemsSource -> rows typed by template", unbound.StartsWith(SampleListFiller.TagPrefix + "Unbound|", StringComparison.Ordinal) && unbound.Contains("\"type\":\"App1.Order\""), unbound);
            Check("inline items left alone", Attr(Named(u, "Inline"), "Tag") is null, Attr(Named(u, "Inline"), "Tag"));
            Check("untyped list left alone", Attr(Named(u, "Untyped"), "Tag") is null, Attr(Named(u, "Untyped"), "Tag"));
        }

        private static void BindParsing()
        {
            Check("positional path", XamlCleaner.TryParseBind("{x:Bind Vm.Name, Mode=OneWay}", out var p, out var n) && p == "Vm.Name" && n["Mode"] == "OneWay");
            Check("Path= named", XamlCleaner.TryParseBind("{x:Bind Path=Vm.Name}", out p, out _) && p == "Vm.Name");
            Check("quoted value with comma and escaped quote",
                XamlCleaner.TryParseBind(@"{x:Bind Name, FallbackValue='it\'s, ok'}", out _, out n) && n["FallbackValue"] == "it's, ok",
                n.TryGetValue("FallbackValue", out var fv) ? fv : "<missing>");
            Check("nested braces in a named arg",
                XamlCleaner.TryParseBind("{x:Bind Name, Converter={StaticResource C}}", out p, out n) && p == "Name" && n["Converter"] == "{StaticResource C}");
            Check("function call path with commas", XamlCleaner.TryParseBind("{x:Bind Fmt(A, B), Mode=OneWay}", out p, out _) && p == "Fmt(A, B)");
            Check("empty binding parses with null path", XamlCleaner.TryParseBind("{x:Bind}", out p, out _) && p is null);
            Check("second positional argument rejected", !XamlCleaner.TryParseBind("{x:Bind A, B}", out _, out _));
            Check("unbalanced rejected", !XamlCleaner.TryParseBind("{x:Bind Fmt(A}", out _, out _));
            Check("not a markup extension rejected", !XamlCleaner.TryParseBind("Hello", out _, out _));

            Eq("label: simple", "{Name}", XamlCleaner.BindPathLabel("Name"));
            Eq("label: dotted -> last segment", "{Name}", XamlCleaner.BindPathLabel("Vm.User.Name"));
            Eq("label: indexer stripped", "{Items}", XamlCleaner.BindPathLabel("Vm.Items[0]"));
            Eq("label: leading cast stripped", "{Title}", XamlCleaner.BindPathLabel("(local:Item)Data.Title"));
            Eq("label: function", "Format(…)", XamlCleaner.BindPathLabel("Helpers.Format(Value)"));
            Eq("label: bare attached path -> null", null, XamlCleaner.BindPathLabel("(Grid.Row)"));
            Eq("label: null -> null", null, XamlCleaner.BindPathLabel(null));
            Eq("label: whitespace -> null", null, XamlCleaner.BindPathLabel("  "));
        }

        // ------------------------------------------------------------ R3

        private static void Rule3()
        {
            var r = CleanRoot(Doc(
                "<Page.Resources><DataTemplate x:Key=\"T\" x:DataType=\"x:String\"><TextBlock x:Phase=\"1\" /></DataTemplate></Page.Resources>" +
                "<Grid x:Name=\"G\" x:FieldModifier=\"public\" x:Load=\"False\" x:DeferLoadStrategy=\"Lazy\" x:Uid=\"Greeting\" />",
                rootAttrs: "x:ClassModifier=\"internal\""));
            var g = Named(r, "G")!;
            foreach (var d in new[] { "FieldModifier", "Load", "DeferLoadStrategy", "Uid" })
            {
                Check($"x:{d} removed", g.Attribute(X + d) is null);
            }
            Check("x:ClassModifier removed", r.Attribute(X + "ClassModifier") is null);
            Check("x:DataType removed", First(r, "DataTemplate")!.Attribute(X + "DataType") is null);
            Check("x:Phase removed", First(r, "TextBlock")!.Attribute(X + "Phase") is null);
            Check("x:Name kept", g.Attribute(X + "Name") is not null);
            Eq("x:Key kept", "T", (string?)First(r, "DataTemplate")!.Attribute(X + "Key"));
        }

        // ------------------------------------------------------------ R4

        private static void Rule4()
        {
            var r = CleanRoot(Doc(
                "<StackPanel x:Name=\"Panel\" Loaded=\"OnLoaded\" SizeChanged=\"OnSize\" UIElement.Tapped=\"OnTap\" Grid.Row=\"1\">" +
                "<Button x:Name=\"Btn\" Click=\"OnClick\" Content=\"Go\" />" +
                "<TextBox x:Name=\"Box\" TextChanged=\"OnText\" Text=\"Hi\" />" +
                "<f:Widget x:Name=\"Widget\" Closed=\"yes\" Pinged=\"OnPing\" Loaded=\"OnLoaded\" />" +
                "<bad:Unknown x:Name=\"Unknown\" Click=\"OnClick\" Foo=\"bar\" Closed=\"x\" />" +
                "</StackPanel>"));
            var panel = Named(r, "Panel");
            Check("Loaded removed", Attr(panel, "Loaded") is null);
            Check("SizeChanged removed", Attr(panel, "SizeChanged") is null);
            Check("attached event (UIElement.Tapped) removed", Attr(panel, "UIElement.Tapped") is null);
            Eq("attached property (Grid.Row) kept", "1", Attr(panel, "Grid.Row"));
            Check("Button.Click removed", Attr(Named(r, "Btn"), "Click") is null);
            Eq("Button.Content kept", "Go", Attr(Named(r, "Btn"), "Content"));
            Check("TextBox.TextChanged removed", Attr(Named(r, "Box"), "TextChanged") is null);
            Eq("TextBox.Text kept", "Hi", Attr(Named(r, "Box"), "Text"));

            var w = Named(r, "Widget");
            Eq("custom type: property named like a curated event kept", "yes", Attr(w, "Closed"));
            Check("custom type: own event removed via reflection", Attr(w, "Pinged") is null);
            Check("custom type: inherited event removed", Attr(w, "Loaded") is null);

            var u = Named(r, "Unknown");
            Check("unresolved type: curated event removed", Attr(u, "Click") is null);
            Check("unresolved type: curated name removed even if a property (documented trade-off)", Attr(u, "Closed") is null);
            Eq("unresolved type: other attribute kept", "bar", Attr(u, "Foo"));
        }

        // ------------------------------------------------------------ R5

        private static void Rule5()
        {
            var raw = Doc(
                "<d:DesignProperties><Grid /></d:DesignProperties>" +
                "<StackPanel d:DesignWidth=\"50\" d:DataContext=\"{d:DesignInstance Type=local:Vm}\" d:LayoutOverrides=\"Width\">" +
                "<TextBlock x:Name=\"T1\" d:Text=\"Sample\" />" +
                "<TextBlock x:Name=\"T2\" Text=\"Real\" d:Text=\"Sample\" />" +
                "<TextBlock x:Name=\"T3\" d:Text=\"{d:DesignData Foo}\" />" +
                "<TextBlock x:Name=\"T4\" d:NotAProperty=\"1\" />" +
                "</StackPanel>",
                rootAttrs: "d:DesignWidth=\"800\" d:DesignHeight=\"600\" Height=\"100\"");
            var text = XamlCleaner.Clean(raw);
            var r = XDocument.Parse(text).Root!;
            Check("mc:Ignorable removed", !r.Attributes().Any(a => a.Name.NamespaceName.Contains("markup-compatibility")));
            Check("no d: attributes or elements remain",
                !r.DescendantsAndSelf().Any(e => e.Name.NamespaceName.Contains("expression/blend") ||
                                                  e.Attributes().Any(a => !a.IsNamespaceDeclaration && a.Name.NamespaceName.Contains("expression/blend"))));
            Check("d:/mc: namespace declarations removed", !text.Contains("expression/blend") && !text.Contains("markup-compatibility"), text);
            Eq("root d:DesignWidth -> Width", "800", Attr(r, "Width"));
            Eq("root d:DesignHeight does not overwrite Height", "100", Attr(r, "Height"));
            var sp = First(r, "StackPanel")!;
            Check("non-root d:DesignWidth not mapped", Attr(sp, "Width") is null);
            Check("d:DataContext DesignInstance not promoted", Attr(sp, "DataContext") is null);
            Check("d:LayoutOverrides (not a property) not promoted", Attr(sp, "LayoutOverrides") is null);
            Eq("d:Text -> Text", "Sample", Attr(Named(r, "T1"), "Text"));
            Eq("d:Text never overwrites a real Text", "Real", Attr(Named(r, "T2"), "Text"));
            Check("d:Text with design extension not promoted", Attr(Named(r, "T3"), "Text") is null);
            Check("d:NotAProperty not promoted", Attr(Named(r, "T4"), "NotAProperty") is null);
            Check("design elements removed", First(r, "DesignProperties") is null);
        }

        // ------------------------------------------------------------ R6

        private static void Rule6()
        {
            var missing = new HashSet<string>();
            var r = CleanRoot(Doc(
                "<Page.Resources><SolidColorBrush x:Key=\"Local\" Color=\"Red\" /></Page.Resources>" +
                "<StackPanel>" +
                "<Border x:Name=\"InDoc\" Background=\"{StaticResource Local}\" />" +
                "<Border x:Name=\"InApp\" Background=\"{ThemeResource AppBrush}\" />" +
                "<Border x:Name=\"Missing\" Background=\"{StaticResource Nope}\" />" +
                "<Border x:Name=\"Named\" Background=\"{ThemeResource ResourceKey=AlsoNope}\" />" +
                "<TextBlock x:Name=\"Text\" Text=\"{StaticResource Greeting}\" />" +
                "</StackPanel>"),
                known: k => k == "AppBrush", missing: missing);
            Eq("document key kept", "{StaticResource Local}", Attr(Named(r, "InDoc"), "Background"));
            Eq("app-scope key kept", "{ThemeResource AppBrush}", Attr(Named(r, "InApp"), "Background"));
            Check("unknown key dropped", Attr(Named(r, "Missing"), "Background") is null);
            Check("ResourceKey= form dropped", Attr(Named(r, "Named"), "Background") is null);
            Check("sample off: missing text resource dropped", Attr(Named(r, "Text"), "Text") is null);
            Check("missing keys reported (incl. ResourceKey= form)",
                missing.SetEquals(new[] { "Nope", "AlsoNope", "Greeting" }), string.Join(",", missing));

            var r2 = CleanRoot(Doc("<TextBlock x:Name=\"T\" Text=\"{StaticResource Greeting}\" />"), sample: true);
            Eq("sample on: missing text resource -> {Key} placeholder", "{}{Greeting}", Attr(Named(r2, "T"), "Text"));
            Check("null missing-set tolerated", Attr(Named(CleanRoot(Doc("<Border x:Name=\"B\" Background=\"{StaticResource Z}\" />")), "B"), "Background") is null);

            // Rule 8: a Setter left without a value by Rule 6 is dropped (it would fail the whole document).
            var r3 = CleanRoot(Doc(
                "<Page.Resources><Style x:Key=\"S\" TargetType=\"Button\">" +
                "<Setter Property=\"CornerRadius\" Value=\"{StaticResource Nope}\" />" +
                "<Setter Property=\"Padding\" Value=\"4\" />" +
                "<Setter Property=\"Template\"><Setter.Value><ControlTemplate /></Setter.Value></Setter>" +
                "</Style></Page.Resources><Grid />"), sample: true);
            var props = r3.Descendants().Where(e => e.Name.LocalName == "Setter").Select(e => Attr(e, "Property")).ToList();
            Eq("valueless Setter dropped; others kept", "Padding,Template", string.Join(",", props));
        }

        // ------------------------------------------------------------ R7

        private static readonly Func<string, bool> GoodOnly = n => n.StartsWith("Good.", StringComparison.Ordinal);

        private static void Rule7()
        {
            var raw = Doc(
                "<Grid x:Name=\"Host\">" +
                "<bad:Chart x:Name=\"C\" Grid.Row=\"2\" Grid.Column=\"1\" Width=\"120\" Margin=\"4\" Foo=\"x\" bad:Ext.Prop=\"y\"><TextBlock /></bad:Chart>" +
                "<good:Card x:Name=\"Kept\" />" +
                "<good:CameraPreview x:Name=\"Cam\" />" +
                "<good:Thrower x:Name=\"Thrower\" />" +
                "<good:Other x:Name=\"BySimpleName\" />" +
                "<bad:Interaction.Behaviors><bad:Behavior /></bad:Interaction.Behaviors>" +
                "<bad:Outer x:Name=\"Outer\"><bad:Inner x:Name=\"Inner\" /></bad:Outer>" +
                "</Grid>");
            var r = CleanRoot(raw, provider: GoodOnly, force: new HashSet<string> { "Good.Thrower", "Other" });

            var c = Named(r, "C")!;
            Eq("unmapped custom -> Border placeholder", Pres + "Border", c.Name.ToString());
            Eq("placeholder tagged", XamlCleaner.PlaceholderTag, Attr(c, "Tag"));
            Eq("placeholder labelled with type name", "Chart", Attr(c.Element(Pres + "TextBlock"), "Text"));
            Eq("placeholder keeps Grid.Row", "2", Attr(c, "Grid.Row"));
            Eq("placeholder keeps Grid.Column", "1", Attr(c, "Grid.Column"));
            Eq("placeholder keeps Width", "120", Attr(c, "Width"));
            Eq("placeholder keeps Margin", "4", Attr(c, "Margin"));
            Check("placeholder drops custom properties", Attr(c, "Foo") is null && !c.Attributes().Any(a => a.Name.NamespaceName == "using:Bad"));
            Check("placeholder drops original children", c.Elements().Count() == 1);

            Eq("provider-mapped custom kept", "{using:Good}Card", Named(r, "Kept")?.Name.ToString());
            Eq("pre-swap list (CameraPreview) forced even when mapped", Pres + "Border", Named(r, "Cam")?.Name.ToString());
            Eq("forcePlaceholderTypes full name", Pres + "Border", Named(r, "Thrower")?.Name.ToString());
            Eq("forcePlaceholderTypes simple name", Pres + "Border", Named(r, "BySimpleName")?.Name.ToString());
            Check("unmapped-owner property element removed", First(r, "Interaction.Behaviors") is null && First(r, "Behavior") is null);
            Check("nested unmapped: outer replaced, inner gone with it",
                Named(r, "Outer")?.Name == Pres + "Border" && Named(r, "Inner") is null);

            var off = CleanRoot(raw);
            Eq("no provider: Rule 7 is a no-op", "{using:Bad}Chart", Named(off, "C")?.Name.ToString());

            var throwing = CleanRoot(raw, provider: _ => throw new InvalidOperationException("boom"));
            Eq("throwing provider treated as mapped (kept)", "{using:Bad}Chart", Named(throwing, "C")?.Name.ToString());

            // Safety-net backstop: the wildcard retires every custom element but keeps custom resource
            // entries (a converter) and framework elements.
            var all = CleanRoot(Doc(
                "<Grid x:Name=\"Host\"><Grid.Resources><good:Conv x:Key=\"K\" /></Grid.Resources>" +
                "<good:Card x:Name=\"Mapped\" /><TextBlock x:Name=\"Fw\" /></Grid>"),
                provider: GoodOnly, force: new HashSet<string> { XamlCleaner.ForceAllCustomTypes });
            Eq("wildcard force: mapped custom -> placeholder", Pres + "Border", Named(all, "Mapped")?.Name.ToString());
            Check("wildcard force: custom resource entry kept", First(all, "Conv") is not null);
            Eq("wildcard force: framework element kept", Pres + "TextBlock", Named(all, "Fw")?.Name.ToString());

            var clr = CleanRoot(Doc("<legacy:Gauge x:Name=\"G\" xmlns:legacy=\"clr-namespace:Bad.Legacy;assembly=Bad\" />"),
                provider: n => n != "Bad.Legacy.Gauge");
            Eq("clr-namespace: custom type resolved by full name", Pres + "Border", Named(clr, "G")?.Name.ToString());

            // Unmapped-type report (drives the extension's "project not built" hint): every custom type the
            // provider can't map, including forced and property-element owners; mapped+forced types excluded.
            var unmapped = new SortedSet<string>(StringComparer.Ordinal);
            XamlCleaner.Clean(raw, providerMapsFullName: GoodOnly, forcePlaceholderTypes: new HashSet<string> { "Good.Thrower", "Other" }, unmappedTypes: unmapped);
            Eq("unmappedTypes: only provider-unmappable types", "Bad.Chart,Bad.Interaction,Bad.Outer", string.Join(",", unmapped));
            var none = new SortedSet<string>(StringComparer.Ordinal);
            XamlCleaner.Clean(Doc("<Grid><good:Card /></Grid>"), providerMapsFullName: GoodOnly, unmappedTypes: none);
            Check("unmappedTypes: empty when everything maps", none.Count == 0, string.Join(",", none));
        }

        private static void Rule7abc()
        {
            var missing = new HashSet<string>();
            var r = CleanRoot(Doc(
                "<Page.Resources>" +
                "<bad:BoolToVis x:Key=\"Conv\" />" +
                "<good:KeptConv x:Key=\"Kept\" />" +
                "<ResourceDictionary><bad:Brushy x:Key=\"InDict\" /></ResourceDictionary>" +
                "</Page.Resources>" +
                "<StackPanel x:Name=\"P\" bad:Implicit.ShowAnimations=\"x\" good:Attached.Prop=\"y\" Grid.Row=\"3\">" +
                "<TextBlock x:Name=\"Only\" Text=\"{Binding V, Converter={StaticResource Conv}}\" />" +
                "<TextBlock x:Name=\"Middle\" Text=\"{Binding V, Converter={StaticResource Conv}, Mode=OneWay}\" />" +
                "<TextBlock x:Name=\"First\" Text=\"{Binding Converter={StaticResource Conv}, Path=V}\" />" +
                "<TextBlock x:Name=\"KeptConv\" Text=\"{Binding V, Converter={StaticResource Kept}}\" />" +
                "<Border x:Name=\"Ref\" Background=\"{StaticResource Conv}\" />" +
                "<Border x:Name=\"DictRef\" Background=\"{StaticResource InDict}\" />" +
                "<Button x:Name=\"Ext\" Content=\"{bad:FontIcon Glyph=&#xE700;}\" />" +
                "<Button x:Name=\"GoodExt\" Content=\"{good:Icon Glyph=x}\" />" +
                "<Button x:Name=\"GoodExtSuffix\" Content=\"{good2:Icon Glyph=x}\" xmlns:good2=\"using:Suffixed\" />" +
                "<Button x:Name=\"Framework\" Content=\"{Binding X}\" />" +
                "</StackPanel>"),
                provider: n => GoodOnly(n) || n == "Suffixed.IconExtension", missing: missing);

            Check("unmapped resource entry dropped", First(r, "BoolToVis") is null);
            Check("unmapped entry inside ResourceDictionary dropped", First(r, "Brushy") is null);
            Check("mapped resource entry kept", First(r, "KeptConv") is not null);

            var p = Named(r, "P");
            Check("R7a: unmapped custom attached property stripped", !p!.Attributes().Any(a => a.Name.LocalName == "Implicit.ShowAnimations"));
            Check("R7a: mapped custom attached property kept", p.Attributes().Any(a => a.Name.LocalName == "Attached.Prop"));
            Eq("R7a: framework attached property kept", "3", Attr(p, "Grid.Row"));

            Eq("R7c: converter clause (only trailing arg) stripped", "{Binding V}", Attr(Named(r, "Only"), "Text"));
            Eq("R7c: converter clause between args keeps one separator", "{Binding V, Mode=OneWay}", Squash(Attr(Named(r, "Middle"), "Text")));
            Eq("R7c: converter clause as first arg stripped", "{Binding Path=V}", Squash(Attr(Named(r, "First"), "Text")));
            Eq("R7c: converter not dropped -> untouched", "{Binding V, Converter={StaticResource Kept}}", Attr(Named(r, "KeptConv"), "Text"));
            Check("R6+R7: direct reference to dropped key removed", Attr(Named(r, "Ref"), "Background") is null);
            Check("R6+R7: reference into dropped dictionary entry removed", Attr(Named(r, "DictRef"), "Background") is null);
            Check("dropped keys reported missing", missing.Contains("Conv") && missing.Contains("InDict"), string.Join(",", missing));

            Check("R7b: unmapped custom markup extension stripped", Attr(Named(r, "Ext"), "Content") is null);
            Eq("R7b: mapped custom extension kept", "{good:Icon Glyph=x}", Attr(Named(r, "GoodExt"), "Content"));
            Eq("R7b: ...Extension-suffixed mapping kept", "{good2:Icon Glyph=x}", Attr(Named(r, "GoodExtSuffix"), "Content"));
            Eq("R7b: framework extension kept", "{Binding X}", Attr(Named(r, "Framework"), "Content"));
        }

        // ------------------------------------------------------------ design-time data grammar

        private const string DtdNs =
            "xmlns=\"" + PresNs + "\" xmlns:d=\"http://schemas.microsoft.com/expression/blend/2008\" " +
            "xmlns:f=\"using:My.Vms\" xmlns:c=\"clr-namespace:Legacy.Vms;assembly=Legacy\" xmlns:g=\"using:\"";

        private static DesignTimeData.Spec? DtdSpec(string dataContext) =>
            DesignTimeData.ExtractRootSpec($"<Page {DtdNs} d:DataContext=\"{dataContext}\"/>");

        private static void DtdGrammar()
        {
            // Never throws, and anything it can't understand is null.
            Check("null / blank markup -> null", DesignTimeData.ExtractRootSpec(null) is null && DesignTimeData.ExtractRootSpec("  ") is null);
            Check("malformed XML -> null", DesignTimeData.ExtractRootSpec("<Page d:DataContext=\"{d:DesignInstance f:Vm}\"") is null);
            Check("no d:DataContext -> null", DesignTimeData.ExtractRootSpec($"<Page {DtdNs}/>") is null);
            Check("plain (non-design) DataContext ignored",
                DesignTimeData.ExtractRootSpec($"<Page {DtdNs} DataContext=\"{{d:DesignInstance f:Vm}}\"/>") is null);
            Check("only the root's d:DataContext counts",
                DesignTimeData.ExtractRootSpec($"<Page {DtdNs}><Grid d:DataContext=\"{{d:DesignInstance f:Vm}}\"/></Page>") is null);
            foreach (var bad in new[] { "Hello", "{d:DesignInstance f:Vm", "d:DesignInstance f:Vm}", "{}", "{d:DesignInstance}",
                                        "{d:DesignInstance Type=}", "{d:DesignInstance Type=nope:Vm}", "{d:DesignInstance Vm}",
                                        "{d:Unknown Type=f:Vm}", "{d:DesignData}", "{d:DesignData Source=}", "{d:DesignData Source=''}" })
            {
                Check($"'{bad}' -> null", DtdSpec(bad) is null);
            }

            // DesignInstance type tokens.
            var s = DtdSpec("{d:DesignInstance Type=f:Vm}");
            Check("Type= with using: prefix", s is { Kind: DesignTimeData.SpecKind.DesignInstance, TypeFullName: "My.Vms.Vm", IsDesignTimeCreatable: false, CreateList: false },
                s?.TypeFullName);
            Eq("Raw keeps the original text", "{d:DesignInstance Type=f:Vm}", s?.Raw);
            Eq("positional type", "My.Vms.Vm", DtdSpec("{d:DesignInstance f:Vm}")?.TypeFullName);
            Eq("named Type wins over positional", "My.Vms.Vm", DtdSpec("{d:DesignInstance f:Other, Type=f:Vm}")?.TypeFullName);
            Eq("clr-namespace with assembly", "Legacy.Vms.Vm", DtdSpec("{d:DesignInstance Type=c:Vm}")?.TypeFullName);
            Eq("empty using: namespace -> bare name", "Vm", DtdSpec("{d:DesignInstance Type=g:Vm}")?.TypeFullName);
            Eq("quoted value", "My.Vms.Vm", DtdSpec("{d:DesignInstance Type='f:Vm'}")?.TypeFullName);
            Eq("keys are case-insensitive", "My.Vms.Vm", DtdSpec("{d:DesignInstance type=f:Vm}")?.TypeFullName);
            Eq("whitespace around '=' and ','", "My.Vms.Vm", DtdSpec("{d:DesignInstance   Type = f:Vm ,  CreateList = True }")?.TypeFullName);
            Eq("tab after the extension name", "My.Vms.Vm", DtdSpec("{d:DesignInstance\tType=f:Vm}")?.TypeFullName);
            Eq("extension without a prefix", "My.Vms.Vm", DtdSpec("{DesignInstance Type=f:Vm}")?.TypeFullName);

            // Named booleans.
            foreach (var (text, want) in new[] { ("True", true), ("true", true), ("TRUE", true), ("1", true), (" True ", true),
                                                 ("False", false), ("false", false), ("0", false), ("yes", false), ("", false) })
            {
                var b = DtdSpec($"{{d:DesignInstance Type=f:Vm, IsDesignTimeCreatable={text}, CreateList={text}}}");
                Check($"bool '{text}' -> {want}", b != null && b.IsDesignTimeCreatable == want && b.CreateList == want,
                    b == null ? "null spec" : $"{b.IsDesignTimeCreatable}/{b.CreateList}");
            }
            var both = DtdSpec("{d:DesignInstance f:Vm, CreateList=True}");
            Check("positional type + named CreateList", both is { TypeFullName: "My.Vms.Vm", CreateList: true, IsDesignTimeCreatable: false });
            Check("unknown named args ignored", DtdSpec("{d:DesignInstance Type=f:Vm, Foo=Bar}")?.TypeFullName == "My.Vms.Vm");

            // DesignData sources.
            var dd = DtdSpec("{d:DesignData Source=Sample.xaml}");
            Check("DesignData Source=", dd is { Kind: DesignTimeData.SpecKind.DesignData, Source: "Sample.xaml" }, dd?.Source);
            Eq("DesignData positional source", "Data/Sample.xaml", DtdSpec("{d:DesignData Data/Sample.xaml}")?.Source);
            Eq("DesignData quoted source with spaces", "My Data/Sample.xaml", DtdSpec("{d:DesignData Source='My Data/Sample.xaml'}")?.Source);
            Eq("DesignData leading slash kept for the resolver", "/Data/Sample.xaml", DtdSpec("{d:DesignData Source=/Data/Sample.xaml}")?.Source);
            Eq("DesignData absolute path", @"C:\data\Sample.xaml", DtdSpec(@"{d:DesignData Source=C:\data\Sample.xaml}")?.Source);
        }

        private static void DtdPaths()
        {
            var root = Path.Combine(Path.GetTempPath(), "wxp-dtd-" + Guid.NewGuid().ToString("N"));
            var sub = Path.Combine(root, "Data");
            Directory.CreateDirectory(sub);
            try
            {
                var top = Path.Combine(root, "Top.xaml");
                var nested = Path.Combine(sub, "Nested.xaml");
                File.WriteAllText(top, "x");
                File.WriteAllText(nested, "x");

                Eq("relative to baseDir", top, DesignTimeData.ResolveSourcePath("Top.xaml", root));
                Eq("leading '/' is baseDir-relative", top, DesignTimeData.ResolveSourcePath("/Top.xaml", root));
                Eq("leading '\\' is baseDir-relative", top, DesignTimeData.ResolveSourcePath("\\Top.xaml", root));
                Eq("forward-slash subfolder", Path.GetFullPath(nested), Path.GetFullPath(DesignTimeData.ResolveSourcePath("Data/Nested.xaml", root) ?? "?"));
                Eq("backslash subfolder", nested, DesignTimeData.ResolveSourcePath("Data\\Nested.xaml", root));
                Eq("surrounding whitespace trimmed", top, DesignTimeData.ResolveSourcePath("  Top.xaml  ", root));
                Eq("absolute path without a baseDir", nested, DesignTimeData.ResolveSourcePath(nested, null));
                Eq("absolute path wins over baseDir", nested, DesignTimeData.ResolveSourcePath(nested, Path.GetTempPath()));
                Check("missing file -> null", DesignTimeData.ResolveSourcePath("Gone.xaml", root) is null);
                Check("missing absolute file -> null", DesignTimeData.ResolveSourcePath(Path.Combine(root, "Gone.xaml"), null) is null);
                Check("relative with no baseDir and not beside the exe -> null", DesignTimeData.ResolveSourcePath("Top.xaml", null) is null);
                Check("blank source -> null", DesignTimeData.ResolveSourcePath("   ", root) is null);
                Check("a directory is not a file", DesignTimeData.ResolveSourcePath("Data", root) is null);
            }
            finally
            {
                try { Directory.Delete(root, true); } catch { }
            }

            const string tb = "<TextBlock/>";
            Eq("plain markup unchanged", tb, DesignTimeData.PrepareForXamlReader(tb));
            Eq("empty unchanged", "", DesignTimeData.PrepareForXamlReader(""));
            Eq("BOM stripped", tb, DesignTimeData.PrepareForXamlReader("\uFEFF" + tb));
            Eq("XML declaration stripped", tb, DesignTimeData.PrepareForXamlReader("<?xml version=\"1.0\" encoding=\"utf-8\"?>\r\n" + tb));
            Eq("BOM + whitespace + declaration stripped", tb, DesignTimeData.PrepareForXamlReader("\uFEFF \r\n<?XML version=\"1.0\"?>" + tb));
            Eq("comment kept", "<!-- c -->" + tb, DesignTimeData.PrepareForXamlReader("<?xml version=\"1.0\"?><!-- c -->" + tb));
            Eq("unterminated declaration left alone", "<?xml version", DesignTimeData.PrepareForXamlReader("<?xml version"));
        }
    }
}
