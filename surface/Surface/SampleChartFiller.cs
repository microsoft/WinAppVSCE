using System;
using System.Collections;
using System.Numerics;
using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.UI.Composition;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Hosting;
using Microsoft.UI.Xaml.Media;
using Windows.UI;

namespace Surface;

/// <summary>
/// Sample data for charts. Chart data is almost always built in code (<c>chart.Series.Add(...)</c>, or Path geometry
/// computed in a SizeChanged handler), which the preview never runs. Two shapes are recognized:
/// <list type="bullet">
/// <item>a control whose type name ends in Chart, Graph, Plot or Sparkline and whose series/items collection is empty;</item>
/// <item>an element named like a chart (x:Name ending in Chart, Graph, Plot, Spark, Sparkline or Trend) whose
/// geometry shapes (Path, Polyline, Polygon, Line) are all still empty.</item>
/// </list>
/// Either gets a generated line drawn over it as a composition child visual. A control that renders through its own
/// child visual (the WinAppSDK Chart does) keeps it: the line moves to the nearest ancestor without one, offset to the
/// control's bounds. The XAML tree is untouched (selection and element paths are unaffected). Never throws.
/// </summary>
internal static class SampleChartFiller
{
    private const int MaxLayoutPasses = 60;
    private const int Points = 24;
    private static readonly Regex ChartType = new("(Chart|Graph|Plot|Sparkline)$", RegexOptions.CultureInvariant);
    private static readonly Regex ChartName = new(@"(chart|graph|plot|spark|sparkline|trend)\d*$",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
    private static readonly string[] DataProperties = { "Series", "ItemsSource", "Points", "Values" };
    private static readonly object NotEmpty = new();
    private static readonly ConditionalWeakTable<FrameworkElement, object> Seen = new();
    private static int s_instances = -1;

    /// <summary>Watch <paramref name="root"/>'s layout passes for empty charts (user controls realize theirs late).</summary>
    public static void Attach(FrameworkElement root)
    {
        int passes = 0;
        EventHandler<object>? handler = null;
        handler = (_, _) =>
        {
            try
            {
                Scan(root);
            }
            catch (Exception ex)
            {
                App.Log($"SAMPLE: chart scan failed: {ex.GetType().Name}: {ex.Message}");
                passes = MaxLayoutPasses;
            }
            if (++passes >= MaxLayoutPasses)
            {
                root.LayoutUpdated -= handler;
            }
        };
        root.LayoutUpdated += handler;
    }

    private static void Scan(DependencyObject node)
    {
        if (node is FrameworkElement fe)
        {
            bool byType = ChartType.IsMatch(fe.GetType().Name);
            bool byName = !byType && !string.IsNullOrEmpty(fe.Name) && ChartName.IsMatch(fe.Name);
            if (byType || byName)
            {
                if (!Seen.TryGetValue(fe, out var state))
                {
                    if (byType ? HasEmptyData(fe) : HasOnlyEmptyGeometry(fe))
                    {
                        Seen.AddOrUpdate(fe, new Placeholder(fe));
                        App.Log($"SAMPLE: drew a placeholder series on empty {fe.GetType().Name}{(string.IsNullOrEmpty(fe.Name) ? "" : " " + fe.Name)}.");
                        return;
                    }
                    Seen.AddOrUpdate(fe, NotEmpty);
                }
                else if (state is Placeholder)
                {
                    return;
                }
                if (byType)
                {
                    return; // a chart's own parts are not charts
                }
            }
        }

        int n = VisualTreeHelper.GetChildrenCount(node);
        for (int i = 0; i < n; i++)
        {
            Scan(VisualTreeHelper.GetChild(node, i));
        }
    }

    /// <summary>True when the control's first data collection is null or has no items; false when it can't tell.</summary>
    private static bool HasEmptyData(FrameworkElement chart)
    {
        foreach (var name in DataProperties)
        {
            var p = chart.GetType().GetProperty(name);
            if (p is null || p.GetIndexParameters().Length > 0)
            {
                continue;
            }
            var value = p.GetValue(chart);
            if (value is null)
            {
                return true;
            }
            if (value is IEnumerable e)
            {
                var it = e.GetEnumerator();
                return !it.MoveNext();
            }
            return false;
        }
        return false;
    }

    /// <summary>True when the subtree has geometry shapes and every one of them is still empty (filled in code).</summary>
    private static bool HasOnlyEmptyGeometry(DependencyObject root)
    {
        int shapes = 0;
        bool Walk(DependencyObject node)
        {
            switch (node)
            {
                case Microsoft.UI.Xaml.Shapes.Path p:
                    shapes++;
                    if (p.Data is not null)
                    {
                        return false;
                    }
                    break;
                case Microsoft.UI.Xaml.Shapes.Polyline pl:
                    shapes++;
                    if (pl.Points.Count > 0)
                    {
                        return false;
                    }
                    break;
                case Microsoft.UI.Xaml.Shapes.Polygon pg:
                    shapes++;
                    if (pg.Points.Count > 0)
                    {
                        return false;
                    }
                    break;
                case Microsoft.UI.Xaml.Shapes.Line l:
                    shapes++;
                    if (l.X1 != l.X2 || l.Y1 != l.Y2)
                    {
                        return false;
                    }
                    break;
            }
            int n = VisualTreeHelper.GetChildrenCount(node);
            for (int i = 0; i < n; i++)
            {
                if (!Walk(VisualTreeHelper.GetChild(node, i)))
                {
                    return false;
                }
            }
            return true;
        }
        return Walk(root) && shapes > 0;
    }

    /// <summary>The generated line on one element, kept clear of any child visual the element installs itself.</summary>
    private sealed class Placeholder
    {
        private readonly FrameworkElement _host;
        private readonly Compositor _compositor;
        private readonly ShapeVisual _shapes;
        private readonly Color _accent;
        private readonly int _phase = Interlocked.Increment(ref s_instances) * 5;
        private UIElement? _owner;
        private bool _failed;

        public Placeholder(FrameworkElement host)
        {
            _host = host;
            _compositor = ElementCompositionPreview.GetElementVisual(host).Compositor;
            _shapes = _compositor.CreateShapeVisual();
            _accent = Color.FromArgb(0xFF, 0x00, 0x78, 0xD4);
            if (Application.Current?.Resources.TryGetValue("SystemAccentColor", out var c) == true && c is Color ac)
            {
                _accent = ac;
            }
            host.SizeChanged += (_, _) => Draw();
            host.LayoutUpdated += (_, _) => Ensure();
            Draw();
        }

        /// <summary>
        /// Install the line on the element, or, when the element renders through its own child visual (which must not
        /// be replaced or reparented), on the nearest ancestor without one, offset to the element's bounds.
        /// </summary>
        private void Ensure()
        {
            if (_failed)
            {
                return;
            }
            try
            {
                if (_owner is not null && ReferenceEquals(ElementCompositionPreview.GetElementChildVisual(_owner), _shapes))
                {
                    Position();
                    return;
                }
                _owner = null;
                if (ElementCompositionPreview.GetElementChildVisual(_host) is null)
                {
                    Install(_host);
                    return;
                }
                for (var p = VisualTreeHelper.GetParent(_host); p is not null; p = VisualTreeHelper.GetParent(p))
                {
                    if (p is UIElement u && ElementCompositionPreview.GetElementChildVisual(u) is null)
                    {
                        Install(u);
                        return;
                    }
                }
                _failed = true;
                App.Log($"SAMPLE: no free composition host for the {_host.GetType().Name} placeholder; skipped.");
            }
            catch (Exception ex)
            {
                _failed = true;
                App.Log($"SAMPLE: chart placeholder install failed: {ex.GetType().Name}: {ex.Message}");
            }
        }

        private void Install(UIElement owner)
        {
            ElementCompositionPreview.SetElementChildVisual(owner, _shapes);
            _owner = owner;
            Position();
        }

        private void Position()
        {
            var pt = ReferenceEquals(_owner, _host) || _owner is null
                ? default
                : _host.TransformToVisual(_owner).TransformPoint(default);
            var offset = new Vector3((float)pt.X, (float)pt.Y, 0);
            if (_shapes.Offset != offset)
            {
                _shapes.Offset = offset;
            }
        }
        private void Draw()
        {
            try
            {
                Ensure();
                float w = (float)_host.ActualWidth, h = (float)_host.ActualHeight;
                _shapes.Size = new Vector2(w, h);
                _shapes.Shapes.Clear();
                if (w < 8 || h < 8)
                {
                    return;
                }

                float padX = Math.Min(16f, w * 0.04f), padY = Math.Max(2f, h * 0.12f);
                float left = padX, right = w - padX, top = padY, bottom = h - padY;
                bool roomy = h >= 80;
                if (roomy)
                {
                    var grid = _compositor.CreateColorBrush(Color.FromArgb(0x30, 0x80, 0x80, 0x80));
                    for (int g = 0; g < 4; g++)
                    {
                        float y = top + (bottom - top) * g / 3f;
                        _shapes.Shapes.Add(Line(_compositor, new Vector2(left, y), new Vector2(right, y), grid, 1f));
                    }
                }

                var stroke = _compositor.CreateColorBrush(_accent);
                float thickness = roomy ? 2.5f : 2f;
                Vector2? prev = null;
                for (int i = 0; i < Points; i++)
                {
                    float x = left + (right - left) * i / (Points - 1);
                    float y = bottom - (bottom - top) * Sample(i + _phase);
                    var pt = new Vector2(x, y);
                    if (prev is { } p0)
                    {
                        _shapes.Shapes.Add(Line(_compositor, p0, pt, stroke, thickness));
                    }
                    prev = pt;
                }
            }
            catch (Exception ex)
            {
                App.Log($"SAMPLE: chart placeholder draw failed: {ex.GetType().Name}: {ex.Message}");
            }
        }
    }

    /// <summary>A gentle deterministic wave in [0.1, 0.9] that reads as real-ish data.</summary>
    internal static float Sample(int i) =>
        (float)(0.5 + 0.22 * Math.Sin(i * 0.45) + 0.1 * Math.Sin(i * 1.3 + 0.7) + 0.08 * Math.Cos(i * 0.21));

    private static CompositionSpriteShape Line(Compositor c, Vector2 a, Vector2 b, CompositionBrush brush, float thickness)
    {
        var geometry = c.CreateLineGeometry();
        geometry.Start = a;
        geometry.End = b;
        var shape = c.CreateSpriteShape(geometry);
        shape.StrokeBrush = brush;
        shape.StrokeThickness = thickness;
        shape.StrokeStartCap = CompositionStrokeCap.Round;
        shape.StrokeEndCap = CompositionStrokeCap.Round;
        return shape;
    }
}
