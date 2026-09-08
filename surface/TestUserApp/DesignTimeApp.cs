using Microsoft.UI.Xaml;

namespace TestUserApp;

/// <summary>
/// P2 (coverage hardening) demo: a stand-in <see cref="Application"/> subclass that owns a static service
/// singleton declared <c>= null!</c> and — exactly like a real app (e.g. AIDevGallery.App.ModelDownloadQueue
/// { get; private set; } = null!) — only assigned during startup, which never runs in a headless preview
/// host. The host NEVER constructs this type (constructing the user's Application subclass fail-fasts); the
/// P2 App-init recovery reflectively SEEDS this null static (its type <see cref="DemoAppService"/> is cleanly
/// constructible) when a control constructor throws dereferencing it, then retries the activation.
/// </summary>
public class DesignTimeApp : Application
{
    /// <summary>Null in a headless host until the host's App-init recovery seeds it (mirrors the gallery).</summary>
    public static DemoAppService AppService { get; private set; } = null!;
}
