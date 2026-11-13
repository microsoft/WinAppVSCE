#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using WinUISurface.Shared;

namespace WinUIXamlPreview.Protocol;

/// <summary>
/// Notices when the previewed project is rebuilt or restored, so the preview can relaunch with the new user DLL
/// and re-run WinAppSDK discovery (a version change lands in <c>project.assets.json</c>). Watches the project's
/// assets file(s) and its output DLL; a burst of build writes is reported once, after <c>quiet</c> passes with no
/// further changes. The callback runs on a thread-pool thread.
/// </summary>
internal sealed class ProjectOutputWatcher : IDisposable
{
    private readonly List<FileSystemWatcher> _watchers = new();
    private readonly List<(string Dir, string Filter, bool Recursive)> _specs = new();
    private bool _rearm;
    private readonly string[] _assetsCandidates;
    private readonly string? _userDll;
    private readonly TimeSpan _quiet;
    private readonly Action<bool> _onSettled;
    private readonly Action<string> _log;
    private readonly object _gate = new();
    private readonly Timer _timer;
    private string _assetsBaseline;
    private string _dllBaseline;
    private bool _disposed;

    private ProjectOutputWatcher(string csproj, string? userDll, TimeSpan quiet, Action<bool> onSettled, Action<string> log)
    {
        var projectDir = Path.GetDirectoryName(csproj)!;
        _assetsCandidates = new[]
        {
            Path.Combine(projectDir, "obj", ProjectFiles.AssetsFileName),
            Path.Combine(projectDir, "obj", Path.GetFileNameWithoutExtension(csproj), ProjectFiles.AssetsFileName),
        };
        _userDll = userDll;
        _quiet = quiet;
        _onSettled = onSettled;
        _log = log;
        _timer = new Timer(_ => Fire(), null, Timeout.Infinite, Timeout.Infinite);
        _assetsBaseline = Fingerprint(_assetsCandidates);
        _dllBaseline = DllFingerprint();

        Watch(Path.Combine(projectDir, "obj"), ProjectFiles.AssetsFileName, recursive: true);
        if (!string.IsNullOrEmpty(userDll))
        {
            Watch(Path.GetDirectoryName(userDll)!, Path.GetFileName(userDll), recursive: false);
        }
        else
        {
            // Not built yet: the default assembly name is the project file name.
            Watch(Path.Combine(projectDir, "bin"), Path.GetFileNameWithoutExtension(csproj) + ".dll", recursive: true);
        }
    }

    /// <summary>Null when there's no owning project or nothing can be watched.</summary>
    public static ProjectOutputWatcher? Create(string? csproj, string? userDll, TimeSpan quiet, Action<bool> onSettled, Action<string> log)
    {
        if (string.IsNullOrEmpty(csproj)) return null;
        try
        {
            var w = new ProjectOutputWatcher(csproj!, userDll, quiet, onSettled, log);
            if (w._watchers.Count > 0) return w;
            w.Dispose();
        }
        catch (Exception ex) { log("Project output watcher unavailable: " + ex.Message); }
        return null;
    }

    /// <summary>True when the assets file or the user DLL differs from when the watcher started (or last settled).</summary>
    public bool HasChanged
    {
        get
        {
            lock (_gate) return Fingerprint(_assetsCandidates) != _assetsBaseline || DllFingerprint() != _dllBaseline;
        }
    }

    private void Watch(string dir, string filter, bool recursive)
    {
        _specs.Add((dir, filter, recursive));
        StartWatcher(dir, filter, recursive);
    }

    private void StartWatcher(string dir, string filter, bool recursive)
    {
        // Watch the nearest existing ancestor so a first build that creates obj\ or bin\ is still seen.
        var root = dir;
        while (!Directory.Exists(root))
        {
            var parent = Path.GetDirectoryName(root);
            if (string.IsNullOrEmpty(parent) || parent == root) return;
            root = parent!;
            recursive = true;
        }

        var w = new FileSystemWatcher(root, filter)
        {
            IncludeSubdirectories = recursive,
            NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.CreationTime,
        };
        w.Changed += (_, _) => Poke();
        w.Created += (_, _) => Poke();
        w.Renamed += (_, _) => Poke();
        // The watched folder was deleted (e.g. a clean): re-arm on the nearest folder that still exists.
        w.Error += (_, _) => { lock (_gate) _rearm = true; Poke(); };
        w.EnableRaisingEvents = true;
        _watchers.Add(w);
    }

    private void Poke()
    {
        lock (_gate)
        {
            if (_disposed) return;
            _timer.Change(_quiet, Timeout.InfiniteTimeSpan);
        }
    }

    private void Fire()
    {
        bool assetsChanged;
        lock (_gate)
        {
            if (_disposed) return;
            if (_rearm)
            {
                _rearm = false;
                foreach (var old in _watchers)
                {
                    try { old.EnableRaisingEvents = false; old.Dispose(); } catch { }
                }
                _watchers.Clear();
                foreach (var s in _specs)
                {
                    try { StartWatcher(s.Dir, s.Filter, s.Recursive); }
                    catch (Exception ex) { _log("Project output watcher re-arm failed: " + ex.Message); }
                }
            }

            var assets = Fingerprint(_assetsCandidates);
            var dll = DllFingerprint();
            assetsChanged = assets != _assetsBaseline;
            if (!assetsChanged && dll == _dllBaseline) return; // touched, not changed
            _assetsBaseline = assets;
            _dllBaseline = dll;
        }

        try { _onSettled(assetsChanged); }
        catch (Exception ex) { _log("Project output change handler failed: " + ex.Message); }
    }

    private string DllFingerprint() => string.IsNullOrEmpty(_userDll) ? "" : Fingerprint(new[] { _userDll! });

    internal static string Fingerprint(IEnumerable<string> files) => string.Join("|", files.Select(f =>
    {
        try
        {
            var fi = new FileInfo(f);
            return fi.Exists ? fi.Length + ":" + fi.LastWriteTimeUtc.Ticks : "-";
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException) { return "?"; }
    }));

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;
        }

        foreach (var w in _watchers)
        {
            try { w.EnableRaisingEvents = false; w.Dispose(); } catch { }
        }
        _timer.Dispose();
    }
}
