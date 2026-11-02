using System.Linq;
using WinUiXaml.Xaml;

namespace WinUiXaml.Xaml.Tests
{
    public class NamespaceScopeTests
    {
        private const string PresentationUri = "http://schemas.microsoft.com/winfx/2006/xaml/presentation";
        private const string XamlUri = "http://schemas.microsoft.com/winfx/2006/xaml";

        [Fact]
        public void Root_ResolvesDefaultAndPrefixedNamespaces()
        {
            var doc = XamlParser.Parse(Fixtures.SmokePage);
            var scope = doc.Root!.NamespaceScope;

            Assert.True(scope.TryResolvePrefix(null, out var def));
            Assert.Equal(PresentationUri, def);

            Assert.True(scope.TryResolvePrefix("x", out var x));
            Assert.Equal(XamlUri, x);

            Assert.True(scope.TryResolvePrefix("local", out var local));
            Assert.Equal("using:SmokeFixture", local);
        }

        [Fact]
        public void NestedElement_InheritsAncestorNamespaces()
        {
            var doc = XamlParser.Parse(Fixtures.SmokePage);
            var grid = TreeQuery.Elements(doc).First(e => e.Name?.LocalName == "Grid");

            Assert.True(grid.NamespaceScope.TryResolvePrefix("local", out var local));
            Assert.Equal("using:SmokeFixture", local);

            Assert.True(grid.NamespaceScope.TryResolvePrefix(null, out var def));
            Assert.Equal(PresentationUri, def);
        }

        [Fact]
        public void UnknownPrefix_DoesNotResolve()
        {
            var doc = XamlParser.Parse(Fixtures.SmokePage);
            Assert.False(doc.Root!.NamespaceScope.TryResolvePrefix("nope", out _));
        }

        [Fact]
        public void ChildScope_OverridesInheritedDeclaration()
        {
            const string xaml =
                "<Root xmlns:p=\"uri-a\">" +
                "  <Child xmlns:p=\"uri-b\">" +
                "    <Leaf />" +
                "  </Child>" +
                "</Root>";

            var doc = XamlParser.Parse(xaml);
            var child = TreeQuery.Elements(doc).First(e => e.Name?.LocalName == "Child");
            var root = doc.Root!;

            Assert.True(root.NamespaceScope.TryResolvePrefix("p", out var a));
            Assert.Equal("uri-a", a);

            Assert.True(child.NamespaceScope.TryResolvePrefix("p", out var b));
            Assert.Equal("uri-b", b);
        }
    }
}
