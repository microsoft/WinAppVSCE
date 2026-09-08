using System;
using System.Collections.Generic;
using System.Xml;
using System.Xml.Linq;

namespace WinUIXamlPreview.Editor
{
    /// <summary>
    /// A pure (no VS types) bridge between XAML source text and the surface's authored-tree index paths
    /// (plan §41 #1/#2). It parses the buffer text into an <see cref="XDocument"/> with line info and walks
    /// the authored element tree in the SAME child-ordering model the surface uses at runtime
    /// (<c>DesignSurface.AuthoredChildren</c>), so a path like <c>"0.1.0"</c> means the same element on both
    /// sides. It exposes:
    /// <list type="bullet">
    ///   <item><see cref="TryGetSpan"/> — path -> [startOffset, endOffset) text span (for selection -> caret);</item>
    ///   <item><see cref="PathForOffset"/> — caret offset -> the innermost authored element's path (caret -> selection).</item>
    /// </list>
    /// Best-effort by design: heavily-templated / multi-property-element / design-namespace edge cases may
    /// resolve to a nearby element or to nothing, but never mutate the source. When resolution diverges the
    /// surface returns null rather than a wrong element, so a mismatch is a safe no-op.
    /// </summary>
    internal sealed class XamlSourceMap
    {
        // Namespaces the surface's XamlCleaner strips before parsing, so the client must NOT count their
        // elements as authored children (doing so would shift sibling indices vs. the surface).
        private const string DesignNs = "http://schemas.microsoft.com/expression/blend/2008";
        private const string McNs = "http://schemas.openxmlformats.org/markup-compatibility/2006";

        // The XAML *language* namespace (conventionally the "x:" prefix). Its elements are language
        // primitives/directives — x:String, x:Int32, x:Double, x:Boolean, x:Null, x:Array, x:Reference, … —
        // which are never FrameworkElements, so the surface's FE-only DesignSurface.AuthoredChildren prunes
        // them. The client must prune them too: a non-FE item placed before an FE sibling in a walked content
        // collection (e.g. <x:String> before <ComboBoxItem>) would otherwise shift every following sibling
        // index and desync the selection paths (bug D2).
        private const string XamlNs = "http://schemas.microsoft.com/winfx/2006/xaml";

        // The default WinUI presentation namespace. The text/inline/document element names below live here.
        private const string PresentationNs = "http://schemas.microsoft.com/winfx/2006/xaml/presentation";

        // Text/inline/document element local names (Inline/Block/TextElement subtypes + GradientStop). These
        // derive from TextElement, NOT FrameworkElement, so the surface never yields them from AuthoredChildren;
        // counting them here would shift sibling indices (bug D2). Matched only in the presentation namespace so
        // a custom control that happens to share one of these names is left untouched.
        private static readonly HashSet<string> NonFrameworkElementNames =
            new HashSet<string>(StringComparer.Ordinal)
            {
                "Run", "LineBreak", "Span", "Bold", "Italic", "Underline",
                "Hyperlink", "Paragraph", "InlineUIContainer", "GradientStop",
            };

        // .NET BCL primitive/value types commonly authored as XAML content via a CLR namespace (e.g.
        // xmlns:sys="using:System" then <sys:String>Alpha</sys:String>). None derive from FrameworkElement,
        // so the surface's FE-only DesignSurface.AuthoredChildren prunes them; the client must prune them too
        // or a primitive placed before an FE sibling shifts every following sibling index and desyncs the
        // selection paths (bug D2 / d2-sysstring-residual). Matched only in the System CLR namespace (see
        // IsSystemClrNamespace) so an unrelated control that happens to share one of these names is untouched.
        private static readonly HashSet<string> SystemPrimitiveNames =
            new HashSet<string>(StringComparer.Ordinal)
            {
                "String", "Boolean", "Byte", "SByte", "Char", "Decimal",
                "Double", "Single", "Int16", "Int32", "Int64",
                "UInt16", "UInt32", "UInt64", "Object", "TimeSpan",
                "Uri", "DateTime", "DateTimeOffset", "Guid",
            };

        // Content-property elements the surface recurses INTO (Panel.Children, *.Content, Border/Viewbox.Child,
        // ItemsControl.Items). Any other property element (RowDefinitions, Resources, attached props, Flyout…)
        // is skipped, matching DesignSurface.AuthoredChildren.
        private static readonly HashSet<string> ContentProps =
            new HashSet<string>(StringComparer.Ordinal) { "Children", "Content", "Child", "Items" };

        private readonly Dictionary<string, (int Start, int End)> _pathToSpan;

        // Pre-order authored elements (path + start offset + depth), used for offset -> path lookup.
        private readonly List<(string Path, int Start, int Depth)> _preorder;

        private XamlSourceMap(
            Dictionary<string, (int, int)> pathToSpan,
            List<(string, int, int)> preorder)
        {
            _pathToSpan = pathToSpan;
            _preorder = preorder;
        }

