using System.Diagnostics;
using WinUiXaml.LanguageServer;

namespace WinUiXaml.LanguageServer.Tests;

/// <summary>
/// Direct/behavioral tests for the workspace-trust allow-list boundary. These exercise the
/// separator-boundary containment logic (<see cref="XamlLanguageServer.PathIsWithin"/>) and root
/// normalization (<see cref="XamlLanguageServer.NormalizeRoots"/>) that decide whether a document
/// gets project (MSBuild) evaluation, plus a non-admin junction regression for the reparse-point
/// bypass that <see cref="XamlLanguageServer.CanonicalizePath"/> closes.
/// </summary>
public class AllowedRootBoundaryTests
{
    [Theory]
    [InlineData(@"C:\repo\app\obj\Debug\net10.0\generated.props", true)]
    [InlineData(@"C:\repo\app\bin\Debug\net10.0\App.dll", true)]
    [InlineData(@"C:\repo\app\src\ObjectModel.cs", false)]
    [InlineData(@"C:\repo\app\objects\theme.props", false)]
    public void GeneratedBuildPathsAreIgnoredByWatchInvalidation(string path, bool expected)
    {
        Assert.Equal(expected, XamlLanguageServer.IsGeneratedBuildPath(path, @"C:\repo"));
    }

    [Theory]
    [InlineData(@"C:\repo\app\obj\project.assets.json", true)]
    [InlineData(@"C:\repo\app\OBJ\PROJECT.ASSETS.JSON", true)]
    [InlineData(@"C:\repo\app\obj\generated.json", false)]
    [InlineData(@"C:\repo\app\project.assets.json", false)]
    public void NuGetAssetsPathIsRecognizedPrecisely(string path, bool expected)
    {
        Assert.Equal(expected, XamlLanguageServer.IsNuGetAssetsPath(path));
    }

    [Fact]
    public void ExactRoot_IsWithin()
    {
        Assert.True(XamlLanguageServer.PathIsWithin(@"C:\root", @"C:\root"));
    }

    [Fact]
    public void ChildOfRoot_IsWithin()
    {
        Assert.True(XamlLanguageServer.PathIsWithin(@"C:\root\sub\Page.xaml", @"C:\root"));
    }

    [Fact]
    public void OutsideRoot_IsRejected()
    {
        Assert.False(XamlLanguageServer.PathIsWithin(@"C:\other\Page.xaml", @"C:\root"));
    }

    [Fact]
    public void SiblingPrefix_IsRejected()
    {
        // "C:\rootEvil" starts with "C:\root" lexically but is NOT under it.
        Assert.False(XamlLanguageServer.PathIsWithin(@"C:\rootEvil\x.xaml", @"C:\root"));
    }

