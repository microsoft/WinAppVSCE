namespace TestUserApp;

/// <summary>
/// P2 (coverage hardening) demo: a stand-in for an app service singleton the real application only creates
/// during startup — mirroring AIDevGallery's <c>ModelDownloadQueue</c>. It is a plain reference type with a
/// public parameterless constructor and no <c>required</c> members, so the Surface host's App-init recovery
/// can cleanly construct it via reflection when a control's constructor throws dereferencing it. The service
/// self-populates in its constructor so the recovered instance carries provable sample content (proving the
/// control read the seeded singleton, not some empty stub).
/// </summary>
public sealed class DemoAppService
{
    /// <summary>A value the demo control surfaces to prove the seeded instance was actually used.</summary>
    public string Status { get; } = "App singleton recovered";

    /// <summary>Sample content the singleton "owns" (mirrors the gallery queue's download list).</summary>
    public IReadOnlyList<string> Items { get; } = new List<string> { "alpha", "beta" };
}
