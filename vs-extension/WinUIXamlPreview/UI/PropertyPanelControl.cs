#nullable enable

using System;
using System.Collections.ObjectModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Data;
using System.Windows.Input;
using System.Windows.Media;
using Microsoft.VisualStudio.PlatformUI;
using Microsoft.VisualStudio.Shell;

namespace WinUIXamlPreview.UI
{
    /// <summary>
    /// The design-time property panel (plan §41, Phase B — read-only). A code-built WPF control that shows
    /// the currently-selected element's type/name header and a category-grouped Name/Value list, themed with
    /// VS environment colors. Subscribes to <see cref="DesignerSelection"/> and repopulates on each selection.
    /// </summary>
    internal sealed class PropertyPanelControl : UserControl
    {
        private readonly TextBlock _typeText;
        private readonly TextBlock _nameText;
        private readonly TextBlock _emptyText;
        private readonly ListView _list;
        private readonly ObservableCollection<PropRow> _rows = new ObservableCollection<PropRow>();

        // The element id behind the current snapshot; edits route back to this id (Phase C). -1 = no selection.
        private int _currentId = -1;

        public PropertyPanelControl()
        {
            var root = new DockPanel { LastChildFill = true };
            root.SetResourceReference(BackgroundProperty, EnvironmentColors.ToolWindowBackgroundBrushKey);

            // ---- header (element type + name) ----
            var header = new StackPanel { Margin = new Thickness(8, 6, 8, 6) };
            _typeText = new TextBlock
            {
                Text = "No selection",
                FontSize = 13,
                FontWeight = FontWeights.SemiBold,
                TextTrimming = TextTrimming.CharacterEllipsis,
            };
            _typeText.SetResourceReference(TextBlock.ForegroundProperty, EnvironmentColors.ToolWindowTextBrushKey);
            _nameText = new TextBlock
            {
                Text = "",
                FontSize = 11,
                Margin = new Thickness(0, 1, 0, 0),
                TextTrimming = TextTrimming.CharacterEllipsis,
            };
            _nameText.SetResourceReference(TextBlock.ForegroundProperty, EnvironmentColors.SystemGrayTextBrushKey);
            header.Children.Add(_typeText);
            header.Children.Add(_nameText);
            DockPanel.SetDock(header, Dock.Top);
            root.Children.Add(header);

            // ---- empty-state hint ----
            _emptyText = new TextBlock
            {
                Text = "Select an element in the preview to inspect its properties.",
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(10, 8, 10, 8),
                FontSize = 11,
                Visibility = Visibility.Visible,
            };
            _emptyText.SetResourceReference(TextBlock.ForegroundProperty, EnvironmentColors.SystemGrayTextBrushKey);
            DockPanel.SetDock(_emptyText, Dock.Top);
            root.Children.Add(_emptyText);

            // ---- property list (category-grouped Name | Value) ----
            _list = new ListView { BorderThickness = new Thickness(0), Visibility = Visibility.Collapsed };
            _list.SetResourceReference(BackgroundProperty, EnvironmentColors.ToolWindowBackgroundBrushKey);
            _list.SetResourceReference(ForegroundProperty, EnvironmentColors.ToolWindowTextBrushKey);
            ScrollViewer.SetHorizontalScrollBarVisibility(_list, ScrollBarVisibility.Disabled);

            var grid = new GridView { AllowsColumnReorder = false };
            grid.Columns.Add(new GridViewColumn { Header = "Property", Width = 150, DisplayMemberBinding = new Binding("Name") });
            grid.Columns.Add(new GridViewColumn
            {
                Header = "Value",
                Width = 220,
                CellTemplateSelector = new ValueTemplateSelector
                {
                    ReadOnlyTemplate = BuildReadOnlyValueTemplate(),
                    TextTemplate = BuildTextValueTemplate(),
                    ComboTemplate = BuildComboValueTemplate(),
                },
            });
            _list.View = grid;

            var view = new CollectionViewSource { Source = _rows };
            view.GroupDescriptions.Add(new PropertyGroupDescription("Category"));
            _list.ItemsSource = view.View;
            _list.GroupStyle.Add(BuildGroupStyle());

            root.Children.Add(_list);

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
            _rows.Clear();
            _currentId = snapshot?.Id ?? -1;

            if (snapshot == null)
            {
                _typeText.Text = "No selection";
                _nameText.Text = "";
                _emptyText.Visibility = Visibility.Visible;
                _list.Visibility = Visibility.Collapsed;
                return;
            }

            _typeText.Text = snapshot.ElementType;
            _nameText.Text = string.IsNullOrEmpty(snapshot.Name) ? "(unnamed)" : snapshot.Name;

            foreach (var row in snapshot.Props)
            {
                _rows.Add(row);
            }

            bool any = _rows.Count > 0;
            _emptyText.Visibility = any ? Visibility.Collapsed : Visibility.Visible;
            _emptyText.Text = any
                ? ""
                : "No inspectable properties for this element.";
            _list.Visibility = any ? Visibility.Visible : Visibility.Collapsed;
        }

        // ---- Phase C: editable value cells -----------------------------------

