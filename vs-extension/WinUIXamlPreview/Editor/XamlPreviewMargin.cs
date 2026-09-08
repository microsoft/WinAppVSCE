#nullable enable

using System;
using System.ComponentModel.Composition;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Imaging;
using Microsoft.VisualStudio.Imaging.Interop;
using Microsoft.VisualStudio.PlatformUI;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using Microsoft.VisualStudio.Text;
using Microsoft.VisualStudio.Text.Editor;
using Microsoft.VisualStudio.Utilities;
using WinUIXamlPreview.Logging;
using WinUIXamlPreview.Protocol;
using WinUIXamlPreview.UI;

namespace WinUIXamlPreview.Editor
{
    // The live WinUI preview rides INSIDE the XAML code tab as an editor margin — the low-risk route to a
    // "native VS Design" feel. It attaches to VS's built-in XAML editor via MEF and adds nothing to the
    // text buffer, so the XAML language service / IntelliSense are untouched by construction.
    //
    // Two providers export the SAME margin, one per dock container (Right vertical split / Bottom
    // horizontal split). Only the provider whose container matches the persisted PreviewOptions.Location
    // returns a real margin; the other returns null. The margin is cached per text view so a single
    // Surface.exe backs each tab even if CreateMargin is re-entered (e.g. Open With), and it disposes with
    // the view. Flipping the layout persists the new location and reopens the file so the other provider
    // runs.

    [Export(typeof(IWpfTextViewMarginProvider))]
    [Name("WinUIXamlPreviewMargin.Right")]
    [Order(After = PredefinedMarginNames.VerticalScrollBar)]
    [MarginContainer(PredefinedMarginNames.Right)]
    [ContentType("XAML")]
    [TextViewRole(PredefinedTextViewRoles.Document)]
    internal sealed class XamlPreviewRightMarginProvider : IWpfTextViewMarginProvider
    {
        private readonly ITextDocumentFactoryService _docFactory;

        [ImportingConstructor]
        public XamlPreviewRightMarginProvider(ITextDocumentFactoryService docFactory)
        {
            _docFactory = docFactory;
        }

        public IWpfTextViewMargin? CreateMargin(IWpfTextViewHost wpfTextViewHost, IWpfTextViewMargin marginContainer)
            => XamlPreviewMargin.TryCreate(wpfTextViewHost, _docFactory, PreviewLocation.Right);
    }

    [Export(typeof(IWpfTextViewMarginProvider))]
    [Name("WinUIXamlPreviewMargin.Bottom")]
    [Order(After = PredefinedMarginNames.HorizontalScrollBar)]
    [MarginContainer(PredefinedMarginNames.Bottom)]
    [ContentType("XAML")]
    [TextViewRole(PredefinedTextViewRoles.Document)]
    internal sealed class XamlPreviewBottomMarginProvider : IWpfTextViewMarginProvider
    {
        private readonly ITextDocumentFactoryService _docFactory;

        [ImportingConstructor]
        public XamlPreviewBottomMarginProvider(ITextDocumentFactoryService docFactory)
        {
            _docFactory = docFactory;
        }

        public IWpfTextViewMargin? CreateMargin(IWpfTextViewHost wpfTextViewHost, IWpfTextViewMargin marginContainer)
            => XamlPreviewMargin.TryCreate(wpfTextViewHost, _docFactory, PreviewLocation.Bottom);
    }

    /// <summary>
    /// The docked panel that hosts a <see cref="PreviewControl"/> pinned to this tab's .xaml file, with a
    /// draggable resize grip, a themed in-tab toolbar, and a Right/Bottom layout toggle.
    /// </summary>
    internal sealed class XamlPreviewMargin : IWpfTextViewMargin
    {
        public const string MarginName = "WinUIXamlPreviewMargin";

        private readonly IWpfTextView _textView;
        private readonly PreviewLocation _location;
        private readonly Grid _root;
        private readonly PreviewControl _preview;
        private readonly DockPanel _content;
        private readonly Border _grip;
        private readonly FrameworkElement _collapsedBar;
        private Button? _liveButton;
        private Button? _dtdButton;
        private Button? _selectButton;
        private Button? _themeButton;
        private Button? _sizeButton;
        private string? _path;
        private bool _disposed;

        // Two-way selection sync (plan §41 #1/#2). The source map bridges the XAML text and the surface's
        // authored-tree paths; it's rebuilt lazily from the current buffer snapshot when marked dirty (on edit).
        private XamlSourceMap? _sourceMap;
        private bool _sourceMapDirty = true;
        // Echo guard: moving the caret in #1 fires PositionChanged (#2) synchronously; this suppresses that
        // re-entrant hop so the two directions can't loop. The async echo (#2 -> surface -> Selected -> #1) is
        // additionally broken by the "caret already inside the element's span" check in #1.
        private bool _syncing;
        private string? _lastCaretPath;

        // Live-edit refresh: coalesce a burst of keystrokes into a single re-render (#7). The editor raises
        // ITextBuffer.Changed on the UI thread, so a UI DispatcherTimer is the natural debounce.
        private readonly ITextBuffer? _buffer;
        private readonly System.Windows.Threading.DispatcherTimer _editDebounce;
        private bool _dirtyWhileCollapsed;

        // Resize-grip drag state (measured against the text view element, which is stable while the
        // margin resizes — using the margin's own coordinate space would feed back on itself).
        private bool _dragging;
        private Point _dragAnchor;
        private double _dragStartSize;

