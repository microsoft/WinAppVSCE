using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;
using WinUiXaml.Xaml;

namespace WinUiXaml.Workspace
{
    /// <summary>Resolves the project/type/reference context for any .xaml file (#4).</summary>
    public sealed class XamlProjectResolver : IDisposable
    {
        // WinUI apps only define x86/x64/ARM64 (no AnyCPU), so use the native server architecture for design-time evaluation instead of forcing x64 on ARM64 machines.
        private static readonly IReadOnlyDictionary<string, string> DefaultGlobalProperties =
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["Configuration"] = "Debug",
                ["Platform"] = RuntimeInformation.ProcessArchitecture == Architecture.Arm64 ? "ARM64" : "x64",
                // Language-service project evaluation must not perform network-backed vulnerability
                // auditing; restore/CI owns that work, and an unavailable feed otherwise blocks hover.
                ["NuGetAudit"] = "false",
            };

        private readonly object _gate = new object();
        private readonly Dictionary<string, CacheEntry> _projects =
            new Dictionary<string, CacheEntry>(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, Task<MsBuildFrameworkProject?>> _frameworkProjects =
            new Dictionary<string, Task<MsBuildFrameworkProject?>>(StringComparer.OrdinalIgnoreCase);
        private readonly IReadOnlyDictionary<string, string> _globalProperties;
        private bool _disposed;

        public XamlProjectResolver(IReadOnlyDictionary<string, string>? globalProperties = null)
        {
            _globalProperties = globalProperties ?? DefaultGlobalProperties;
        }

        /// <summary>
        /// One cached project load. Tracks the invalidations that arrived while the load was still in
        /// flight (its graph does not exist until it completes, so it cannot be tested with
        /// <c>ContainsProject</c> at invalidate time) and the number of resolves currently using the
        /// workspace, so an evicted workspace is only disposed once no caller is still reading it.
        /// </summary>
        private sealed class CacheEntry
        {
            public CacheEntry(Task<RoslynProjectWorkspace> task) => Task = task;

            public Task<RoslynProjectWorkspace> Task { get; }

            /// <summary>Projects invalidated while this load was pending, re-tested against the graph on completion.</summary>
            public HashSet<string> PendingInvalidations { get; } =
                new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            public bool InvalidatedAllWhilePending { get; set; }

            public bool Evicted { get; set; }

            public bool Disposed { get; set; }

            public int Leases { get; set; }
        }

        /// <summary>Test hook: whether a cached workspace is currently held for the given project root.</summary>
        internal bool IsCached(string projectPath)
        {
            var key = Path.GetFullPath(projectPath);
            lock (_gate)
            {
                return _projects.ContainsKey(key);
            }
        }

        /// <summary>Finds the project that owns xamlPath by walking up the directory tree and returning the nearest ancestor directory that contains a single project file.</summary>
        public static string? FindOwningProject(string xamlPath, string? searchRoot = null)
        {
            if (string.IsNullOrEmpty(xamlPath))
            {
                return null;
            }

            var directory = Directory.Exists(xamlPath)
                ? new DirectoryInfo(xamlPath)
                : new FileInfo(xamlPath).Directory;
            var boundary = string.IsNullOrEmpty(searchRoot)
                ? null
                : new DirectoryInfo(Path.GetFullPath(searchRoot));

            if (directory == null || (boundary != null && !IsWithin(directory.FullName, boundary.FullName)))
            {
                return null;
            }

            for (var dir = directory; dir != null; dir = dir.Parent)
            {
                var candidates = dir.GetFiles("*.csproj");
                if (candidates.Length == 1)
                {
                    return candidates[0].FullName;
                }

                if (candidates.Length > 1)
                {
                    return null;
                }

                if (boundary != null && PathsEqual(dir.FullName, boundary.FullName))
                {
                    break;
                }
            }

            return null;
        }

        /// <summary> Associates <paramref name="xamlPath"/> with its project and resolves its <c>x:Class</c> type and referenced assembly set. Returns null if no owning project is found.</summary>
        public async Task<XamlResolution?> ResolveAsync(
            string xamlPath,
            string? searchRoot = null,
            CancellationToken cancellationToken = default,
            string? xamlText = null)
        {
            if (xamlPath == null)
            {
                throw new ArgumentNullException(nameof(xamlPath));
            }

            var projectPath = FindOwningProject(xamlPath, searchRoot);
            if (projectPath == null)
            {
                return null;
            }

            var normalizedXaml = Path.GetFullPath(xamlPath);
            var className = xamlText is null
                ? TryReadClassName(normalizedXaml)
                : XamlIntrospection.GetClass(xamlText);

            var workspaceResult = await UseWorkspaceAsync(
                projectPath,
                cancellationToken,
                async workspace =>
                {
                    var compilation = await workspace.GetCompilationAsync(cancellationToken).ConfigureAwait(false);
                    if (compilation == null)
                    {
                        return null;
                    }

                    var classSymbol = className != null ? compilation.GetTypeByMetadataName(className) : null;
                    var referencedAssemblies = compilation.SourceModule.ReferencedAssemblySymbols;
                    return new XamlResolution(
                        normalizedXaml,
                        Path.GetFullPath(projectPath),
                        className,
                        classSymbol,
                        compilation,
                        referencedAssemblies,
                        workspace.XamlFiles,
                        workspace.ApplicationDefinitionPath);
                }).ConfigureAwait(false);
            return workspaceResult;
        }

        /// <summary>
        /// Resolves framework metadata from the owning project's exact MSBuild-selected references
        /// without compiling project sources or running source generators.
        /// </summary>
        public async Task<XamlResolution?> ResolveFrameworkAsync(
            string xamlPath,
            string? searchRoot = null,
            CancellationToken cancellationToken = default,
            string? xamlText = null)
        {
            if (xamlPath == null)
            {
                throw new ArgumentNullException(nameof(xamlPath));
            }

            var projectPath = FindOwningProject(xamlPath, searchRoot);
            if (projectPath == null)
            {
                return null;
            }

            var normalizedXaml = Path.GetFullPath(xamlPath);
            var className = xamlText is null
                ? TryReadClassName(normalizedXaml)
                : XamlIntrospection.GetClass(xamlText);
            var frameworkProject = await GetOrLoadFrameworkAsync(projectPath)
                .WaitAsync(cancellationToken)
                .ConfigureAwait(false);
            if (frameworkProject is not null)
            {
                var compilation = frameworkProject.Compilation;
                return new XamlResolution(
                    normalizedXaml,
                    Path.GetFullPath(projectPath),
                    className,
                    classSymbol: null,
                    compilation,
                    compilation.SourceModule.ReferencedAssemblySymbols,
                    frameworkProject.XamlFiles,
                    frameworkProject.ApplicationDefinitionPath);
            }

            // Unsupported custom project systems retain the existing authoritative path.
            return await UseWorkspaceAsync(
                projectPath,
                cancellationToken,
                workspace =>
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    var fallbackCompilation = workspace.GetFrameworkCompilation();
                    return Task.FromResult<XamlResolution?>(new XamlResolution(
                        normalizedXaml,
                        Path.GetFullPath(projectPath),
                        className,
                        classSymbol: null,
                        fallbackCompilation,
                        fallbackCompilation.SourceModule.ReferencedAssemblySymbols,
                        workspace.XamlFiles,
                        workspace.ApplicationDefinitionPath));
                }).ConfigureAwait(false);
        }

