using System.Collections.Concurrent;

namespace WinUiXaml.LanguageServer;

/// <summary>
/// Tracks which projects have already been prompted about so a per-request failure does not become
/// a per-request notification. A prompt is a one-shot, but only while the condition holds: callers
/// <see cref="Clear"/> a project once it loads, so a condition that returns later in the same
/// session (a clean, a branch switch, a deleted bin) is reported again rather than going silent.
/// </summary>
internal sealed class ProjectPromptLatch
{
    private readonly ConcurrentDictionary<string, byte> _notified =
        new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Returns true exactly once per project until <see cref="Clear"/> is called.</summary>
    public bool ShouldNotify(string projectPath) => _notified.TryAdd(projectPath, 0);

    /// <summary>Re-arms the prompt for a project whose condition is no longer true.</summary>
    public void Clear(string projectPath) => _notified.TryRemove(projectPath, out _);
}
