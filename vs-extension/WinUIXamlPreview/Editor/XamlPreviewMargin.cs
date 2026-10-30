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
    internal sealed partial class XamlPreviewMargin : IWpfTextViewMargin
    {
        public const string MarginName = "WinUIXamlPreviewMargin";

        private readonly IWpfTextView _textView;
        private readonly PreviewLocation _location;
        private readonly Grid _root;
        private readonly PreviewControl _preview;
        private readonly DockPanel _content;
        private readonly Border _grip;
        private readonly FrameworkElement _collapsedBar;
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

                // Leak-safe singleton: one margin (one surface) per view even under re-entrant CreateMargin.
                return host.TextView.Properties.GetOrCreateSingletonProperty(
                    typeof(XamlPreviewMargin),
                    () => new XamlPreviewMargin(host.TextView, docFactory, location));
            }
            catch (Exception ex)
            {
                // A margin failure must never take down the editor — log and render no margin.
                Log.Write("XamlPreviewMargin creation failed: " + ex);
                Telemetry.PreviewTelemetry.LogException("CreateMargin", ex);
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
            try { _textView.Caret.PositionChanged += OnCaretPositionChanged; }
            catch (Exception ex) { Log.Write("Caret sync subscribe failed: " + ex.Message); }

            PreviewPackageState.PopOutChanged += OnPopOutChanged;
            if (PreviewPackageState.PoppedOut)
            {
                _preview.Suspend();
            }

            ApplyCollapsedState();
            Testing.TestHooks.RegisterMargin(this);
        }

        // ---- toolbar --------------------------------------------------------
        //
        // The shared preview bar (PreviewToolbar) plus the margin-only trailing group: Dock / Window / Hide.

        private FrameworkElement BuildToolbar()
        {
            var toggleTarget = _location == PreviewLocation.Right ? "Bottom" : "Right";
            var dockMoniker = _location == PreviewLocation.Right ? KnownMonikers.DockBottom : KnownMonikers.DockRight;
            var dockLabel = $"Dock {toggleTarget}";

            _toolbar = new PreviewToolbar(_preview, tb => new List<PreviewToolbar.ToolbarItem>
            {
                new PreviewToolbar.ToolbarItem(
                    tb.MakeButton(dockMoniker, dockLabel, $"Move the preview to the {toggleTarget.ToLowerInvariant()} (reopens this file)", OnToggleLayoutClick, "PreviewDockToggle"),
                    2, () => tb.MakeOverflowCommand(dockMoniker, dockLabel, OnToggleLayoutClick, "PreviewOverflowDock")),
                new PreviewToolbar.ToolbarItem(
                    tb.MakeButton(KnownMonikers.NewWindow, "Window", "Move the preview into a separate tool window", OnPopOutClick, "PreviewWindowButton"),
                    1, () => tb.MakeOverflowCommand(KnownMonikers.NewWindow, "Window", OnPopOutClick, "PreviewOverflowWindow")),
                new PreviewToolbar.ToolbarItem(
                    tb.MakeButton(KnownMonikers.Collapse, "Hide", "Collapse the preview to a thin strip — click the strip to reopen it", OnHideClick, "PreviewHideButton"),
                    0, null),
            });
            return _toolbar.Element;
        }

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
                else
                {
                    _preview.Resume();
                }

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

            // Re-render on expand if edits arrived while hidden (we skip live-edit renders while collapsed).
            if (!collapsed && _liveEdit.OnExpanded())
            {
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
                if (_caretSync.IsEchoOfCaret(sel.Path!, caret, start, end))
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
                    Telemetry.PreviewTelemetry.LogException("ReopenDocument", ex);
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
            Testing.TestHooks.UnregisterMargin(this);
            PreviewPackageState.PopOutChanged -= OnPopOutChanged;
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
