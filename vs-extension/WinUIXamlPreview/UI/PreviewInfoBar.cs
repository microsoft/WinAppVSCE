#nullable enable

using System;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;
using Microsoft.VisualStudio.Imaging;
using Microsoft.VisualStudio.Imaging.Interop;
using Microsoft.VisualStudio.PlatformUI;

namespace WinUIXamlPreview.UI
{
    internal enum BannerSeverity
    {
        Info,
        Warning,
        Error,
        Success,
        Progress,
    }

    /// <summary>
    /// U2: the one non-blocking notification surface for the preview — a VS-style info bar docked at the top
    /// of the pane (below the toolbar), themed with <see cref="InfoBarColors"/> and the standard status
    /// monikers so it matches VS's own info bars in every theme. It lives in its own layout row, so in native
    /// mode the reparented WinUI HWND shrinks below it instead of painting over it (airspace).
    /// </summary>
    internal sealed class PreviewInfoBar : Border
    {
        private readonly CrispImage _icon;
        private readonly TextBlock _text;
        private readonly Button _action;
        private readonly Button _close;
        private readonly ProgressBar _progress;
        private DispatcherTimer? _autoHide;
        private Action? _onAction;

        public event EventHandler? Dismissed;

        public PreviewInfoBar(string automationId)
        {
            Visibility = Visibility.Collapsed;
            BorderThickness = new Thickness(0, 0, 0, 1);
            SnapsToDevicePixels = true;
            SetResourceReference(BackgroundProperty, InfoBarColors.InfoBarBackgroundBrushKey);
            SetResourceReference(BorderBrushProperty, InfoBarColors.InfoBarBorderBrushKey);
            SetResourceReference(ImageThemingUtilities.ImageBackgroundColorProperty, InfoBarColors.InfoBarBackgroundColorKey);
            SetResourceReference(TextElement.ForegroundProperty, InfoBarColors.InfoBarBackgroundTextBrushKey);
            AutomationProperties.SetAutomationId(this, automationId);

            var grid = new Grid();
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

            _icon = new CrispImage
            {
                Width = 16,
                Height = 16,
                Margin = new Thickness(10, 7, 8, 7),
                VerticalAlignment = VerticalAlignment.Top,
            };
            Grid.SetColumn(_icon, 0);
            grid.Children.Add(_icon);

            _text = new TextBlock
            {
                TextWrapping = TextWrapping.Wrap,
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(0, 6, 8, 6),
            };
            Grid.SetColumn(_text, 1);
            grid.Children.Add(_text);

            _action = PreviewChrome.MakeButton("", (_, __) => _onAction?.Invoke());
            _action.Margin = new Thickness(0, 4, 6, 4);
            _action.VerticalAlignment = VerticalAlignment.Top;
            AutomationProperties.SetAutomationId(_action, automationId + ".Action");
            Grid.SetColumn(_action, 2);
            grid.Children.Add(_action);

            _close = PreviewChrome.MakeCloseButton((_, __) => { Hide(); Dismissed?.Invoke(this, EventArgs.Empty); });
            _close.Margin = new Thickness(0, 5, 6, 5);
            _close.VerticalAlignment = VerticalAlignment.Top;
            AutomationProperties.SetAutomationId(_close, automationId + ".Close");
            Grid.SetColumn(_close, 3);
            grid.Children.Add(_close);

            _progress = PreviewChrome.MakeProgressBar();
            _progress.Height = 2;
            Grid.SetRow(_progress, 1);
            Grid.SetColumnSpan(_progress, 4);
            grid.Children.Add(_progress);

            Child = grid;
        }

        public bool IsShown => Visibility == Visibility.Visible;

        /// <summary>Show (or replace) the bar's content. <paramref name="autoHide"/> collapses it after a delay.</summary>
        public void Show(
            BannerSeverity severity,
            string title,
            string? message = null,
            string? actionText = null,
            Action? onAction = null,
            bool dismissible = true,
            TimeSpan? autoHide = null)
        {
            _autoHide?.Stop();

            _icon.Moniker = PreviewChrome.MonikerFor(severity);

            _text.Inlines.Clear();
            _text.Inlines.Add(new Run(title) { FontWeight = FontWeights.SemiBold });
            if (!string.IsNullOrEmpty(message))
            {
                _text.Inlines.Add(new Run("  " + message));
            }

            var full = string.IsNullOrEmpty(message) ? title : title + ": " + message;
            _text.ToolTip = full;
            AutomationProperties.SetName(this, full);

            _onAction = onAction;
            if (!string.IsNullOrEmpty(actionText) && onAction != null)
            {
                _action.Content = actionText;
                AutomationProperties.SetName(_action, actionText);
                _action.Visibility = Visibility.Visible;
            }
            else
            {
                _action.Visibility = Visibility.Collapsed;
            }

            _close.Visibility = dismissible ? Visibility.Visible : Visibility.Collapsed;

            var busy = severity == BannerSeverity.Progress;
            _progress.Visibility = busy ? Visibility.Visible : Visibility.Collapsed;
            _progress.IsIndeterminate = busy;

            Visibility = Visibility.Visible;

            if (autoHide.HasValue)
            {
                if (_autoHide == null)
                {
                    _autoHide = new DispatcherTimer();
                    _autoHide.Tick += (_, __) => Hide();
                }

                _autoHide.Interval = autoHide.Value;
                _autoHide.Start();
            }
        }

