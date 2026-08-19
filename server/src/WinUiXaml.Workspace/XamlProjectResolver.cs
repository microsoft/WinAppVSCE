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
        private readonly Dictionary<string, Task<RoslynProjectWorkspace>> _projects =
            new Dictionary<string, Task<RoslynProjectWorkspace>>(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, Task<MsBuildFrameworkProject?>> _frameworkProjects =
            new Dictionary<string, Task<MsBuildFrameworkProject?>>(StringComparer.OrdinalIgnoreCase);
        private readonly IReadOnlyDictionary<string, string> _globalProperties;
        private bool _disposed;

        public XamlProjectResolver(IReadOnlyDictionary<string, string>? globalProperties = null)
        {
            _globalProperties = globalProperties ?? DefaultGlobalProperties;
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

            var workspace = await GetOrLoadAsync(projectPath, cancellationToken)
                .WaitAsync(cancellationToken)
                .ConfigureAwait(false);

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
            var workspace = await GetOrLoadAsync(projectPath, cancellationToken)
                .WaitAsync(cancellationToken)
                .ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            var fallbackCompilation = workspace.GetFrameworkCompilation();
            return new XamlResolution(
                normalizedXaml,
                Path.GetFullPath(projectPath),
                className,
                classSymbol: null,
                fallbackCompilation,
                fallbackCompilation.SourceModule.ReferencedAssemblySymbols,
                workspace.XamlFiles,
                workspace.ApplicationDefinitionPath);
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
            Task<RoslynProjectWorkspace>? removed = null;
            lock (_gate)
            {
                if (_projects.TryGetValue(key, out var task))
                {
                    _projects.Remove(key);
                    removed = task;
                }
                _frameworkProjects.Remove(key);
            }

            DisposeWhenComplete(removed);
        }

        /// <summary>Drops every cached workspace after a shared imported MSBuild file changes.</summary>
        public void InvalidateAll()
        {
            List<Task<RoslynProjectWorkspace>> removed;
            lock (_gate)
            {
                removed = _projects.Values.ToList();
                _projects.Clear();
                _frameworkProjects.Clear();
            }

            foreach (var task in removed)
            {
                DisposeWhenComplete(task);
            }
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

                // Load with an independent token so one caller's cancellation can't poison the shared cache entry for other callers.
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
                _frameworkProjects.Clear();
            }

            foreach (var task in tasks)
            {
                DisposeWhenComplete(task);
            }
        }
    }
}
