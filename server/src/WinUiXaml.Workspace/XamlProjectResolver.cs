using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;
using WinUiXaml.Xaml;

namespace WinUiXaml.Workspace
{
    /// <summary>
    /// Resolves the project/type/reference context for any <c>.xaml</c> file (#4). It finds the
    /// owning project, loads it through the Host B <see cref="RoslynProjectWorkspace"/> (caching one
    /// workspace per project), reads the file's <c>x:Class</c>, and resolves that type plus the
    /// project's referenced assemblies.
    /// <para>
    /// Loaded projects are cached; call <see cref="Invalidate"/> (e.g. when a reference or the
    /// project file changes) to force the next resolve to reload.
    /// </para>
    /// </summary>
    public sealed class XamlProjectResolver : IDisposable
    {
        // WinUI apps only define x86/x64/ARM64 (no AnyCPU), so a design-time build needs an explicit
        // platform. Debug|x64 matches the fixture's known-good configuration.
        private static readonly IReadOnlyDictionary<string, string> DefaultGlobalProperties =
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["Configuration"] = "Debug",
                ["Platform"] = "x64",
            };

        private readonly object _gate = new object();
        private readonly Dictionary<string, Task<RoslynProjectWorkspace>> _projects =
            new Dictionary<string, Task<RoslynProjectWorkspace>>(StringComparer.OrdinalIgnoreCase);
        private readonly IReadOnlyDictionary<string, string> _globalProperties;
        private bool _disposed;

        public XamlProjectResolver(IReadOnlyDictionary<string, string>? globalProperties = null)
        {
            _globalProperties = globalProperties ?? DefaultGlobalProperties;
        }

        /// <summary>
        /// Finds the project that owns <paramref name="xamlPath"/> by walking up the directory tree
        /// and returning the nearest ancestor directory that contains a single project file. Returns
        /// null if no project is found.
        /// </summary>
        public static string? FindOwningProject(string xamlPath)
        {
            if (string.IsNullOrEmpty(xamlPath))
            {
                return null;
            }

            var directory = Directory.Exists(xamlPath)
                ? new DirectoryInfo(xamlPath)
                : new FileInfo(xamlPath).Directory;

            for (var dir = directory; dir != null; dir = dir.Parent)
            {
                var candidates = dir.GetFiles("*.csproj");
                if (candidates.Length == 1)
                {
                    return candidates[0].FullName;
                }

                if (candidates.Length > 1)
                {
                    // Ambiguous: pick deterministically. A future refinement can read each project's
                    // item groups to find which one actually includes this .xaml.
                    return candidates
                        .OrderBy(f => f.Name, StringComparer.OrdinalIgnoreCase)
                        .First()
                        .FullName;
                }
            }

            return null;
        }

        /// <summary>
        /// Associates <paramref name="xamlPath"/> with its project and resolves its <c>x:Class</c>
        /// type and referenced assembly set. Returns null if no owning project is found.
        /// </summary>
        public async Task<XamlResolution?> ResolveAsync(string xamlPath, CancellationToken cancellationToken = default)
        {
            if (xamlPath == null)
            {
                throw new ArgumentNullException(nameof(xamlPath));
            }

            var projectPath = FindOwningProject(xamlPath);
            if (projectPath == null)
            {
                return null;
            }

            var normalizedXaml = Path.GetFullPath(xamlPath);
            var className = TryReadClassName(normalizedXaml);

            var workspace = await GetOrLoadAsync(projectPath, cancellationToken).ConfigureAwait(false);

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
                referencedAssemblies);
        }

        /// <summary>Drops the cached workspace for a project so the next resolve reloads it.</summary>
        public void Invalidate(string projectPath)
        {
            if (string.IsNullOrEmpty(projectPath))
            {
                return;
            }

            var key = Path.GetFullPath(projectPath);
            Task<RoslynProjectWorkspace>? removed = null;
            lock (_gate)
            {
                if (_projects.TryGetValue(key, out var task))
                {
                    _projects.Remove(key);
                    removed = task;
                }
            }

            DisposeWhenComplete(removed);
        }

        private Task<RoslynProjectWorkspace> GetOrLoadAsync(string projectPath, CancellationToken cancellationToken)
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
                    return existing;
                }

                // Load with an independent token so one caller's cancellation can't poison the shared
                // cache entry for other callers.
                var task = RoslynProjectWorkspace.LoadProjectAsync(key, _globalProperties.ToDictionary(p => p.Key, p => p.Value), CancellationToken.None);
                _projects[key] = task;

                // If the load fails, evict so a later resolve can retry instead of replaying the error.
                _ = task.ContinueWith(
                    t =>
                    {
                        lock (_gate)
                        {
                            if (_projects.TryGetValue(key, out var current) && ReferenceEquals(current, t))
                            {
                                _projects.Remove(key);
                            }
                        }
                    },
                    CancellationToken.None,
                    TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously,
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
            List<Task<RoslynProjectWorkspace>> tasks;
            lock (_gate)
            {
                if (_disposed)
                {
                    return;
                }

                _disposed = true;
                tasks = _projects.Values.ToList();
                _projects.Clear();
            }

            foreach (var task in tasks)
            {
                DisposeWhenComplete(task);
            }
        }
    }
}
