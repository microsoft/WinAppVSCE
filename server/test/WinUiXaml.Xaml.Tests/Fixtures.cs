using System.IO;

namespace WinUiXaml.Xaml.Tests
{
    internal static class Fixtures
    {
        private static string FixturesDir =>
            Path.Combine(System.AppContext.BaseDirectory, "Fixtures");

        public static string Load(string fileName) =>
            File.ReadAllText(Path.Combine(FixturesDir, fileName));

        public static string SmokePage => Load("SmokePage.xaml");

        public static string DiPage => Load("DiPage.xaml");

        public static string[] AllFiles => Directory.GetFiles(FixturesDir, "*.xaml");
    }
}