        /// <summary>Read-only value: a trimmed text block (used for properties with no setter).</summary>
        private static DataTemplate BuildReadOnlyValueTemplate()
        {
            var f = new FrameworkElementFactory(typeof(TextBlock));
            f.SetBinding(TextBlock.TextProperty, new Binding("Value"));
            f.SetValue(TextBlock.TextTrimmingProperty, TextTrimming.CharacterEllipsis);
            f.SetValue(TextBlock.ToolTipProperty, new Binding("Value"));
            f.SetResourceReference(TextBlock.ForegroundProperty, EnvironmentColors.SystemGrayTextBrushKey);
            return new DataTemplate(typeof(PropRow)) { VisualTree = f };
        }

        /// <summary>Free-text value: an inline text box committed on Enter or focus loss.</summary>
        private DataTemplate BuildTextValueTemplate()
        {
            var f = new FrameworkElementFactory(typeof(TextBox));
            f.SetBinding(TextBox.TextProperty, new Binding("Value") { Mode = BindingMode.OneWay });
            f.SetValue(TextBox.BorderThicknessProperty, new Thickness(0));
            f.SetValue(TextBox.BackgroundProperty, Brushes.Transparent);
            f.SetValue(TextBox.PaddingProperty, new Thickness(0));
            f.SetResourceReference(TextBox.ForegroundProperty, EnvironmentColors.ToolWindowTextBrushKey);
            f.AddHandler(TextBox.LostFocusEvent, new RoutedEventHandler(OnValueTextCommitted));
            f.AddHandler(TextBox.KeyDownEvent, new KeyEventHandler(OnValueTextKeyDown));
            return new DataTemplate(typeof(PropRow)) { VisualTree = f };
        }

        /// <summary>Closed-set value (enum/bool): a dropdown committed on selection change.</summary>
        private DataTemplate BuildComboValueTemplate()
        {
            var f = new FrameworkElementFactory(typeof(ComboBox));
            f.SetBinding(ComboBox.ItemsSourceProperty, new Binding("Options"));
            f.SetBinding(ComboBox.SelectedItemProperty, new Binding("Value") { Mode = BindingMode.OneWay });
            f.SetValue(ComboBox.IsEditableProperty, false);
            f.AddHandler(ComboBox.SelectionChangedEvent, new SelectionChangedEventHandler(OnValueComboCommitted));
            return new DataTemplate(typeof(PropRow)) { VisualTree = f };
        }

        private void OnValueTextKeyDown(object sender, KeyEventArgs e)
        {
            // Enter commits by moving focus off the box, which triggers the single LostFocus commit below.
            if (e.Key == Key.Enter && sender is TextBox tb)
            {
                e.Handled = true;
                _list.Focus();
                tb.MoveFocus(new TraversalRequest(FocusNavigationDirection.Next));
            }
        }

        private void OnValueTextCommitted(object sender, RoutedEventArgs e)
        {
            if (sender is TextBox tb)
            {
                Commit(tb.DataContext as PropRow, tb.Text);
            }
        }

        private void OnValueComboCommitted(object sender, SelectionChangedEventArgs e)
        {
            if (sender is ComboBox cb && cb.SelectedItem is string s)
            {
                Commit(cb.DataContext as PropRow, s);
            }
        }

        /// <summary>
        /// Route a committed edit back to the surface (Phase C). No-ops on read-only rows, no-change edits, or
        /// when there's no live selection. The surface echoes fresh <c>ElementProps</c>, which re-renders the
        /// panel — so a rejected value visibly reverts.
        /// </summary>
        private void Commit(PropRow? row, string newValue)
        {
            if (row == null || row.ReadOnly || _currentId < 0)
            {
                return;
            }

            newValue ??= "";
            if (newValue == row.Value)
            {
                return; // no change (also skips the ComboBox's initial programmatic selection)
            }

            row.Value = newValue; // optimistic; the surface echo confirms or reverts
            DesignerSelection.RequestSetProperty(_currentId, row.Name, newValue);
        }

        /// <summary>Picks the editor for a row: read-only text, enum/bool dropdown, or free-text box.</summary>
        private sealed class ValueTemplateSelector : DataTemplateSelector
        {
            public DataTemplate? ReadOnlyTemplate { get; set; }
            public DataTemplate? TextTemplate { get; set; }
            public DataTemplate? ComboTemplate { get; set; }

            public override DataTemplate? SelectTemplate(object item, DependencyObject container)
            {
                if (item is PropRow r)
                {
                    if (r.ReadOnly)
                    {
                        return ReadOnlyTemplate;
                    }

                    return r.Options != null && r.Options.Count > 0 ? ComboTemplate : TextTemplate;
                }

                return base.SelectTemplate(item, container);
            }
        }

        private static GroupStyle BuildGroupStyle()
        {
            // A simple bold category header row above each group.
            var headerTemplate = new DataTemplate();
            var textFactory = new FrameworkElementFactory(typeof(TextBlock));
            textFactory.SetBinding(TextBlock.TextProperty, new Binding("Name"));
            textFactory.SetValue(TextBlock.FontWeightProperty, FontWeights.SemiBold);
            textFactory.SetValue(TextBlock.MarginProperty, new Thickness(4, 6, 0, 2));
            textFactory.SetValue(TextBlock.FontSizeProperty, 11.0);
            textFactory.SetResourceReference(TextBlock.ForegroundProperty, EnvironmentColors.SystemGrayTextBrushKey);
            headerTemplate.VisualTree = textFactory;

            return new GroupStyle { HeaderTemplate = headerTemplate };
        }
    }
}
