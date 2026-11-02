using System.Collections.Concurrent;

namespace WinUiXaml.LanguageServer;

/// <summary>Tracks project prompts once per active condition; Clear re-arms a project after recovery so later cleans or branch switches report again.</summary>
internal sealed class ProjectPromptLatch
{
    private readonly ConcurrentDictionary<string, byte> _notified =
        new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Returns true exactly once per project until <see cref="Clear"/> is called.</summary>
    public bool ShouldNotify(string projectPath) => _notified.TryAdd(projectPath, 0);

    /// <summary>Re-arms the prompt for a project whose condition is no longer true.</summary>
    public void Clear(string projectPath) => _notified.TryRemove(projectPath, out _);
}
