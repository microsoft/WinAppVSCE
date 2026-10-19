#nullable enable

using System;
using System.Collections.Generic;
using System.Linq;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Data;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Media;
using Microsoft.VisualStudio.Imaging;
using Microsoft.VisualStudio.Imaging.Interop;
using Microsoft.VisualStudio.PlatformUI;
using WinUIXamlPreview.Logging;
using WinUIXamlPreview.UI;

namespace WinUIXamlPreview.Editor
{
    /// <summary>
    /// The preview's command bar (Reload, Select, Properties, Theme, Size, Sample data), shared by the in-editor
    /// margin and the separate preview tool window. A host can append its own trailing group (the margin adds
    /// Dock / Window / Hide). Narrow widths drop the title, then labels, then move buttons into a "⋯" menu.
    /// </summary>
    internal sealed class PreviewToolbar
    {
        private readonly PreviewControl _preview;
        private Button? _dtdButton;
        private Button? _selectButton;
        private Button? _themeButton;
        private Button? _sizeButton;
        private DockPanel? _toolbarBar;
        private StackPanel? _toolbarButtons;
        private TextBlock? _toolbarTitle;
        private Button? _overflowButton;
        private readonly List<List<ToolbarItem>> _toolbarGroups = new List<List<ToolbarItem>>();
        private readonly List<FrameworkElement> _toolbarSeparators = new List<FrameworkElement>();
        private bool _compactLabels;
        private int _toolbarLevel = -1;

        /// <param name="hostGroup">Optional trailing group of host-specific buttons (built with this toolbar's
        /// <see cref="MakeButton"/> / <see cref="MakeOverflowCommand"/> so they match).</param>
        public PreviewToolbar(PreviewControl preview, Func<PreviewToolbar, List<ToolbarItem>>? hostGroup = null)
        {
            _preview = preview;
            Element = BuildToolbar(hostGroup);
        }

        public FrameworkElement Element { get; }

        internal string? SelectLabelState => _selectButton != null ? AutomationProperties.GetName(_selectButton) : null;
        internal string? ThemeLabelState => _themeButton != null ? AutomationProperties.GetName(_themeButton) : null;
        internal string? SizeLabelState => _sizeButton != null ? AutomationProperties.GetName(_sizeButton) : null;
        internal string? DtdLabelState => _dtdButton != null ? AutomationProperties.GetName(_dtdButton) : null;
        internal int Level => _toolbarLevel;
        internal bool OverflowVisible => _overflowButton?.Visibility == Visibility.Visible;

        // ---- toolbar --------------------------------------------------------

        // A toolbar entry and how it degrades when the margin is narrow. OverflowRank 0 = always on the bar;
        // otherwise entries move into the "⋯" menu in ascending rank order (1 = first to go).
        internal sealed class ToolbarItem
        {
            public ToolbarItem(FrameworkElement element, int overflowRank, Func<MenuItem>? makeOverflowItem)
            {
                Element = element;
                OverflowRank = overflowRank;
                MakeOverflowItem = makeOverflowItem;
            }

            public FrameworkElement Element { get; }
            public int OverflowRank { get; }
            public Func<MenuItem>? MakeOverflowItem { get; }
            public bool Overflowed { get; set; }
        }

        private const int MaxOverflowRank = 7;

        private FrameworkElement BuildToolbar(Func<PreviewToolbar, List<ToolbarItem>>? hostGroup)
        {
            var bar = new DockPanel { LastChildFill = true, Height = 28, ClipToBounds = true };
            bar.SetResourceReference(Panel.BackgroundProperty, EnvironmentColors.CommandShelfBackgroundGradientBrushKey);

            var buttons = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                HorizontalAlignment = HorizontalAlignment.Right,
                VerticalAlignment = VerticalAlignment.Center,
            };