        public void Hide()
        {
            _autoHide?.Stop();
            _progress.IsIndeterminate = false;
            _onAction = null;
            Visibility = Visibility.Collapsed;
        }
    }

    /// <summary>Shared themed pieces for the preview's banners and centered status card.</summary>
    internal static class PreviewChrome
    {
        public static ImageMoniker MonikerFor(BannerSeverity severity) => severity switch
        {
            BannerSeverity.Error => KnownMonikers.StatusError,
            BannerSeverity.Warning => KnownMonikers.StatusWarning,
            BannerSeverity.Success => KnownMonikers.StatusOK,
            _ => KnownMonikers.StatusInformation,
        };

        private static Style? _buttonStyle;
        private static Style? _closeStyle;

        /// <summary>A VS info-bar button (InfoBarColors.Button*), used for banner and status-card actions.</summary>
        public static Button MakeButton(string text, RoutedEventHandler onClick)
        {
            var b = new Button
            {
                Style = _buttonStyle ??= BuildButtonStyle(),
                Content = text,
                Padding = new Thickness(10, 2, 10, 3),
                MinWidth = 0,
                Cursor = Cursors.Hand,
            };
            b.Click += onClick;
            return b;
        }

        public static Button MakeCloseButton(RoutedEventHandler onClick)
        {
            var b = new Button
            {
                Style = _closeStyle ??= BuildCloseStyle(),
                Width = 18,
                Height = 18,
                Cursor = Cursors.Hand,
                ToolTip = "Dismiss",
                Content = new TextBlock
                {
                    FontFamily = new FontFamily("Segoe MDL2 Assets"),
                    FontSize = 9,
                    Text = "\uE711",
                    HorizontalAlignment = HorizontalAlignment.Center,
                    VerticalAlignment = VerticalAlignment.Center,
                },
            };
            AutomationProperties.SetName(b, "Dismiss");
            b.Click += onClick;
            return b;
        }

        /// <summary>A flat, theme-colored progress line (the stock Aero bar is a green chip that ignores VS themes).</summary>
        public static ProgressBar MakeProgressBar()
        {
            var bar = new ProgressBar
            {
                BorderThickness = new Thickness(0),
                Background = Brushes.Transparent,
                Minimum = 0,
                Maximum = 100,
                Focusable = false,
            };
            bar.SetResourceReference(Control.ForegroundProperty, EnvironmentColors.SystemHighlightBrushKey);
            return bar;
        }

