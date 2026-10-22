#nullable enable

using System.Collections.Generic;
using System.Windows;

namespace WinUIXamlPreview.UI
{
    // Read-only state probe for the in-VS integration tests (vs-extension\WinUIXamlPreview.IntegrationTests).
    // Reached only through Testing.TestHooks; UI thread only.
    public partial class PreviewControl
    {
        internal Dictionary<string, object?> TestSnapshot()
        {
            var client = _client;
            var spare = _spareClient;
            var path = _pinnedPath ?? _currentPath;
            return new Dictionary<string, object?>
            {
                ["currentPath"] = _currentPath,
                ["pinnedPath"] = _pinnedPath,
                ["disposed"] = _disposed,
                ["isLoaded"] = IsLoaded,
                ["isVisible"] = IsVisible,
                ["actualWidth"] = ActualWidth,
                ["actualHeight"] = ActualHeight,
                ["hasFrame"] = _hasFrame,
                ["hasNative"] = _hasNative,
                ["nativeSupported"] = _nativeSupported,
                ["frameImageVisible"] = FrameImage.Visibility == Visibility.Visible,
                ["statusVisible"] = StatusOverlay.Visibility == Visibility.Visible,
                ["statusText"] = StatusText.Text,
                ["statusDetail"] = StatusDetail.Visibility == Visibility.Visible ? StatusDetail.Text : null,
                ["statusSpinner"] = Spinner.Visibility == Visibility.Visible,
                ["statusActionVisible"] = StatusActionHost.Visibility == Visibility.Visible && StatusActionHost.Content != null,
                ["messageBarShown"] = _messageBar.IsShown,
                ["messageBarText"] = _messageBar.IsShown ? System.Windows.Automation.AutomationProperties.GetName(_messageBar) : null,
                ["fidelityBarShown"] = _fidelityBar.IsShown,
                ["fidelityBarText"] = _fidelityBar.IsShown ? System.Windows.Automation.AutomationProperties.GetName(_fidelityBar) : null,
                ["reconnectShown"] = _reconnectShown,
                ["clientPid"] = client?.ProcessId,
                ["clientFaulted"] = client?.IsFaulted,
                ["sparePid"] = spare?.ProcessId,
                ["spareReady"] = _spareReady,
                ["restartAttempts"] = _session.Restarts.Attempts,
                ["restartsExhausted"] = _session.Restarts.Exhausted,
                ["isRisky"] = _session.IsRisky(path),
                ["activeTheme"] = _activeTheme,
                ["lastSelectedPath"] = _lastSelected?.Path,
                ["lastSelectedType"] = _lastSelected?.ElementType,
            };
        }
    }
}
