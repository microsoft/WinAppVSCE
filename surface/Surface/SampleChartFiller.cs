using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Linq.Expressions;
using System.Runtime.CompilerServices;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Windows.Foundation;
using Windows.UI;

namespace Surface;

/// <summary>
/// Sample data for charts. Never throws; every step is isolated so one odd chart cannot affect the rest of the page.
/// <list type="number">
/// <item>Planned fixups (<see cref="ChartFixup"/>) re-wire the WinAppSDK chart pattern the cleaner had to strip:
/// sample values for <c>Samples.ItemsSource</c> and the element references (<c>XAxis="{x:Bind MonthX}"</c>,
/// <c>XValues="{x:Bind Month}"</c>) that only compiled bindings can express.</item>
/// <item>A WinAppSDK <c>Chart</c> still without data after load (series built in code-behind, which the preview never
/// runs) is given a sample line series through its own API, so it renders with the app's chart styles. If the app
/// later supplies data (a custom control's code does run), the sample series is removed.</item>
/// <item>Anything else chart-like (a control typed <c>*Chart</c>/<c>*Graph</c>/<c>*Plot</c>/<c>*Sparkline</c> with no
/// data, or an element named like a chart whose shapes are all empty) gets a generated line drawn in a separate,
/// non-interactive layer above the page (<see cref="CreateOverlay"/>), clipped to the scroll viewers around it. The
/// app's elements are never modified.</item>
/// </list>
/// Collapsed subtrees are skipped until they become visible.
/// </summary>
internal static class SampleChartFiller
{
    /// <summary>Tag on the overlay layer; tree walks over authored content skip it.</summary>
    internal const string OverlayTag = "__wxpSampleChartOverlay";

    private const int MaxLayoutPasses = 60;
    private const int MaxPlaceholders = 200;
    private const int OverlayPoints = 24;
    private const double MinSize = 8;
    private static readonly string[] DataProperties = { "Series", "ItemsSource", "Points", "Values" };
    private static readonly ConditionalWeakTable<FrameworkElement, RootState> Roots = new();

    /// <summary>Apply <paramref name="fixups"/> to the freshly loaded <paramref name="root"/> and watch its layout passes for empty charts.</summary>
    public static void Attach(FrameworkElement root, IReadOnlyList<ChartFixup>? fixups = null)
    {
        try
        {
            var state = new RootState(root);
            Roots.AddOrUpdate(root, state);
            if (fixups is { Count: > 0 })
            {
                ApplyFixups(root, fixups);
            }
            state.Start();
        }
        catch (Exception ex)
        {
            App.Log($"SAMPLE: chart attach failed: {ex.GetType().Name}: {ex.Message}");
        }
    }

    /// <summary>The layer chart placeholders draw in, for a root passed to <see cref="Attach"/>; null otherwise.</summary>
    public static FrameworkElement? CreateOverlay(FrameworkElement root)
    {
        if (!Roots.TryGetValue(root, out var state))
        {
            return null;
        }
        state.Overlay ??= new Canvas { IsHitTestVisible = false, Tag = OverlayTag };
        return state.Overlay;
    }

    private static void ApplyFixups(FrameworkElement root, IReadOnlyList<ChartFixup> fixups)
    {
        int applied = 0;
        foreach (var f in fixups)
        {
            try
            {
                var target = root.FindName(f.Element);
                if (target is null)
                {
                    App.Log($"SAMPLE: chart fixup target '{f.Element}' not found.");
                    continue;
                }
                object? value;
                if (f.RefName is not null)
                {
                    value = root.FindName(f.RefName);
                    if (value is null)
                    {
                        App.Log($"SAMPLE: chart fixup reference '{f.RefName}' not found.");
                        continue;
                    }
                }
                else
                {
                    value = MakeItems(f.Values ?? Array.Empty<string>(), f.Numeric);
                }
                if (Set(target, f.Property, value))
                {
                    applied++;
                }
                else
                {
                    App.Log($"SAMPLE: chart fixup could not set {target.GetType().Name}.{f.Property}.");
                }
            }
            catch (Exception ex)
            {
                App.Log($"SAMPLE: chart fixup {f.Element}.{f.Property} failed: {ex.GetType().Name}: {ex.Message}");
            }
        }
        if (applied > 0)
        {
            App.Log($"SAMPLE: applied {applied} chart binding fixup(s).");
        }
    }

