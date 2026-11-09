using System.Security.AccessControl;
using System.Security.Principal;

namespace WinUiXaml.Workspace.Tests;

public sealed class ProjectInputSnapshotTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "xaml-input-snapshot-" + Guid.NewGuid().ToString("N"));

    [Theory]
    [InlineData("Page.xaml.cs")]
    [InlineData("App.csproj")]
    [InlineData("Directory.Build.props")]
    [InlineData("Directory.Packages.props")]
    [InlineData(".editorconfig")]
    [InlineData("obj\\project.assets.json")]
    public void MissedDiskChangesAreDetected(string relative)
    {
        Directory.CreateDirectory(_root);
        var path = Path.Combine(_root, relative);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, "old");
        var snapshot = new ProjectInputSnapshot([Path.Combine(_root, "App.csproj")], [path]);
        Assert.False(snapshot.HasChanges());
        File.WriteAllText(path, "changed");
        Assert.True(snapshot.HasChanges());
    }

    [Fact]
    public void XamlContentAndBuildOutputsDoNotCauseReloadsButNewPagesDo()
    {
        Directory.CreateDirectory(_root);
        var page = Path.Combine(_root, "Page.xaml");
        File.WriteAllText(page, "<Page/>");
        var snapshot = new ProjectInputSnapshot([Path.Combine(_root, "App.csproj")], []);
        File.WriteAllText(page, "<Page><Buton/></Page>");
        Directory.CreateDirectory(Path.Combine(_root, "obj"));
        File.WriteAllText(Path.Combine(_root, "obj", "Generated.cs"), "generated");
        Assert.False(snapshot.HasChanges());
        File.WriteAllText(Path.Combine(_root, "NewPage.xaml"), "<Page/>");
        Assert.True(snapshot.HasChanges());
    }

    [Fact]
    public void AddedAndDeletedSourceFilesAreDetected()
    {
        Directory.CreateDirectory(_root);
        var project = Path.Combine(_root, "App.csproj");
        var before = new ProjectInputSnapshot([project], []);
        var source = Path.Combine(_root, "New.cs");
        File.WriteAllText(source, "class New {}");
        Assert.True(before.HasChanges());
        var after = new ProjectInputSnapshot([project], []);
        File.Delete(source);
        Assert.True(after.HasChanges());
    }

    [Fact]
    public void NewlyAddedEditorConfigIsDetectedWithoutExplicitInputs()
    {
        Directory.CreateDirectory(_root);
        var snapshot = new ProjectInputSnapshot([Path.Combine(_root, "App.csproj")], []);
        File.WriteAllText(Path.Combine(_root, ".editorconfig"), "root = true");
        Assert.True(snapshot.HasChanges());
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void UnreadableSubfolderDoesNotPreventTrackingReadableInputs(bool denyBeforeSnapshot)
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        Directory.CreateDirectory(_root);
        var project = Path.Combine(_root, "App.csproj");
        File.WriteAllText(project, "<Project/>");
        var denied = Directory.CreateDirectory(Path.Combine(_root, "Secrets"));
        var source = Path.Combine(Directory.CreateDirectory(Path.Combine(_root, "Visible")).FullName, "Page.cs");
        File.WriteAllText(source, "old");
        var restricted = denied.GetAccessControl();
        using var identity = WindowsIdentity.GetCurrent();
        var denyRule = new FileSystemAccessRule(
            identity.User!, FileSystemRights.ListDirectory, AccessControlType.Deny);
        restricted.AddAccessRule(denyRule);
        var snapshot = denyBeforeSnapshot ? null : new ProjectInputSnapshot([project], []);
        try
        {
            denied.SetAccessControl(restricted);
            Assert.Throws<UnauthorizedAccessException>(() => Directory.GetFiles(denied.FullName));
            snapshot ??= new ProjectInputSnapshot([project], []);
            Assert.False(snapshot.HasChanges());
            File.WriteAllText(source, "changed");
            Assert.True(snapshot.HasChanges());
        }
        finally
        {
            restricted.RemoveAccessRuleSpecific(denyRule);
            denied.SetAccessControl(restricted);
        }
    }

    [Fact]
    public void DeletedProjectDirectoryDoesNotPreventTrackingOtherInputs()
    {
        Directory.CreateDirectory(_root);
        var removed = Directory.CreateDirectory(Path.Combine(_root, "Removed")).FullName;
        var source = Path.Combine(_root, "Page.cs");
        File.WriteAllText(source, "old");
        var snapshot = new ProjectInputSnapshot([Path.Combine(removed, "App.csproj")], [source]);
        Directory.Delete(removed);
        Assert.False(snapshot.HasChanges());
        File.WriteAllText(source, "changed");
        Assert.True(snapshot.HasChanges());
    }

    public void Dispose() => Directory.Delete(_root, recursive: true);
}
