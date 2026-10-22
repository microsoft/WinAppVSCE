using System.IO;

namespace WinUIXamlPreview.IntegrationTests
{
    /// <summary>Generates the throwaway projects the tests open. No build needed: previews render framework-only.</summary>
    internal sealed class Fixture
    {
        public string Root { get; }
        public string Readme => Path.Combine(Root, "readme.txt");
        public string Solution => Path.Combine(Root, "Fixture.sln");
        public string WinUiDir => Path.Combine(Root, "WinUiApp");
        public string MainPage => Path.Combine(WinUiDir, "MainPage.xaml");
        public string SecondPage => Path.Combine(WinUiDir, "SecondPage.xaml");
        public string BrokenPage => Path.Combine(WinUiDir, "BrokenPage.xaml");
        public string Dictionary => Path.Combine(WinUiDir, "Styles.xaml");
        /// <summary>Only the Save As test uses this: VS keeps a renamed buffer's identity, so a renamed page can't be reused.</summary>
        public string SaveAsPage => Path.Combine(WinUiDir, "SaveAsPage.xaml");
        public string WpfWindow => Path.Combine(Root, "WpfApp", "MainWindow.xaml");
        /// <summary>Outside every project, so VS opens these in the XML editor.</summary>
        public string LoosePage => Path.Combine(Root, "Loose", "LoosePage.xaml");
        public string LooseXml => Path.Combine(Root, "Loose", "settings.xml");

        public Fixture(string root)
        {
            Root = root;
        }

        public void Create()
        {
            if (Directory.Exists(Root))
            {
                Directory.Delete(Root, recursive: true);
            }
            Directory.CreateDirectory(WinUiDir);
            Directory.CreateDirectory(Path.GetDirectoryName(WpfWindow)!);

            File.WriteAllText(Readme, "WinUI XAML Preview integration-test fixture.\r\n");

            File.WriteAllText(Path.Combine(WinUiDir, "WinUiApp.csproj"),
@"<Project Sdk=""Microsoft.NET.Sdk"">
  <PropertyGroup>
    <OutputType>WinExe</OutputType>
    <TargetFramework>net8.0-windows10.0.19041.0</TargetFramework>
    <UseWinUI>true</UseWinUI>
  </PropertyGroup>
</Project>
");
            ResetPages();

            File.WriteAllText(Path.Combine(Root, "WpfApp", "WpfApp.csproj"),
@"<Project Sdk=""Microsoft.NET.Sdk"">
  <PropertyGroup>
    <OutputType>WinExe</OutputType>
    <TargetFramework>net8.0-windows</TargetFramework>
    <UseWPF>true</UseWPF>
  </PropertyGroup>
</Project>
");
            File.WriteAllText(WpfWindow,
@"<Window x:Class=""WpfApp.MainWindow""
        xmlns=""http://schemas.microsoft.com/winfx/2006/xaml/presentation""
        xmlns:x=""http://schemas.microsoft.com/winfx/2006/xaml""
        Title=""WPF"" Height=""200"" Width=""300"">
    <Grid><TextBlock Text=""wpf"" /></Grid>
</Window>
");
            // Loose .xaml files open in the XML editor (content type "XML"); only files in a loaded project get
            // the XAML content type, so open the projects as a solution. The margin also accepts XML views of
            // .xaml files, which the Loose files exercise.
            Directory.CreateDirectory(Path.GetDirectoryName(LoosePage)!);
            File.WriteAllText(LoosePage, SecondPageXaml);
            File.WriteAllText(LooseXml, "<settings><item key=\"a\" /></settings>\r\n");
            const string sdkProject = "9A19103F-16F7-4668-BE54-9A1E7A4F7556";
            File.WriteAllText(Solution,
"\r\nMicrosoft Visual Studio Solution File, Format Version 12.00\r\n# Visual Studio Version 17\r\n" +
$"Project(\"{{{sdkProject}}}\") = \"WinUiApp\", \"WinUiApp\\WinUiApp.csproj\", \"{{3C1E5A10-0000-4000-8000-000000000001}}\"\r\nEndProject\r\n" +
$"Project(\"{{{sdkProject}}}\") = \"WpfApp\", \"WpfApp\\WpfApp.csproj\", \"{{3C1E5A10-0000-4000-8000-000000000002}}\"\r\nEndProject\r\n" +
"Global\r\nEndGlobal\r\n");
        }

        /// <summary>Restores the WinUI pages to their pristine text (tests may have edited or renamed them).</summary>
        public void ResetPages()
        {
            File.WriteAllText(MainPage, MainPageXaml);
            File.WriteAllText(SecondPage, SecondPageXaml);
            File.WriteAllText(BrokenPage, BrokenPageXaml);
            File.WriteAllText(Dictionary, DictionaryXaml);
            File.WriteAllText(SaveAsPage, SecondPageXaml);
        }

        public const string MainPageXaml =
@"<Page
    xmlns=""http://schemas.microsoft.com/winfx/2006/xaml/presentation""
    xmlns:x=""http://schemas.microsoft.com/winfx/2006/xaml"">
    <StackPanel x:Name=""Root"" Padding=""12"" Spacing=""8"">
        <TextBlock x:Name=""Title"" Text=""Hello preview"" />
        <Button x:Name=""Go"" Content=""Go"" />
        <TextBox x:Name=""Input"" PlaceholderText=""type"" />
    </StackPanel>
</Page>
";

        public const string SecondPageXaml =
@"<Page
    xmlns=""http://schemas.microsoft.com/winfx/2006/xaml/presentation""
    xmlns:x=""http://schemas.microsoft.com/winfx/2006/xaml"">
    <Grid>
        <TextBlock Text=""Second page"" />
    </Grid>
</Page>
";

        public const string BrokenPageXaml =
@"<Page
    xmlns=""http://schemas.microsoft.com/winfx/2006/xaml/presentation""
    xmlns:x=""http://schemas.microsoft.com/winfx/2006/xaml"">
    <Grid>
        <NoSuchControl />
    </Grid>
</Page>
";

        public const string DictionaryXaml =
@"<ResourceDictionary
    xmlns=""http://schemas.microsoft.com/winfx/2006/xaml/presentation""
    xmlns:x=""http://schemas.microsoft.com/winfx/2006/xaml"">
    <SolidColorBrush x:Key=""Accent"" Color=""Red"" />
</ResourceDictionary>
";
    }
}
