using System.Collections.Immutable;

namespace WinUiXaml.LanguageServer;

/// <summary>Limits out-of-root invalidation to inputs reached through project graphs the server already loaded.</summary>
internal sealed class ProjectInputTracker
{
    private readonly object _gate = new();
    private readonly Dictionary<string, ProjectInputs> _inputsByRoot =
        new(StringComparer.OrdinalIgnoreCase);

    public void Register(
        string rootProject,
        IEnumerable<string> projectPaths,
        IEnumerable<string> generatorInputFiles)
    {
        var root = Canonicalize(rootProject);
        var projects = projectPaths
            .Select(Canonicalize)
            .ToImmutableHashSet(StringComparer.OrdinalIgnoreCase);
        var generatorInputs = generatorInputFiles
            .Select(Canonicalize)
            .ToImmutableHashSet(StringComparer.OrdinalIgnoreCase);

        lock (_gate)
        {
            _inputsByRoot[root] = new ProjectInputs(projects, generatorInputs);
        }
    }

    public ImmutableHashSet<string> GetProjectsToInvalidate(
        string path,
        bool includeProjectDirectories)
    {
        var canonicalPath = Canonicalize(path);
        var projects = ImmutableHashSet.CreateBuilder<string>(StringComparer.OrdinalIgnoreCase);

        lock (_gate)
        {
            foreach (var pair in _inputsByRoot)
            {
                if (pair.Value.GeneratorInputFiles.Contains(canonicalPath))
                {
                    projects.Add(pair.Key);
                }

                if (!includeProjectDirectories)
                {
                    continue;
                }

                foreach (var projectPath in pair.Value.ProjectPaths)
                {
                    var directory = Path.GetDirectoryName(projectPath);
                    if (directory != null &&
                        IsWithin(canonicalPath, directory) &&
                        !IsGeneratedBuildPath(canonicalPath, directory))
                    {
                        projects.Add(projectPath);
                    }
                }
            }
        }

        return projects.ToImmutable();
    }

    private static string Canonicalize(string path) =>
        Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));

    private static bool IsWithin(string path, string directory)
    {
        var relative = Path.GetRelativePath(directory, path);
        return relative.Length == 0 ||
            (!Path.IsPathRooted(relative) &&
             !relative.Equals("..", StringComparison.Ordinal) &&
             !relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal) &&
             !relative.StartsWith($"..{Path.AltDirectorySeparatorChar}", StringComparison.Ordinal));
    }

    private static bool IsGeneratedBuildPath(string path, string directory)
    {
        var relative = Path.GetRelativePath(directory, path);
        return relative.Split(
                new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar },
                StringSplitOptions.RemoveEmptyEntries)
            .Any(segment =>
                segment.Equals("bin", StringComparison.OrdinalIgnoreCase) ||
                segment.Equals("obj", StringComparison.OrdinalIgnoreCase));
    }

    private sealed record ProjectInputs(
        ImmutableHashSet<string> ProjectPaths,
        ImmutableHashSet<string> GeneratorInputFiles);
}
