using System;
using System.Collections;
using System.Collections.Generic;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Markup;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Windows.Foundation;
using Windows.System;
using Windows.UI;

namespace Surface;

/// <summary>The data the surface hands the client when an element is picked in the design surface.</summary>
internal sealed class DesignSelectionPayload
{
    public int Id;
    public string TypeName = "";
    public string? Name;
    public double X;
    public double Y;
    public double W;
    public double H;

    /// <summary>
    /// The authored-tree index path (e.g. <c>"0.1.0"</c>) of the selected element, relative to the content
    /// host: a sequence of child indices through <see cref="DesignSurface.AuthoredChildren"/>. The client
    /// computes the identical path from the XAML source so selection maps to a text span (plan §41 #1/#2).
    /// Null when the element has no resolvable authored path.
    /// </summary>
    public string? Path;

    public List<DesignPropInfo> Props = new();
}

/// <summary>
/// The design-time interaction layer that wraps the hosted user content. It is a plain visual sandwich —
/// no VS/designer code — built from public WinUI APIs:
/// <list type="bullet">
///   <item>a gray "artboard" holding the user content inside a zoom-to-fit <see cref="Viewbox"/>;</item>
///   <item>a non-hit-testable <see cref="Canvas"/> adorner layer that draws the selection/hover chrome;</item>
///   <item>a transparent input overlay that — in <b>design mode</b> — eats pointer input so the app can't
///     be interacted with, and turns a click into a <see cref="VisualTreeHelper.FindElementsInHostCoordinates"/>
///     hit-test that selects the topmost user element.</item>
/// </list>
/// In <b>interact mode</b> the overlay is collapsed, so input flows to the live content (the original
/// behavior). Selection results are raised via <see cref="SelectionChanged"/>; the adorner is drawn in the
/// surface's own window (same compositor as the content) so it is always pixel-aligned with no airspace seam.
/// </summary>
internal sealed class DesignSurface
{
    // Visual-Studio-designer selection blue.
    private static readonly Color AccentColor = Color.FromArgb(0xFF, 0x00, 0x78, 0xD4);
    private static readonly Color HoverColor = Color.FromArgb(0xFF, 0x60, 0xA0, 0xE0);

    private readonly Grid _artboard;
    private readonly Canvas _adornerCanvas;
    private readonly Border _inputOverlay;
    private readonly Canvas _chromeCanvas; // hit-testable designer chrome (selection tag) above the input overlay
    private readonly Border _selectionTag; // accent chip at the selection's top-left: type + name + props icon
    private readonly TextBlock _tagType;
    private readonly TextBlock _tagName;
    private readonly Button _propsButton;
    private readonly Flyout _propsFlyout;
    private readonly FrameworkElement _contentHost; // the design canvas — the hit-test subtree

    private readonly Rectangle _selectRect;
    private readonly Border _hoverOutline;
    private readonly Rectangle[] _handles = new Rectangle[8];

    private readonly Dictionary<FrameworkElement, int> _elToId = new();
    private readonly Dictionary<int, WeakReference<FrameworkElement>> _idToEl = new();
    private int _nextId = 1;

    private FrameworkElement? _selected;
    private DesignSelectionPayload? _selectedPayload;
    // The deepest authored element under the cursor for the current click sequence. Re-clicking the SAME spot
    // (leaf unchanged) walks the selection one level UP instead of re-picking the leaf — see PickForClick.
    private FrameworkElement? _walkLeaf;
    private bool _designMode = true;

    // ---- artboard grid backdrop + zoom/pan (designer polish) ----
    private readonly ScrollViewer _scroll;
    private readonly Border _board;         // the "page": fixed-size design canvas, floated on the grid
    private readonly Microsoft.UI.Xaml.Shapes.Path _gridPath;        // faint grid backdrop that fills the artboard
    private readonly Border _zoomBar;       // in-surface zoom control (bottom-left corner)
    private TextBlock? _zoomLabel;
    private readonly double _canvasW;
    private readonly double _canvasH;
    private bool _fitMode = true;           // default: zoom-to-fit the pane, re-fitting on resize
    private bool _applyingFit;              // guards ViewChanged from clearing fit mode during a fit
    private bool _zoomInitialized;
    private const double MinZoom = 0.10;
    private const double MaxZoom = 8.0;
    private const double GridSpacing = 24.0; // artboard grid square size (DIP)

    /// <summary>Raised (on the UI thread) when the user selects an element in design mode.</summary>
    public event Action<DesignSelectionPayload>? SelectionChanged;

    /// <summary>
    /// Raised (on the UI thread) after a live property edit (<see cref="SetProperty"/>) re-reads the selected
    /// element. Carries the same payload as <see cref="SelectionChanged"/> but is meant to refresh ONLY the
    /// property panel — the server maps it to an <c>ElementProps</c> send, not a <c>Selected</c>, so a property
    /// edit never nudges the editor caret (plan §41 #1).
    /// </summary>
    public event Action<DesignSelectionPayload>? PropsRefreshed;