        private static bool IsWithin(string path, string root)
        {
            var relative = Path.GetRelativePath(root, path);
            return relative.Length == 0
                || (!Path.IsPathRooted(relative)
                    && !relative.Equals("..", StringComparison.Ordinal)
                    && !relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                    && !relative.StartsWith($"..{Path.AltDirectorySeparatorChar}", StringComparison.Ordinal));
        }

        private static bool PathsEqual(string left, string right) =>
            string.Equals(
                Path.TrimEndingDirectorySeparator(Path.GetFullPath(left)),
                Path.TrimEndingDirectorySeparator(Path.GetFullPath(right)),
                StringComparison.OrdinalIgnoreCase);

        /// <summary>Drops the cached workspace for a project so the next resolve reloads it.</summary>
        public void Invalidate(string projectPath)
        {
            if (string.IsNullOrEmpty(projectPath))
            {
                return;
            }

            var key = Path.GetFullPath(projectPath);
            var evicted = new List<CacheEntry>();
            lock (_gate)
            {
                var affectedRoots = new List<string>();
                foreach (var pair in _projects)
                {
                    if (string.Equals(pair.Key, key, StringComparison.OrdinalIgnoreCase))
                    {
                        affectedRoots.Add(pair.Key);
                        continue;
                    }

                    if (pair.Value.Task.Status == TaskStatus.RanToCompletion)
                    {
                        if (pair.Value.Task.Result.ContainsProject(key))
                        {
                            affectedRoots.Add(pair.Key);
                        }

                        continue;
                    }

                    // The graph does not exist yet, so record the invalidation and re-test it when the
                    // load completes. Evicting every pending entry here would kill unrelated in-flight
                    // loads across other roots.
                    pair.Value.PendingInvalidations.Add(key);
                }

                foreach (var affectedRoot in affectedRoots)
                {
                    evicted.Add(_projects[affectedRoot]);
                    _projects.Remove(affectedRoot);
                    _frameworkProjects.Remove(affectedRoot);
                }

                _frameworkProjects.Remove(key);
                foreach (var entry in evicted)
                {
                    entry.Evicted = true;
                }
            }

            foreach (var entry in evicted)
            {
                ReleaseWhenUnused(entry);
            }
        }

