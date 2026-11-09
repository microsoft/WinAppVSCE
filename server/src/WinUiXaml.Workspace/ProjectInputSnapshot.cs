using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace WinUiXaml.Workspace;

internal sealed class ProjectInputSnapshot
{
    private readonly string[] _projects;
    private readonly string[] _inputs;
    private readonly bool _trackXamlContent;
    private readonly Dictionary<string, (long Length, long WriteTime)> _stamps;

    internal ProjectInputSnapshot(IEnumerable<string> projects, IEnumerable<string> inputs, bool trackXamlContent = false)
    {
        _projects = projects.ToArray();
        _inputs = inputs.ToArray();
        _trackXamlContent = trackXamlContent;
        _stamps = ReadStamps();
    }

    internal bool HasChanges()
    {
        var current = ReadStamps();
        var changed = _stamps.Keys.Concat(current.Keys).FirstOrDefault(path =>
            !_stamps.TryGetValue(path, out var previous) ||
            !current.TryGetValue(path, out var stamp) || stamp != previous);
        if (changed is not null)
        {
            Console.Error.WriteLine($"[winui-xaml-ls] project input changed: {changed}");
        }
        return changed is not null;
    }

    private Dictionary<string, (long Length, long WriteTime)> ReadStamps()
    {
        var paths = new HashSet<string>(_inputs, StringComparer.OrdinalIgnoreCase);
        foreach (var project in _projects)
        {
            var directory = Path.GetDirectoryName(project)!;
            CollectFiles(directory, paths);
            for (var ancestor = new DirectoryInfo(directory); ancestor is not null; ancestor = ancestor.Parent)
            {
                paths.Add(Path.Combine(ancestor.FullName, "Directory.Build.props"));
                paths.Add(Path.Combine(ancestor.FullName, "Directory.Build.targets"));
                paths.Add(Path.Combine(ancestor.FullName, "Directory.Packages.props"));
                paths.Add(Path.Combine(ancestor.FullName, "global.json"));
            }
        }

        var result = new Dictionary<string, (long Length, long WriteTime)>(StringComparer.OrdinalIgnoreCase);
        foreach (var path in paths)
        {
            try
            {
                var file = new FileInfo(path);
                result[path] = !file.Exists ? (-1, -1) :
                    !_trackXamlContent && path.EndsWith(".xaml", StringComparison.OrdinalIgnoreCase) ? (0, 0) :
                    (file.Length, file.LastWriteTimeUtc.Ticks);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                Console.Error.WriteLine($"[winui-xaml-ls] could not read project input '{path}': {ex.Message}");
                result[path] = (-1, -1);
            }
        }
        return result;
    }

    private static void CollectFiles(string directory, HashSet<string> paths)
    {
        string[] files;
        string[] children;
        try
        {
            files = Directory.GetFiles(directory);
            children = Directory.GetDirectories(directory);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Console.Error.WriteLine($"[winui-xaml-ls] could not scan project input directory '{directory}': {ex.Message}");
            return;
        }

        foreach (var file in files)
        {
            if (Path.GetExtension(file).ToLowerInvariant() is
                ".cs" or ".csproj" or ".props" or ".targets" or ".xaml" ||
                Path.GetFileName(file).Equals(".editorconfig", StringComparison.OrdinalIgnoreCase))
            {
                paths.Add(file);
            }
        }
        foreach (var child in children)
        {
            if (Path.GetFileName(child).ToLowerInvariant() is "obj" or "bin" or ".git" or ".vs" or "node_modules")
            {
                continue;
            }

            try
            {
                if ((File.GetAttributes(child) & FileAttributes.ReparsePoint) != 0)
                {
                    continue;
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                Console.Error.WriteLine($"[winui-xaml-ls] could not inspect project input directory '{child}': {ex.Message}");
                continue;
            }

            CollectFiles(child, paths);
        }
    }
}
