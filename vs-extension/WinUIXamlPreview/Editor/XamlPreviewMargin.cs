#nullable enable

using System;
using System.Collections.Generic;
using System.ComponentModel.Composition;
using System.Linq;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Data;
using System.Windows.Documents;
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
    // Two providers, one per dock container (Right vertical split / Bottom horizontal split), each return a
    // slot of the SAME per-view preview, which is cached so a single Surface.exe backs each tab even if
    // CreateMargin is re-entered (e.g. Open With). The panel lives in the slot matching PreviewOptions.Location;
    // the other slot is empty. Dock Right/Bottom moves the panel between slots in every open tab, without
    // reopening the document (BB-001: the reopen prompted to save and "Don't Save" lost the edits).

    [Export(typeof(IWpfTextViewMarginProvider))]
    [Name("WinUIXamlPreviewMargin.Right")]
    [Order(After = PredefinedMarginNames.VerticalScrollBar)]
    [MarginContainer(PredefinedMarginNames.Right)]
    [ContentType("XAML")]
    [ContentType("XML")] // a .xaml outside any project opens in the XML editor
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
    [ContentType("XML")]
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
    internal sealed partial class XamlPreviewMargin : IDisposable
    {
        public const string MarginName = "WinUIXamlPreviewMargin";

        private readonly IWpfTextView _textView;
        private readonly FrameworkElement? _hostControl;
        private PreviewLocation _location;
        private readonly Dictionary<PreviewLocation, MarginSlot> _slots = new Dictionary<PreviewLocation, MarginSlot>();
        private readonly Grid _root;
        private readonly PreviewControl _preview;
        private readonly DockPanel _content;
        private readonly Border _grip;
        private readonly FrameworkElement _collapsedBar;
        private TextBlock _collapsedLabel = null!;
        private Button _dockButton = null!;
        private PreviewToolbar _toolbar = null!;
        private string? _path;
        private ITextDocument? _textDocument;
        private bool _disposed;

        // Two-way selection sync (plan §41 #1/#2). The source map bridges the XAML text and the surface's
        // authored-tree paths; it's rebuilt lazily from the current buffer snapshot when marked dirty (on edit).
        private XamlSourceMap? _sourceMap;
        private bool _sourceMapDirty = true;
        // Echo guard: moving the caret in #1 fires PositionChanged (#2) synchronously; this suppresses that
        // re-entrant hop so the two directions can't loop. The async echo (#2 -> surface -> Selected -> #1) is
        // additionally broken by the "caret already inside the element's span" check in #1.
        private readonly CaretSyncGuard _caretSync = new CaretSyncGuard();

        // Live-edit refresh: coalesce a burst of keystrokes into a single re-render (#7). The editor raises
        // ITextBuffer.Changed on the UI thread, so a UI DispatcherTimer is the natural debounce.
        private readonly ITextBuffer? _buffer;
        private readonly System.Windows.Threading.DispatcherTimer _editDebounce;
        private readonly LiveEditGate _liveEdit = new LiveEditGate();

        // Resize-grip drag state (measured against the text view element, which is stable while the
        // margin resizes — using the margin's own coordinate space would feed back on itself).
        private bool _dragging;
        private Point _dragAnchor;
        private double _dragStartSize;

        /// <summary>
        /// Returns this view's slot for <paramref name="location"/>'s dock container. Both containers get a slot;
        /// the preview panel sits in the one matching the persisted preference. The preview is cached per text
        /// view (one Surface.exe per tab); never throws into the editor.
        /// </summary>
        public static IWpfTextViewMargin? TryCreate(IWpfTextViewHost host, ITextDocumentFactoryService docFactory, PreviewLocation location)
        {
            try
            {
                // Only attach to WinUI 3 XAML. WPF and UWP share WinUI's default namespace URI, so they can't
                // be told apart from the markup alone — we inspect the owning project. A non-WinUI document gets
                // no margin (and, returning null, no cached surface) so the previewer never shows for WPF/UWP.
                var path = ResolveDocument(host.TextView, docFactory)?.FilePath;
                if (!host.TextView.TextBuffer.ContentType.IsOfType("XAML")
                    && (path == null || !path.EndsWith(".xaml", StringComparison.OrdinalIgnoreCase)))
                {
                    return null; // registered for XML only to catch loose .xaml files
                }

                if (!Protocol.ProjectDllLocator.IsWinUiXaml(path, m => Log.Write("WinUI gate: " + m)))
                {
                    return null;
                }

                // P8: the margin can come up minutes before the background-loaded package, so kick identity
                // prewarm here too (deduped per project; the preview open joins the in-flight attempt).
                Protocol.IdentityPrewarm.ForDocument(path, "margin", Log.Write);

                // Leak-safe singleton: one preview (one surface) per view even under re-entrant CreateMargin.
                var margin = host.TextView.Properties.GetOrCreateSingletonProperty(
                    typeof(XamlPreviewMargin),
                    () => new XamlPreviewMargin(host, docFactory, PreviewOptions.Location));
                return margin._slots[location];
            }
            catch (Exception ex)
            {
                // A margin failure must never take down the editor — log and render no margin.
                Log.Write("XamlPreviewMargin creation failed: " + ex);
                Telemetry.PreviewTelemetry.LogException("CreateMargin", ex);
                return null;
            }
        }

        private XamlPreviewMargin(IWpfTextViewHost host, ITextDocumentFactoryService docFactory, PreviewLocation location)
        {
            var textView = host.TextView;
            _textView = textView;
            _hostControl = host.HostControl;
            _location = location;
            _preview = new PreviewControl();
            _preview.ReclaimFocus = () => _textView.VisualElement.Focus();

            _root = new Grid();
            _root.SetResourceReference(Panel.BackgroundProperty, EnvironmentColors.ToolWindowBackgroundBrushKey);

            // toolbar (top) + preview (fill)
            _content = new DockPanel { LastChildFill = true };
            var toolbar = BuildToolbar();
            DockPanel.SetDock(toolbar, Dock.Top);
            _content.Children.Add(toolbar);
            _content.Children.Add(_preview);

            _grip = BuildGrip();
            _collapsedBar = BuildCollapsedBar();

            _root.Children.Add(_grip);
            _root.Children.Add(_content);
            _root.Children.Add(_collapsedBar);
            // BB-004: Tab cycles through the preview's buttons instead of escaping into the rest of VS;
            // Esc hands focus back to the code.
            KeyboardNavigation.SetTabNavigation(_root, KeyboardNavigationMode.Cycle);
            _root.KeyDown += OnRootKeyDown;
            _textView.GotAggregateFocus += OnTextViewGotFocus;
            s_lastFocused = this;
            _slots[PreviewLocation.Right] = new MarginSlot(this, PreviewLocation.Right);
            _slots[PreviewLocation.Bottom] = new MarginSlot(this, PreviewLocation.Bottom);

            // Pin the preview to THIS tab's document so it doesn't chase the active tab.
            _textDocument = ResolveDocument(textView, docFactory);
            _path = _textDocument?.FilePath;
            if (_textDocument != null)
            {
                // Follow a rename/move of this tab's file (Solution Explorer drag, Save As) so the preview
                // doesn't stay pinned to a path that no longer exists.
                _textDocument.FileActionOccurred += OnFileActionOccurred;
            }

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

            // Two-way selection sync (plan §41): previewer selection -> editor caret (#1), editor caret ->
            // previewer selection (#2). Both are best-effort and guarded against echo looping.
            _preview.ElementSelected += OnPreviewerElementSelected;
            _preview.ContentPropMapChanged += OnContentPropMapChanged;
            _preview.ContentRerendered += OnContentRerendered;
            try { _textView.Caret.PositionChanged += OnCaretPositionChanged; }
            catch (Exception ex) { Log.Write("Caret sync subscribe failed: " + ex.Message); }

            PreviewPackageState.PopOutChanged += OnPopOutChanged;
            CollapsedChanged += OnCollapsedChanged;
            LocationChanged += OnLocationChanged;
            if (PreviewPackageState.PoppedOut)
            {
                _preview.Suspend();
            }

            if (_hostControl != null)
            {
                _hostControl.SizeChanged += OnHostSizeChanged;
            }
            ApplyLayout();
            Testing.TestHooks.RegisterMargin(this);
        }

        // ---- fit to the editor ---------------------------------------------
        //
        // The persisted size is a preference, not a guarantee: the editor tab can be narrower (docked tool
        // windows, a split screen). A fixed-size margin wider than the tab is clipped by WPF, but the reparented
        // WinUI HWND is not (airspace), so it would paint over neighboring VS panes. Cap the margin to what the
        // tab can fit while keeping some code visible; the stored preference is left untouched.

        internal const double MinEditorWidth = 200;
        internal const double MinEditorHeight = 120;

        private void OnHostSizeChanged(object sender, SizeChangedEventArgs e) => FitToEditor();

        private void FitToEditor()
        {
            if (_disposed || _hostControl == null)
            {
                return;
            }

            if (_location == PreviewLocation.Right)
            {
                var w = _hostControl.ActualWidth;
                _root.MaxWidth = w > 0 ? MaxMarginSize(w, MinEditorWidth) : double.PositiveInfinity;
            }
            else
            {
                var h = _hostControl.ActualHeight;
                _root.MaxHeight = h > 0 ? MaxMarginSize(h, MinEditorHeight) : double.PositiveInfinity;
            }
        }

        internal static double MaxMarginSize(double available, double minEditor) =>
            Math.Max(CollapsedStripSize, available - minEditor);

        // ---- toolbar --------------------------------------------------------
        //
        // The shared preview bar (PreviewToolbar) plus the margin-only trailing group: Dock / Window / Hide.

        private FrameworkElement BuildToolbar()
        {
            _toolbar = new PreviewToolbar(_preview, tb =>
            {
                _dockButton = tb.MakeButton(DockMoniker(), DockLabel(), DockTooltip(), OnToggleLayoutClick, "PreviewDockToggle");
                return new List<PreviewToolbar.ToolbarItem>
                {
                    new PreviewToolbar.ToolbarItem(
                        _dockButton,
                        2, () => tb.MakeOverflowCommand(DockMoniker(), DockLabel(), OnToggleLayoutClick, "PreviewOverflowDock")),
                    new PreviewToolbar.ToolbarItem(
                        tb.MakeButton(KnownMonikers.NewWindow, "Window", "Move the preview into a separate tool window", OnPopOutClick, "PreviewWindowButton"),
                        1, () => tb.MakeOverflowCommand(KnownMonikers.NewWindow, "Window", OnPopOutClick, "PreviewOverflowWindow")),
                    new PreviewToolbar.ToolbarItem(
                        tb.MakeButton(KnownMonikers.Collapse, "Hide", "Collapse the preview to a thin strip — click the strip to reopen it", OnHideClick, "PreviewHideButton"),
                        0, null),
                };
            });
            return _toolbar.Element;
        }

        private string DockTarget() => _location == PreviewLocation.Right ? "Bottom" : "Right";

        private ImageMoniker DockMoniker() => _location == PreviewLocation.Right ? KnownMonikers.DockBottom : KnownMonikers.DockRight;

        private string DockLabel() => "Dock " + DockTarget();

        private string DockTooltip() => $"Move the preview to the {DockTarget().ToLowerInvariant()}";

        private void OnPopOutClick(object sender, RoutedEventArgs e)
        {
            // Move, not copy: opening the window flips PreviewPackageState.PoppedOut, which collapses every margin
            // to its strip and releases its surface (OnPopOutChanged) until the window is closed.
            try { PreviewPackageState.RequestShowToolWindow?.Invoke(); }
            catch (Exception ex) { Log.Write("Pop-out failed: " + ex); }
        }

        private void OnPopOutChanged()
        {
            if (_disposed)
            {
                return;
            }

            try
            {
                if (PreviewPackageState.PoppedOut)
                {
                    _preview.Suspend();
                }

                // Closing the window resumes the preview unless it's hidden (ApplyCollapsedState decides).
                ApplyCollapsedState();
            }
            catch (Exception ex) { Log.Write("Pop-out state change failed: " + ex); }
        }

        // Hidden either by the user (persisted) or because the preview moved to the tool window.
        private static bool IsHidden => PreviewOptions.Collapsed || PreviewPackageState.PoppedOut;

        // ---- collapse / expand (easy open + close, #6) ---------------------
        //
        // Collapsed, the margin shrinks to a thin strip on its docked edge so the editor reclaims the space;
        // clicking the strip restores it. The choice persists (PreviewOptions.Collapsed) so it sticks across
        // tabs and sessions. The strip is always present, so the previewer is one click away — the "how do I get
        // it back?" problem is gone.

        private void OnHideClick(object sender, RoutedEventArgs e) => SetCollapsed(true);

        private void OnShowClick(object sender, RoutedEventArgs e)
        {
            if (PreviewPackageState.PoppedOut)
            {
                // Bring the preview back into the editor: close the window (which un-pops every margin).
                try { PreviewPackageState.RequestCloseToolWindow?.Invoke(); }
                catch (Exception ex) { Log.Write("Close preview window failed: " + ex); }
            }

            SetCollapsed(false);
        }

        private void SetCollapsed(bool collapsed)
        {
            try
            {
                PreviewOptions.Collapsed = collapsed;
                ApplyCollapsedState();
            }
            catch (Exception ex) { Log.Write("Toggle collapse failed: " + ex); }

            // Hide is global (BB-006): every other open margin follows, so none stays expanded but frozen.
            try { CollapsedChanged?.Invoke(this); }
            catch (Exception ex) { Log.Write("CollapsedChanged handler failed: " + ex); }
        }

        private static event Action<XamlPreviewMargin>? CollapsedChanged;

        private void OnCollapsedChanged(XamlPreviewMargin source)
        {
            if (_disposed || ReferenceEquals(source, this))
            {
                return;
            }

            try { ApplyCollapsedState(); }
            catch (Exception ex) { Log.Write("Collapse sync failed: " + ex); }
        }

        private void ApplyCollapsedState()
        {
            var collapsed = IsHidden;

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

            // Re-render on expand if edits arrived while hidden (we skip live-edit renders while collapsed). A
            // preview resumed from Hide renders the current buffer anyway, so it needs no extra reload.
            if (collapsed)
            {
                // BB-063: a hidden preview releases its surface (parked briefly, so a quick Show re-adopts it).
                if (!PreviewPackageState.PoppedOut)
                {
                    _preview.Suspend(hidden: true);
                }
            }
            else
            {
                var resumed = _preview.Resume();
                if (_liveEdit.OnExpanded() && !resumed)
                {
                    try { _preview.Reload(); } catch (Exception ex) { Log.Write("Reload-on-expand failed: " + ex); }
                }
            }
        }

        private const double CollapsedStripSize = 26;

        // ---- keyboard access (BB-004) ---------------------------------------
        //
        // The margin sits beside the editor, outside VS's Tab order, so it's reached through the
        // "Focus WinUI XAML Preview Toolbar" command (no default key binding; users can bind one).

        private static XamlPreviewMargin? s_lastFocused;

        private void OnTextViewGotFocus(object sender, EventArgs e) => s_lastFocused = this;

        /// <summary>Moves keyboard focus into the most recently focused editor's preview toolbar.</summary>
        internal static bool FocusActiveToolbar() => s_lastFocused?.FocusToolbar() ?? false;

        internal static bool HasActiveMargin => s_lastFocused != null && !PreviewPackageState.PoppedOut;

        internal bool FocusToolbar()
        {
            if (_disposed || PreviewPackageState.PoppedOut || !_root.IsVisible)
            {
                return false;
            }

            if (PreviewOptions.Collapsed)
            {
                return _collapsedBar.Focus();
            }

            return _content.MoveFocus(new TraversalRequest(FocusNavigationDirection.First));
        }

        private void OnRootKeyDown(object sender, KeyEventArgs e)
        {
            if (e.Key == Key.Escape && Keyboard.Modifiers == ModifierKeys.None)
            {
                e.Handled = _textView.VisualElement.Focus();
            }
        }

        private FrameworkElement BuildCollapsedBar()
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
            _collapsedLabel = label;

            var button = PreviewChrome.KeyboardOnlyFocus(new Button
            {
                Content = label,
                ToolTip = "Show the WinUI preview",
                Cursor = Cursors.Hand,
                Padding = new Thickness(2),
                BorderThickness = new Thickness(0),
            });
            button.SetResourceReference(Control.BackgroundProperty, EnvironmentColors.CommandShelfBackgroundGradientBrushKey);
            AutomationProperties.SetAutomationId(button, "PreviewShowButton");
            AutomationProperties.SetName(button, "Show the WinUI preview");
            button.Click += OnShowClick;
            button.HorizontalAlignment = HorizontalAlignment.Stretch;
            button.VerticalAlignment = VerticalAlignment.Stretch;
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

            // Don't spend renders on a hidden preview; it refreshes once when it's reopened.
            if (!_liveEdit.OnTextChanged(IsHidden))
            {
                return;
            }

            _editDebounce.Stop();
            _editDebounce.Start();
        }

        private void OnEditDebounceTick(object sender, EventArgs e)
        {
            _editDebounce.Stop();
            if (!_liveEdit.OnDebounceElapsed(IsHidden, _disposed))
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

        /// <summary>#1 — the previewer selected an element; move the editor caret to its source span.</summary>
        private void OnPreviewerElementSelected(SelectedMsg sel)
        {
            if (_disposed || !_caretSync.AcceptsPreviewerSelection(sel?.Path))
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
                (start, end) = CaretSyncGuard.Clamp(start, end, snapshot.Length);

                // If the caret is already inside this element, the selection originated from the caret (#2's
                // echo) — leave it be so the two directions don't fight over the caret.
                int caret = _textView.Caret.Position.BufferPosition.Position;
                if (_caretSync.IsEchoOfCaret(sel.Path!, caret, start, end, map.PathForOffset(caret)))
                {
                    return;
                }

                using (_caretSync.BeginCaretMove())
                {
                    // Highlight the element's opening tag (name + attributes), caret at its start.
                    int tagEnd = FindStartTagEnd(snapshot, start);
                    var selSpan = new SnapshotSpan(snapshot, start, Math.Max(0, tagEnd - start));
                    _textView.Selection.Select(selSpan, isReversed: false);
                    _textView.Caret.MoveTo(new SnapshotPoint(snapshot, start));
                    RevealTagStart(new SnapshotPoint(snapshot, start));
                    _caretSync.CaretMovedTo(sel.Path!);
                }
            }
            catch (Exception ex)
            {
                Log.Write("Previewer->editor caret sync failed: " + ex.Message);
            }
        }

        // Bring the tag's start into view vertically without dragging the editor sideways to fit a long
        // attribute list: when the start column fits in the viewport from the left edge, snap back to it.
        private void RevealTagStart(SnapshotPoint start)
        {
            _textView.ViewScroller.EnsureSpanVisible(new SnapshotSpan(start, 0), EnsureSpanVisibleOptions.MinimumScroll);
            try
            {
                var line = _textView.GetTextViewLineContainingBufferPosition(start);
                var bounds = line.GetCharacterBounds(start);
                if (bounds.Left < _textView.ViewportWidth)
                {
                    _textView.ViewportLeft = 0;
                }
            }
            catch (Exception ex)
            {
                Log.Write("Previewer->editor horizontal reveal failed: " + ex.Message);
            }
        }

        /// <summary>#2 — the preview re-rendered under a selection; re-select the element at the caret in the new tree.</summary>
        private void OnContentRerendered()
        {
            if (_disposed || !_caretSync.TracksCaret(PreviewOptions.DesignMode))
            {
                return;
            }

            try
            {
                var map = EnsureSourceMap();
                var path = map?.PathForOffset(_textView.Caret.Position.BufferPosition.Position);
                if (path == null)
                {
                    return;
                }

                _caretSync.CaretMovedTo(path);
                _preview.SelectByPath(path);
            }
            catch (Exception ex)
            {
                Log.Write("Re-render reselection failed: " + ex.Message);
            }
        }

        /// <summary>#2 — the editor caret moved; select the innermost enclosing element in the previewer.</summary>
        private void OnCaretPositionChanged(object sender, CaretPositionChangedEventArgs e)
        {
            if (_disposed || !_caretSync.TracksCaret(PreviewOptions.DesignMode))
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
                string? path = _caretSync.OnCaretMoved(map.PathForOffset(caret), PreviewOptions.DesignMode);
                if (path == null)
                {
                    return; // outside any element, or the caret is still in the same element
                }

                _preview.SelectByPath(path);
            }
            catch (Exception ex)
            {
                Log.Write("Editor->previewer selection sync failed: " + ex.Message);
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
            try
            {
                var target = _location == PreviewLocation.Right ? PreviewLocation.Bottom : PreviewLocation.Right;
                PreviewOptions.Location = target;
                Log.Write($"Preview layout -> {target}.");
                SetLocation(target);
            }
            catch (Exception ex)
            {
                Log.Write("Dock toggle failed: " + ex);
                Telemetry.PreviewTelemetry.LogException("DockToggle", ex);
            }

            // Every open tab follows, like Hide.
            try { LocationChanged?.Invoke(this); }
            catch (Exception ex) { Log.Write("LocationChanged handler failed: " + ex); }
        }

        private static event Action<XamlPreviewMargin>? LocationChanged;

        private void OnLocationChanged(XamlPreviewMargin source)
        {
            if (_disposed || ReferenceEquals(source, this))
            {
                return;
            }

            try { SetLocation(PreviewOptions.Location); }
            catch (Exception ex) { Log.Write("Dock sync failed: " + ex); }
        }

        private void SetLocation(PreviewLocation location)
        {
            if (_disposed || _location == location)
            {
                return;
            }

            _location = location;
            ApplyLayout();
        }

        // Lays the panel out for _location and moves it into that dock container's slot. Moving it unloads and
        // reloads the PreviewControl, which parks and re-adopts its live surface (no relaunch, no reopen).
        private void ApplyLayout()
        {
            var right = _location == PreviewLocation.Right;

            _root.ColumnDefinitions.Clear();
            _root.RowDefinitions.Clear();
            _root.Width = double.NaN;
            _root.Height = double.NaN;
            _root.MaxWidth = double.PositiveInfinity;
            _root.MaxHeight = double.PositiveInfinity;
            foreach (UIElement child in _root.Children)
            {
                Grid.SetRow(child, 0);
                Grid.SetColumn(child, 0);
                Grid.SetRowSpan(child, 1);
                Grid.SetColumnSpan(child, 1);
            }

            if (right)
            {
                _root.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                _root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                Grid.SetColumn(_content, 1);
                Grid.SetColumnSpan(_collapsedBar, 2);
            }
            else
            {
                _root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
                _root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
                Grid.SetRow(_content, 1);
                Grid.SetRowSpan(_collapsedBar, 2);
            }

            // Grip on the inner edge: a vertical bar for Right, a horizontal one for Bottom.
            _grip.Cursor = right ? Cursors.SizeWE : Cursors.SizeNS;
            _grip.Width = right ? 6 : double.NaN;
            _grip.Height = right ? double.NaN : 6;

            // Rotate the strip label so it reads bottom-to-top in the narrow vertical strip.
            _collapsedLabel.LayoutTransform = right ? new RotateTransform(-90) : Transform.Identity;

            _toolbar.SetButton(_dockButton, DockMoniker(), DockLabel(), DockTooltip());

            foreach (var slot in _slots.Values)
            {
                slot.Host(slot.Location == _location ? _root : null);
            }

            ApplyCollapsedState();
            FitToEditor();
        }

        /// <summary>
        /// The margin VS sees in one dock container. Both containers get one per view; only the slot for the
        /// current location holds the preview panel, the other is empty and collapsed.
        /// </summary>
        private sealed class MarginSlot : IWpfTextViewMargin
        {
            private readonly XamlPreviewMargin _owner;
            private readonly Border _host = new Border { Visibility = Visibility.Collapsed };

            public MarginSlot(XamlPreviewMargin owner, PreviewLocation location)
            {
                _owner = owner;
                Location = location;
            }

            public PreviewLocation Location { get; }

            public void Host(FrameworkElement? panel)
            {
                if (ReferenceEquals(_host.Child, panel))
                {
                    return;
                }

                _host.Child = panel;
                _host.Visibility = panel != null ? Visibility.Visible : Visibility.Collapsed;
            }

            public FrameworkElement VisualElement => _host;

            public double MarginSize => _host.Child == null ? 0
                : Location == PreviewLocation.Right ? _host.ActualWidth : _host.ActualHeight;

            public bool Enabled => true;

            public ITextViewMargin? GetTextViewMargin(string marginName) =>
                string.Equals(marginName, MarginName, StringComparison.OrdinalIgnoreCase) && _host.Child != null ? this : null;

            // VS disposes every margin of a view together when the view closes.
            public void Dispose() => _owner.Dispose();
        }

        // ---- resize grip ----------------------------------------------------

        private Border BuildGrip()
        {
            var grip = new Border();

            // A theme-colored, hit-testable splitter bar on the inner edge of the panel (sized by ApplyLayout).
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
                _root.Width = Math.Min(_root.MaxWidth, PreviewOptions.Clamp(_dragStartSize - dx, PreviewOptions.MinWidth, PreviewOptions.MaxWidth));
            }
            else
            {
                // Grip on the TOP edge: dragging up (negative dy) grows the panel.
                var dy = p.Y - _dragAnchor.Y;
                _root.Height = Math.Min(_root.MaxHeight, PreviewOptions.Clamp(_dragStartSize - dy, PreviewOptions.MinHeight, PreviewOptions.MaxHeight));
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

        private static ITextDocument? ResolveDocument(IWpfTextView textView, ITextDocumentFactoryService docFactory)
        {
            try
            {
                var buffer = textView.TextDataModel?.DocumentBuffer ?? textView.TextBuffer;
                if (buffer != null && docFactory.TryGetTextDocument(buffer, out ITextDocument doc))
                {
                    return doc;
                }
            }
            catch
            {
                // fall through — return null
            }

            return null;
        }

        private void OnFileActionOccurred(object sender, TextDocumentFileActionEventArgs e)
        {
            if (_disposed || (e.FileActionType & FileActionTypes.DocumentRenamed) == 0)
            {
                return;
            }

            var oldPath = _path;
            var newPath = e.FilePath;
            if (string.IsNullOrEmpty(newPath) || string.Equals(oldPath, newPath, StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            _path = newPath;
            Log.Write($"XamlPreviewMargin: document renamed '{oldPath}' -> '{newPath}'.");
            _preview.OnDocumentRenamed(oldPath, newPath);
        }

        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            Testing.TestHooks.UnregisterMargin(this);
            if (ReferenceEquals(s_lastFocused, this))
            {
                s_lastFocused = null;
            }
            _textView.GotAggregateFocus -= OnTextViewGotFocus;
            _root.KeyDown -= OnRootKeyDown;
            PreviewPackageState.PopOutChanged -= OnPopOutChanged;
            CollapsedChanged -= OnCollapsedChanged;
            LocationChanged -= OnLocationChanged;
            try
            {
                // A recreated margin set for this view must get a fresh preview, not this disposed one.
                _textView.Properties.RemoveProperty(typeof(XamlPreviewMargin));
                foreach (var slot in _slots.Values)
                {
                    slot.Host(null);
                }
            }
            catch (Exception ex) { Log.Write("Margin teardown (slots) failed: " + ex); }

            if (_hostControl != null)
            {
                _hostControl.SizeChanged -= OnHostSizeChanged;
            }
            try
            {
                _editDebounce.Stop();
                _editDebounce.Tick -= OnEditDebounceTick;
                if (_buffer != null)
                {
                    _buffer.Changed -= OnBufferChanged;
                }

                if (_textDocument != null)
                {
                    _textDocument.FileActionOccurred -= OnFileActionOccurred;
                }
            }
            catch (Exception ex) { Log.Write("Margin teardown (edit debounce) failed: " + ex); }

            try
            {
                _preview.ElementSelected -= OnPreviewerElementSelected;
                _preview.ContentPropMapChanged -= OnContentPropMapChanged;
                _preview.ContentRerendered -= OnContentRerendered;
                _textView.Caret.PositionChanged -= OnCaretPositionChanged;
            }
            catch (Exception ex) { Log.Write("Margin teardown (selection sync) failed: " + ex); }

            (_preview as IDisposable)?.Dispose();
        }
    }
}