            var reload = MakeButton(KnownMonikers.Refresh, "Reload", "Re-render the preview", OnReloadClick, "PreviewReloadButton");
            _selectButton = MakeButton(SelectMoniker(), SelectLabel(), SelectTooltip(), OnToggleSelectClick, "PreviewSelectToggle");
            var properties = MakeButton(KnownMonikers.Property, "Properties", "Show the design-time Properties panel", OnPropertiesClick, "PreviewPropertiesButton");
            _themeButton = MakeMenuButton(KnownMonikers.DarkTheme, ThemeLabel(), ThemeTooltip(), "PreviewThemeButton", BuildThemeMenu());
            _sizeButton = MakeMenuButton(KnownMonikers.Monitor, SizeLabel(), SizeTooltip(), "PreviewSizeButton", BuildSizeMenu());
            _dtdButton = MakeButton(DtdMoniker(), DtdLabel(), DtdTooltip(), OnToggleDtdClick, "PreviewDtdToggle");

            _toolbarGroups.Add(new List<ToolbarItem> { new ToolbarItem(reload, 0, null) });
            _toolbarGroups.Add(new List<ToolbarItem>
            {
                new ToolbarItem(_selectButton, 0, null),
                new ToolbarItem(properties, 5, () => MakeOverflowCommand(KnownMonikers.Property, "Properties", OnPropertiesClick, "PreviewOverflowProperties")),
            });
            _toolbarGroups.Add(new List<ToolbarItem>
            {
                new ToolbarItem(_themeButton, 7, () => MakeOverflowSubmenu(KnownMonikers.DarkTheme, "Theme: " + ThemeLabel(), BuildThemeMenu(), "PreviewOverflowTheme")),
                new ToolbarItem(_sizeButton, 6, () => MakeOverflowSubmenu(KnownMonikers.Monitor, "Size: " + SizeLabel(), BuildSizeMenu(), "PreviewOverflowSize")),
            });
            _toolbarGroups.Add(new List<ToolbarItem>
            {
                new ToolbarItem(_dtdButton, 3, () => MakeOverflowCommand(DtdMoniker(), DtdLabel(), OnToggleDtdClick, "PreviewOverflowDtd")),
            });
            var host = hostGroup?.Invoke(this);
            if (host != null && host.Count > 0)
            {
                _toolbarGroups.Add(host);
            }

            for (var i = 0; i < _toolbarGroups.Count; i++)
            {
                if (i > 0)
                {
                    var sep = MakeSeparator();
                    _toolbarSeparators.Add(sep);
                    buttons.Children.Add(sep);
                }
                foreach (var item in _toolbarGroups[i])
                {
                    buttons.Children.Add(item.Element);
                }
            }

            _overflowButton = MakeOverflowButton();
            buttons.Children.Add(_overflowButton);

            var title = new TextBlock
            {
                Text = "WinUI Preview",
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(8, 0, 0, 0),
                FontSize = 12,
                TextTrimming = TextTrimming.CharacterEllipsis,
            };
            title.SetResourceReference(TextBlock.ForegroundProperty, EnvironmentColors.ToolWindowTextBrushKey);
            AutomationProperties.SetAutomationId(title, "PreviewMarginTitle");

            DockPanel.SetDock(buttons, Dock.Right);
            bar.Children.Add(buttons); // right-docked first so the title fills the remainder
            bar.Children.Add(title);

            _toolbarBar = bar;
            _toolbarButtons = buttons;
            _toolbarTitle = title;
            bar.SizeChanged += (s, e) => { if (e.WidthChanged) { UpdateToolbarLayout(); } };
            return bar;
        }