        /// <summary>Drops every cached workspace after a shared imported MSBuild file changes.</summary>
        public void InvalidateAll()
        {
            List<CacheEntry> evicted;
            lock (_gate)
            {
                evicted = _projects.Values.ToList();
                _projects.Clear();
                _frameworkProjects.Clear();
                foreach (var entry in evicted)
                {
                    entry.Evicted = true;
                    entry.InvalidatedAllWhilePending = true;
                }
            }

            foreach (var entry in evicted)
            {
                ReleaseWhenUnused(entry);
            }
        }

        /// <summary>
        /// Runs <paramref name="body"/> against the cached workspace while holding a lease, so an
        /// invalidation that evicts the entry mid-read defers disposal until this caller is done.
        /// </summary>
        private async Task<XamlResolution?> UseWorkspaceAsync(
            string projectPath,
            CancellationToken cancellationToken,
            Func<RoslynProjectWorkspace, Task<XamlResolution?>> body)
        {
            var entry = GetOrLoadEntry(projectPath);
            try
            {
                var workspace = await entry.Task.WaitAsync(cancellationToken).ConfigureAwait(false);
                return await body(workspace).ConfigureAwait(false);
            }
            finally
            {
                ReleaseLease(entry);
            }
        }

        private CacheEntry GetOrLoadEntry(string projectPath)
        {
            var key = Path.GetFullPath(projectPath);
            lock (_gate)
            {
                if (_disposed)
                {
                    throw new ObjectDisposedException(nameof(XamlProjectResolver));
                }

                if (_projects.TryGetValue(key, out var existing))
                {
                    existing.Leases++;
                    return existing;
                }

                // Load with an independent token so one caller's cancellation can't poison the shared cache entry for other callers.
                var task = RoslynProjectWorkspace.LoadProjectAsync(key, _globalProperties.ToDictionary(p => p.Key, p => p.Value), CancellationToken.None);
                var entry = new CacheEntry(task) { Leases = 1 };
                _projects[key] = entry;

                // If the load fails, evict so a later resolve can retry instead of replaying the error.
                // If it succeeds, re-test any invalidation that arrived while it was pending: only now
                // does the project graph exist, so only now can ContainsProject answer.
                _ = task.ContinueWith(
                    t => OnLoadCompleted(key, entry, t),
                    CancellationToken.None,
                    TaskContinuationOptions.ExecuteSynchronously,
                    TaskScheduler.Default);

                return entry;
            }
        }

