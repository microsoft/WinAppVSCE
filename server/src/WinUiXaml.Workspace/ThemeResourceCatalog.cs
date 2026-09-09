using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Xml;
using Microsoft.CodeAnalysis;

namespace WinUiXaml.Workspace
{
    /// <summary>
    /// Reads the WinUI SDK's shipped <c>generic.xaml</c> to build the framework theme-resource
    /// catalog. This is file/XML work over the package layout, deliberately kept out of
    /// <see cref="XamlTypeSystem"/>, which resolves symbols through Roslyn.
    /// </summary>
    internal static class ThemeResourceCatalog
    {
        /// <summary>Loads the catalog for a compilation, or an empty list when no generic.xaml is reachable.</summary>
        /// <param name="discovered">True when a generic.xaml was found and yielded resources.</param>
        public static IReadOnlyList<ThemeResourceInfo> Load(Compilation compilation, out bool discovered)
        {
            foreach (var path in GetCandidates(compilation))
            {
                if (!File.Exists(path))
                {
                    continue;
                }

                try
                {
                    var resources = Parse(path);
                    if (resources.Count > 0)
                    {
                        discovered = true;
                        return resources;
                    }
                }
                catch (IOException)
                {
                }
                catch (UnauthorizedAccessException)
                {
                }
                catch (XmlException)
                {
                }
            }

            discovered = false;
            return Array.Empty<ThemeResourceInfo>();
        }

        /// <summary>Every generic.xaml the compilation's WinUI references could point at, managed layout first.</summary>
        private static IEnumerable<string> GetCandidates(Compilation compilation)
        {
            var managed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var native = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            foreach (var reference in compilation.References.OfType<PortableExecutableReference>())
            {
                if (string.IsNullOrEmpty(reference.FilePath))
                {
                    continue;
                }

                var referencePath = Path.GetFullPath(reference.FilePath);
                var directory = Path.GetDirectoryName(referencePath);
                var fileName = Path.GetFileName(referencePath);
                var isManagedWinUi = string.Equals(
                    fileName, "Microsoft.WinUI.dll", StringComparison.OrdinalIgnoreCase);
                var isNativeWinUi = string.Equals(
                    fileName, "Microsoft.UI.Xaml.winmd", StringComparison.OrdinalIgnoreCase);
                if ((!isManagedWinUi && !isNativeWinUi) ||
                    directory is null ||
                    !XamlTypeSystem.TryFindPackageRoot(directory, out var packageRoot))
                {
                    continue;
                }

                if (isManagedWinUi)
                {
                    managed.Add(Path.Combine(directory, "Microsoft.WinUI", "Themes", "generic.xaml"));
                }

                native.Add(Path.Combine(packageRoot, "lib", "native", "Microsoft.UI", "Themes", "generic.xaml"));
            }

            return managed.Concat(native);
        }

        private static IReadOnlyList<ThemeResourceInfo> Parse(string path)
        {
            var settings = new XmlReaderSettings
            {
                DtdProcessing = DtdProcessing.Prohibit,
                XmlResolver = null,
            };
            var resources = new Dictionary<string, ThemeResourceInfo>(StringComparer.Ordinal);

            using var reader = XmlReader.Create(path, settings);
            while (reader.Read())
            {
                if (reader.NodeType != XmlNodeType.Element)
                {
                    continue;
                }

                var key = reader.GetAttribute("Key", XamlTypeSystem.XamlLanguageNamespace);
                if (!string.IsNullOrEmpty(key) && !resources.ContainsKey(key))
                {
                    resources.Add(key, new ThemeResourceInfo(key, reader.NamespaceURI, reader.LocalName));
                }
            }

            if (resources.Count == 0)
            {
                return Array.Empty<ThemeResourceInfo>();
            }

            // These platform-provided Color resources are consumed by WinUI's generic.xaml but
            // are not declared in it, so supplement the package catalog with the Windows SDK set.
            foreach (var key in IntrinsicSystemColorResources)
            {
                resources.TryAdd(
                    key, new ThemeResourceInfo(key, XamlTypeSystem.PresentationNamespace, "Color"));
            }

            return resources.Values.OrderBy(resource => resource.Key, StringComparer.Ordinal).ToList();
        }

        private static readonly string[] IntrinsicSystemColorResources =
        {
            "SystemColorButtonFaceColor",
            "SystemColorButtonTextColor",
            "SystemColorGrayTextColor",
            "SystemColorHighlightColor",
            "SystemColorHighlightTextColor",
            "SystemColorHotlightColor",
            "SystemColorWindowColor",
            "SystemColorWindowTextColor",
        };
    }

    /// <summary>A keyed resource declared by the active WinUI SDK's generic.xaml.</summary>
    public sealed class ThemeResourceInfo
    {
        public ThemeResourceInfo(string key, string typeNamespace, string localTypeName)
        {
            Key = key;
            TypeNamespace = typeNamespace;
            LocalTypeName = localTypeName;
        }

        public string Key { get; }

        public string TypeNamespace { get; }

        public string LocalTypeName { get; }
    }
}