        // Progressive narrow-width layout: drop the title, then the button labels (icon + tooltip), then move
        // buttons into the "⋯" overflow menu least-used first. Picks the first level whose buttons fit.
        private void UpdateToolbarLayout()
        {
            if (_toolbarBar == null || _toolbarButtons == null || _toolbarTitle == null)
            {
                return;
            }

            var available = _toolbarBar.ActualWidth;
            if (available <= 0)
            {
                return;
            }

            var unbounded = new Size(double.PositiveInfinity, double.PositiveInfinity);
            var level = 0;
            for (; ; level++)
            {
                var showTitle = level == 0;
                var overflowCount = Math.Max(0, level - 2);
                ApplyToolbarState(showTitle, showLabels: level <= 1, overflowCount);
                if (overflowCount >= MaxOverflowRank)
                {
                    break;
                }

                _toolbarButtons.Measure(unbounded);
                var needed = _toolbarButtons.DesiredSize.Width;
                if (showTitle)
                {
                    _toolbarTitle.Measure(unbounded);
                    needed += _toolbarTitle.DesiredSize.Width;
                }
                if (needed <= available)
                {
                    break;
                }
            }

            if (level != _toolbarLevel)
            {
                _toolbarLevel = level;
                Log.Write($"Toolbar layout: width={available:0} level={level} (0 full, 1 no title, 2 icons only, 3+ overflow).");
            }
        }

        private void ApplyToolbarState(bool showTitle, bool showLabels, int overflowCount)
        {
            _toolbarTitle!.Visibility = showTitle ? Visibility.Visible : Visibility.Collapsed;
            _compactLabels = !showLabels;

            var anyOverflowed = false;
            foreach (var item in _toolbarGroups.SelectMany(g => g))
            {
                item.Overflowed = item.OverflowRank > 0 && item.OverflowRank <= overflowCount;
                anyOverflowed |= item.Overflowed;
                item.Element.Visibility = item.Overflowed ? Visibility.Collapsed : Visibility.Visible;
                SetLabelVisible(item.Element, showLabels);
            }

            // A separator shows only between two groups that both still have a button on the bar.
            var seenVisible = _toolbarGroups[0].Any(i => !i.Overflowed);
            for (var g = 1; g < _toolbarGroups.Count; g++)
            {
                var groupVisible = _toolbarGroups[g].Any(i => !i.Overflowed);
                _toolbarSeparators[g - 1].Visibility = seenVisible && groupVisible ? Visibility.Visible : Visibility.Collapsed;
                seenVisible |= groupVisible;
            }

            _overflowButton!.Visibility = anyOverflowed ? Visibility.Visible : Visibility.Collapsed;
        }

        private const string ButtonLabelTag = "PreviewToolbarLabel";

        private void SetLabelVisible(FrameworkElement element, bool visible)
        {
            if (element is ContentControl { Content: Panel panel })
            {
                foreach (var tb in panel.Children.OfType<TextBlock>().Where(t => Equals(t.Tag, ButtonLabelTag)))
                {
                    var target = visible ? Visibility.Visible : Visibility.Collapsed;
                    if (tb.Visibility == target)
                    {
                        continue;
                    }
                    tb.Visibility = target;

                    // The cached DesiredSize of every ancestor up to the button row is stale until the next layout
                    // pass, so invalidate the chain to make the trial Measure in UpdateToolbarLayout see the change.
                    for (DependencyObject? node = tb; node != null && node != _toolbarButtons; node = VisualTreeHelper.GetParent(node) ?? LogicalTreeHelper.GetParent(node))
                    {
                        (node as UIElement)?.InvalidateMeasure();
                    }
                    _toolbarButtons?.InvalidateMeasure();
                }
            }
        }

        private Button MakeOverflowButton()
        {
            var b = new Button
            {
                Style = FlatButtonStyle,
                ToolTip = "More preview options",
                Padding = new Thickness(6, 1, 6, 1),
                Margin = new Thickness(0, 3, 2, 3),
                MinWidth = 0,
                Cursor = Cursors.Hand,
                Focusable = false,
                VerticalAlignment = VerticalAlignment.Center,
                Visibility = Visibility.Collapsed,
                Content = new CrispImage { Moniker = KnownMonikers.Ellipsis, Width = 16, Height = 16, VerticalAlignment = VerticalAlignment.Center },
            };
            b.SetResourceReference(Control.ForegroundProperty, EnvironmentColors.ToolWindowTextBrushKey);
            AutomationProperties.SetName(b, "More options");
            AutomationProperties.SetAutomationId(b, "PreviewOverflowButton");
            b.Click += OnOverflowClick;
            return b;
        }

