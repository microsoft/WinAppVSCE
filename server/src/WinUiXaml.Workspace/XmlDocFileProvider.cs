using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Threading;
using System.Xml;
using Microsoft.CodeAnalysis;

namespace WinUiXaml.Workspace
{
    /// <summary>
    /// Supplies XML documentation without <c>Microsoft.CodeAnalysis.Workspaces</c>, whose MEF composition fails under Native AOT trimming; otherwise symbols resolve but quick-info prose disappears.
    /// </summary>
    internal sealed class XmlDocFileProvider : DocumentationProvider
    {
        private static readonly ConcurrentDictionary<string, XmlDocFileProvider> Cache =
            new ConcurrentDictionary<string, XmlDocFileProvider>(StringComparer.OrdinalIgnoreCase);

        private readonly string _path;
        private readonly object _gate = new object();
        private Dictionary<string, string>? _members;

        private XmlDocFileProvider(string path)
        {
            _path = path;
        }

        /// <summary>Returns a cached provider for <paramref name="path"/> so reloads do not reparse hundreds of reference docs.</summary>
        internal static XmlDocFileProvider GetOrCreate(string path) =>
            Cache.GetOrAdd(Path.GetFullPath(path), fullPath => new XmlDocFileProvider(fullPath));

        protected override string? GetDocumentationForSymbol(
            string documentationMemberID,
            CultureInfo? preferredCulture = null,
            CancellationToken cancellationToken = default)
        {
            var members = _members;
            if (members is null)
            {
                lock (_gate)
                {
                    // Parsing is deferred until a symbol is actually asked about, so loading a
                    // project does not pay for documentation nobody reads.
                    members = _members ??= Parse(_path);
                }
            }

            return members.TryGetValue(documentationMemberID, out var documentation)
                ? documentation
                : null;
        }

        private static Dictionary<string, string> Parse(string path)
        {
            var members = new Dictionary<string, string>(StringComparer.Ordinal);
            try
            {
                var settings = new XmlReaderSettings
                {
                    DtdProcessing = DtdProcessing.Prohibit,
                    XmlResolver = null,
                    IgnoreWhitespace = false,
                    CloseInput = true,
                };

                using var reader = XmlReader.Create(File.OpenRead(path), settings);
                while (reader.Read())
                {
                    if (reader.NodeType != XmlNodeType.Element ||
                        !string.Equals(reader.Name, "member", StringComparison.Ordinal))
                    {
                        continue;
                    }

                    var name = reader.GetAttribute("name");
                    if (string.IsNullOrEmpty(name))
                    {
                        continue;
                    }

                    // Roslyn expects the full <member> element, not just its inner content.
                    members[name!] = reader.ReadOuterXml();
                }
            }
            catch (XmlException)
            {
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }

            return members;
        }

        public override bool Equals(object? obj) =>
            obj is XmlDocFileProvider other &&
            string.Equals(_path, other._path, StringComparison.OrdinalIgnoreCase);

        public override int GetHashCode() =>
            StringComparer.OrdinalIgnoreCase.GetHashCode(_path);
    }
}