        private static Style BuildButtonStyle()
        {
            var style = new Style(typeof(Button));
            style.Setters.Add(new Setter(Control.BorderThicknessProperty, new Thickness(1)));
            style.Setters.Add(new Setter(UIElement.SnapsToDevicePixelsProperty, true));
            style.Setters.Add(new Setter(Control.BackgroundProperty, new DynamicResourceExtension(InfoBarColors.ButtonBrushKey)));
            style.Setters.Add(new Setter(Control.BorderBrushProperty, new DynamicResourceExtension(InfoBarColors.ButtonBorderBrushKey)));
            style.Setters.Add(new Setter(Control.ForegroundProperty, new DynamicResourceExtension(InfoBarColors.ButtonTextBrushKey)));

            var template = new ControlTemplate(typeof(Button));
            var border = new FrameworkElementFactory(typeof(Border), "Bd");
            border.SetValue(Border.BackgroundProperty, new TemplateBindingExtension(Control.BackgroundProperty));
            border.SetValue(Border.BorderBrushProperty, new TemplateBindingExtension(Control.BorderBrushProperty));
            border.SetValue(Border.BorderThicknessProperty, new TemplateBindingExtension(Control.BorderThicknessProperty));
            border.SetValue(Border.CornerRadiusProperty, new CornerRadius(2));
            border.SetValue(UIElement.SnapsToDevicePixelsProperty, true);
            var content = new FrameworkElementFactory(typeof(ContentPresenter));
            content.SetValue(FrameworkElement.MarginProperty, new TemplateBindingExtension(Control.PaddingProperty));
            content.SetValue(FrameworkElement.HorizontalAlignmentProperty, HorizontalAlignment.Center);
            content.SetValue(FrameworkElement.VerticalAlignmentProperty, VerticalAlignment.Center);
            border.AppendChild(content);
            template.VisualTree = border;

            var hover = new Trigger { Property = UIElement.IsMouseOverProperty, Value = true };
            hover.Setters.Add(new Setter(Control.BackgroundProperty, new DynamicResourceExtension(InfoBarColors.ButtonMouseOverBrushKey)));
            hover.Setters.Add(new Setter(Control.BorderBrushProperty, new DynamicResourceExtension(InfoBarColors.ButtonMouseOverBorderBrushKey)));
            hover.Setters.Add(new Setter(Control.ForegroundProperty, new DynamicResourceExtension(InfoBarColors.ButtonMouseOverTextBrushKey)));
            template.Triggers.Add(hover);

            var focus = new Trigger { Property = UIElement.IsKeyboardFocusedProperty, Value = true };
            focus.Setters.Add(new Setter(Control.BackgroundProperty, new DynamicResourceExtension(InfoBarColors.ButtonFocusBrushKey)));
            focus.Setters.Add(new Setter(Control.BorderBrushProperty, new DynamicResourceExtension(InfoBarColors.ButtonFocusBorderBrushKey)));
            focus.Setters.Add(new Setter(Control.ForegroundProperty, new DynamicResourceExtension(InfoBarColors.ButtonFocusTextBrushKey)));
            template.Triggers.Add(focus);

            var pressed = new Trigger { Property = Button.IsPressedProperty, Value = true };
            pressed.Setters.Add(new Setter(Control.BackgroundProperty, new DynamicResourceExtension(InfoBarColors.ButtonMouseDownBrushKey)));
            pressed.Setters.Add(new Setter(Control.BorderBrushProperty, new DynamicResourceExtension(InfoBarColors.ButtonMouseDownBorderBrushKey)));
            pressed.Setters.Add(new Setter(Control.ForegroundProperty, new DynamicResourceExtension(InfoBarColors.ButtonMouseDownTextBrushKey)));
            template.Triggers.Add(pressed);

            style.Setters.Add(new Setter(Control.TemplateProperty, template));
            return style;
        }

        private static Style BuildCloseStyle()
        {
            var style = new Style(typeof(Button));
            style.Setters.Add(new Setter(Control.BorderThicknessProperty, new Thickness(1)));
            style.Setters.Add(new Setter(Control.BackgroundProperty, new DynamicResourceExtension(InfoBarColors.CloseButtonBrushKey)));
            style.Setters.Add(new Setter(Control.BorderBrushProperty, new DynamicResourceExtension(InfoBarColors.CloseButtonBorderBrushKey)));
            style.Setters.Add(new Setter(Control.ForegroundProperty, new DynamicResourceExtension(InfoBarColors.CloseButtonGlyphBrushKey)));

            var template = new ControlTemplate(typeof(Button));
            var border = new FrameworkElementFactory(typeof(Border), "Bd");
            border.SetValue(Border.BackgroundProperty, new TemplateBindingExtension(Control.BackgroundProperty));
            border.SetValue(Border.BorderBrushProperty, new TemplateBindingExtension(Control.BorderBrushProperty));
            border.SetValue(Border.BorderThicknessProperty, new TemplateBindingExtension(Control.BorderThicknessProperty));
            var content = new FrameworkElementFactory(typeof(ContentPresenter));
            content.SetValue(FrameworkElement.HorizontalAlignmentProperty, HorizontalAlignment.Center);
            content.SetValue(FrameworkElement.VerticalAlignmentProperty, VerticalAlignment.Center);
            border.AppendChild(content);
            template.VisualTree = border;

            var hover = new Trigger { Property = UIElement.IsMouseOverProperty, Value = true };
            hover.Setters.Add(new Setter(Control.BackgroundProperty, new DynamicResourceExtension(InfoBarColors.CloseButtonHoverBrushKey)));
            hover.Setters.Add(new Setter(Control.BorderBrushProperty, new DynamicResourceExtension(InfoBarColors.CloseButtonHoverBorderBrushKey)));
            hover.Setters.Add(new Setter(Control.ForegroundProperty, new DynamicResourceExtension(InfoBarColors.CloseButtonHoverGlyphBrushKey)));
            template.Triggers.Add(hover);

            var pressed = new Trigger { Property = Button.IsPressedProperty, Value = true };
            pressed.Setters.Add(new Setter(Control.BackgroundProperty, new DynamicResourceExtension(InfoBarColors.CloseButtonDownBrushKey)));
            pressed.Setters.Add(new Setter(Control.BorderBrushProperty, new DynamicResourceExtension(InfoBarColors.CloseButtonDownBorderBrushKey)));
            pressed.Setters.Add(new Setter(Control.ForegroundProperty, new DynamicResourceExtension(InfoBarColors.CloseButtonDownGlyphBrushKey)));
            template.Triggers.Add(pressed);

            style.Setters.Add(new Setter(Control.TemplateProperty, template));
            return style;
        }
    }
}