        // Built fresh on every open so toggle labels and checked states are current.
        private void OnOverflowClick(object sender, RoutedEventArgs e)
        {
            try
            {
                var menu = ThemeMenu(new ContextMenu());
                foreach (var group in _toolbarGroups)
                {
                    var overflowed = group.Where(i => i.Overflowed && i.MakeOverflowItem != null).ToList();
                    if (overflowed.Count == 0)
                    {
                        continue;
                    }
                    if (menu.Items.Count > 0)
                    {
                        menu.Items.Add(new Separator());
                    }
                    foreach (var item in overflowed)
                    {
                        menu.Items.Add(item.MakeOverflowItem!());
                    }
                }

                menu.PlacementTarget = _overflowButton;
                menu.Placement = System.Windows.Controls.Primitives.PlacementMode.Bottom;
                menu.IsOpen = true;
            }
            catch (Exception ex) { Log.Write("Toolbar overflow menu failed: " + ex); }
        }

        internal MenuItem MakeOverflowCommand(ImageMoniker moniker, string header, RoutedEventHandler onClick, string automationId)
        {
            var item = new MenuItem
            {
                Header = header,
                Icon = new CrispImage { Moniker = moniker, Width = 16, Height = 16 },
            };
            item.SetResourceReference(Control.ForegroundProperty, EnvironmentColors.CommandBarTextActiveBrushKey);
            AutomationProperties.SetName(item, header);
            AutomationProperties.SetAutomationId(item, automationId);
            item.Click += onClick;
            return item;
        }

        private MenuItem MakeOverflowSubmenu(ImageMoniker moniker, string header, ContextMenu source, string automationId)
        {
            var item = new MenuItem
            {
                Header = header,
                Icon = new CrispImage { Moniker = moniker, Width = 16, Height = 16 },
            };
            item.SetResourceReference(Control.ForegroundProperty, EnvironmentColors.CommandBarTextActiveBrushKey);
            AutomationProperties.SetName(item, header);
            AutomationProperties.SetAutomationId(item, automationId);
            foreach (var child in source.Items.OfType<MenuItem>().ToList())
            {
                source.Items.Remove(child);
                item.Items.Add(child);
            }
            return item;
        }

        // Flat, theme-aware chrome for the toolbar buttons. The stock WPF Button template paints an opaque
        // light-gray background that ignores the VS theme, so in dark mode the buttons read as washed-out
        // light chips with near-white icons. This template keeps the button transparent (the command shelf
        // shows through) and lights up hover/pressed with VS environment brushes, so it tracks every theme.
        private static Style? _flatButtonStyle;
        private static Style FlatButtonStyle => _flatButtonStyle ??= BuildFlatButtonStyle();

