#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace WinUISurface.Shared;

/// <summary>
/// Toolchain-free reads of a target project's MSBuild layout, shared by the VSIX (net472) and the
/// provisioner so both agree on where the restore graph lives and what a <c>$(Property)</c> version means.
/// Never throws; every failure is "not found".
/// </summary>
internal static class ProjectFiles
{
    private const string AssetsFileName = "project.assets.json";
    private static readonly Regex PropertyRef = new Regex(@"\$\(([A-Za-z_][A-Za-z0-9_.-]*)\)");
    private static readonly Regex ConcreteVersion = new Regex(@"^\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$");

    /// <summary>A plain NuGet version (no MSBuild expression, range or wildcard).</summary>
    public static bool IsConcreteVersion(string? version) => version != null && ConcreteVersion.IsMatch(version);

    /// <summary>The csproj for a project path that is either the .csproj itself or its directory.</summary>
    public static string? ResolveCsproj(string projectPath)
    {
        try
        {
            if (File.Exists(projectPath)) return Path.GetFullPath(projectPath);
            return Directory.Exists(projectPath)
                ? Directory.EnumerateFiles(projectPath, "*.csproj", SearchOption.TopDirectoryOnly).FirstOrDefault()
                : null;
        }
        catch { return null; }
    }

    /// <summary>
    /// The restored <c>project.assets.json</c>, or null. Restore writes it under BaseIntermediateOutputPath,
    /// which is <c>obj\</c> by default and <c>obj\&lt;ProjectName&gt;\</c> in repos that keep several projects in
    /// one folder (e.g. WinUI Gallery).
    /// </summary>
    public static string? FindAssetsFile(string projectDir, string? csproj)
    {
        var candidates = new List<string> { Path.Combine(projectDir, "obj", AssetsFileName) };
        if (!string.IsNullOrEmpty(csproj))
        {
            candidates.Add(Path.Combine(projectDir, "obj", Path.GetFileNameWithoutExtension(csproj), AssetsFileName));
        }

        return candidates.FirstOrDefault(File.Exists);
    }