    private static object MakeItems(IReadOnlyList<string> values, bool numeric) =>
        numeric
            ? values.Select(v => double.TryParse(v, System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture, out var d) ? d : 0d).ToList()
            : values.ToList();

    /// <summary>Per-root scan state: which elements were classified, and the placeholders/fills in place.</summary>
    private sealed class RootState
    {
        private readonly WeakReference<FrameworkElement> _root;
        private readonly ConditionalWeakTable<FrameworkElement, object> _seen = new();
        private readonly List<Placeholder> _placeholders = new();
        private readonly List<ChartFill> _fills = new();
        private int _passes;
        private bool _overlayMissingLogged;

        public Canvas? Overlay { get; set; }

        public RootState(FrameworkElement root) => _root = new WeakReference<FrameworkElement>(root);

        public void Start()
        {
            if (_root.TryGetTarget(out var root))
            {
                root.LayoutUpdated += OnLayoutUpdated;
            }
        }

        private void OnLayoutUpdated(object? sender, object e)
        {
            if (!_root.TryGetTarget(out var root))
            {
                return;
            }
            if (_passes < MaxLayoutPasses)
            {
                _passes++;
                try
                {
                    Scan(root, root, "");
                }
                catch (Exception ex)
                {
                    App.Log($"SAMPLE: chart scan failed: {ex.GetType().Name}: {ex.Message}");
                    _passes = MaxLayoutPasses;
                }
            }
            Maintain(root);
            if (_passes >= MaxLayoutPasses && _placeholders.Count == 0 && _fills.Count == 0)
            {
                root.LayoutUpdated -= OnLayoutUpdated;
            }
        }

        /// <summary>Keep placeholders positioned, and retire any whose chart has since received real data.</summary>
        private void Maintain(FrameworkElement root)
        {
            for (int i = _placeholders.Count - 1; i >= 0; i--)
            {
                var p = _placeholders[i];
                if (!p.Update(root))
                {
                    _placeholders.RemoveAt(i);
                }
            }
            for (int i = _fills.Count - 1; i >= 0; i--)
            {
                if (!_fills[i].Check())
                {
                    _fills.RemoveAt(i);
                }
            }
        }

        private void Scan(FrameworkElement root, DependencyObject node, string path)
        {
            if (node is UIElement { Visibility: Visibility.Collapsed })
            {
                return; // revisited on a later pass if it becomes visible
            }
            if (node is FrameworkElement fe && !ReferenceEquals(fe, Overlay))
            {
                try
                {
                    var outcome = Classify(root, fe, path);
                    if (outcome == Outcome.Stop)
                    {
                        return;
                    }
                }
                catch (Exception ex)
                {
                    _seen.AddOrUpdate(fe, Outcome.Stop);
                    App.Log($"SAMPLE: chart check of {fe.GetType().Name} failed: {ex.GetType().Name}: {ex.Message}");
                    return;
                }
            }

            int n = VisualTreeHelper.GetChildrenCount(node);
            for (int i = 0; i < n; i++)
            {
                Scan(root, VisualTreeHelper.GetChild(node, i), path + "/" + i.ToString(System.Globalization.CultureInfo.InvariantCulture));
            }
        }