        private static Style BuildFlatButtonStyle()
        {
            var style = new Style(typeof(Button));
            style.Setters.Add(new Setter(Control.BackgroundProperty, Brushes.Transparent));
            style.Setters.Add(new Setter(Control.BorderBrushProperty, Brushes.Transparent));
            style.Setters.Add(new Setter(Control.BorderThicknessProperty, new Thickness(1)));
            style.Setters.Add(new Setter(UIElement.SnapsToDevicePixelsProperty, true));

            var template = new ControlTemplate(typeof(Button));
            var border = new FrameworkElementFactory(typeof(Border), "Bd");
            border.SetValue(Border.BackgroundProperty, new TemplateBindingExtension(Control.BackgroundProperty));
            border.SetValue(Border.BorderBrushProperty, new TemplateBindingExtension(Control.BorderBrushProperty));
            border.SetValue(Border.BorderThicknessProperty, new TemplateBindingExtension(Control.BorderThicknessProperty));
            border.SetValue(Border.CornerRadiusProperty, new CornerRadius(3));
            border.SetValue(UIElement.SnapsToDevicePixelsProperty, true);

            var content = new FrameworkElementFactory(typeof(ContentPresenter));
            content.SetValue(FrameworkElement.MarginProperty, new TemplateBindingExtension(Control.PaddingProperty));
            content.SetValue(FrameworkElement.HorizontalAlignmentProperty, HorizontalAlignment.Center);
            content.SetValue(FrameworkElement.VerticalAlignmentProperty, VerticalAlignment.Center);
            border.AppendChild(content);
            template.VisualTree = border;

            var hover = new Trigger { Property = UIElement.IsMouseOverProperty, Value = true };
            hover.Setters.Add(new Setter(Border.BackgroundProperty, new DynamicResourceExtension(EnvironmentColors.CommandBarHoverBrushKey), "Bd"));
            hover.Setters.Add(new Setter(Border.BorderBrushProperty, new DynamicResourceExtension(EnvironmentColors.CommandBarMenuBorderBrushKey), "Bd"));
            template.Triggers.Add(hover);

            var pressed = new Trigger { Property = Button.IsPressedProperty, Value = true };
            pressed.Setters.Add(new Setter(Border.BackgroundProperty, new DynamicResourceExtension(EnvironmentColors.CommandBarMouseDownBackgroundBeginBrushKey), "Bd"));
            pressed.Setters.Add(new Setter(Border.BorderBrushProperty, new DynamicResourceExtension(EnvironmentColors.CommandBarMenuBorderBrushKey), "Bd"));
            template.Triggers.Add(pressed);

            style.Setters.Add(new Setter(Control.TemplateProperty, template));
            return style;
        }