        /// <summary>
        /// Returns the shared margin for this view when <paramref name="location"/> matches the persisted
        /// preference, else null. Cached per text view (one Surface.exe per tab); never throws into the editor.
        /// </summary>
        public static IWpfTextViewMargin? TryCreate(IWpfTextViewHost host, ITextDocumentFactoryService docFactory, PreviewLocation location)
        {
            try
            {
                if (PreviewOptions.Location != location)
                {
                    return null; // the other container owns the margin right now
                }

                // Only attach to WinUI 3 XAML. WPF and UWP share WinUI's default namespace URI, so they can't
                // be told apart from the markup alone — we inspect the owning project. A non-WinUI document gets
                // no margin (and, returning null, no cached surface) so the designer never shows for WPF/UWP.
                var path = ResolveDocumentPath(host.TextView, docFactory);
                if (!Protocol.ProjectDllLocator.IsWinUiXaml(path, m => Log.Write("WinUI gate: " + m)))
                {
                    return null;
                }

                // Leak-safe singleton: one margin (one surface) per view even under re-entrant CreateMargin.
                return host.TextView.Properties.GetOrCreateSingletonProperty(
                    typeof(XamlPreviewMargin),
                    () => new XamlPreviewMargin(host.TextView, docFactory, location));
            }
            catch (Exception ex)
            {
                // A margin failure must never take down the editor — log and render no margin.
                Log.Write("XamlPreviewMargin creation failed: " + ex);
                return null;
            }
        }

        private XamlPreviewMargin(IWpfTextView textView, ITextDocumentFactoryService docFactory, PreviewLocation location)
        {
            _textView = textView;
            _location = location;
            _preview = new PreviewControl();

            _root = new Grid();
            _root.SetResourceReference(Panel.BackgroundProperty, EnvironmentColors.ToolWindowBackgroundBrushKey);

            // toolbar (top) + preview (fill)
            _content = new DockPanel { LastChildFill = true };
            var toolbar = BuildToolbar();
            DockPanel.SetDock(toolbar, Dock.Top);
            _content.Children.Add(toolbar);
            _content.Children.Add(_preview);

            _grip = BuildGrip(vertical: location == PreviewLocation.Right);
            _collapsedBar = BuildCollapsedBar(vertical: location == PreviewLocation.Right);

            if (location == PreviewLocation.Right)
            {
                _root.Width = PreviewOptions.RightWidth;
                _root.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                _root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                Grid.SetColumn(_grip, 0);
                Grid.SetColumn(_content, 1);
                Grid.SetColumn(_collapsedBar, 0);
                Grid.SetColumnSpan(_collapsedBar, 2);
            }
            else
            {
                _root.Height = PreviewOptions.BottomHeight;
                _root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
                _root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
                Grid.SetRow(_grip, 0);
                Grid.SetRow(_content, 1);
                Grid.SetRow(_collapsedBar, 0);
                Grid.SetRowSpan(_collapsedBar, 2);
            }

            _root.Children.Add(_grip);
            _root.Children.Add(_content);
            _root.Children.Add(_collapsedBar);

            // Pin the preview to THIS tab's document so it doesn't chase the active tab.
            _path = ResolveDocumentPath(textView, docFactory);
            if (!string.IsNullOrEmpty(_path))
            {
                Log.Write($"XamlPreviewMargin[{location}]: pinning to '{_path}'.");
                _preview.PinToDocument(_path!);
            }
            else
            {
                Log.Write($"XamlPreviewMargin[{location}]: could not resolve a document path for this view.");
            }

            // Debounced live-edit refresh (#7): re-render from the unsaved buffer a short beat after typing stops.
            _buffer = textView.TextDataModel?.DocumentBuffer ?? textView.TextBuffer;
            _editDebounce = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromMilliseconds(500) };
            _editDebounce.Tick += OnEditDebounceTick;
            if (_buffer != null)
            {
                _buffer.Changed += OnBufferChanged;
            }

            // Two-way selection sync (plan §41): designer selection -> editor caret (#1), editor caret ->
            // designer selection (#2). Both are best-effort and guarded against echo looping.
            _preview.ElementSelected += OnDesignerElementSelected;
            _preview.ContentPropMapChanged += OnContentPropMapChanged;
            try { _textView.Caret.PositionChanged += OnCaretPositionChanged; }
            catch (Exception ex) { Log.Write("Caret sync subscribe failed: " + ex.Message); }

            ApplyCollapsedState();
        }

        // ---- toolbar --------------------------------------------------------

        private FrameworkElement BuildToolbar()
        {
            var bar = new DockPanel { LastChildFill = true, Height = 28 };
            bar.SetResourceReference(Panel.BackgroundProperty, EnvironmentColors.CommandShelfBackgroundGradientBrushKey);

            var buttons = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                HorizontalAlignment = HorizontalAlignment.Right,
                VerticalAlignment = VerticalAlignment.Center,
            };

