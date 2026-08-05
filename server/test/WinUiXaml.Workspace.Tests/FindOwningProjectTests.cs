using System;
using System.IO;
using WinUiXaml.Workspace;

namespace WinUiXaml.Workspace.Tests
{
    /// <summary>
    /// Hermetic tests for the pure project-discovery logic of <see cref="XamlProjectResolver"/>.
    /// These build a throwaway directory tree on disk and never load MSBuild, so they run fast and
    /// with no dependency on an installed SDK or the WinUI fixture.
    /// </summary>
    public sealed class FindOwningProjectTests : IDisposable
    {
        private readonly string _root;

        public FindOwningProjectTests()
        {
            _root = Path.Combine(Path.GetTempPath(), "winui-vsc-tests", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_root);
        }

        [Fact]
        public void FindsProjectBesideXaml()
        {
            var proj = Touch("App", "App.csproj");
            var xaml = Touch("App", "MainWindow.xaml");

            Assert.Equal(proj, XamlProjectResolver.FindOwningProject(xaml));
        }

        [Fact]
        public void WalksUpToAncestorProject()
        {
            var proj = Touch("App", "App.csproj");
            var xaml = Touch("App", "Views", "Nested", "Deep.xaml");

            Assert.Equal(proj, XamlProjectResolver.FindOwningProject(xaml));
        }

        [Fact]
        public void SearchRootStopsParentProjectDiscovery()
        {
            Touch("Outer.csproj");
            var trustedRoot = Path.Combine(_root, "Trusted");
            var xaml = Touch("Trusted", "Views", "Page.xaml");

            Assert.Null(XamlProjectResolver.FindOwningProject(xaml, trustedRoot));
        }

        [Fact]
        public void SearchRootIncludesProjectAtBoundary()
        {
            var project = Touch("Trusted", "App.csproj");
            var trustedRoot = Path.Combine(_root, "Trusted");
            var xaml = Touch("Trusted", "Views", "Page.xaml");

            Assert.Equal(project, XamlProjectResolver.FindOwningProject(xaml, trustedRoot));
        }

        [Fact]
        public void NearestProjectWins()
        {
            Touch("App", "Outer.csproj");
            var inner = Touch("App", "Sub", "Inner.csproj");
            var xaml = Touch("App", "Sub", "Views", "Page.xaml");

            Assert.Equal(inner, XamlProjectResolver.FindOwningProject(xaml));
        }

        [Fact]
        public void NoProject_ReturnsNull()
        {
            var xaml = Touch("Loose", "Orphan.xaml");

            Assert.Null(XamlProjectResolver.FindOwningProject(xaml));
        }

        [Fact]
        public void MultipleProjectsInDirectory_ReturnsNullWhenAmbiguous()
        {
            var b = Touch("App", "Bravo.csproj");
            Touch("App", "Alpha.csproj");
            var xaml = Touch("App", "Page.xaml");

            var result = XamlProjectResolver.FindOwningProject(xaml);
            Assert.Null(result);
        }

        [Fact]
        public void NullOrEmptyPath_ReturnsNull()
        {
            Assert.Null(XamlProjectResolver.FindOwningProject(null!));
            Assert.Null(XamlProjectResolver.FindOwningProject(string.Empty));
        }

        private string Touch(params string[] segments)
        {
            var full = Path.Combine(new[] { _root }.Concat(segments).ToArray());
            Directory.CreateDirectory(Path.GetDirectoryName(full)!);
            File.WriteAllText(full, string.Empty);
            return full;
        }

        public void Dispose()
        {
            try
            {
                if (Directory.Exists(_root))
                {
                    Directory.Delete(_root, recursive: true);
                }
            }
            catch (IOException)
            {
                // Best-effort cleanup; a leaked temp dir is harmless.
            }
        }
    }
}