        internal Button MakeButton(ImageMoniker moniker, string label, string tooltip, RoutedEventHandler onClick, string automationId)
        {
            var b = new Button
            {
                Style = FlatButtonStyle,
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
            // keeps it in sync when a toggle flips (Select/Interact, Sample data: On/Off, Dock Right/Bottom).
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
                    Tag = ButtonLabelTag,
                };
                tb.SetResourceReference(TextBlock.ForegroundProperty, EnvironmentColors.ToolWindowTextBrushKey);
                panel.Children.Add(tb);
            }
            return panel;
        }

        // Updates a toggle button's icon + label + UIA Name + tooltip together.
        private void SetButton(Button? b, ImageMoniker moniker, string label, string tooltip)
        {
            if (b == null) { return; }
            b.Content = BuildButtonContent(moniker, label);
            b.ToolTip = tooltip;
            AutomationProperties.SetName(b, label);
            OnToolbarButtonContentChanged(b);
        }

        // A relabelled button can change width, so honour the current compact state and re-fit the bar.
        private void OnToolbarButtonContentChanged(Button b)
        {
            SetLabelVisible(b, !_compactLabels);
            UpdateToolbarLayout();
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
                Style = FlatButtonStyle,
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
            var tb = new TextBlock { Text = label, FontSize = 11, Margin = new Thickness(5, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center, Tag = ButtonLabelTag };
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

            // The stock (Aero2) ContextMenu/MenuItem templates paint a light icon gutter and separator that ignore
            // the VS theme. Swap in theme-aware templates; the implicit styles reach submenu items too.
            menu.Template = MenuPopupTemplate;
            menu.Resources[typeof(MenuItem)] = ThemedMenuItemStyle;
            menu.Resources[MenuItem.SeparatorStyleKey] = ThemedSeparatorStyle;
            return menu;
        }

        private const double MenuGutterWidth = 28;

        private static ControlTemplate? _menuPopupTemplate;
        private static ControlTemplate MenuPopupTemplate => _menuPopupTemplate ??= BuildMenuPopupTemplate(typeof(ContextMenu));

        private static ControlTemplate BuildMenuPopupTemplate(Type targetType)
        {
            var template = new ControlTemplate(targetType);
            var border = new FrameworkElementFactory(typeof(Border));
            border.SetValue(Border.BackgroundProperty, new TemplateBindingExtension(Control.BackgroundProperty));
            border.SetValue(Border.BorderBrushProperty, new TemplateBindingExtension(Control.BorderBrushProperty));
            border.SetValue(Border.BorderThicknessProperty, new TemplateBindingExtension(Control.BorderThicknessProperty));
            border.SetValue(Border.PaddingProperty, new Thickness(2));
            border.SetValue(UIElement.SnapsToDevicePixelsProperty, true);
            border.AppendChild(MenuItemsHost());
            template.VisualTree = border;
            return template;
        }

        private static FrameworkElementFactory MenuItemsHost()
        {
            var scroll = new FrameworkElementFactory(typeof(ScrollViewer));
            scroll.SetValue(ScrollViewer.VerticalScrollBarVisibilityProperty, ScrollBarVisibility.Auto);
            scroll.SetValue(ScrollViewer.HorizontalScrollBarVisibilityProperty, ScrollBarVisibility.Disabled);
            var items = new FrameworkElementFactory(typeof(ItemsPresenter));
            items.SetValue(KeyboardNavigation.DirectionalNavigationProperty, KeyboardNavigationMode.Cycle);
            items.SetValue(Grid.IsSharedSizeScopeProperty, true);
            scroll.AppendChild(items);
            return scroll;
        }

        private static Style? _themedSeparatorStyle;
        private static Style ThemedSeparatorStyle => _themedSeparatorStyle ??= BuildThemedSeparatorStyle();

        private static Style BuildThemedSeparatorStyle()
        {
            var style = new Style(typeof(Separator));
            var template = new ControlTemplate(typeof(Separator));
            var line = new FrameworkElementFactory(typeof(Border));
            line.SetValue(FrameworkElement.HeightProperty, 1.0);
            line.SetValue(FrameworkElement.MarginProperty, new Thickness(MenuGutterWidth + 2, 3, 2, 3));
            line.SetResourceReference(Border.BackgroundProperty, EnvironmentColors.CommandBarMenuSeparatorBrushKey);
            template.VisualTree = line;
            style.Setters.Add(new Setter(Control.TemplateProperty, template));
            return style;
        }

        private static Style? _themedMenuItemStyle;
        private static Style ThemedMenuItemStyle => _themedMenuItemStyle ??= BuildThemedMenuItemStyle();

        // One template for leaf and submenu-header items (context menus have no top-level items).
        private static Style BuildThemedMenuItemStyle()
        {
            var style = new Style(typeof(MenuItem));
            style.Setters.Add(new Setter(UIElement.SnapsToDevicePixelsProperty, true));
            style.Setters.Add(new Setter(FrameworkElement.MinHeightProperty, 24.0));

            var template = new ControlTemplate(typeof(MenuItem));
            var root = new FrameworkElementFactory(typeof(Grid), "Bd");
            root.SetValue(Panel.BackgroundProperty, Brushes.Transparent);
            root.SetResourceReference(TextElement.ForegroundProperty, EnvironmentColors.CommandBarTextActiveBrushKey);

            var gutter = new FrameworkElementFactory(typeof(ColumnDefinition));
            gutter.SetValue(ColumnDefinition.WidthProperty, new GridLength(MenuGutterWidth));
            var header = new FrameworkElementFactory(typeof(ColumnDefinition));
            header.SetValue(ColumnDefinition.WidthProperty, new GridLength(1, GridUnitType.Star));
            header.SetValue(DefinitionBase.SharedSizeGroupProperty, "MenuItemHeader");
            var arrowCol = new FrameworkElementFactory(typeof(ColumnDefinition));
            arrowCol.SetValue(ColumnDefinition.WidthProperty, new GridLength(20));
            root.AppendChild(gutter);
            root.AppendChild(header);
            root.AppendChild(arrowCol);

            var highlight = new FrameworkElementFactory(typeof(Border), "Hl");
            highlight.SetValue(Grid.ColumnSpanProperty, 3);
            highlight.SetValue(Border.BorderThicknessProperty, new Thickness(1));
            highlight.SetValue(Border.BackgroundProperty, Brushes.Transparent);
            highlight.SetValue(Border.BorderBrushProperty, Brushes.Transparent);
            root.AppendChild(highlight);

            var icon = new FrameworkElementFactory(typeof(ContentPresenter), "Icon");
            icon.SetValue(ContentPresenter.ContentSourceProperty, "Icon");
            icon.SetValue(FrameworkElement.HorizontalAlignmentProperty, HorizontalAlignment.Center);
            icon.SetValue(FrameworkElement.VerticalAlignmentProperty, VerticalAlignment.Center);
            root.AppendChild(icon);

            var check = new FrameworkElementFactory(typeof(System.Windows.Shapes.Path), "Check");
            check.SetValue(System.Windows.Shapes.Path.DataProperty, Geometry.Parse("M 0,5 L 3.5,8.5 L 10,1.5"));
            check.SetValue(System.Windows.Shapes.Shape.StrokeThicknessProperty, 1.6);
            check.SetResourceReference(System.Windows.Shapes.Shape.StrokeProperty, EnvironmentColors.CommandBarTextActiveBrushKey);
            check.SetValue(FrameworkElement.HorizontalAlignmentProperty, HorizontalAlignment.Center);
            check.SetValue(FrameworkElement.VerticalAlignmentProperty, VerticalAlignment.Center);
            check.SetValue(UIElement.VisibilityProperty, Visibility.Collapsed);
            root.AppendChild(check);

            var content = new FrameworkElementFactory(typeof(ContentPresenter));
            content.SetValue(Grid.ColumnProperty, 1);
            content.SetValue(ContentPresenter.ContentSourceProperty, "Header");
            content.SetValue(ContentPresenter.RecognizesAccessKeyProperty, true);
            content.SetValue(FrameworkElement.MarginProperty, new Thickness(6, 3, 12, 3));
            content.SetValue(FrameworkElement.VerticalAlignmentProperty, VerticalAlignment.Center);
            root.AppendChild(content);

            var arrow = new FrameworkElementFactory(typeof(System.Windows.Shapes.Path), "Arrow");
            arrow.SetValue(Grid.ColumnProperty, 2);
            arrow.SetValue(System.Windows.Shapes.Path.DataProperty, Geometry.Parse("M 0,0 L 4,4 L 0,8 Z"));
            arrow.SetResourceReference(System.Windows.Shapes.Shape.FillProperty, EnvironmentColors.CommandBarMenuSubmenuGlyphBrushKey);
            arrow.SetValue(FrameworkElement.HorizontalAlignmentProperty, HorizontalAlignment.Center);
            arrow.SetValue(FrameworkElement.VerticalAlignmentProperty, VerticalAlignment.Center);
            arrow.SetValue(UIElement.VisibilityProperty, Visibility.Collapsed);
            root.AppendChild(arrow);

            var popup = new FrameworkElementFactory(typeof(System.Windows.Controls.Primitives.Popup), "PART_Popup");
            popup.SetValue(System.Windows.Controls.Primitives.Popup.PlacementProperty, System.Windows.Controls.Primitives.PlacementMode.Right);
            popup.SetValue(System.Windows.Controls.Primitives.Popup.HorizontalOffsetProperty, -2.0);
            popup.SetValue(System.Windows.Controls.Primitives.Popup.AllowsTransparencyProperty, true);
            popup.SetValue(System.Windows.Controls.Primitives.Popup.FocusableProperty, false);
            popup.SetValue(System.Windows.Controls.Primitives.Popup.PopupAnimationProperty, System.Windows.Controls.Primitives.PopupAnimation.None);
            popup.SetBinding(System.Windows.Controls.Primitives.Popup.IsOpenProperty, new Binding(nameof(MenuItem.IsSubmenuOpen)) { RelativeSource = RelativeSource.TemplatedParent, Mode = BindingMode.TwoWay });
            var sub = new FrameworkElementFactory(typeof(Border));
            sub.SetResourceReference(Border.BackgroundProperty, EnvironmentColors.CommandBarMenuBackgroundGradientBrushKey);
            sub.SetResourceReference(Border.BorderBrushProperty, EnvironmentColors.CommandBarMenuBorderBrushKey);
            sub.SetValue(Border.BorderThicknessProperty, new Thickness(1));
            sub.SetValue(Border.PaddingProperty, new Thickness(2));
            sub.AppendChild(MenuItemsHost());
            popup.AppendChild(sub);
            root.AppendChild(popup);

            template.VisualTree = root;

            var hasItems = new Trigger { Property = ItemsControl.HasItemsProperty, Value = true };
            hasItems.Setters.Add(new Setter(UIElement.VisibilityProperty, Visibility.Visible, "Arrow"));
            template.Triggers.Add(hasItems);

            var isChecked = new Trigger { Property = MenuItem.IsCheckedProperty, Value = true };
            isChecked.Setters.Add(new Setter(UIElement.VisibilityProperty, Visibility.Visible, "Check"));
            isChecked.Setters.Add(new Setter(UIElement.VisibilityProperty, Visibility.Collapsed, "Icon"));
            template.Triggers.Add(isChecked);

            var highlighted = new Trigger { Property = MenuItem.IsHighlightedProperty, Value = true };
            highlighted.Setters.Add(new Setter(Border.BackgroundProperty, new DynamicResourceExtension(EnvironmentColors.CommandBarMenuItemMouseOverBrushKey), "Hl"));
            highlighted.Setters.Add(new Setter(Border.BorderBrushProperty, new DynamicResourceExtension(EnvironmentColors.CommandBarMenuItemMouseOverBorderBrushKey), "Hl"));
            highlighted.Setters.Add(new Setter(TextElement.ForegroundProperty, new DynamicResourceExtension(EnvironmentColors.CommandBarMenuItemMouseOverTextBrushKey), "Bd"));
            template.Triggers.Add(highlighted);

            var disabled = new Trigger { Property = UIElement.IsEnabledProperty, Value = false };
            disabled.Setters.Add(new Setter(TextElement.ForegroundProperty, new DynamicResourceExtension(EnvironmentColors.CommandBarTextInactiveBrushKey), "Bd"));
            template.Triggers.Add(disabled);

            style.Setters.Add(new Setter(Control.TemplateProperty, template));
            return style;
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
        private void SetMenuButton(Button? b, ImageMoniker moniker, string label, string tooltip, ContextMenu menu)
        {
            if (b == null) { return; }
            b.Content = BuildMenuButtonContent(moniker, label);
            b.ToolTip = tooltip;
            AutomationProperties.SetName(b, label);
            menu.PlacementTarget = b;
            menu.Placement = System.Windows.Controls.Primitives.PlacementMode.Bottom;
            b.ContextMenu = menu;
            OnToolbarButtonContentChanged(b);
        }

        private void OnReloadClick(object sender, RoutedEventArgs e)
        {
            try { _preview.Reload(); }
            catch (Exception ex) { Log.Write("Reload failed: " + ex); }
        }

        // ---- design-time data (sample data) toggle -------------------------
        //
        // Flips the persisted PreviewOptions.DesignTimeData flag: placeholder text and dummy list rows for
        // {x:Bind} pages (WS2-F6). The M1 (d:DesignData) and M2 (DesignMode signal) paths are automatic and
        // need no toggle.

        private static string DtdLabel() => PreviewOptions.DesignTimeData ? "Sample data: On" : "Sample data: Off";

        private static ImageMoniker DtdMoniker() => KnownMonikers.Table;

        private static string DtdTooltip() => PreviewOptions.DesignTimeData
            ? "Sample data is ON: x:Bind text shows placeholders and bound lists show sample rows. Click to turn it off."
            : "Sample data is OFF: x:Bind values are left empty. Click to turn it on.";

        private void OnToggleDtdClick(object sender, RoutedEventArgs e)
        {
            try
            {
                _preview.SetDesignTimeData(!PreviewOptions.DesignTimeData);
                SetButton(_dtdButton, DtdMoniker(), DtdLabel(), DtdTooltip());
            }
            catch (Exception ex) { Log.Write("Toggle design-time data failed: " + ex); }
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

    }
}