    public DesignSurface(FrameworkElement contentHost, Color letterbox)
    {
        _contentHost = contentHost;

        _canvasW = (!double.IsNaN(contentHost.Width) && contentHost.Width > 0) ? contentHost.Width : 400;
        _canvasH = (!double.IsNaN(contentHost.Height) && contentHost.Height > 0) ? contentHost.Height : 300;

        // The "page": the fixed-size design canvas floated on the artboard with a hairline edge, so it reads
        // as a sheet resting on the grid backdrop (Blend/WPF-designer feel). Zoom scales this board.
        _board = new Border
        {
            Width = _canvasW,
            Height = _canvasH,
            Child = contentHost,
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
            BorderBrush = new SolidColorBrush(Color.FromArgb(0x40, 0x00, 0x00, 0x00)),
            BorderThickness = new Thickness(1),
        };

        // Zoomable/scrollable viewport onto the board. The selection overlays stay OUTSIDE this ScrollViewer
        // (full-artboard siblings), so TransformToVisual / FindElementsInHostCoordinates keep the adorner and
        // hit-testing pixel-accurate at any zoom — we only reflow the chrome when the view changes.
        _scroll = new ScrollViewer
        {
            ZoomMode = ZoomMode.Enabled,
            MinZoomFactor = (float)MinZoom,
            MaxZoomFactor = (float)MaxZoom,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Auto,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollMode = ScrollMode.Enabled,
            VerticalScrollMode = ScrollMode.Enabled,
            Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
            Content = _board,
        };

        // Faint grid backdrop that fills the artboard (rebuilt on resize) — the "design area" look.
        _gridPath = new Microsoft.UI.Xaml.Shapes.Path
        {
            Stroke = new SolidColorBrush(Color.FromArgb(0x16, 0xFF, 0xFF, 0xFF)),
            StrokeThickness = 1,
            IsHitTestVisible = false,
        };

        _adornerCanvas = new Canvas { IsHitTestVisible = false };

        _hoverOutline = new Border
        {
            BorderBrush = new SolidColorBrush(HoverColor),
            BorderThickness = new Thickness(1),
            IsHitTestVisible = false,
            Visibility = Visibility.Collapsed,
        };
        _adornerCanvas.Children.Add(_hoverOutline);

        _selectRect = new Rectangle
        {
            Stroke = new SolidColorBrush(AccentColor),
            StrokeThickness = 1.5,
            Fill = new SolidColorBrush(Color.FromArgb(0x18, 0x00, 0x78, 0xD4)),
            IsHitTestVisible = false,
            Visibility = Visibility.Collapsed,
        };
        _adornerCanvas.Children.Add(_selectRect);

        for (int i = 0; i < _handles.Length; i++)
        {
            var h = new Rectangle
            {
                Width = 6,
                Height = 6,
                Fill = new SolidColorBrush(Microsoft.UI.Colors.White),
                Stroke = new SolidColorBrush(AccentColor),
                StrokeThickness = 1,
                IsHitTestVisible = false,
                Visibility = Visibility.Collapsed,
            };
            _handles[i] = h;
            _adornerCanvas.Children.Add(h);
        }

        _inputOverlay = new Border { Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent) };
        _inputOverlay.PointerPressed += OnPointerPressed;
        _inputOverlay.PointerMoved += OnPointerMoved;
        _inputOverlay.PointerExited += (_, _) => _hoverOutline.Visibility = Visibility.Collapsed;

        // Designer chrome that must be clickable (the selection tag) rides on its own canvas above the input
        // overlay. A Canvas with no Background is hit-transparent except where its children are, so clicks that
        // miss the tag still fall through to the overlay's selection hit-test.
        _propsFlyout = new Flyout { Placement = Microsoft.UI.Xaml.Controls.Primitives.FlyoutPlacementMode.Bottom };

        // Selection tag: a compact accent chip at the selection's top-left showing the element TYPE and (if set)
        // x:Name so you can see WHAT is selected, plus a small gear icon button that opens the property flyout.
        _tagType = new TextBlock
        {
            FontSize = 11,
            FontWeight = FontWeights.SemiBold,
            Foreground = new SolidColorBrush(Microsoft.UI.Colors.White),
            VerticalAlignment = VerticalAlignment.Center,
        };
        _tagName = new TextBlock
        {
            FontSize = 11,
            Foreground = new SolidColorBrush(Microsoft.UI.Colors.White),
            Opacity = 0.75,
            VerticalAlignment = VerticalAlignment.Center,
            TextTrimming = TextTrimming.CharacterEllipsis,
            MaxWidth = 160,
        };
        _propsButton = new Button
        {
            Content = new FontIcon { Glyph = "\uE713", FontSize = 12 }, // Setting (gear) = "properties"
            Foreground = new SolidColorBrush(Microsoft.UI.Colors.White),
            Padding = new Thickness(4, 0, 4, 0),
            MinWidth = 0,
            MinHeight = 0,
            Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
            BorderThickness = new Thickness(0),
            VerticalAlignment = VerticalAlignment.Center,
        };
        ToolTipService.SetToolTip(_propsButton, "Properties");
        // Make the gear/properties button UIA-addressable (D6): screen readers announce it and automation can
        // click it by name/id. Without these the button is an unnamed glyph Button (no accessible name).
        AutomationProperties.SetName(_propsButton, "Properties");
        AutomationProperties.SetAutomationId(_propsButton, "DesignPropertiesButton");
        _propsButton.Click += (_, _) => ShowPropsFlyout();