        /// <summary>Whether the map has at least the root element.</summary>
        public bool HasContent => _preorder.Count > 0;

        /// <summary>
        /// Builds a source map from XAML <paramref name="text"/>. Returns null if the text can't be parsed
        /// (e.g. mid-edit it isn't well-formed) — callers should keep the last good map in that case.
        /// <paramref name="contentPropByType"/> (bug D1) is the surface-reported map of simple runtime type
        /// name -> its CUSTOM content-property name (e.g. "ControlExample" -> "Example"); when a property
        /// element's owner/prop matches an entry, the walk recurses into it just like a standard content
        /// property. Null/omitted preserves the original behaviour (standard content props only).
        /// </summary>
        public static XamlSourceMap? Build(string? text, IReadOnlyDictionary<string, string>? contentPropByType = null)
        {
            if (string.IsNullOrEmpty(text))
            {
                return null;
            }

            XDocument doc;
            try
            {
                doc = XDocument.Parse(text, LoadOptions.SetLineInfo);
            }
            catch
            {
                return null;
            }

            var rootEl = doc.Root;
            if (rootEl is null)
            {
                return null;
            }

            var lineStarts = BuildLineStarts(text!);
            var pathToSpan = new Dictionary<string, (int, int)>(StringComparer.Ordinal);
            var preorder = new List<(string, int, int)>();

            // The XML root maps to surface path "0" (the design canvas's single child == the page root).
            Walk(rootEl, "0", 0, lineStarts, text!.Length, pathToSpan, preorder, contentPropByType);

            // Second pass: end offset = start of the next pre-order element that is NOT a descendant (i.e. the
            // next entry at depth <= this one), or end-of-text. This yields properly-nested containment spans.
            for (int i = 0; i < preorder.Count; i++)
            {
                var (path, start, depth) = preorder[i];
                int end = text.Length;
                for (int j = i + 1; j < preorder.Count; j++)
                {
                    if (preorder[j].Item3 <= depth)
                    {
                        end = preorder[j].Item2;
                        break;
                    }
                }

                pathToSpan[path] = (start, end);
            }

            return new XamlSourceMap(pathToSpan, preorder);
        }

        private static void Walk(
            XElement element,
            string path,
            int depth,
            int[] lineStarts,
            int textLength,
            Dictionary<string, (int, int)> pathToSpan,
            List<(string, int, int)> preorder,
            IReadOnlyDictionary<string, string>? contentPropByType)
        {
            int start = StartOffset(element, lineStarts, textLength);
            pathToSpan[path] = (start, textLength); // provisional end; finalized in the second pass
            preorder.Add((path, start, depth));

            int index = 0;
            foreach (var child in AuthoredChildElements(element, contentPropByType))
            {
                Walk(child, path + "." + index, depth + 1, lineStarts, textLength, pathToSpan, preorder, contentPropByType);
                index++;
            }
        }

        /// <summary>
        /// The authored child elements of <paramref name="parent"/> in document order, mirroring the surface's
        /// <c>DesignSurface.AuthoredChildren</c>: skip design/mc-namespace elements AND elements that can never
        /// be a <c>FrameworkElement</c> (XAML language primitives like <c>x:String</c> and text/inline
        /// <c>TextElement</c>s like <c>Run</c>) — the surface's FE-only enumeration prunes these, so counting
        /// them here would shift sibling indices (bug D2); recurse INTO a content-property element
        /// (<c>Owner.Children/.Content/.Child/.Items</c>, plus any custom owner/content-prop pair the surface
        /// reported via <paramref name="contentPropByType"/> — bug D1); include implicit (no-dot) content
        /// elements directly; skip every other property element.
        /// </summary>
        private static IEnumerable<XElement> AuthoredChildElements(
            XElement parent,
            IReadOnlyDictionary<string, string>? contentPropByType)
        {
            foreach (var child in parent.Elements())
            {
                if (IsSkippedChild(child))
                {
                    continue;
                }

                string local = child.Name.LocalName;
                int dot = local.LastIndexOf('.');
                if (dot >= 0)
                {
                    // Property element. Recurse into a content property; skip the rest. A property element is a
                    // content property when its name is a standard one, OR when the surface reported that the
                    // owner type's custom content property is exactly this prop (bug D1).
                    string owner = local.Substring(0, dot);
                    string prop = local.Substring(dot + 1);
                    bool isContent = ContentProps.Contains(prop)
                        || (contentPropByType != null
                            && contentPropByType.TryGetValue(owner, out var cp)
                            && cp == prop);
                    if (isContent)
                    {
                        foreach (var gc in child.Elements())
                        {
                            if (!IsSkippedChild(gc))
                            {
                                yield return gc;
                            }
                        }
                    }
                }
                else
                {
                    yield return child;
                }
            }
        }

        private static bool IsIgnoredNamespace(XElement el)
        {
            string ns = el.Name.NamespaceName;
            return ns == DesignNs || ns == McNs;
        }