            var toggleTarget = _location == PreviewLocation.Right ? "Bottom" : "Right";
            var dockMoniker = _location == PreviewLocation.Right ? KnownMonikers.DockBottom : KnownMonikers.DockRight;
            buttons.Children.Add(MakeButton(KnownMonikers.Refresh, "Reload", "Re-render the preview", OnReloadClick, "PreviewReloadButton"));
            buttons.Children.Add(MakeSeparator());
            _selectButton = MakeButton(SelectMoniker(), SelectLabel(), SelectTooltip(), OnToggleSelectClick, "PreviewSelectToggle");
            buttons.Children.Add(_selectButton);
            buttons.Children.Add(MakeButton(KnownMonikers.Property, "Properties", "Show the design-time Properties panel", OnPropertiesClick, "PreviewPropertiesButton"));
            buttons.Children.Add(MakeSeparator());
            _themeButton = MakeMenuButton(KnownMonikers.DarkTheme, ThemeLabel(), ThemeTooltip(), "PreviewThemeButton", BuildThemeMenu());
            buttons.Children.Add(_themeButton);
            _sizeButton = MakeMenuButton(KnownMonikers.Monitor, SizeLabel(), SizeTooltip(), "PreviewSizeButton", BuildSizeMenu());
            buttons.Children.Add(_sizeButton);
            buttons.Children.Add(MakeSeparator());
            _liveButton = MakeButton(LiveMoniker(), LiveLabel(), LiveTooltip(), OnToggleLiveClick, "PreviewLiveToggle");
            buttons.Children.Add(_liveButton);
            _dtdButton = MakeButton(DtdMoniker(), DtdLabel(), DtdTooltip(), OnToggleDtdClick, "PreviewDtdToggle");
            buttons.Children.Add(_dtdButton);
            buttons.Children.Add(MakeSeparator());
            buttons.Children.Add(MakeButton(dockMoniker, $"Dock {toggleTarget}", $"Move the preview to the {toggleTarget.ToLowerInvariant()} (reopens this file)", OnToggleLayoutClick, "PreviewDockToggle"));
            buttons.Children.Add(MakeButton(KnownMonikers.NewWindow, "Window", "Open the preview in a separate tool window", OnPopOutClick, "PreviewWindowButton"));
            buttons.Children.Add(MakeButton(KnownMonikers.Collapse, "Hide", "Collapse the preview to a thin strip — click the strip to reopen it", OnHideClick, "PreviewHideButton"));

            var title = new TextBlock
            {
                Text = "WinUI Preview",
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(8, 0, 0, 0),
                FontSize = 12,
            };
            title.SetResourceReference(TextBlock.ForegroundProperty, EnvironmentColors.ToolWindowTextBrushKey);
            AutomationProperties.SetAutomationId(title, "PreviewMarginTitle");

