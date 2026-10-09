#nullable enable

using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Shapes;
using Microsoft.VisualStudio.PlatformUI;
using Microsoft.VisualStudio.Shell;

namespace WinUIXamlPreview.UI
{
    /// <summary>
    /// The design-time property panel (plan §41) — read-only. A code-built WPF control that shows the
    /// currently-selected element's type/name header and a category-grouped Name/Value list. Everything is
    /// themed via VS environment colors/fonts (no stock ListView/GridView/ComboBox chrome, which renders light
    /// in dark themes). Subscribes to <see cref="DesignerSelection"/> and rebuilds on each selection.
    /// </summary>
    internal sealed class PropertyPanelControl : UserControl
    {
        private const string NameColumnGroup = "PropName";

        private readonly TextBlock _typeText;
        private readonly TextBlock _nameText;
        private readonly TextBlock _emptyText;
        private readonly ScrollViewer _scroller;
        private readonly StackPanel _rowsPanel;

        public PropertyPanelControl()
        {
            SetResourceReference(FontFamilyProperty, VsFonts.EnvironmentFontFamilyKey);
            SetResourceReference(FontSizeProperty, VsFonts.EnvironmentFontSizeKey);

            var root = new DockPanel { LastChildFill = true };
            root.SetResourceReference(BackgroundProperty, EnvironmentColors.ToolWindowBackgroundBrushKey);

            // ---- header (element type + name) ----
            var header = new StackPanel { Margin = new Thickness(12, 10, 12, 8) };
            _typeText = new TextBlock
            {
                Text = "No selection",
                FontSize = 15,
                FontWeight = FontWeights.SemiBold,
                TextTrimming = TextTrimming.CharacterEllipsis,
            };
            _typeText.SetResourceReference(TextBlock.ForegroundProperty, EnvironmentColors.ToolWindowTextBrushKey);
            _nameText = new TextBlock
            {
                Margin = new Thickness(0, 2, 0, 0),
                TextTrimming = TextTrimming.CharacterEllipsis,
            };
            _nameText.SetResourceReference(TextBlock.ForegroundProperty, EnvironmentColors.SystemGrayTextBrushKey);
            header.Children.Add(_typeText);
            header.Children.Add(_nameText);
            DockPanel.SetDock(header, Dock.Top);
            root.Children.Add(header);

            var divider = new Rectangle { Height = 1, Margin = new Thickness(12, 0, 12, 0) };
            divider.SetResourceReference(Shape.FillProperty, EnvironmentColors.ToolWindowBorderBrushKey);
            DockPanel.SetDock(divider, Dock.Top);
            root.Children.Add(divider);

            // ---- empty-state hint ----
            _emptyText = new TextBlock
            {
                Text = "Select an element in the preview to inspect its properties.",
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(12, 10, 12, 10),
            };
            _emptyText.SetResourceReference(TextBlock.ForegroundProperty, EnvironmentColors.SystemGrayTextBrushKey);
            DockPanel.SetDock(_emptyText, Dock.Top);
            root.Children.Add(_emptyText);

            // ---- property list (category-grouped Name | Value) ----
            _rowsPanel = new StackPanel { Margin = new Thickness(12, 4, 12, 12) };
            Grid.SetIsSharedSizeScope(_rowsPanel, true);
            _scroller = new ScrollViewer
            {
                Content = _rowsPanel,
                HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
                VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                Visibility = Visibility.Collapsed,
            };
            root.Children.Add(_scroller);

            Content = root;

            Loaded += OnLoaded;
            Unloaded += OnUnloaded;
        }

        private void OnLoaded(object sender, RoutedEventArgs e)
        {
            DesignerSelection.Changed += OnSelectionChanged;
            Render(DesignerSelection.Current);
        }

        private void OnUnloaded(object sender, RoutedEventArgs e)
        {
            DesignerSelection.Changed -= OnSelectionChanged;
        }

        private void OnSelectionChanged(SelectionSnapshot? snapshot)
        {
            if (!Dispatcher.CheckAccess())
            {
                _ = Dispatcher.BeginInvoke(new Action(() => Render(snapshot)));
                return;
            }

            Render(snapshot);
        }

        private void Render(SelectionSnapshot? snapshot)
        {
            _rowsPanel.Children.Clear();

            if (snapshot == null)
            {
                _typeText.Text = "No selection";
                _nameText.Text = "";
                _nameText.Visibility = Visibility.Collapsed;
                _emptyText.Text = "Select an element in the preview to inspect its properties.";
                _emptyText.Visibility = Visibility.Visible;
                _scroller.Visibility = Visibility.Collapsed;
                return;
            }

            _typeText.Text = snapshot.ElementType;
            _nameText.Text = string.IsNullOrEmpty(snapshot.Name) ? "(unnamed)" : snapshot.Name;
            _nameText.Visibility = Visibility.Visible;

            string? lastCategory = null;
            foreach (var row in snapshot.Props) // already grouped/sorted by category on the surface side
            {
                if (!string.Equals(row.Category, lastCategory, StringComparison.Ordinal))
                {
                    lastCategory = row.Category;
                    _rowsPanel.Children.Add(BuildCategoryHeader(row.Category, first: _rowsPanel.Children.Count == 0));
                }

                _rowsPanel.Children.Add(BuildRow(row));
            }

            bool any = _rowsPanel.Children.Count > 0;
            _emptyText.Text = "No inspectable properties for this element.";
            _emptyText.Visibility = any ? Visibility.Collapsed : Visibility.Visible;
            _scroller.Visibility = any ? Visibility.Visible : Visibility.Collapsed;
            _scroller.ScrollToTop();
        }

        private static FrameworkElement BuildCategoryHeader(string category, bool first)
        {
            var panel = new StackPanel { Margin = new Thickness(0, first ? 6 : 10, 0, 4) };
            if (!first)
            {
                var separator = new Rectangle { Height = 1, Margin = new Thickness(0, 0, 0, 10), Opacity = 0.8 };
                separator.SetResourceReference(Shape.FillProperty, EnvironmentColors.ToolWindowBorderBrushKey);
                panel.Children.Add(separator);
            }

            var text = new TextBlock { Text = category, FontWeight = FontWeights.Bold, FontSize = 13 };
            text.SetResourceReference(TextBlock.ForegroundProperty, EnvironmentColors.ToolWindowTextBrushKey);
            panel.Children.Add(text);
            return panel;
        }

        private static FrameworkElement BuildRow(PropRow row)
        {
            var grid = new Grid { Margin = new Thickness(0, 3, 0, 3) };
            grid.ColumnDefinitions.Add(new ColumnDefinition
            {
                Width = GridLength.Auto,
                MinWidth = 120,
                SharedSizeGroup = NameColumnGroup,
            });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(16) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

            var name = new TextBlock { Text = row.Name };
            name.SetResourceReference(TextBlock.ForegroundProperty, EnvironmentColors.SystemGrayTextBrushKey);

            var value = new TextBlock
            {
                Text = row.Value,
                FontWeight = FontWeights.SemiBold,
                TextTrimming = TextTrimming.CharacterEllipsis,
                ToolTip = string.IsNullOrEmpty(row.Value) ? null : row.Value,
            };
            value.SetResourceReference(TextBlock.ForegroundProperty, EnvironmentColors.ToolWindowTextBrushKey);
            Grid.SetColumn(value, 2);

            grid.Children.Add(name);
            grid.Children.Add(value);
            return grid;
        }
    }
}
