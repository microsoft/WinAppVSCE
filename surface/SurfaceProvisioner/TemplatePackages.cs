using System.Text;
using System.Xml.Linq;

using WinUISurface.Shared;

namespace SurfaceProvisioner;

/// <summary>
/// Makes the PreviewHost merged PRI follow the target project's own packages instead of a fixed list.
/// <para>
/// Third-party control templates (<c>Themes/Generic.xbf</c>) ship only inside each package's <c>.pri</c>.
/// Every package in the target's resolved graph that carries a <c>.pri</c> is added to the staged PreviewHost
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
        var assets = ProjectFiles.FindAssetsFile(dir, ProjectFiles.ResolveCsproj(project));
        if (assets == null)
        {
            log("Template packages: target project.assets.json not found; using the template baseline.");
            return null;
        }

        var found = ProjectFiles.ReadPriPackages(assets);
        if (found == null)
        {
            log("Template packages: could not read target project.assets.json; using the template baseline.");
            return null;
        }

        log(found.Count == 0
            ? "Template packages: target has no PRI-bearing packages."
            : "Template packages: " + string.Join(", ", found.Select(p => p.Key + " " + p.Value)));
        return found.Select(p => (p.Key, p.Value)).ToList();
    }

    /// <summary>
    /// Writes (or, for <paramref name="packages"/> null, removes) the props the staged PreviewHost imports.
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
