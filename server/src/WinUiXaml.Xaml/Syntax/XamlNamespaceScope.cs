using System.Collections.Generic;

namespace WinUiXaml.Xaml
{
    /// <summary>
    /// The set of <c>xmlns</c> declarations in effect at a given element, flattened from the element
    /// and all its ancestors. The default namespace is stored under the empty-string key.
    /// </summary>
    public sealed class XamlNamespaceScope
    {
        public static readonly XamlNamespaceScope Empty =
            new XamlNamespaceScope(new Dictionary<string, string>());

        private readonly IReadOnlyDictionary<string, string> _map;

        public XamlNamespaceScope(IReadOnlyDictionary<string, string> map)
        {
            _map = map;
        }

        /// <summary>
        /// Resolves a prefix to its namespace URI. Pass null or empty for the default namespace.
        /// </summary>
        public bool TryResolvePrefix(string? prefix, out string namespaceUri)
        {
            var key = prefix ?? string.Empty;
            if (_map.TryGetValue(key, out var uri))
            {
                namespaceUri = uri;
                return true;
            }

            namespaceUri = string.Empty;
            return false;
        }

        /// <summary>All effective declarations at this scope (prefix -> URI; "" is the default namespace).</summary>
        public IReadOnlyDictionary<string, string> Declarations => _map;
    }
}
