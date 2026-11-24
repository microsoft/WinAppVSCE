#nullable enable

using System.Collections.Generic;
using System.Linq;

namespace WinUIXamlPreview.UI
{
    /// <summary>
    /// Explains why WinUI controls are missing when the page uses types newer than the bundled preview host's
    /// WinAppSDK (the surface leaves them out so the rest of the page still renders), and points at the way to
    /// get them back: Full fidelity, which previews with the project's own WinAppSDK version.
    /// </summary>
    internal static class NewerTypesHint
    {
        public const string Title = "Newer WinUI controls left out";
        public const string TurnOnAction = "Turn on Full fidelity";
        private const int MaxNamedTypes = 3;

        /// <summary>
        /// The banner message, or null when nothing was left out.
        /// </summary>
        /// <param name="newerTypes">WinUI type names the bundled host couldn't create.</param>
        /// <param name="bundledVersion">The bundled host's WinAppSDK version, if known.</param>
        /// <param name="targetVersion">The project's WinAppSDK version, if known.</param>
        /// <param name="fullFidelityOn">Whether Full fidelity (matched-host auto-build) is on.</param>
        /// <param name="buildFailed">Whether building a matched host for <paramref name="targetVersion"/> already failed.</param>
        public static string? Describe(
            IReadOnlyCollection<string>? newerTypes,
            string? bundledVersion,
            string? targetVersion,
            bool fullFidelityOn,
            bool buildFailed)
        {
            var types = (newerTypes ?? new string[0])
                .Select(t => (t ?? string.Empty).Trim())
                .Where(t => t.Length > 0)
                .Distinct()
                .ToList();
            if (types.Count == 0)
            {
                return null;
            }

            var named = string.Join(", ", types.Take(MaxNamedTypes));
            if (types.Count > MaxNamedTypes)
            {
                named += $", +{types.Count - MaxNamedTypes} more";
            }

            var host = string.IsNullOrEmpty(bundledVersion) ? "the preview's bundled WinAppSDK" : $"the preview's bundled WinAppSDK {bundledVersion}";
            var text = $"{named} {(types.Count == 1 ? "isn't" : "aren't")} in {host}, so {(types.Count == 1 ? "it's" : "they're")} left out.";
            var target = string.IsNullOrEmpty(targetVersion) ? "your project's WinAppSDK" : $"WinAppSDK {targetVersion}";

            if (buildFailed)
            {
                return text + $" A {target} preview host couldn't be built; details are in preview.log.";
            }

            return fullFidelityOn
                ? text
                : text + $" Turn on Full fidelity to preview with {target}.";
        }
    }
}
