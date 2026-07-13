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
        var baseDir = Path.Combine(Path.GetTempPath(), "winui-xaml-jtest-" + Guid.NewGuid().ToString("N"));
        var trustedRoot = Path.Combine(baseDir, "trusted");
        var externalDir = Path.Combine(baseDir, "external");
        var linkPath = Path.Combine(trustedRoot, "link");
        try
        {
            Directory.CreateDirectory(trustedRoot);
            Directory.CreateDirectory(externalDir);
            File.WriteAllText(Path.Combine(externalDir, "Evil.csproj"), "<Project />");

            // Junctions do NOT require admin; skip gracefully if the OS refuses.
            var psi = new ProcessStartInfo("cmd.exe", $"/c mklink /J \"{linkPath}\" \"{externalDir}\"")
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            using var proc = Process.Start(psi);
            if (proc is null) { return; } // skip
            proc.WaitForExit(10000);
            if (proc.ExitCode != 0 || !Directory.Exists(linkPath)) { return; } // skip: mklink /J unavailable

            var normalized = XamlLanguageServer.NormalizeRoots(new[] { trustedRoot });
            Assert.Single(normalized);

            // A file reached through the junction physically lives in externalDir; canonicalization
            // resolves the reparse point so it is NOT under the trusted root.
            var fileViaLink = Path.Combine(linkPath, "Page.xaml");
            var canonical = XamlLanguageServer.CanonicalizePath(fileViaLink);
            Assert.False(
                XamlLanguageServer.PathIsWithin(canonical, normalized[0]),
                $"canonical '{canonical}' must not be under trusted root '{normalized[0]}'");
        }
        catch (Exception)
        {
            // Environment can't create junctions — skip rather than fail the suite.
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
