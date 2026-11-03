using System.Collections.Generic;
using System.Linq;
using WinUiXaml.Xaml;

namespace WinUiXaml.Xaml.Tests
{
    internal static class TreeQuery
    {
        public static IEnumerable<XamlElement> Elements(XamlNode node) =>
            node.DescendantNodesAndSelf().OfType<XamlElement>();

        public static XamlElement? ByName(XamlDocument doc, string name) =>
            Elements(doc).FirstOrDefault(e => e.GetAttribute("x:Name")?.Value?.Text == name);

        public static XamlElement? FirstElement(XamlDocument doc, string localName) =>
            Elements(doc).FirstOrDefault(e => e.Name?.LocalName == localName);
    }
}