    /// <summary>
    /// Packages in a restore graph that carry a <c>.pri</c> (where third-party control templates live), keyed
    /// by id with their resolved version, excluding Windows App SDK packages. Null when the file is unreadable.
    /// </summary>
    public static SortedDictionary<string, string>? ReadPriPackages(string assetsPath)
    {
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(assetsPath));
            var found = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var lib in doc.RootElement.GetProperty("libraries").EnumerateObject())
            {
                if (!lib.Value.TryGetProperty("type", out var type) || type.GetString() != "package") continue;
                var slash = lib.Name.IndexOf('/');
                if (slash <= 0) continue;
                var id = lib.Name.Substring(0, slash);
                if (id.StartsWith("Microsoft.WindowsAppSDK", StringComparison.OrdinalIgnoreCase)) continue;
                if (!lib.Value.TryGetProperty("files", out var files) || files.ValueKind != JsonValueKind.Array) continue;
                if (!files.EnumerateArray().Any(f => f.GetString()?.EndsWith(".pri", StringComparison.OrdinalIgnoreCase) == true)) continue;
                found[id] = lib.Name.Substring(slash + 1);
            }
            return found;
            }
            catch { return null; }
    }

    /// <summary>
    /// Expand <c>$(Name)</c> references in <paramref name="value"/> using properties statically defined in the
    /// Directory.Build.props chain (and its plain imports), Directory.Packages.props, then the csproj — the
    /// same order MSBuild evaluates them. Returns null if any reference stays unresolved (property functions,
    /// properties set only by targets or the command line).
    /// </summary>
    public static string? ExpandProperties(string value, string? csproj)
    {
        if (value.IndexOf("$(", StringComparison.Ordinal) < 0) return value;
        if (string.IsNullOrEmpty(csproj) || !File.Exists(csproj)) return null;

        try
        {
            var projectDir = Path.GetDirectoryName(Path.GetFullPath(csproj))!;
            var props = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["MSBuildProjectName"] = Path.GetFileNameWithoutExtension(csproj),
                ["MSBuildProjectDirectory"] = projectDir,
            };
            var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            var dbp = FindUpwards(projectDir, "Directory.Build.props");
            if (dbp != null) Collect(dbp, props, visited, 0);
            var dpp = FindUpwards(projectDir, "Directory.Packages.props");
            if (dpp != null) Collect(dpp, props, visited, 0);
            Collect(csproj!, props, visited, 0);

            var result = value;
            for (int pass = 0; pass < 8 && result.IndexOf("$(", StringComparison.Ordinal) >= 0; pass++)
            {
                var next = PropertyRef.Replace(result, m => props.TryGetValue(m.Groups[1].Value, out var v) ? v : m.Value);
                if (next == result) break;
                result = next;
            }

            result = result.Trim();
            return result.IndexOf("$(", StringComparison.Ordinal) >= 0 || result.Length == 0 ? null : result;
        }
        catch
        {
            return null;
        }
    }

    // Conditions are not evaluated: imports are followed regardless, and a conditional property never overrides
    // an earlier value (the common '$(X)' == '' default pattern).
    private static void Collect(string file, Dictionary<string, string> props, HashSet<string> visited, int depth)
    {
        if (depth > 16 || !visited.Add(Path.GetFullPath(file))) return;

        XDocument xml;
        try { xml = XDocument.Load(file); }
        catch { return; }
        if (xml.Root == null) return;

        var thisDir = Path.GetDirectoryName(Path.GetFullPath(file))!;
        foreach (var el in xml.Root.Elements())
        {
            if (el.Name.LocalName == "Import")
            {
                var imported = ResolveImport((string?)el.Attribute("Project"), thisDir, props);
                if (imported != null) Collect(imported, props, visited, depth + 1);
            }
            else if (el.Name.LocalName == "PropertyGroup")
            {
                bool groupConditional = el.Attribute("Condition") != null;
                foreach (var p in el.Elements())
                {
                    if (p.HasElements) continue;
                    var name = p.Name.LocalName;
                    bool conditional = groupConditional || p.Attribute("Condition") != null;
                    if (conditional && props.ContainsKey(name)) continue;
                    props[name] = p.Value;
                }
            }
        }
    }

    private static readonly Regex FileAbove = new Regex(@"GetPathOfFileAbove\(\s*'([^']+)'");

    private static string? ResolveImport(string? project, string thisDir, Dictionary<string, string> props)
    {
        if (string.IsNullOrWhiteSpace(project)) return null;
        try
        {
            // The standard "import the parent Directory.Build.props" idiom.
            var above = FileAbove.Match(project);
            if (above.Success)
            {
                var parent = Directory.GetParent(thisDir)?.FullName;
                return parent == null ? null : FindUpwards(parent, above.Groups[1].Value);
            }

            var path = project!
                .Replace("$(MSBuildThisFileDirectory)", thisDir + Path.DirectorySeparatorChar)
                .Replace("$(MSBuildProjectDirectory)", props["MSBuildProjectDirectory"]);
            if (path.IndexOf('$') >= 0 || path.IndexOf('*') >= 0) return null;
            var full = Path.IsPathRooted(path) ? path : Path.Combine(thisDir, path);
            return File.Exists(full) ? Path.GetFullPath(full) : null;
        }
        catch
        {
            return null;
        }
    }

    public static string? FindUpwards(string startDir, string fileName)
    {
        try
        {
            var dir = new DirectoryInfo(startDir);
            for (int i = 0; dir != null && i < 30; i++)
            {
                var p = Path.Combine(dir.FullName, fileName);
                if (File.Exists(p)) return p;
                dir = dir.Parent;
            }
        }
        catch
        {
        }

        return null;
    }
}