    [Fact]
    public void DriveRoot_AllowsChild()
    {
        // G11: a bare drive root keeps its trailing separator; every child must be contained.
        Assert.True(XamlLanguageServer.PathIsWithin(@"C:\proj\Page.xaml", @"C:\"));
    }

    [Fact]
    public void DriveRoot_RejectsOtherDrive()
    {
        Assert.False(XamlLanguageServer.PathIsWithin(@"D:\x.xaml", @"C:\"));
    }

    [Fact]
    public void Containment_IsCaseInsensitive()
    {
        Assert.True(XamlLanguageServer.PathIsWithin(@"C:\ROOT\Sub\PAGE.XAML", @"c:\root"));
    }

    [Theory]
    [InlineData(@"C:\root\a.xaml", @"C:\root", true)]
    [InlineData(@"C:\root", @"C:\root", true)]
    [InlineData(@"C:\rootier\a.xaml", @"C:\root", false)]
    [InlineData(@"C:\a.xaml", @"C:\", true)]
    public void PathIsWithin_Theory(string path, string root, bool expected)
    {
        Assert.Equal(expected, XamlLanguageServer.PathIsWithin(path, root));
    }

    [Fact]
    public void NormalizeRoots_TrailingSeparatorComparesEqual()
    {
        var withSep = XamlLanguageServer.NormalizeRoots(new[] { @"C:\proj\" });
        var withoutSep = XamlLanguageServer.NormalizeRoots(new[] { @"C:\proj" });
        Assert.Single(withSep);
        Assert.Single(withoutSep);
        Assert.Equal(withoutSep[0], withSep[0], ignoreCase: true);
    }

    [Fact]
    public void NormalizeRoots_TrimsChildRoot_ButKeepsDriveRootIntact()
    {
        var trimmed = XamlLanguageServer.NormalizeRoots(new[] { @"C:\proj\" });
        Assert.Equal(@"C:\proj", trimmed[0], ignoreCase: true);

        var drive = XamlLanguageServer.NormalizeRoots(new[] { @"C:\" });
        Assert.Single(drive);
        Assert.EndsWith(@"\", drive[0]);
        // The bare drive root must not collapse to the drive-relative "C:".
        Assert.False(string.Equals("C:", drive[0], StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void NormalizeRoots_SkipsEmptyEntries()
    {
        var roots = XamlLanguageServer.NormalizeRoots(new[] { "", "   ", @"C:\root" });
        Assert.Single(roots);
        Assert.Equal(@"C:\root", roots[0], ignoreCase: true);
    }

    [Fact]
    public void NormalizeThenContainment_DriveRootFix_EndToEnd()
    {
        // G11 end-to-end: NormalizeRoots keeps "C:\" intact and PathIsWithin then allows children.
        var roots = XamlLanguageServer.NormalizeRoots(new[] { @"C:\" });
        Assert.True(XamlLanguageServer.PathIsWithin(@"C:\proj\Page.xaml", roots[0]));
    }

    [Fact]
    public void Junction_InsideRoot_TargetingExternalDir_IsRejected()
    {
        // G15 regression (non-admin): a junction inside a trusted root that targets an external
        // directory must NOT canonicalize to inside the root, so a file under it is out-of-bounds.
        // Both an EXISTING file and a not-yet-created (missing-leaf) file must be rejected — the
        // missing-leaf case is the one that must not fall back to the lexical in-root path.
        var baseDir = Path.Combine(Path.GetTempPath(), "winui-xaml-jtest-" + Guid.NewGuid().ToString("N"));
        var trustedRoot = Path.Combine(baseDir, "trusted");
        var externalDir = Path.Combine(baseDir, "external");
        var linkPath = Path.Combine(trustedRoot, "link");
        var junctionCreated = false;
        try
        {
            Directory.CreateDirectory(trustedRoot);
            Directory.CreateDirectory(externalDir);
            File.WriteAllText(Path.Combine(externalDir, "Evil.csproj"), "<Project />");

            // Junctions do NOT require admin; skip the assertions ONLY when the OS refuses to make
            // one. Assertions live outside this guard so a real regression can never be swallowed.
            var psi = new ProcessStartInfo("cmd.exe", $"/c mklink /J \"{linkPath}\" \"{externalDir}\"")
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            using (var proc = Process.Start(psi))
            {
                proc?.WaitForExit(10000);
                junctionCreated = proc is { ExitCode: 0 } && Directory.Exists(linkPath);
            }
        }
        catch (Exception)
        {
            junctionCreated = false; // environment can't create junctions — treated as skip below
        }

        try
        {
            if (!junctionCreated)
            {
                return; // skip: junction creation unavailable (nothing proven, nothing masked)
            }

            var normalized = XamlLanguageServer.NormalizeRoots(new[] { trustedRoot });
            Assert.Single(normalized);

            // A real file reached through the junction physically lives in externalDir.
            var existingViaLink = Path.Combine(linkPath, "Page.xaml");
            File.WriteAllText(existingViaLink, "<Page/>");

            // A missing leaf under the junction: FindOwningProject only needs the DIRECTORY, so this
            // must also canonicalize outside the trusted root (the reparse point is in the ancestry).
            var missingViaLink = Path.Combine(linkPath, "DoesNotExist.xaml");

            foreach (var probe in new[] { existingViaLink, missingViaLink })
            {
                var canonical = XamlLanguageServer.CanonicalizePath(probe);
                Assert.False(
                    XamlLanguageServer.PathIsWithin(canonical, normalized[0]),
                    $"canonical '{canonical}' (from '{probe}') must not be under trusted root '{normalized[0]}'");
            }
        }
        finally
        {
            try
            {
                if (Directory.Exists(linkPath)) { Directory.Delete(linkPath); } // removes the junction, not the target
                if (Directory.Exists(baseDir)) { Directory.Delete(baseDir, recursive: true); }
            }
            catch { /* best-effort cleanup */ }
        }
    }
}