            DockPanel.SetDock(buttons, Dock.Right);
            bar.Children.Add(buttons); // right-docked first so the title fills the remainder
            bar.Children.Add(title);
            return bar;
        }

        private Button MakeButton(ImageMoniker moniker, string label, string tooltip, RoutedEventHandler onClick, string automationId)
        {
            var b = new Button
            {
                ToolTip = tooltip,
                Padding = new Thickness(6, 1, 8, 1),
                Margin = new Thickness(0, 3, 2, 3),
                MinWidth = 0,
                Cursor = Cursors.Hand,
                Focusable = false,
                VerticalAlignment = VerticalAlignment.Center,
                Content = BuildButtonContent(moniker, label),
            };
            b.SetResourceReference(Control.ForegroundProperty, EnvironmentColors.ToolWindowTextBrushKey);
            // Content is now an icon+text panel, so the UIA Name no longer defaults to the label. Set it
            // explicitly so scripted UIA (winapp) can still read a toggle button's current state; SetButton
            // keeps it in sync when a toggle flips (Select/Interact, Live: On/Off, Dock Right/Bottom).
            AutomationProperties.SetName(b, label);
            AutomationProperties.SetAutomationId(b, automationId);
            b.Click += onClick;
            return b;
        }

        // VS-authentic themed icon (CrispImage + KnownMonikers) + optional text label.
        private static FrameworkElement BuildButtonContent(ImageMoniker moniker, string label)
        {
            var panel = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
            panel.Children.Add(new CrispImage
            {
                Moniker = moniker,
                Width = 16,
                Height = 16,
                VerticalAlignment = VerticalAlignment.Center,
            });
            if (!string.IsNullOrEmpty(label))
            {
                var tb = new TextBlock
                {
                    Text = label,
                    FontSize = 11,
                    Margin = new Thickness(5, 0, 0, 0),
                    VerticalAlignment = VerticalAlignment.Center,
                };
                tb.SetResourceReference(TextBlock.ForegroundProperty, EnvironmentColors.ToolWindowTextBrushKey);
                panel.Children.Add(tb);
            }
            return panel;
        }

        // Updates a toggle button's icon + label + UIA Name + tooltip together.
        private static void SetButton(Button? b, ImageMoniker moniker, string label, string tooltip)
        {
            if (b == null) { return; }
            b.Content = BuildButtonContent(moniker, label);
            b.ToolTip = tooltip;
            AutomationProperties.SetName(b, label);
        }

        // Thin themed group separator between toolbar button clusters.
        private static FrameworkElement MakeSeparator()
        {
            var sep = new Border
            {
                Width = 1,
                Margin = new Thickness(3, 6, 3, 6),
                VerticalAlignment = VerticalAlignment.Stretch,
                SnapsToDevicePixels = true,
            };
            sep.SetResourceReference(Border.BackgroundProperty, EnvironmentColors.CommandBarMenuSeparatorBrushKey);
            return sep;
        }

        // ---- dropdown (menu) buttons: Theme + Size ------------------------------
        //
        // A VS-icon toolbar button that opens a checkable ContextMenu (like a WPF/Blend "device" + theme
        // picker). The button label reflects the current selection; the checked menu item confirms it.

        // Device-size presets for the design canvas (DIP). "Auto" (0,0) clears the override so the page
        // renders at its own size / the default canvas. Kept in sync with the surface's SetCanvasSize.
        private static readonly (string Name, double W, double H)[] SizePresets =
        {
            ("Auto", 0, 0),
            ("Phone", 360, 640),
            ("Tablet", 768, 1024),
            ("Desktop", 1280, 800),
            ("Full HD", 1920, 1080),
        };

        private static readonly string[] ThemeOptions = { "Light", "Dark", "Default" };

        private Button MakeMenuButton(ImageMoniker moniker, string label, string tooltip, string automationId, ContextMenu menu)
        {
            var b = new Button
            {
                ToolTip = tooltip,
                Padding = new Thickness(6, 1, 6, 1),
                Margin = new Thickness(0, 3, 2, 3),
                MinWidth = 0,
                Cursor = Cursors.Hand,
                Focusable = false,
                VerticalAlignment = VerticalAlignment.Center,
                Content = BuildMenuButtonContent(moniker, label),
            };
            b.SetResourceReference(Control.ForegroundProperty, EnvironmentColors.ToolWindowTextBrushKey);
            AutomationProperties.SetName(b, label);
            AutomationProperties.SetAutomationId(b, automationId);
            menu.PlacementTarget = b;
            menu.Placement = System.Windows.Controls.Primitives.PlacementMode.Bottom;
            b.ContextMenu = menu;
            b.Click += (s, e) =>
            {
                if (b.ContextMenu != null)
                {
                    b.ContextMenu.PlacementTarget = b;
                    b.ContextMenu.IsOpen = true;
                }
            };
            return b;
        }

        // Icon + label + a small dropdown caret, so the button reads as a picker.
        private static FrameworkElement BuildMenuButtonContent(ImageMoniker moniker, string label)
        {
            var panel = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
            panel.Children.Add(new CrispImage { Moniker = moniker, Width = 16, Height = 16, VerticalAlignment = VerticalAlignment.Center });
            var tb = new TextBlock { Text = label, FontSize = 11, Margin = new Thickness(5, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
            tb.SetResourceReference(TextBlock.ForegroundProperty, EnvironmentColors.ToolWindowTextBrushKey);
            panel.Children.Add(tb);
            var caret = new TextBlock { Text = "\u25BE", FontSize = 9, Margin = new Thickness(4, 1, 0, 0), VerticalAlignment = VerticalAlignment.Center };
            caret.SetResourceReference(TextBlock.ForegroundProperty, EnvironmentColors.ToolWindowTextBrushKey);
            panel.Children.Add(caret);
            return panel;
        }

        // Applies VS environment brushes to a ContextMenu + its items so it doesn't render as a bare white
        // WPF menu inside a dark IDE. Best-effort — brush keys always resolve inside VS.
        private static ContextMenu ThemeMenu(ContextMenu menu)
        {
            menu.SetResourceReference(Control.BackgroundProperty, EnvironmentColors.CommandBarMenuBackgroundGradientBrushKey);
            menu.SetResourceReference(Control.ForegroundProperty, EnvironmentColors.CommandBarTextActiveBrushKey);
            menu.SetResourceReference(Control.BorderBrushProperty, EnvironmentColors.CommandBarMenuBorderBrushKey);
            menu.BorderThickness = new Thickness(1);
            return menu;
        }

        private MenuItem MakeMenuItem(string header, bool isChecked, string automationId, RoutedEventHandler onClick)
        {
            var item = new MenuItem { Header = header, IsCheckable = true, IsChecked = isChecked };
            item.SetResourceReference(Control.ForegroundProperty, EnvironmentColors.CommandBarTextActiveBrushKey);
            AutomationProperties.SetName(item, header);
            AutomationProperties.SetAutomationId(item, automationId);
            item.Click += onClick;
            return item;
        }

        // ---- Theme picker (Light / Dark / Default) --------------------------

        private static string ThemeLabel() => PreviewOptions.Theme;

        private static string ThemeTooltip() =>
            $"Preview theme: {PreviewOptions.Theme}. Click to preview the page under Light, Dark, or Default (host) theme.";

        private ContextMenu BuildThemeMenu()
        {
            var menu = ThemeMenu(new ContextMenu());
            var current = PreviewOptions.Theme;
            foreach (var opt in ThemeOptions)
            {
                var value = opt;
                menu.Items.Add(MakeMenuItem(opt, string.Equals(current, value, StringComparison.Ordinal),
                    "PreviewTheme" + value, (s, e) => OnThemeSelected(value)));
            }
            return menu;
        }

        private void OnThemeSelected(string theme)
        {
            try
            {
                _preview.SetTheme(theme);
                SetMenuButton(_themeButton, KnownMonikers.DarkTheme, ThemeLabel(), ThemeTooltip(), BuildThemeMenu());
            }
            catch (Exception ex) { Log.Write("Theme select failed: " + ex); }
        }

        // ---- Size picker (device presets) -----------------------------------

        private static string SizeLabel()
        {
            double w = PreviewOptions.CanvasWidth, h = PreviewOptions.CanvasHeight;
            if (!(w > 0 && h > 0)) { return "Auto"; }
            foreach (var p in SizePresets)
            {
                if (p.W == w && p.H == h) { return p.Name; }
            }
            return $"{w:0}\u00d7{h:0}";
        }

        private static string SizeTooltip() =>
            $"Design surface size: {SizeLabel()}. Click to preview the page at a device size (or Auto for its own size).";

        private ContextMenu BuildSizeMenu()
        {
            var menu = ThemeMenu(new ContextMenu());
            double w = PreviewOptions.CanvasWidth, h = PreviewOptions.CanvasHeight;
            foreach (var p in SizePresets)
            {
                bool isAuto = p.W == 0 || p.H == 0;
                bool isChecked = isAuto ? !(w > 0 && h > 0) : (p.W == w && p.H == h);
                string header = isAuto ? p.Name : $"{p.Name}  ({p.W:0}\u00d7{p.H:0})";
                var pw = p.W; var ph = p.H;
                menu.Items.Add(MakeMenuItem(header, isChecked,
                    "PreviewSize" + p.Name.Replace(" ", ""), (s, e) => OnSizeSelected(pw, ph)));
            }
            return menu;
        }

        private void OnSizeSelected(double w, double h)
        {
            try
            {
                _preview.SetCanvasSize(w, h);
                SetMenuButton(_sizeButton, KnownMonikers.Monitor, SizeLabel(), SizeTooltip(), BuildSizeMenu());
            }
            catch (Exception ex) { Log.Write("Size select failed: " + ex); }
        }

        // Updates a dropdown button's icon + label + UIA Name + tooltip + menu (with refreshed checks).
        private static void SetMenuButton(Button? b, ImageMoniker moniker, string label, string tooltip, ContextMenu menu)
        {
            if (b == null) { return; }
            b.Content = BuildMenuButtonContent(moniker, label);
            b.ToolTip = tooltip;
            AutomationProperties.SetName(b, label);
            menu.PlacementTarget = b;
            menu.Placement = System.Windows.Controls.Primitives.PlacementMode.Bottom;
            b.ContextMenu = menu;
        }

        private void OnReloadClick(object sender, RoutedEventArgs e)
        {
            try { _preview.Reload(); }
            catch (Exception ex) { Log.Write("Reload failed: " + ex); }
        }

        // ---- live-mode toggle ----------------------------------------------
        //
        // Flips the global opt-in (PreviewOptions.LiveMode) and restarts THIS tab's preview so its surface
        // relaunches in the new mode. Live = instantiate the real page type so {x:Bind}/code-behind state
        // render (plan §39); off = the robust static parse path. The preview auto-falls back to parse per
        // page when a page can't activate live, so this can only add fidelity, never leave a dead preview.

        private static string LiveLabel() => PreviewOptions.LiveMode ? "Live: On" : "Live: Off";

        private static ImageMoniker LiveMoniker() => PreviewOptions.LiveMode ? KnownMonikers.Play : KnownMonikers.Stop;

        private static string LiveTooltip() => PreviewOptions.LiveMode
            ? "Live preview is ON — runs the real page so x:Bind and code-behind state render. Click to switch to the static (parse) preview."
            : "Live preview is OFF — static parse preview (x:Bind and code-behind state are blank). Click to enable live preview.";

        private void OnToggleLiveClick(object sender, RoutedEventArgs e)
        {
            try
            {
                _preview.SetLiveMode(!PreviewOptions.LiveMode);
                SetButton(_liveButton, LiveMoniker(), LiveLabel(), LiveTooltip());
            }
            catch (Exception ex) { Log.Write("Toggle live mode failed: " + ex); }
        }

        // ---- design-time data (sample data) toggle -------------------------
        //
        // Flips the global opt-in (PreviewOptions.DesignTimeData) and restarts THIS tab's preview so its surface
        // relaunches with SURFACE_DTD_REFLECT set. This is the §51 M3 reflection accelerator: it fills empty
        // {x:Bind}-backed collections with reflected sample items so otherwise-blank live pages show representative
        // content. It only takes effect together with live mode (it runs after real-type activation); the M1
        // (d:DesignData) and M2 (DesignMode contract) sample-data paths are automatic and need no toggle.

        private static string DtdLabel() => PreviewOptions.DesignTimeData ? "Sample data: On" : "Sample data: Off";

        private static ImageMoniker DtdMoniker() => KnownMonikers.Table;

        private static string DtdTooltip() => PreviewOptions.DesignTimeData
            ? "Design-time sample data is ON — empty x:Bind collections are filled with reflected sample items (takes effect in live mode). Click to turn it off."
            : "Design-time sample data is OFF. Click to fill empty x:Bind collections with sample items in live preview (design-time data accelerator).";

        private void OnToggleDtdClick(object sender, RoutedEventArgs e)
        {
            try
            {
                _preview.SetDesignTimeData(!PreviewOptions.DesignTimeData);
                SetButton(_dtdButton, DtdMoniker(), DtdLabel(), DtdTooltip());
            }
            catch (Exception ex) { Log.Write("Toggle design-time data failed: " + ex); }
        }

        private void OnPopOutClick(object sender, RoutedEventArgs e)
        {
            try { PreviewPackageState.RequestShowToolWindow?.Invoke(); }
            catch (Exception ex) { Log.Write("Pop-out failed: " + ex); }
        }

        // ---- select / interact toggle -------------------------------------
        //
        // Flips the design surface between SELECT (click an element to select + inspect it — the WPF/Blend
        // designer behavior) and INTERACT (clicks reach the running content). Applied live by the surface
        // with no re-render (plan §41). Selecting an element populates the Properties panel.

        private static string SelectLabel() => PreviewOptions.DesignMode ? "Select" : "Interact";

        private static ImageMoniker SelectMoniker() => PreviewOptions.DesignMode ? KnownMonikers.Select : KnownMonikers.Cursor;

        private static string SelectTooltip() => PreviewOptions.DesignMode
            ? "Select mode — click an element to select and inspect it (it won't interact). Click to switch to Interact."
            : "Interact mode — clicks reach the running app. Click to switch to Select (design) mode.";

        private void OnToggleSelectClick(object sender, RoutedEventArgs e)
        {
            try
            {
                _preview.SetDesignMode(!PreviewOptions.DesignMode);
                SetButton(_selectButton, SelectMoniker(), SelectLabel(), SelectTooltip());
            }
            catch (Exception ex) { Log.Write("Toggle select mode failed: " + ex); }
        }

        private void OnPropertiesClick(object sender, RoutedEventArgs e)
        {
            try { DesignerSelection.ShowPropertiesWindow(); }
            catch (Exception ex) { Log.Write("Show properties failed: " + ex); }
        }

        // ---- collapse / expand (easy open + close, #6) ---------------------
        //
        // Collapsed, the margin shrinks to a thin strip on its docked edge so the editor reclaims the space;
        // clicking the strip restores it. The choice persists (PreviewOptions.Collapsed) so it sticks across
        // tabs and sessions. The strip is always present, so the designer is one click away — the "how do I get
        // it back?" problem is gone.

        private void OnHideClick(object sender, RoutedEventArgs e) => SetCollapsed(true);

        private void OnShowClick(object sender, RoutedEventArgs e) => SetCollapsed(false);

        private void SetCollapsed(bool collapsed)
        {
            try
            {
                PreviewOptions.Collapsed = collapsed;
                ApplyCollapsedState();
            }
            catch (Exception ex) { Log.Write("Toggle collapse failed: " + ex); }
        }

        private void ApplyCollapsedState()
        {
            var collapsed = PreviewOptions.Collapsed;

            _content.Visibility = collapsed ? Visibility.Collapsed : Visibility.Visible;
            _grip.Visibility = collapsed ? Visibility.Collapsed : Visibility.Visible;
            _collapsedBar.Visibility = collapsed ? Visibility.Visible : Visibility.Collapsed;

            if (_location == PreviewLocation.Right)
            {
                _root.Width = collapsed ? CollapsedStripSize : PreviewOptions.RightWidth;
            }
            else
            {
                _root.Height = collapsed ? CollapsedStripSize : PreviewOptions.BottomHeight;
            }

            // Re-render on expand if edits arrived while hidden (we skip live-edit renders while collapsed).
            if (!collapsed && _dirtyWhileCollapsed)
            {
                _dirtyWhileCollapsed = false;
                try { _preview.Reload(); } catch (Exception ex) { Log.Write("Reload-on-expand failed: " + ex); }
            }
        }

        private const double CollapsedStripSize = 26;

        private FrameworkElement BuildCollapsedBar(bool vertical)
        {
            // A single stretch button along the docked edge: the whole strip is the "reopen" affordance.
            var label = new TextBlock
            {
                Text = "WinUI Preview",
                FontSize = 11,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
            };
            label.SetResourceReference(TextBlock.ForegroundProperty, EnvironmentColors.ToolWindowTextBrushKey);

            if (vertical)
            {
                // Rotate the label so it reads bottom-to-top in the narrow vertical strip.
                label.LayoutTransform = new RotateTransform(-90);
            }

            var button = new Button
            {
                Content = label,
                ToolTip = "Show the WinUI preview",
                Cursor = Cursors.Hand,
                Focusable = false,
                Padding = new Thickness(2),
                BorderThickness = new Thickness(0),
            };
            button.SetResourceReference(Control.BackgroundProperty, EnvironmentColors.CommandShelfBackgroundGradientBrushKey);
            AutomationProperties.SetAutomationId(button, "PreviewShowButton");
            AutomationProperties.SetName(button, "Show the WinUI preview");
            button.Click += OnShowClick;

            if (vertical)
            {
                button.HorizontalAlignment = HorizontalAlignment.Stretch;
                button.VerticalAlignment = VerticalAlignment.Stretch;
            }
            else
            {
                button.HorizontalAlignment = HorizontalAlignment.Stretch;
                button.VerticalAlignment = VerticalAlignment.Stretch;
            }

            return button;
        }

        // ---- debounced live-edit refresh (#7) ------------------------------

        private void OnBufferChanged(object sender, TextContentChangedEventArgs e)
        {
            if (_disposed)
            {
                return;
            }

            // The text changed, so the cached path<->span map is stale; rebuild it lazily on next use.
            _sourceMapDirty = true;

            // Don't spend renders on a hidden preview; mark it dirty and refresh when it's reopened.
            if (PreviewOptions.Collapsed)
            {
                _dirtyWhileCollapsed = true;
                return;
            }

            _editDebounce.Stop();
            _editDebounce.Start();
        }

        private void OnEditDebounceTick(object sender, EventArgs e)
        {
            _editDebounce.Stop();
            if (_disposed || PreviewOptions.Collapsed)
            {
                return;
            }

            try { _preview.Reload(); }
            catch (Exception ex) { Log.Write("Live-edit reload failed: " + ex); }
        }

        // ---- two-way selection sync (plan §41 #1/#2) ------------------------

        /// <summary>Bug D1 — the surface reported a new custom content-property map; the source map must rebuild
        /// so path resolution recurses into explicit property elements (e.g. ControlExample.Example).</summary>
        private void OnContentPropMapChanged()
        {
            _sourceMapDirty = true;
        }

        /// <summary>Rebuilds the path&lt;-&gt;span map from the current buffer snapshot if it's stale. Keeps the
        /// last good map when the (mid-edit) text isn't well-formed, so sync degrades to slightly-stale offsets
        /// rather than breaking.</summary>
        private XamlSourceMap? EnsureSourceMap()
        {
            if (!_sourceMapDirty && _sourceMap != null)
            {
                return _sourceMap;
            }

            try
            {
                var text = _buffer?.CurrentSnapshot?.GetText() ?? _textView.TextSnapshot?.GetText();
                var built = XamlSourceMap.Build(text, _preview.ContentPropMap);
                if (built != null && built.HasContent)
                {
                    _sourceMap = built;
                    _sourceMapDirty = false;
                }
            }
            catch (Exception ex)
            {
                Log.Write("Source map rebuild failed: " + ex.Message);
            }

            return _sourceMap;
        }

        /// <summary>#1 — the designer selected an element; move the editor caret to its source span.</summary>
        private void OnDesignerElementSelected(SelectedMsg sel)
        {
            if (_disposed || _syncing || string.IsNullOrEmpty(sel?.Path))
            {
                return;
            }

            var map = EnsureSourceMap();
            if (map == null || !map.TryGetSpan(sel!.Path, out int start, out int end))
            {
                return;
            }

            try
            {
                var snapshot = _textView.TextSnapshot;
                int len = snapshot.Length;
                if (start > len) start = len;
                if (end > len) end = len;
                if (end < start) end = start;

                // If the caret is already inside this element, the selection originated from the caret (#2's
                // echo) — leave it be so the two directions don't fight over the caret.
                int caret = _textView.Caret.Position.BufferPosition.Position;
                if (caret >= start && caret < end)
                {
                    _lastCaretPath = sel.Path;
                    return;
                }

                _syncing = true;
                try
                {
                    // Highlight the element's opening tag (name + attributes), caret at its start.
                    int tagEnd = FindStartTagEnd(snapshot, start);
                    var selSpan = new SnapshotSpan(snapshot, start, Math.Max(0, tagEnd - start));
                    _textView.Selection.Select(selSpan, isReversed: false);
                    _textView.Caret.MoveTo(new SnapshotPoint(snapshot, start));
                    _textView.ViewScroller.EnsureSpanVisible(selSpan);
                    _lastCaretPath = sel.Path;
                }
                finally
                {
                    _syncing = false;
                }
            }
            catch (Exception ex)
            {
                Log.Write("Designer->editor caret sync failed: " + ex.Message);
            }
        }

        /// <summary>#2 — the editor caret moved; select the innermost enclosing element in the designer.</summary>
        private void OnCaretPositionChanged(object sender, CaretPositionChangedEventArgs e)
        {
            if (_disposed || _syncing || !PreviewOptions.DesignMode)
            {
                return;
            }

            try
            {
                var map = EnsureSourceMap();
                if (map == null)
                {
                    return;
                }

                int caret = e.NewPosition.BufferPosition.Position;
                string? path = map.PathForOffset(caret);
                if (path == null || path == _lastCaretPath)
                {
                    return; // outside any element, or the caret is still in the same element
                }

                _lastCaretPath = path;
                _preview.SelectByPath(path);
            }
            catch (Exception ex)
            {
                Log.Write("Editor->designer selection sync failed: " + ex.Message);
            }
        }

        /// <summary>Offset just past the '&gt;' that closes the start tag beginning at <paramref name="start"/>,
        /// skipping quoted attribute values so a '&gt;' inside a string doesn't end the tag early.</summary>
        private static int FindStartTagEnd(ITextSnapshot snapshot, int start)
        {
            int len = snapshot.Length;
            char quote = '\0';
            for (int i = start; i < len && i < start + 4096; i++)
            {
                char c = snapshot[i];
                if (quote != '\0')
                {
                    if (c == quote) quote = '\0';
                }
                else if (c == '"' || c == '\'')
                {
                    quote = c;
                }
                else if (c == '>')
                {
                    return i + 1;
                }
            }

            return start;
        }

        private void OnToggleLayoutClick(object sender, RoutedEventArgs e)
        {
            var target = _location == PreviewLocation.Right ? PreviewLocation.Bottom : PreviewLocation.Right;
            PreviewOptions.Location = target;
            Log.Write($"Preview layout -> {target}; reopening document to apply.");
            ReopenDocument();
        }

        private void ReopenDocument()
        {
            var path = _path;
            if (string.IsNullOrEmpty(path))
            {
                return;
            }

            _ = ThreadHelper.JoinableTaskFactory.RunAsync(async () =>
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                try
                {
                    var sp = ServiceProvider.GlobalProvider;

                    // Close the current frame (prompts to save only if the file is dirty), then reopen it so
                    // the new-location margin provider runs. Reopening the same path just re-activates it if
                    // it's still open, which is why we close first.
                    if (VsShellUtilities.IsDocumentOpen(sp, path, Guid.Empty, out _, out _, out IVsWindowFrame frame) && frame != null)
                    {
                        frame.CloseFrame((uint)__FRAMECLOSE.FRAMECLOSE_PromptSave);
                    }

                    VsShellUtilities.OpenDocument(sp, path!, VSConstants.LOGVIEWID_Primary, out _, out _, out IVsWindowFrame newFrame);
                    newFrame?.Show();
                }
                catch (Exception ex)
                {
                    Log.Write("ReopenDocument failed: " + ex);
                }
            });
        }

        // ---- resize grip ----------------------------------------------------

        private Border BuildGrip(bool vertical)
        {
            var grip = new Border
            {
                Cursor = vertical ? Cursors.SizeWE : Cursors.SizeNS,
            };

            if (vertical)
            {
                grip.Width = 6;
                grip.VerticalAlignment = VerticalAlignment.Stretch;
            }
            else
            {
                grip.Height = 6;
                grip.HorizontalAlignment = HorizontalAlignment.Stretch;
            }

            // A theme-colored, hit-testable splitter bar on the inner edge of the panel.
            grip.SetResourceReference(Border.BackgroundProperty, EnvironmentColors.EnvironmentBackgroundBrushKey);
            grip.MouseLeftButtonDown += OnGripDown;
            grip.MouseMove += OnGripMove;
            grip.MouseLeftButtonUp += OnGripUp;
            return grip;
        }

        private void OnGripDown(object sender, MouseButtonEventArgs e)
        {
            _dragging = true;
            _dragAnchor = e.GetPosition(_textView.VisualElement);
            _dragStartSize = _location == PreviewLocation.Right ? _root.ActualWidth : _root.ActualHeight;
            ((UIElement)sender).CaptureMouse();
            e.Handled = true;
        }

        private void OnGripMove(object sender, MouseEventArgs e)
        {
            if (!_dragging)
            {
                return;
            }

            var p = e.GetPosition(_textView.VisualElement);
            if (_location == PreviewLocation.Right)
            {
                // Grip on the LEFT edge: dragging left (negative dx) grows the panel.
                var dx = p.X - _dragAnchor.X;
                _root.Width = PreviewOptions.Clamp(_dragStartSize - dx, PreviewOptions.MinWidth, PreviewOptions.MaxWidth);
            }
            else
            {
                // Grip on the TOP edge: dragging up (negative dy) grows the panel.
                var dy = p.Y - _dragAnchor.Y;
                _root.Height = PreviewOptions.Clamp(_dragStartSize - dy, PreviewOptions.MinHeight, PreviewOptions.MaxHeight);
            }
        }

        private void OnGripUp(object sender, MouseButtonEventArgs e)
        {
            if (!_dragging)
            {
                return;
            }

            _dragging = false;
            ((UIElement)sender).ReleaseMouseCapture();
            if (_location == PreviewLocation.Right)
            {
                PreviewOptions.RightWidth = _root.Width;
            }
            else
            {
                PreviewOptions.BottomHeight = _root.Height;
            }

            e.Handled = true;
        }

        // ---- IWpfTextViewMargin --------------------------------------------

        private static string? ResolveDocumentPath(IWpfTextView textView, ITextDocumentFactoryService docFactory)
        {
            try
            {
                var buffer = textView.TextDataModel?.DocumentBuffer ?? textView.TextBuffer;
                if (buffer != null && docFactory.TryGetTextDocument(buffer, out ITextDocument doc))
                {
                    return doc.FilePath;
                }
            }
            catch
            {
                // fall through — return null
            }

            return null;
        }

        public FrameworkElement VisualElement
        {
            get
            {
                ThrowIfDisposed();
                return _root;
            }
        }

        public double MarginSize
        {
            get
            {
                ThrowIfDisposed();
                return _location == PreviewLocation.Right ? _root.ActualWidth : _root.ActualHeight;
            }
        }

        public bool Enabled
        {
            get
            {
                ThrowIfDisposed();
                return true;
            }
        }

        public ITextViewMargin? GetTextViewMargin(string marginName)
        {
            return string.Equals(marginName, MarginName, StringComparison.OrdinalIgnoreCase) ? this : null;
        }

        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            try
            {
                _editDebounce.Stop();
                _editDebounce.Tick -= OnEditDebounceTick;
                if (_buffer != null)
                {
                    _buffer.Changed -= OnBufferChanged;
                }
            }
            catch (Exception ex) { Log.Write("Margin teardown (edit debounce) failed: " + ex); }

            try
            {
                _preview.ElementSelected -= OnDesignerElementSelected;
                _preview.ContentPropMapChanged -= OnContentPropMapChanged;
                _textView.Caret.PositionChanged -= OnCaretPositionChanged;
            }
            catch (Exception ex) { Log.Write("Margin teardown (selection sync) failed: " + ex); }

            (_preview as IDisposable)?.Dispose();
        }

        private void ThrowIfDisposed()
        {
            if (_disposed)
            {
                throw new ObjectDisposedException(nameof(XamlPreviewMargin));
            }
        }
    }
}