        private void OnLoadCompleted(string key, CacheEntry entry, Task<RoslynProjectWorkspace> task)
        {
            var evict = false;
            lock (_gate)
            {
                if (task.Status != TaskStatus.RanToCompletion)
                {
                    evict = true;
                }
                else if (entry.InvalidatedAllWhilePending)
                {
                    evict = true;
                }
                else if (entry.PendingInvalidations.Count > 0)
                {
                    var graph = task.Result;
                    evict = entry.PendingInvalidations.Any(pending => graph.ContainsProject(pending));
                }

                if (!evict)
                {
                    entry.PendingInvalidations.Clear();
                    return;
                }

                if (_projects.TryGetValue(key, out var current) && ReferenceEquals(current, entry))
                {
                    _projects.Remove(key);
                    _frameworkProjects.Remove(key);
                }

                entry.Evicted = true;
            }

            ReleaseWhenUnused(entry);
        }

        private void ReleaseLease(CacheEntry entry)
        {
            lock (_gate)
            {
                entry.Leases--;
                if (entry.Leases > 0 || !entry.Evicted || entry.Disposed)
                {
                    return;
                }

                entry.Disposed = true;
            }

            DisposeWhenComplete(entry.Task);
        }

        /// <summary>Disposes an evicted entry once no resolve is still reading it.</summary>
        private void ReleaseWhenUnused(CacheEntry entry)
        {
            lock (_gate)
            {
                if (entry.Leases > 0 || entry.Disposed)
                {
                    return;
                }

                entry.Disposed = true;
            }

            DisposeWhenComplete(entry.Task);
        }

        private Task<MsBuildFrameworkProject?> GetOrLoadFrameworkAsync(string projectPath)
        {
            var key = Path.GetFullPath(projectPath);
            lock (_gate)
            {
                if (_disposed)
                {
                    throw new ObjectDisposedException(nameof(XamlProjectResolver));
                }

                if (_frameworkProjects.TryGetValue(key, out var existing))
                {
                    return existing;
                }

                var task = Task.Run(
                    () => MsBuildFrameworkProject.Load(key, _globalProperties),
                    CancellationToken.None);
                _frameworkProjects[key] = task;
                _ = task.ContinueWith(
                    completed =>
                    {
                        if (completed.Status == TaskStatus.RanToCompletion &&
                            completed.Result is not null)
                        {
                            return;
                        }

                        lock (_gate)
                        {
                            if (_frameworkProjects.TryGetValue(key, out var current) &&
                                ReferenceEquals(current, completed))
                            {
                                _frameworkProjects.Remove(key);
                            }
                        }
                    },
                    CancellationToken.None,
                    TaskContinuationOptions.ExecuteSynchronously,
                    TaskScheduler.Default);
                return task;
            }
        }

        private static string? TryReadClassName(string xamlPath)
        {
            try
            {
                var text = File.ReadAllText(xamlPath);
                return XamlIntrospection.GetClass(text);
            }
            catch (IOException)
            {
                return null;
            }
            catch (UnauthorizedAccessException)
            {
                return null;
            }
        }

        private static void DisposeWhenComplete(Task<RoslynProjectWorkspace>? task)
        {
            if (task == null)
            {
                return;
            }

            if (task.Status == TaskStatus.RanToCompletion)
            {
                task.Result.Dispose();
                return;
            }

            _ = task.ContinueWith(
                t =>
                {
                    if (t.Status == TaskStatus.RanToCompletion)
                    {
                        t.Result.Dispose();
                    }
                },
                CancellationToken.None,
                TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
        }

        public void Dispose()
        {
            List<CacheEntry> entries;
            lock (_gate)
            {
                if (_disposed)
                {
                    return;
                }

                _disposed = true;
                entries = _projects.Values.ToList();
                _projects.Clear();
                _frameworkProjects.Clear();
                foreach (var entry in entries)
                {
                    entry.Evicted = true;
                }
            }

            // Shutdown forces disposal even if a resolve is still in flight; the process is going away.
            foreach (var entry in entries)
            {
                bool alreadyDisposed;
                lock (_gate)
                {
                    alreadyDisposed = entry.Disposed;
                    entry.Disposed = true;
                }

                if (!alreadyDisposed)
                {
                    DisposeWhenComplete(entry.Task);
                }
            }
        }
    }
}
