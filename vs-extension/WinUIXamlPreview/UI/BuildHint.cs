#nullable enable

using System.Collections.Generic;
using System.Linq;

namespace WinUIXamlPreview.UI
{
    /// <summary>
    /// Decides whether to tell the user that building their project would improve the preview. Without a build
    /// the surface has no user assembly (custom controls can't be created) and no App.xaml resource scope (app
    /// styles/brushes are missing), so the cleaner placeholders or drops those parts. When the surface reports
    /// such losses for a project with no build output, the preview is knowingly incomplete.
    /// </summary>
    internal static class BuildHint
    {
        public const string Title = "Project not built";
        private const int MaxNamedTypes = 3;

        /// <summary>
        /// The banner message, or null when no hint applies: the project has a build (or there is no project),
        /// or the render lost nothing a build would restore.
        /// </summary>
        public static string? Describe(bool unbuiltProject, IReadOnlyCollection<string>? missingKeys, IReadOnlyCollection<string>? unmappedTypes, IReadOnlyCollection<string>? placeholderTypes = null)
        {
            if (!unbuiltProject)
            {
                return null;
            }

            int keys = missingKeys?.Count ?? 0;
            var types = (unmappedTypes ?? new string[0]).Concat(placeholderTypes ?? new string[0])
                .Select(SimpleName)
                .Where(n => n.Length > 0)
                .Distinct()
                .ToList();
            if (keys == 0 && types.Count == 0)
            {
                return null;
            }

            var parts = new List<string>();
            if (types.Count > 0)
            {
                var named = string.Join(", ", types.Take(MaxNamedTypes));
                if (types.Count > MaxNamedTypes)
                {
                    named += $", +{types.Count - MaxNamedTypes} more";
                }
                parts.Add($"{Plural(types.Count, "custom control")} shown as placeholders ({named})");
            }
            if (keys > 0)
            {
                parts.Add($"{Plural(keys, "app style or resource", "app styles or resources")} not found");
            }

            return "Parts of this page can't be previewed yet: " + string.Join("; ", parts) +
                   ". Build the project for a complete preview — it refreshes automatically when the build finishes.";
        }

        public const string BuiltTitle = "Some parts couldn't be previewed";
        private const int MaxNamedKeys = 3;

        /// <summary>
        /// For a built project (or a loose file): names the controls shown as placeholders and the resources that
        /// weren't found, so a fallback isn't mistaken for the real rendering. Null when nothing was lost.
        /// </summary>
        public static string? DescribeBuilt(IReadOnlyCollection<string>? missingKeys, IReadOnlyCollection<string>? unmappedTypes, IReadOnlyCollection<string>? placeholderTypes = null)
        {
            var types = (unmappedTypes ?? new string[0]).Concat(placeholderTypes ?? new string[0])
                .Select(SimpleName)
                .Where(n => n.Length > 0)
                .Distinct()
                .ToList();
            var keys = (missingKeys ?? new string[0])
                .Select(k => (k ?? string.Empty).Trim())
                .Where(k => k.Length > 0)
                .Distinct()
                .ToList();
            if (keys.Count == 0 && types.Count == 0)
            {
                return null;
            }

            var parts = new List<string>();
            if (types.Count > 0)
            {
                parts.Add($"{Plural(types.Count, "control")} shown as placeholders ({Named(types, MaxNamedTypes)})");
            }
            if (keys.Count > 0)
            {
                parts.Add($"{Plural(keys.Count, "resource")} not found ({Named(keys, MaxNamedKeys)}), so defaults are used");
            }

            return string.Join("; ", parts) + ".";
        }

        private static string Named(List<string> names, int max)
        {
            var named = string.Join(", ", names.Take(max));
            return names.Count > max ? named + $", +{names.Count - max} more" : named;
        }

        private static string SimpleName(string fullName)
        {
            var name = (fullName ?? string.Empty).Trim();
            int dot = name.LastIndexOf('.');
            return dot >= 0 ? name.Substring(dot + 1) : name;
        }

        private static string Plural(int n, string one, string? many = null) =>
            n == 1 ? $"1 {one}" : $"{n} {many ?? one + "s"}";
    }
}