        private Outcome Classify(FrameworkElement root, FrameworkElement fe, string path)
        {
            if (_seen.TryGetValue(fe, out var known))
            {
                return (Outcome)known;
            }

            var type = fe.GetType();
            bool realChart = type.FullName == SamplePlanner.ChartsNamespace + ".Chart";
            bool byType = !realChart && type.Namespace != SamplePlanner.ChartsNamespace && SamplePlanner.ChartTypeName.IsMatch(type.Name);
            bool byName = !realChart && !byType && !string.IsNullOrEmpty(fe.Name) && SamplePlanner.ChartElementName.IsMatch(fe.Name);
            if (!realChart && !byType && !byName)
            {
                return Outcome.Descend;
            }
            if (fe.ActualWidth < MinSize || fe.ActualHeight < MinSize)
            {
                return realChart || byType ? Outcome.Stop : Outcome.Descend; // not laid out yet; decide on a later pass
            }

            Outcome Mark(Outcome o)
            {
                _seen.AddOrUpdate(fe, o);
                return o;
            }

            if (realChart)
            {
                if (!ChartFill.IsEmpty(fe))
                {
                    return Mark(Outcome.Stop);
                }
                if (ChartFill.TryFill(fe) is { } fill)
                {
                    _fills.Add(fill);
                    App.Log($"SAMPLE: filled empty Chart{Label(fe)} with a sample series.");
                    return Mark(Outcome.Stop);
                }
                AddPlaceholder(root, fe, path, () => ChartFill.IsEmpty(fe));
                return Mark(Outcome.Stop);
            }

            if (byType)
            {
                if (HasEmptyData(fe) && !HasDrawnGeometry(fe))
                {
                    AddPlaceholder(root, fe, path, () => HasEmptyData(fe) && !HasDrawnGeometry(fe));
                }
                return Mark(Outcome.Stop); // a chart's own parts are not charts
            }

            if (HasOnlyEmptyGeometry(fe))
            {
                AddPlaceholder(root, fe, path, () => HasOnlyEmptyGeometry(fe));
                return Mark(Outcome.Stop);
            }
            return Mark(Outcome.Descend);
        }

        private void AddPlaceholder(FrameworkElement root, FrameworkElement target, string path, Func<bool> stillEmpty)
        {
            if (Overlay is null)
            {
                if (!_overlayMissingLogged)
                {
                    _overlayMissingLogged = true;
                    App.Log("SAMPLE: no chart overlay layer for this render; placeholders skipped.");
                }
                return;
            }
            if (_placeholders.Count >= MaxPlaceholders)
            {
                return;
            }
            var p = new Placeholder(Overlay, target, SamplePlanner.StableHash((target.Name ?? "") + path), stillEmpty);
            if (p.Update(root))
            {
                _placeholders.Add(p);
                App.Log($"SAMPLE: drew a placeholder series on empty {target.GetType().Name}{Label(target)}.");
            }
        }
    }

    private enum Outcome
    {
        Descend,
        Stop,
    }

