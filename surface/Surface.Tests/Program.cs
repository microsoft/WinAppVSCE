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
            Run("R2 TryParseBind/BindPathLabel", BindParsing);
            Run("R3 x: directives", Rule3);
            Run("R4 events", Rule4);
            Run("R5 design namespaces", Rule5);
            Run("R6 resources", Rule6);
            Run("R7 unmapped custom types", Rule7);
            Run("R7a/b/c attached, extensions, converters", Rule7abc);
            Run("DTD grammar", DtdGrammar);
            Run("DTD source paths + file prep", DtdPaths);

            foreach (var f in s_failures)
            {
                Console.WriteLine("  FAILED: " + f);
            }
            Console.WriteLine($"===== CLEANER: {s_pass} passed, {s_fail} failed =====");
            return s_fail == 0 ? 0 : 1;
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
            ISet<string>? missing = null) =>
            XDocument.Parse(XamlCleaner.Clean(xaml, known, provider, force, sample, missing)).Root!;

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
            Eq("path -> {LastSegment} (escaped)", "{}{Name}", Attr(Named(r, "Path"), "Text"));
            Eq("FallbackValue wins (single quotes stripped)", "Hello, world", Attr(Named(r, "Fallback"), "Text"));
            Eq("TargetNullValue used", "Nothing", Attr(Named(r, "NullValue"), "Text"));
            Eq("function binding -> Func(…)", "Format(…)", Attr(Named(r, "Func"), "Text"));
            Eq("object-typed Content gets placeholder", "{}{Label}", Attr(Named(r, "Btn"), "Content"));
            Check("non-text property still dropped", Attr(Named(r, "Width"), "Width") is null);
            Eq("d: value wins over x:Bind placeholder", "Design value", Attr(Named(r, "DWins"), "Text"));
            Check("unparsable binding (positional after first) dropped", Attr(Named(r, "Unparsable"), "Text") is null);
            Check("bound list: ItemsSource dropped", Attr(Named(r, "List"), "ItemsSource") is null);
            Eq("bound list: sample marker in Tag", SampleListFiller.TagPrefix + "{Orders}", Attr(Named(r, "List"), "Tag"));
            Eq("bound list with existing Tag: Tag untouched", "Mine", Attr(Named(r, "Tagged"), "Tag"));
            Check("x:Bind Tag on non-list just dropped", Attr(Named(r, "NoItems"), "Tag") is null);
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