        /// <summary>
        /// True when <paramref name="el"/> can never be a <see cref="Microsoft.UI.Xaml.FrameworkElement"/> the
        /// surface would count as an authored child: a XAML language-namespace primitive/directive (x:String,
        /// x:Int32, …); a text/inline/document element (Run, Span, GradientStop, …) in the presentation
        /// namespace; or a .NET System primitive authored via a CLR namespace (using:System /
        /// clr-namespace:System — e.g. &lt;sys:String&gt;). Keeps the client's child indexing in lockstep with
        /// the surface's FE-only enumeration (bug D2 / d2-sysstring-residual).
        /// </summary>
        private static bool IsNonFrameworkElement(XElement el)
        {
            string ns = el.Name.NamespaceName;
            if (ns == XamlNs)
            {
                return true;
            }

            if (ns == PresentationNs && NonFrameworkElementNames.Contains(el.Name.LocalName))
            {
                return true;
            }

            // A .NET System primitive authored via a CLR namespace (WinUI "using:System" or WPF-style
            // "clr-namespace:System[;assembly=...]"). That namespace unambiguously resolves to .NET System and
            // these BCL types are provably not FrameworkElements, so the surface prunes them; mirroring that
            // here keeps sibling indices aligned and cannot over-prune a real FrameworkElement.
            return IsSystemClrNamespace(ns) && SystemPrimitiveNames.Contains(el.Name.LocalName);
        }

        /// <summary>
        /// True when <paramref name="ns"/> is the .NET <c>System</c> CLR namespace in either XAML form:
        /// WinUI/UWP <c>using:System</c>, or WPF-style <c>clr-namespace:System</c> optionally followed by
        /// <c>;assembly=…</c> (the assembly qualifier is ignored — the <c>clr-namespace:</c> portion decides).
        /// </summary>
        private static bool IsSystemClrNamespace(string ns)
        {
            if (ns == "using:System")
            {
                return true;
            }

            const string ClrPrefix = "clr-namespace:";
            if (ns.StartsWith(ClrPrefix, StringComparison.Ordinal))
            {
                string decl = ns.Substring(ClrPrefix.Length);
                int semi = decl.IndexOf(';');
                if (semi >= 0)
                {
                    decl = decl.Substring(0, semi);
                }

                return decl == "System";
            }

            return false;
        }

        /// <summary>An element that must NOT be counted as an authored child: a stripped design/mc-namespace
        /// element, or a non-FrameworkElement (see <see cref="IsNonFrameworkElement"/>).</summary>
        private static bool IsSkippedChild(XElement el) =>
            IsIgnoredNamespace(el) || IsNonFrameworkElement(el);

        /// <summary>Path -> [start, end) text span, or false if the path isn't in the map.</summary>
        public bool TryGetSpan(string? path, out int start, out int end)
        {
            start = 0;
            end = 0;
            if (string.IsNullOrEmpty(path) || !_pathToSpan.TryGetValue(path!, out var span))
            {
                return false;
            }

            start = span.Start;
            end = span.End;
            return true;
        }

        /// <summary>
        /// The authored path of the innermost element whose span contains <paramref name="offset"/>, or null.
        /// "Innermost" = the largest start offset with start &lt;= offset &lt; end (deeper elements start later).
        /// </summary>
        public string? PathForOffset(int offset)
        {
            string? best = null;
            int bestStart = -1;
            foreach (var (path, start, _) in _preorder)
            {
                if (start > offset)
                {
                    continue; // pre-order is not sorted by start in general; check all
                }

                if (_pathToSpan.TryGetValue(path, out var span) &&
                    offset >= span.Start && offset < span.End &&
                    span.Start > bestStart)
                {
                    best = path;
                    bestStart = span.Start;
                }
            }

            return best;
        }

        // ---- offset helpers ----------------------------------------------------

        private static int[] BuildLineStarts(string text)
        {
            var starts = new List<int> { 0 };
            for (int i = 0; i < text.Length; i++)
            {
                if (text[i] == '\n')
                {
                    starts.Add(i + 1);
                }
            }

            return starts.ToArray();
        }

        /// <summary>
        /// The 0-based offset of the '&lt;' that opens <paramref name="element"/>'s start tag. IXmlLineInfo
        /// points at the element NAME (the char after '&lt;'), so the '&lt;' is one column earlier.
        /// </summary>
        private static int StartOffset(XElement element, int[] lineStarts, int textLength)
        {
            var info = (IXmlLineInfo)element;
            if (!info.HasLineInfo() || info.LineNumber < 1 || info.LineNumber > lineStarts.Length)
            {
                return 0;
            }

            int nameOffset = lineStarts[info.LineNumber - 1] + (info.LinePosition - 1);
            int ltOffset = nameOffset - 1; // the '<'
            if (ltOffset < 0)
            {
                ltOffset = 0;
            }

            return ltOffset > textLength ? textLength : ltOffset;
        }
    }
}