        var tagPanel = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Spacing = 6,
            VerticalAlignment = VerticalAlignment.Center,
        };
        tagPanel.Children.Add(_tagType);
        tagPanel.Children.Add(_tagName);
        tagPanel.Children.Add(_propsButton);

        _selectionTag = new Border
        {
            Background = new SolidColorBrush(AccentColor),
            CornerRadius = new CornerRadius(3),
            Padding = new Thickness(6, 1, 2, 1),
            Child = tagPanel,
            Visibility = Visibility.Collapsed,
        };

        _chromeCanvas = new Canvas();
        _chromeCanvas.Children.Add(_selectionTag);

        _artboard = new Grid { Background = new SolidColorBrush(letterbox) };
        _artboard.Children.Add(_gridPath);       // faint grid backdrop (bottom)
        _artboard.Children.Add(_scroll);         // the zoomable page/content
        _artboard.Children.Add(_adornerCanvas);  // selection chrome (screen space, constant thickness)
        _artboard.Children.Add(_inputOverlay);   // design-mode input eater (full artboard)
        _artboard.Children.Add(_chromeCanvas);   // selection tag
        _zoomBar = BuildZoomBar();
        _artboard.Children.Add(_zoomBar);        // zoom control (bottom-left corner)

        _artboard.SizeChanged += OnArtboardSizeChanged;
        _scroll.ViewChanged += OnScrollViewChanged;
        _scroll.Loaded += (_, _) => { if (!_zoomInitialized) { ApplyFit(); } };
        _inputOverlay.PointerWheelChanged += OnOverlayWheel;

        ApplyMode();
    }

    /// <summary>The root visual to mount as the render window's content.</summary>
    public Grid Root => _artboard;

    // ---- artboard grid backdrop + zoom control ----------------------------------

    private Border BuildZoomBar()
    {
        _zoomLabel = new TextBlock
        {
            Text = "100%",
            FontSize = 11,
            Foreground = new SolidColorBrush(Microsoft.UI.Colors.White),
            VerticalAlignment = VerticalAlignment.Center,
            TextAlignment = TextAlignment.Center,
        };

        var outBtn = MakeZoomButton("\uE738", "Zoom out (Ctrl+scroll)", "DesignZoomOut");
        outBtn.Click += (_, _) => ChangeZoom(_scroll.ZoomFactor / 1.25, null, keepFit: false);
        var inBtn = MakeZoomButton("\uE710", "Zoom in (Ctrl+scroll)", "DesignZoomIn");
        inBtn.Click += (_, _) => ChangeZoom(_scroll.ZoomFactor * 1.25, null, keepFit: false);
        var fitBtn = MakeZoomButton("\uE9A6", "Zoom to fit", "DesignZoomFit");
        fitBtn.Click += (_, _) => ApplyFit();

        var labelBtn = new Button
        {
            Content = _zoomLabel,
            Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
            BorderThickness = new Thickness(0),
            Padding = new Thickness(4, 0, 4, 0),
            MinWidth = 42,
            MinHeight = 0,
            VerticalAlignment = VerticalAlignment.Center,
        };
        ToolTipService.SetToolTip(labelBtn, "Reset to 100%");
        AutomationProperties.SetName(labelBtn, "Zoom level");
        AutomationProperties.SetAutomationId(labelBtn, "DesignZoomLabel");
        labelBtn.Click += (_, _) => ChangeZoom(1.0, null, keepFit: false);

        var panel = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 1, VerticalAlignment = VerticalAlignment.Center };
        panel.Children.Add(outBtn);
        panel.Children.Add(labelBtn);
        panel.Children.Add(inBtn);
        panel.Children.Add(new Border { Width = 1, Height = 14, Margin = new Thickness(4, 0, 4, 0), Background = new SolidColorBrush(Color.FromArgb(0x40, 0xFF, 0xFF, 0xFF)) });
        panel.Children.Add(fitBtn);

        return new Border
        {
            Child = panel,
            Background = new SolidColorBrush(Color.FromArgb(0xC8, 0x2B, 0x2B, 0x2B)),
            BorderBrush = new SolidColorBrush(Color.FromArgb(0x30, 0xFF, 0xFF, 0xFF)),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(4),
            Padding = new Thickness(3, 2, 3, 2),
            HorizontalAlignment = HorizontalAlignment.Left,
            VerticalAlignment = VerticalAlignment.Bottom,
            Margin = new Thickness(8, 0, 0, 8),
        };
    }

    private Button MakeZoomButton(string glyph, string tooltip, string automationId)
    {
        var b = new Button
        {
            Content = new FontIcon { Glyph = glyph, FontSize = 12 },
            Foreground = new SolidColorBrush(Microsoft.UI.Colors.White),
            Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
            BorderThickness = new Thickness(0),
            Padding = new Thickness(6, 2, 6, 2),
            MinWidth = 0,
            MinHeight = 0,
            VerticalAlignment = VerticalAlignment.Center,
        };
        ToolTipService.SetToolTip(b, tooltip);
        AutomationProperties.SetName(b, tooltip);
        AutomationProperties.SetAutomationId(b, automationId);
        return b;
    }

    private void OnArtboardSizeChanged(object sender, SizeChangedEventArgs e)
    {
        RebuildGrid(e.NewSize.Width, e.NewSize.Height);
        if (!_zoomInitialized || _fitMode) { ApplyFit(); }
        else { ReflowSelectionChrome(); }
    }

    private void OnScrollViewChanged(object? sender, ScrollViewerViewChangedEventArgs e)
    {
        if (!_applyingFit) { _fitMode = false; }
        UpdateZoomLabel(_scroll.ZoomFactor);
        ReflowSelectionChrome();
    }

    private void RebuildGrid(double w, double h)
    {
        if (w <= 0 || h <= 0) { _gridPath.Data = null; return; }
        var gg = new GeometryGroup();
        for (double x = 0; x <= w; x += GridSpacing)
            gg.Children.Add(new LineGeometry { StartPoint = new Point(x, 0), EndPoint = new Point(x, h) });
        for (double y = 0; y <= h; y += GridSpacing)
            gg.Children.Add(new LineGeometry { StartPoint = new Point(0, y), EndPoint = new Point(w, y) });
        _gridPath.Data = gg;
    }

    /// <summary>Zoom-to-fit the pane (never upscales past 100%), staying in fit mode so pane resizes re-fit.</summary>
    private void ApplyFit()
    {
        double vw = _scroll.ViewportWidth > 0 ? _scroll.ViewportWidth : _artboard.ActualWidth;
        double vh = _scroll.ViewportHeight > 0 ? _scroll.ViewportHeight : _artboard.ActualHeight;
        if (vw <= 0 || vh <= 0 || _canvasW <= 0 || _canvasH <= 0) { return; }
        double fit = Math.Min(vw / _canvasW, vh / _canvasH) * 0.94;
        fit = Math.Min(fit, 1.0);
        fit = Math.Max(MinZoom, fit);
        _zoomInitialized = true;
        ChangeZoom(fit, null, keepFit: true);
    }

    /// <summary>Set the zoom factor, anchoring on <paramref name="centerViewport"/> (or the viewport center).</summary>
    private void ChangeZoom(double factor, Point? centerViewport, bool keepFit)
    {
        factor = Math.Max(MinZoom, Math.Min(MaxZoom, factor));
        double oldZoom = _scroll.ZoomFactor;
        if (oldZoom <= 0) { oldZoom = 1.0; }

        double cx = centerViewport?.X ?? (_scroll.ViewportWidth / 2.0);
        double cy = centerViewport?.Y ?? (_scroll.ViewportHeight / 2.0);
        double contentX = (_scroll.HorizontalOffset + cx) / oldZoom;
        double contentY = (_scroll.VerticalOffset + cy) / oldZoom;
        double newOffsetX = contentX * factor - cx;
        double newOffsetY = contentY * factor - cy;

        _fitMode = keepFit;
        _applyingFit = keepFit;
        _scroll.ChangeView(Math.Max(0, newOffsetX), Math.Max(0, newOffsetY), (float)factor, true);
        _applyingFit = false;
        UpdateZoomLabel(factor);
    }

    private void UpdateZoomLabel(double factor)
    {
        if (_zoomLabel != null) { _zoomLabel.Text = $"{Math.Round(factor * 100)}%"; }
    }

    private void ReflowSelectionChrome()
    {
        if (_selected == null || !_designMode) { return; }
        try
        {
            var bounds = DrawAdorner(_selected);
            PositionSelectionTag(bounds);
        }
        catch (Exception ex) { App.Log("ReflowSelectionChrome failed: " + ex.Message); }
    }

    private void OnOverlayWheel(object sender, PointerRoutedEventArgs e)
    {
        var pp = e.GetCurrentPoint(_scroll);
        int delta = pp.Properties.MouseWheelDelta;
        if (delta == 0) { return; }
        var mods = e.KeyModifiers;
        if ((mods & VirtualKeyModifiers.Control) != 0)
        {
            double step = delta > 0 ? 1.15 : 1.0 / 1.15;
            ChangeZoom(_scroll.ZoomFactor * step, pp.Position, keepFit: false);
        }
        else if ((mods & VirtualKeyModifiers.Shift) != 0)
        {
            _scroll.ChangeView(_scroll.HorizontalOffset - delta, null, null, true);
        }
        else
        {
            _scroll.ChangeView(null, _scroll.VerticalOffset - delta, null, true);
        }
        e.Handled = true;
    }

    /// <summary>Design mode intercepts input for selection; interact mode passes input to the live content.</summary>
    public bool DesignMode
    {
        get => _designMode;
        set
        {
            if (_designMode == value)
            {
                return;
            }

            _designMode = value;
            ApplyMode();
        }
    }

    /// <summary>Resolve a previously-selected element by its id (for Phase C/D property edits). May be null.</summary>
    public FrameworkElement? Resolve(int id) =>
        _idToEl.TryGetValue(id, out var wr) && wr.TryGetTarget(out var fe) ? fe : null;

    private void ApplyMode()
    {
        _inputOverlay.Visibility = _designMode ? Visibility.Visible : Visibility.Collapsed;
        _inputOverlay.IsHitTestVisible = _designMode;
        if (!_designMode)
        {
            ClearAdorner();
            _hoverOutline.Visibility = Visibility.Collapsed;
            _selected = null;
            _selectedPayload = null;
            _walkLeaf = null;
        }
    }

    private void OnPointerPressed(object sender, PointerRoutedEventArgs e)
    {
        if (!_designMode)
        {
            return;
        }

        e.Handled = true; // consume the click so it never reaches the live content
        ApplyPick(e.GetCurrentPoint(_artboard).Position);
    }

    /// <summary>
    /// TEST-ONLY headless pick hook (bug D3 regression): run the exact pointer-pick + selection-report path a
    /// design-mode click runs, for the point (<paramref name="x"/>, <paramref name="y"/>) in artboard/host DIP
    /// coordinates. Lets a test assert point -> element without synthesizing real pointer input; the production
    /// VS client never sends the corresponding <c>PickAt</c> message. Returns true when an element was selected.
    /// </summary>
    internal bool PickAt(double x, double y) => ApplyPick(new Point(x, y));

    /// <summary>
    /// Shared body of a design-mode pick at <paramref name="pt"/> (artboard/host DIP space): pick the element,
    /// update selection + adorner, and raise <see cref="SelectionChanged"/>; or clear the selection when nothing
    /// authored is under the point. Returns true when an element was selected. Called by the pointer handler and
    /// by <see cref="PickAt"/> so both produce byte-identical selection state.
    /// </summary>
    private bool ApplyPick(Point pt)
    {
        var hit = PickForClick(pt);
        if (hit is null)
        {
            _selected = null;
            _selectedPayload = null;
            ClearAdorner();
            return false;
        }

        _selected = hit;
        _hoverOutline.Visibility = Visibility.Collapsed;
        SelectAndReport(hit);
        return true;
    }

    /// <summary>
    /// Draw the adorner for <paramref name="hit"/>, build its selection payload (including the authored-tree
    /// <see cref="DesignSelectionPayload.Path"/>), position the selection tag, and raise
    /// <see cref="SelectionChanged"/>. Shared by pointer-pick and <see cref="SelectByPath"/> so both produce
    /// identical selection state. Assumes <c>_selected</c> is already set to <paramref name="hit"/>.
    /// </summary>
    private void SelectAndReport(FrameworkElement hit)
    {
        var bounds = DrawAdorner(hit);

        try
        {
            var payload = BuildPayload(hit, bounds);
            _selectedPayload = payload;
            UpdateSelectionTag(payload);
            PositionSelectionTag(bounds);
            SelectionChanged?.Invoke(payload);
        }
        catch (Exception ex)
        {
            App.Log("DesignSurface selection callback failed: " + ex.Message);
        }
    }

    /// <summary>Builds the full selection payload (identity + adorner bounds + authored path + reflected props).</summary>
    private DesignSelectionPayload BuildPayload(FrameworkElement fe, Rect bounds) => new DesignSelectionPayload
    {
        Id = GetOrAssignId(fe),
        TypeName = fe.GetType().Name,
        Name = string.IsNullOrEmpty(fe.Name) ? null : fe.Name,
        X = bounds.X,
        Y = bounds.Y,
        W = bounds.Width,
        H = bounds.Height,
        Path = PathForElement(fe),
        Props = DesignInspector.Describe(fe),
    };

    /// <summary>
    /// Phase C: apply a live property edit from the panel. Resolves the element by <paramref name="id"/>,
    /// writes the value through <see cref="DesignInspector.TrySet"/> (which converts the string to the
    /// property's type), then re-lays-out, redraws the adorner (the element may have resized), and re-emits
    /// the element's properties via <see cref="PropsRefreshed"/> so the panel shows the applied value — or
    /// reverts if the edit didn't convert. The live HWND repaints itself; no frame round-trip. Returns whether
    /// the value was actually applied. UI thread only.
    /// </summary>
    public bool SetProperty(int id, string name, string value)
    {
        if (!_designMode)
        {
            return false;
        }

        var fe = Resolve(id);
        if (fe is null)
        {
            return false;
        }

        bool applied = DesignInspector.TrySet(fe, name, value ?? "", out var error);
        if (!applied && error != null)
        {
            App.Log($"SetProperty #{id} {name}='{value}' rejected: {error}");
        }

        try
        {
            // Force layout so a size-affecting edit (Width, Margin, …) yields fresh adorner bounds.
            _artboard.UpdateLayout();

            bool isSelected = ReferenceEquals(fe, _selected);
            Rect bounds = isSelected ? DrawAdorner(fe) : BoundsOf(fe);
            var payload = BuildPayload(fe, bounds);
            if (isSelected)
            {
                _selectedPayload = payload;
                UpdateSelectionTag(payload);
                PositionSelectionTag(bounds);
            }

            PropsRefreshed?.Invoke(payload);
        }
        catch (Exception ex)
        {
            App.Log("SetProperty re-describe failed: " + ex.Message);
        }

        return applied;
    }

    /// <summary>
    /// Select the element at the given authored-tree <paramref name="path"/> (editor caret -> designer, #2).
    /// Resolves the path via <see cref="ElementForPath"/>, draws the adorner, and raises
    /// <see cref="SelectionChanged"/> exactly as a pointer pick would. Returns false when the path resolves to
    /// nothing (stale/out-of-range) — the caller leaves the current selection untouched. UI thread only.
    /// </summary>
    public bool SelectByPath(string? path)
    {
        if (!_designMode || string.IsNullOrEmpty(path))
        {
            return false;
        }

        var fe = ElementForPath(path!);
        if (fe is null)
        {
            return false;
        }

        if (ReferenceEquals(fe, _selected))
        {
            // Already selected — nothing to redraw and don't re-echo, but STILL reset the walk anchor (D4):
            // an editor echo of the current selection must not leave a stale _walkLeaf, or the next designer
            // click on this element would immediately walk UP instead of fresh-picking its leaf.
            _walkLeaf = null;
            return true;
        }

        _selected = fe;
        _walkLeaf = null; // editor-driven selection; the next designer click starts a fresh leaf pick
        _hoverOutline.Visibility = Visibility.Collapsed;
        SelectAndReport(fe);
        return true;
    }

    private void OnPointerMoved(object sender, PointerRoutedEventArgs e)
    {
        if (!_designMode)
        {
            return;
        }

        var pt = e.GetCurrentPoint(_artboard).Position;
        var hit = LeafUnder(pt);
        if (hit is null || ReferenceEquals(hit, _selected))
        {
            _hoverOutline.Visibility = Visibility.Collapsed;
            return;
        }

        var r = BoundsOf(hit);
        Canvas.SetLeft(_hoverOutline, r.X);
        Canvas.SetTop(_hoverOutline, r.Y);
        _hoverOutline.Width = Math.Max(0, r.Width);
        _hoverOutline.Height = Math.Max(0, r.Height);
        _hoverOutline.Visibility = Visibility.Visible;
    }

    // ---- authored-element hit-testing + drill-down (#3) --------------------
    //
    // Designers select the elements the user *authored in the XAML*, never a control's template internals.
    // We therefore consider only elements in the authored (logical) tree — reconstructed via AuthoredSet() from
    // the public content/children accessors — and ignore anything realized from a ControlTemplate. The first
    // click on a region selects its outermost authored element (the "high-level" element); clicking again drills
    // one level deeper into the child under the cursor, and so on to the leaf — the Blend/WPF-designer
    // progressive-selection model. Clicking a different region resets to that region's high-level element.

    /// <summary>The authored ancestor chain under <paramref name="pt"/>, root-first (content root … deepest).</summary>
    private List<FrameworkElement> AuthoredChain(Point pt)
    {
        var chain = new List<FrameworkElement>();
        var authored = AuthoredSet();

        IEnumerable<UIElement> hits;
        try
        {
            // includeAllElements: true so authored panels that are laid out but not hit-testable — a Panel with
            // no Background, over its own padding/margins — are still returned by bounds (bug D3). The default
            // 2-arg overload returns only hit-testable elements, so a click in a transparent StackPanel/Grid's
            // padding would skip the panel entirely and pick an opaque ancestor (or nothing).
            hits = VisualTreeHelper.FindElementsInHostCoordinates(pt, _contentHost, includeAllElements: true);
        }
        catch
        {
            return chain;
        }

        FrameworkElement? deep = null;
        foreach (var el in hits)
        {
            // Results are front-to-back, so the first authored element is the deepest one under the point.
            // Skip anything not user-visible: includeAllElements would otherwise surface Collapsed/Hidden nodes
            // a real click could never hit, which must not become selectable (anti-regression for the D3 fix).
            if (el is FrameworkElement fe && fe.Visibility == Visibility.Visible && authored.Contains(fe))
            {
                deep = fe;
                break;
            }
        }

        if (deep is null)
        {
            return chain;
        }

        DependencyObject? node = deep;
        while (node != null && !ReferenceEquals(node, _contentHost))
        {
            if (node is FrameworkElement fe && authored.Contains(fe))
            {
                chain.Add(fe);
            }

            node = VisualTreeHelper.GetParent(node);
        }

        chain.Reverse(); // root-first
        return chain;
    }

    // The authored (logical) element set — every element reachable through AuthoredChildren from the content
    // host. A control's template internals are never returned by AuthoredChildren, so they're excluded by
    // construction. Built once per host mount (the design surface is recreated on every re-render) and cached.
    // This same authored tree powers source mapping (#1/#2).
    private HashSet<FrameworkElement>? _authoredSet;

    private HashSet<FrameworkElement> AuthoredSet()
    {
        if (_authoredSet != null)
        {
            return _authoredSet;
        }

        var set = new HashSet<FrameworkElement>();
        var stack = new Stack<DependencyObject>();
        stack.Push(_contentHost);
        while (stack.Count > 0)
        {
            foreach (var child in AuthoredChildren(stack.Pop()))
            {
                if (set.Add(child))
                {
                    stack.Push(child);
                }
            }
        }

        _authoredSet = set;
        return set;
    }

    // WinUI (unlike WPF) doesn't expose FrameworkElement.TemplatedParent, so "authored" can't be tested by
    // asking an element whether it came from a template. Instead we reconstruct the authored (logical) tree
    // top-down through each type's XAML CONTENT PROPERTY — the same property the markup compiler assigns a
    // direct child element to. We read it by reflection off the public [ContentProperty] attribute (Panel ->
    // Children, Border/Viewbox -> Child, ContentControl/UserControl/ContentPresenter -> Content, ItemsControl
    // -> Items, and CUSTOM controls -> whatever they declare, e.g. WinUI Gallery's ControlExample -> Example).
    // This is what makes a nested custom control's authored child (the CalendarView the user wrote inside a
    // ControlExample) resolve identically on the client's XML source-map and here — so selection paths match.
    //
    // The one carve-out: a nested UserControl whose content property is "Content" holds its OWN compiled
    // template there (authored in that control's .xaml, not in this page), so we treat it as an opaque leaf.
    // The design ROOT (the page being edited) is the deliberate exception — its Content IS the authored body.
    private FrameworkElement? _rootContent;
    private static readonly Dictionary<Type, string?> _contentPropCache = new();

    /// <summary>The design root — the single authored child of the content host (the page being edited).</summary>
    private FrameworkElement? RootContent()
    {
        if (_rootContent == null)
        {
            foreach (var c in AuthoredChildren(_contentHost))
            {
                _rootContent = c;
                break;
            }
        }

        return _rootContent;
    }

    /// <summary>The XAML content-property name declared by <paramref name="t"/> (or a base type), or null. Cached.</summary>
    private static string? ContentPropertyName(Type t)
    {
        if (_contentPropCache.TryGetValue(t, out var cached))
        {
            return cached;
        }

        string? name = null;
        for (Type? cur = t; cur != null; cur = cur.BaseType)
        {
            var attrs = cur.GetCustomAttributes(typeof(ContentPropertyAttribute), inherit: false);
            if (attrs.Length > 0)
            {
                name = (attrs[0] as ContentPropertyAttribute)?.Name;
                break;
            }
        }

        _contentPropCache[t] = name;
        return name;
    }

    /// <summary>The authored child elements of <paramref name="obj"/> in document order, via its content property.</summary>
    private IEnumerable<FrameworkElement> AuthoredChildren(DependencyObject obj)
    {
        string? cp = ContentPropertyName(obj.GetType());
        if (cp == null)
        {
            yield break;
        }

        // A nested UserControl's "Content" is its private compiled template — opaque. (The root page is the
        // exception: its Content is the authored page body.) Custom controls that expose authored content via a
        // DIFFERENT property (ControlExample.Example) fall through and are walked normally.
        //
        // D5: the !ReferenceEquals(obj, _contentHost) clause MUST precede the RootContent() call. RootContent()
        // is computed lazily by enumerating AuthoredChildren(_contentHost); if the content host itself were a
        // "Content"-property control (a UserControl/ContentControl instead of today's Grid), evaluating
        // RootContent() here — before _rootContent is cached — would re-enter AuthoredChildren(_contentHost) and
        // stack-overflow on the first pick. Short-circuiting on the host is also semantically correct: we always
        // walk the host's Content to FIND the root, and the host is never a "nested opaque UserControl". Zero
        // behavior change for a Grid host (its content property is "Children", so this branch is already skipped).
        if (cp == "Content" && obj is UserControl && !ReferenceEquals(obj, _contentHost) && !ReferenceEquals(obj, RootContent()))
        {
            yield break;
        }

        object? value;
        try
        {
            value = obj.GetType().GetProperty(cp)?.GetValue(obj);
        }
        catch
        {
            yield break;
        }

        if (value is FrameworkElement single)
        {
            yield return single;
            yield break;
        }

        if (value is IEnumerable seq && value is not string)
        {
            foreach (var item in seq)
            {
                if (item is FrameworkElement fe)
                {
                    yield return fe;
                }
            }
        }
    }

    /// <summary>
    /// The set of runtime types in the authored subtree that declare a NON-standard XAML content property —
    /// keyed by the type's simple name (<c>type.Name</c>), value = the content-property name. Only entries
    /// whose content property is non-null and NOT one of the four names the client already handles
    /// ({Children, Content, Child, Items}) are included; e.g. WinUI Gallery's <c>ControlExample</c> -&gt;
    /// <c>{ "ControlExample": "Example" }</c>. The client uses this to recurse into explicit property elements
    /// (<c>&lt;controls:ControlExample.Example&gt;…&lt;/&gt;</c>) so its XAML source-map path matches the
    /// surface's live path (bug D1). Walks the SAME authored tree used for paths. UI thread only.
    /// </summary>
    public Dictionary<string, string> CollectContentProps()
    {
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        var start = RootContent();
        if (start is null)
        {
            return map;
        }

        var visited = new HashSet<FrameworkElement>();
        var stack = new Stack<FrameworkElement>();
        stack.Push(start);
        while (stack.Count > 0)
        {
            var el = stack.Pop();
            if (!visited.Add(el))
            {
                continue;
            }

            Type t = el.GetType();
            string? cp = ContentPropertyName(t);
            if (cp != null && !_standardContentProps.Contains(cp))
            {
                map[t.Name] = cp;
            }

            foreach (var child in AuthoredChildren(el))
            {
                stack.Push(child);
            }
        }

        return map;
    }

    // The four content-property names the client's XamlSourceMap already recurses into unconditionally; any
    // type whose content property is one of these needs no ContentProps map entry.
    private static readonly HashSet<string> _standardContentProps =
        new(StringComparer.Ordinal) { "Children", "Content", "Child", "Items" };

    // ---- authored-tree index paths (source mapping, #1/#2) -----------------
    //
    // A "path" is the sequence of authored child indices from _contentHost down to an element, joined by '.'
    // (e.g. "0.1.0" = _contentHost's child[0] -> its child[1] -> its child[0]). Both directions walk the SAME
    // AuthoredChildren enumeration used for hit-testing, so PathForElement and ElementForPath are exact
    // inverses. The client reconstructs the identical path from the XAML source (document-order element walk),
    // giving a stable bridge between a live element and its text span without mutating the user's markup.

    /// <summary>The authored-tree path of <paramref name="fe"/> relative to the content host, or null if unmapped.</summary>
    private string? PathForElement(FrameworkElement fe)
    {
        var authored = AuthoredSet();
        if (!authored.Contains(fe))
        {
            return null;
        }

        // Authored-ancestor chain, deepest-first, walking up the visual tree and keeping authored elements.
        var chain = new List<FrameworkElement>();
        DependencyObject? node = fe;
        while (node != null && !ReferenceEquals(node, _contentHost))
        {
            if (node is FrameworkElement afe && authored.Contains(afe))
            {
                chain.Add(afe);
            }

            node = VisualTreeHelper.GetParent(node);
        }

        chain.Reverse(); // root-first

        var indices = new List<int>(chain.Count);
        DependencyObject parent = _contentHost;
        foreach (var el in chain)
        {
            int idx = IndexInAuthoredChildren(parent, el);
            if (idx < 0)
            {
                return null; // structural mismatch — give up rather than emit a wrong path
            }

            indices.Add(idx);
            parent = el;
        }

        return indices.Count == 0 ? null : string.Join(".", indices);
    }

    /// <summary>Resolves an authored-tree <paramref name="path"/> (e.g. "0.1.0") to its element, or null.</summary>
    private FrameworkElement? ElementForPath(string path)
    {
        var parts = path.Split('.');
        DependencyObject current = _contentHost;
        foreach (var part in parts)
        {
            if (!int.TryParse(part, out int idx) || idx < 0)
            {
                return null;
            }

            FrameworkElement? next = null;
            int i = 0;
            foreach (var child in AuthoredChildren(current))
            {
                if (i++ == idx)
                {
                    next = child;
                    break;
                }
            }

            if (next is null)
            {
                return null;
            }

            current = next;
        }

        return ReferenceEquals(current, _contentHost) ? null : current as FrameworkElement;
    }

    /// <summary>The index of <paramref name="child"/> within <paramref name="parent"/>'s authored children, or -1.</summary>
    private int IndexInAuthoredChildren(DependencyObject parent, FrameworkElement child)
    {
        int i = 0;
        foreach (var c in AuthoredChildren(parent))
        {
            if (ReferenceEquals(c, child))
            {
                return i;
            }

            i++;
        }

        return -1;
    }

    /// <summary>Applies the selection rule for a click at <paramref name="pt"/>: select the deepest authored
    /// element under the cursor (so a control the user drew in the XAML is picked directly — no drill-in), and
    /// when the SAME spot is clicked again, walk the selection one level UP toward the root. Stateful (updates
    /// <c>_walkLeaf</c>); call once per click.</summary>
    private FrameworkElement? PickForClick(Point pt)
    {
        var chain = AuthoredChain(pt);
        if (chain.Count == 0)
        {
            _walkLeaf = null;
            return null;
        }

        var leaf = chain[chain.Count - 1];
        FrameworkElement target;
        if (_selected != null && ReferenceEquals(leaf, _walkLeaf) && chain.Contains(_selected))
        {
            // Re-click on the same spot: climb one authored level up from the current selection.
            int idx = chain.IndexOf(_selected);
            target = idx > 0 ? chain[idx - 1] : chain[0];
        }
        else
        {
            // Fresh pick: the deepest authored element under the cursor (what the user clicked).
            target = leaf;
        }

        _walkLeaf = leaf;
        return target;
    }

    /// <summary>The deepest authored element under <paramref name="pt"/> (for hover preview), or null.</summary>
    private FrameworkElement? LeafUnder(Point pt)
    {
        var chain = AuthoredChain(pt);
        return chain.Count == 0 ? null : chain[chain.Count - 1];
    }

    // ---- selection tag + properties flyout inside the designer (#1, #4) ----

    /// <summary>Sets the selection tag's type/name text from the current selection payload.</summary>
    private void UpdateSelectionTag(DesignSelectionPayload p)
    {
        _tagType.Text = p.TypeName;
        bool hasName = !string.IsNullOrEmpty(p.Name);
        _tagName.Text = hasName ? p.Name! : string.Empty;
        _tagName.Visibility = hasName ? Visibility.Visible : Visibility.Collapsed;
    }

    /// <summary>Floats the selection tag at the selection's top-left, just above it (drops inside if no room).</summary>
    private void PositionSelectionTag(Rect selection)
    {
        try
        {
            _selectionTag.Visibility = Visibility.Visible;
            _selectionTag.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
            double th = _selectionTag.DesiredSize.Height;

            double left = Math.Max(0, selection.Left);
            double top = selection.Top - th - 2;
            if (top < 0)
            {
                top = selection.Top + 2;
            }

            Canvas.SetLeft(_selectionTag, left);
            Canvas.SetTop(_selectionTag, top);
        }
        catch (Exception ex)
        {
            App.Log("PositionSelectionTag failed: " + ex.Message);
        }
    }

    private void ShowPropsFlyout()
    {
        if (_selectedPayload is null)
        {
            return;
        }

        try
        {
            _propsFlyout.Content = BuildPropsFlyoutContent(_selectedPayload);
            _propsFlyout.ShowAt(_propsButton);
        }
        catch (Exception ex)
        {
            App.Log("ShowPropsFlyout failed: " + ex.Message);
        }
    }

    private static FrameworkElement BuildPropsFlyoutContent(DesignSelectionPayload p)
    {
        var panel = new StackPanel { Spacing = 1, MinWidth = 260 };

        var header = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, Margin = new Thickness(0, 0, 0, 6) };
        header.Children.Add(new TextBlock { Text = p.TypeName, FontWeight = FontWeights.SemiBold });
        if (!string.IsNullOrEmpty(p.Name))
        {
            header.Children.Add(new TextBlock { Text = p.Name, Opacity = 0.7 });
        }

        panel.Children.Add(header);

        if (p.Props.Count == 0)
        {
            panel.Children.Add(new TextBlock { Text = "No inspectable properties.", Opacity = 0.6, FontSize = 12 });
        }

        string? lastCategory = null;
        foreach (var pr in p.Props) // DesignInspector returns rows already grouped/sorted by category
        {
            if (!string.Equals(pr.Category, lastCategory, StringComparison.Ordinal))
            {
                lastCategory = pr.Category;
                panel.Children.Add(new TextBlock
                {
                    Text = pr.Category,
                    FontSize = 11,
                    Opacity = 0.6,
                    FontWeight = FontWeights.SemiBold,
                    Margin = new Thickness(0, 6, 0, 2),
                });
            }

            var row = new Grid { Margin = new Thickness(0, 1, 0, 1) };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(0.45, GridUnitType.Star) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(0.55, GridUnitType.Star) });

            var name = new TextBlock { Text = pr.Name, FontSize = 12, TextTrimming = TextTrimming.CharacterEllipsis };
            var value = new TextBlock { Text = pr.Value, FontSize = 12, Opacity = 0.85, TextTrimming = TextTrimming.CharacterEllipsis };
            Grid.SetColumn(value, 1);
            row.Children.Add(name);
            row.Children.Add(value);
            panel.Children.Add(row);
        }

        return new ScrollViewer
        {
            Content = panel,
            MaxHeight = 420,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
        };
    }

    private Rect BoundsOf(FrameworkElement fe)
    {
        try
        {
            var gt = fe.TransformToVisual(_adornerCanvas);
            return gt.TransformBounds(new Rect(0, 0, fe.ActualWidth, fe.ActualHeight));
        }
        catch
        {
            return new Rect(0, 0, 0, 0);
        }
    }

    private Rect DrawAdorner(FrameworkElement fe)
    {
        var r = BoundsOf(fe);
        Canvas.SetLeft(_selectRect, r.X);
        Canvas.SetTop(_selectRect, r.Y);
        _selectRect.Width = Math.Max(0, r.Width);
        _selectRect.Height = Math.Max(0, r.Height);
        _selectRect.Visibility = Visibility.Visible;
        PositionHandles(r);
        return r;
    }

    private void PositionHandles(Rect r)
    {
        // 8 handles: 4 corners + 4 edge midpoints, centered on the selection border.
        double[] xs = { r.Left, r.Left + r.Width / 2, r.Right };
        double[] ys = { r.Top, r.Top + r.Height / 2, r.Bottom };
        int i = 0;
        for (int yi = 0; yi < 3; yi++)
        {
            for (int xi = 0; xi < 3; xi++)
            {
                if (xi == 1 && yi == 1)
                {
                    continue; // skip the center
                }

                var h = _handles[i++];
                Canvas.SetLeft(h, xs[xi] - h.Width / 2);
                Canvas.SetTop(h, ys[yi] - h.Height / 2);
                h.Visibility = Visibility.Visible;
            }
        }
    }

    private void ClearAdorner()
    {
        _selectRect.Visibility = Visibility.Collapsed;
        _selectionTag.Visibility = Visibility.Collapsed;
        foreach (var h in _handles)
        {
            h.Visibility = Visibility.Collapsed;
        }
    }

    private int GetOrAssignId(FrameworkElement fe)
    {
        if (_elToId.TryGetValue(fe, out var existing))
        {
            return existing;
        }

        int id = _nextId++;
        _elToId[fe] = id;
        _idToEl[id] = new WeakReference<FrameworkElement>(fe);
        return id;
    }
}
