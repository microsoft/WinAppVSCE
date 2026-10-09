using System.Text;
using System.Text.Json;
using System.Xml.Linq;

namespace SurfaceProvisioner;

/// <summary>
/// Makes the DesignHost merged PRI follow the target project's own packages instead of a fixed list.
/// <para>
/// Third-party control templates (<c>Themes/Generic.xbf</c>) ship only inside each package's <c>.pri</c>.
/// Every package in the target's resolved graph that carries a <c>.pri</c> is added to the staged DesignHost
/// copy at the target's exact resolved version, so its templates land in the merged index. Windows App SDK
/// packages are excluded (the template already references the matched version). When the target graph is
/// unavailable the template keeps its fixed CommunityToolkit baseline.
/// </para>
/// </summary>
internal static class TemplatePackages
{
    public const string FileName = "UserPackages.g.props";

    /// <summary>PRI-bearing target packages, or null when the target graph is unavailable (keep the baseline).</summary>
    public static IReadOnlyList<(string Id, string Version)>? Discover(string project, Action<string> log)
    {
        var dir = File.Exists(project) ? Path.GetDirectoryName(Path.GetFullPath(project))! : project;
        var assets = Path.Combine(dir, "obj", "project.assets.json");
        if (!File.Exists(assets))
        {
            log("Template packages: target project.assets.json not found; using the template baseline.");
            return null;
        }

        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(assets));
            var found = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var lib in doc.RootElement.GetProperty("libraries").EnumerateObject())
            {
                if (!lib.Value.TryGetProperty("type", out var type) || type.GetString() != "package") continue;
                var slash = lib.Name.IndexOf('/');
                if (slash <= 0) continue;
                var id = lib.Name[..slash];
                var version = lib.Name[(slash + 1)..];
                if (id.StartsWith("Microsoft.WindowsAppSDK", StringComparison.OrdinalIgnoreCase)) continue;
                if (!lib.Value.TryGetProperty("files", out var files)) continue;
                if (!files.EnumerateArray().Any(f => f.GetString()?.EndsWith(".pri", StringComparison.OrdinalIgnoreCase) == true)) continue;
                found[id] = version;
            }

            log(found.Count == 0
                ? "Template packages: target has no PRI-bearing packages."
                : "Template packages: " + string.Join(", ", found.Select(p => p.Key + " " + p.Value)));
            return found.Select(p => (p.Key, p.Value)).ToList();
        }
        catch (Exception ex) when (ex is JsonException or KeyNotFoundException or InvalidOperationException)
        {
            log("Template packages: could not read target project.assets.json (" + ex.Message + "); using the template baseline.");
            return null;
        }
    }

    /// <summary>
    /// Writes (or, for <paramref name="packages"/> null, removes) the props the staged DesignHost imports.
    /// An empty list still replaces the baseline: a target without toolkit packages needs no toolkit templates.
    /// </summary>
    public static void Write(string templateDir, IReadOnlyList<(string Id, string Version)>? packages)
    {
        var path = Path.Combine(templateDir, FileName);
        if (packages == null)
        {
            File.Delete(path);
            return;
        }

        var items = new XElement("ItemGroup",
            packages.Select(p => new XElement("PackageReference",
                new XAttribute("Include", p.Id), new XAttribute("Version", p.Version))));
        var doc = new XDocument(new XElement("Project",
            new XElement("PropertyGroup", new XElement("WinUISurfaceUserPackages", "true")),
            items));
        File.WriteAllText(path, doc.ToString(), new UTF8Encoding(false));
    }
}