    private static string Label(FrameworkElement fe) => string.IsNullOrEmpty(fe.Name) ? "" : " " + fe.Name;

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
            return p.GetValue(chart) switch
            {
                null => true,
                IEnumerable e => !e.GetEnumerator().MoveNext(),
                _ => false,
            };
        }
        return false;
    }

    /// <summary>True when the subtree has at least one shape with non-empty geometry (the control drew something).</summary>
    private static bool HasDrawnGeometry(DependencyObject root) => CountShapes(root, out int drawn) > 0 && drawn > 0;

    /// <summary>True when the subtree has geometry shapes and every one of them is still empty (filled in code).</summary>
    private static bool HasOnlyEmptyGeometry(DependencyObject root) => CountShapes(root, out int drawn) > 0 && drawn == 0;

    private static int CountShapes(DependencyObject root, out int drawn)
    {
        int shapes = 0, nonEmpty = 0;
        void Walk(DependencyObject node)
        {
            bool? empty = node switch
            {
                Microsoft.UI.Xaml.Shapes.Path p => p.Data is null,
                Polyline pl => pl.Points.Count == 0,
                Polygon pg => pg.Points.Count == 0,
                Line l => l.X1 == l.X2 && l.Y1 == l.Y2,
                _ => null,
            };
            if (empty is { } e)
            {
                shapes++;
                if (!e)
                {
                    nonEmpty++;
                }
            }
            int n = VisualTreeHelper.GetChildrenCount(node);
            for (int i = 0; i < n; i++)
            {
                Walk(VisualTreeHelper.GetChild(node, i));
            }
        }
        Walk(root);
        drawn = nonEmpty;
        return shapes;
    }

    /// <summary>
    /// A sample series added to a WinAppSDK Chart through its API. Records exactly what was added or filled so it can
    /// be undone if the app supplies its own data later.
    /// </summary>
    private sealed class ChartFill
    {
        private readonly WeakReference<FrameworkElement> _chart;
        private readonly List<(object collection, Type declared, object item)> _added = new();
        private readonly List<(object samples, IList values)> _filled = new();
        private readonly HashSet<object> _ourSeries = new(ReferenceEqualityComparer.Instance);

        private ChartFill(FrameworkElement chart) => _chart = new WeakReference<FrameworkElement>(chart);

        /// <summary>True when the chart has no series, or none of its series has any Y values.</summary>
        public static bool IsEmpty(FrameworkElement chart)
        {
            if (Get(chart, "Series") is not IEnumerable series)
            {
                return false;
            }
            foreach (var s in series)
            {
                if (s is not null && Count(Get(Get(s, "YValues"), "ItemsSource")) > 0)
                {
                    return false;
                }
            }
            return true;
        }

        /// <summary>Gives an empty chart a sample line, or fills its existing empty series. Null when it can't.</summary>
        public static ChartFill? TryFill(FrameworkElement chart)
        {
            var fill = new ChartFill(chart);
            try
            {
                var asm = chart.GetType().Assembly;
                Type ChartsType(string name) => asm.GetType(SamplePlanner.ChartsNamespace + "." + name)
                    ?? throw new InvalidOperationException($"charts type {name} not found");

                var seriesProp = chart.GetType().GetProperty("Series")!;
                var dataProp = chart.GetType().GetProperty("Data")!;
                var axesProp = chart.GetType().GetProperty("Axes")!;
                var data = dataProp.GetValue(chart)!;
                var axes = axesProp.GetValue(chart)!;
                var existing = ((IEnumerable)seriesProp.GetValue(chart)!).Cast<object>().Where(s => s is not null).ToList();

                if (Count(axes) > 0 && ((IEnumerable)axes).Cast<object>().Any(a => a?.GetType().Name == "DateTimeAxis"))
                {
                    return null; // date axes need DateTime samples; leave it to the overlay
                }

                object? xAxis = null, yAxis = null;
                object NewAxes(bool forX)
                {
                    if (xAxis is null)
                    {
                        xAxis = Activator.CreateInstance(ChartsType("CategoryAxis"))!;
                        yAxis = Activator.CreateInstance(ChartsType("LinearAxis"))!;
                        fill.Add(axes, axesProp.PropertyType, xAxis);
                        fill.Add(axes, axesProp.PropertyType, yAxis);
                    }
                    return forX ? xAxis : yAxis!;
                }

                object NewSamples(IList values)
                {
                    var s = Activator.CreateInstance(ChartsType("Samples"))!;
                    Set(s, "ItemsSource", values);
                    fill.Add(data, dataProp.PropertyType, s);
                    return s;
                }

                if (existing.Count == 0)
                {
                    var series = Activator.CreateInstance(ChartsType("LineSeries"))!;
                    Set(series, "XAxis", NewAxes(true));
                    Set(series, "YAxis", NewAxes(false));
                    Set(series, "XValues", NewSamples(XValuesFor(xAxis)));
                    Set(series, "YValues", NewSamples(SamplePlanner.ChartSeriesValues(chart.Name).ToList()));
                    fill.Add(Get(chart, "Series")!, seriesProp.PropertyType, series);
                    fill._ourSeries.Add(series);
                    return fill;
                }

                var existingAxes = ((IEnumerable)axes).Cast<object>().Where(a => a is not null).ToList();
                foreach (var series in existing)
                {
                    var x = Get(series, "XAxis");
                    var y = Get(series, "YAxis");
                    if (x is null)
                    {
                        x = existingAxes.FirstOrDefault(a => a.GetType().Name == "CategoryAxis")
                            ?? existingAxes.FirstOrDefault(a => !ReferenceEquals(a, y))
                            ?? NewAxes(true);
                        Set(series, "XAxis", x);
                    }
                    if (y is null)
                    {
                        y = existingAxes.FirstOrDefault(a => a.GetType().Name == "LinearAxis" && !ReferenceEquals(a, x))
                            ?? NewAxes(false);
                        Set(series, "YAxis", y);
                    }
                    if (x.GetType().Name == "DateTimeAxis")
                    {
                        fill.Undo();
                        return null;
                    }
                    FillValues(fill, series, "XValues", XValuesFor(x), NewSamples);
                    FillValues(fill, series, "YValues",
                        SamplePlanner.ChartSeriesValues((chart.Name ?? "") + existing.IndexOf(series)).ToList(), NewSamples);
                }
                return fill;
            }
            catch (Exception ex)
            {
                App.Log($"SAMPLE: could not fill Chart{Label(chart)} through its API ({ex.GetType().Name}: {ex.Message}); drawing a placeholder instead.");
                fill.Undo();
                return null;
            }
        }

        private static IList XValuesFor(object? xAxis) =>
            xAxis?.GetType().Name == "CategoryAxis"
                ? SamplePlanner.ChartCategories().ToList()
                : Enumerable.Range(0, SamplePlanner.ChartPoints).Select(i => (double)i).ToList();

        private static void FillValues(ChartFill fill, object series, string property, IList values, Func<IList, object> newSamples)
        {
            var samples = Get(series, property);
            if (samples is null)
            {
                Set(series, property, newSamples(values));
            }
            else if (Count(Get(samples, "ItemsSource")) == 0)
            {
                Set(samples, "ItemsSource", values);
                fill._filled.Add((samples, values));
            }
        }

        private void Add(object collection, Type declared, object item)
        {
            CollectionOp(declared, "Add")(collection, item);
            _added.Add((collection, declared, item));
        }

        /// <summary>False once the app has supplied its own data and the sample was removed (or the chart is gone).</summary>
        public bool Check()
        {
            if (!_chart.TryGetTarget(out var chart))
            {
                return false;
            }
            try
            {
                bool appData = false;
                foreach (var (samples, values) in _filled)
                {
                    if (!SameItems(Get(samples, "ItemsSource"), values))
                    {
                        appData = true;
                    }
                }
                if (!appData && Get(chart, "Series") is IEnumerable series)
                {
                    foreach (var s in series)
                    {
                        if (s is not null && !_ourSeries.Contains(s) && !_filled.Any(f => ReferenceEquals(Get(s, "YValues"), f.samples)) &&
                            Count(Get(Get(s, "YValues"), "ItemsSource")) > 0)
                        {
                            appData = true;
                            break;
                        }
                    }
                }
                if (!appData)
                {
                    return true;
                }
                Undo();
                App.Log($"SAMPLE: Chart{Label(chart)} received its own data; removed the sample series.");
            }
            catch (Exception ex)
            {
                App.Log($"SAMPLE: chart data check failed: {ex.GetType().Name}: {ex.Message}");
            }
            return false;
        }

        private void Undo()
        {
            for (int i = _added.Count - 1; i >= 0; i--)
            {
                var (collection, declared, item) = _added[i];
                try
                {
                    CollectionOp(declared, "Remove")(collection, item);
                }
                catch
                {
                    // best effort
                }
            }
            _added.Clear();
            foreach (var (samples, values) in _filled)
            {
                try
                {
                    if (SameItems(Get(samples, "ItemsSource"), values))
                    {
                        Set(samples, "ItemsSource", null);
                    }
                }
                catch
                {
                    // best effort
                }
            }
            _filled.Clear();
        }

        private static bool SameItems(object? actual, IList expected)
        {
            if (actual is not IEnumerable e)
            {
                return false;
            }
            int i = 0;
            foreach (var item in e)
            {
                if (i >= expected.Count || !Equals(item, expected[i]))
                {
                    return false;
                }
                i++;
            }
            return i == expected.Count;
        }
    }

    /// <summary>One generated line in the overlay layer, tracking its target's bounds and visible area.</summary>
    private sealed class Placeholder
    {
        private readonly Canvas _overlay;
        private readonly WeakReference<FrameworkElement> _target;
        private readonly int _phase;
        private readonly Func<bool> _stillEmpty;
        private readonly Canvas _piece = new() { IsHitTestVisible = false };
        private readonly List<ScrollViewer> _scrollers = new();
        private Size _drawn;
        private int _positionFailures;

        public Placeholder(Canvas overlay, FrameworkElement target, int phase, Func<bool> stillEmpty)
        {
            _overlay = overlay;
            _target = new WeakReference<FrameworkElement>(target);
            _phase = phase % 16;
            _stillEmpty = stillEmpty;
            for (var p = VisualTreeHelper.GetParent(target); p is not null; p = VisualTreeHelper.GetParent(p))
            {
                if (p is ScrollViewer sv)
                {
                    _scrollers.Add(sv);
                    sv.ViewChanged += OnViewChanged;
                }
            }
        }

        private void OnViewChanged(object? sender, ScrollViewerViewChangedEventArgs e)
        {
            try
            {
                if (_overlay.XamlRoot is not null)
                {
                    Position(null);
                }
            }
            catch
            {
                _piece.Visibility = Visibility.Collapsed;
            }
        }

        /// <summary>Reposition and redraw; false (and removed) once the target is gone or has its own data.</summary>
        public bool Update(FrameworkElement root)
        {
            bool empty;
            try
            {
                empty = _target.TryGetTarget(out var t) && _stillEmpty();
                if (!empty)
                {
                    if (t is not null)
                    {
                        App.Log($"SAMPLE: {t.GetType().Name}{Label(t)} received its own data; removed the placeholder.");
                    }
                    Remove();
                    return false;
                }
            }
            catch (Exception ex)
            {
                App.Log($"SAMPLE: chart placeholder data check failed: {ex.GetType().Name}: {ex.Message}");
                Remove();
                return false;
            }

            try
            {
                if (_piece.Parent is null)
                {
                    _overlay.Children.Add(_piece);
                }
                if (_overlay.XamlRoot is null)
                {
                    return true; // canvas detached (e.g. after an image capture); nothing to position against
                }
                Position(root);
                _positionFailures = 0;
            }
            catch (Exception ex)
            {
                // Transient (first passes before the canvas is live, or during teardown): hide and retry next pass.
                _piece.Visibility = Visibility.Collapsed;
                if (++_positionFailures == 5)
                {
                    App.Log($"SAMPLE: chart placeholder positioning keeps failing: {ex.GetType().Name}: {ex.Message}");
                }
            }
            return true;
        }

        private void Remove()
        {
            foreach (var sv in _scrollers)
            {
                sv.ViewChanged -= OnViewChanged;
            }
            _scrollers.Clear();
            if (_piece.Parent is not null)
            {
                _overlay.Children.Remove(_piece);
            }
        }

        private void Position(FrameworkElement? root)
        {
            if (!_target.TryGetTarget(out var target))
            {
                return;
            }
            if (!IsShown(target, root))
            {
                _piece.Visibility = Visibility.Collapsed;
                return;
            }
            var bounds = target.TransformToVisual(_overlay).TransformBounds(new Rect(0, 0, target.ActualWidth, target.ActualHeight));
            var visible = bounds;
            foreach (var sv in _scrollers)
            {
                var clip = sv.TransformToVisual(_overlay).TransformBounds(new Rect(0, 0, sv.ActualWidth, sv.ActualHeight));
                visible.Intersect(clip);
                if (visible.IsEmpty)
                {
                    break;
                }
            }
            if (visible.IsEmpty || visible.Width < 1 || visible.Height < 1)
            {
                _piece.Visibility = Visibility.Collapsed;
                return;
            }
            _piece.Visibility = Visibility.Visible;
            Canvas.SetLeft(_piece, bounds.X);
            Canvas.SetTop(_piece, bounds.Y);
            _piece.Width = bounds.Width;
            _piece.Height = bounds.Height;
            _piece.Clip = new RectangleGeometry { Rect = new Rect(visible.X - bounds.X, visible.Y - bounds.Y, visible.Width, visible.Height) };
            var size = new Size(bounds.Width, bounds.Height);
            if (size != _drawn)
            {
                _drawn = size;
                Draw(size.Width, size.Height);
            }
        }

        /// <summary>True when the target is still in the page under <paramref name="root"/> and nothing above it is collapsed.</summary>
        private static bool IsShown(FrameworkElement target, FrameworkElement? root)
        {
            DependencyObject? node = target;
            while (node is not null)
            {
                if (node is UIElement { Visibility: Visibility.Collapsed })
                {
                    return false;
                }
                if (root is not null && ReferenceEquals(node, root))
                {
                    return true;
                }
                node = VisualTreeHelper.GetParent(node);
            }
            return root is null && target.XamlRoot is not null;
        }

        private void Draw(double w, double h)
        {
            _piece.Children.Clear();
            if (w < MinSize || h < MinSize)
            {
                return;
            }
            double padX = Math.Min(16, w * 0.04), padY = Math.Max(2, h * 0.12);
            double left = padX, right = w - padX, top = padY, bottom = h - padY;
            bool roomy = h >= 80;
            if (roomy)
            {
                var grid = new SolidColorBrush(Color.FromArgb(0x30, 0x80, 0x80, 0x80));
                for (int g = 0; g < 4; g++)
                {
                    double y = top + (bottom - top) * g / 3;
                    _piece.Children.Add(new Line { X1 = left, X2 = right, Y1 = y, Y2 = y, Stroke = grid, StrokeThickness = 1 });
                }
            }
            var line = new Polyline
            {
                Stroke = new SolidColorBrush(Accent()),
                StrokeThickness = roomy ? 2.5 : 2,
                StrokeLineJoin = PenLineJoin.Round,
                StrokeStartLineCap = PenLineCap.Round,
                StrokeEndLineCap = PenLineCap.Round,
            };
            for (int i = 0; i < OverlayPoints; i++)
            {
                double x = left + (right - left) * i / (OverlayPoints - 1);
                double y = bottom - (bottom - top) * SamplePlanner.ChartWave(i + _phase);
                line.Points.Add(new Point(x, y));
            }
            _piece.Children.Add(line);
        }

        private static Color Accent() =>
            Application.Current?.Resources.TryGetValue("SystemAccentColor", out var c) == true && c is Color ac
                ? ac
                : Color.FromArgb(0xFF, 0x00, 0x78, 0xD4);
    }

    private static object? Get(object? target, string property) =>
        target?.GetType().GetProperty(property)?.GetValue(target);

    private static bool Set(object target, string property, object? value)
    {
        var p = target.GetType().GetProperty(property);
        if (p is null || !p.CanWrite)
        {
            return false;
        }
        p.SetValue(target, value);
        return true;
    }

    private static int Count(object? items)
    {
        if (items is not IEnumerable e || items is string)
        {
            return 0;
        }
        int n = 0;
        foreach (var _ in e)
        {
            if (++n > 0)
            {
                break;
            }
        }
        return n;
    }

    private static readonly ConcurrentDictionary<(Type, string), Action<object, object>> CollectionOps = new();

    /// <summary>
    /// <c>ICollection&lt;T&gt;.Add/Remove</c> for a projected WinRT vector whose element type is only known at runtime.
    /// Compiled with a cast (not MethodInfo.Invoke) so CsWinRT's dynamically implemented interfaces resolve.
    /// </summary>
    private static Action<object, object> CollectionOp(Type declared, string op) =>
        CollectionOps.GetOrAdd((declared, op), key =>
        {
            var element = key.Item1.IsGenericType ? key.Item1.GetGenericArguments()[0] : typeof(object);
            var iface = typeof(ICollection<>).MakeGenericType(element);
            var c = Expression.Parameter(typeof(object));
            var item = Expression.Parameter(typeof(object));
            Expression call = Expression.Call(Expression.Convert(c, iface), iface.GetMethod(key.Item2)!, Expression.Convert(item, element));
            if (call.Type != typeof(void))
            {
                call = Expression.Block(typeof(void), call);
            }
            return Expression.Lambda<Action<object, object>>(call, c, item).Compile();
        });
}
