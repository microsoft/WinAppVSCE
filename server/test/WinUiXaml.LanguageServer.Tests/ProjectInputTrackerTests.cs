namespace WinUiXaml.LanguageServer.Tests;

public sealed class ProjectInputTrackerTests
{
    [Fact]
    public void KnownExternalProjectSourcesInvalidateWithoutTrustingTheirSiblingDirectories()
    {
        var root = Path.Combine(Path.GetTempPath(), "winui-xaml-inputs", Guid.NewGuid().ToString("N"));
        var appProject = Path.Combine(root, "App", "App.csproj");
        var sharedProject = Path.Combine(root, "Shared", "Shared.csproj");
        var tracker = new ProjectInputTracker();
        tracker.Register(appProject, [appProject, sharedProject], []);

        var affected = tracker.GetProjectsToInvalidate(
            Path.Combine(root, "Shared", "Models", "Widget.cs"),
            includeProjectDirectories: true);
        var unrelated = tracker.GetProjectsToInvalidate(
            Path.Combine(root, "Unrelated", "Other.cs"),
            includeProjectDirectories: true);
        var generated = tracker.GetProjectsToInvalidate(
            Path.Combine(root, "Shared", "obj", "Generated.cs"),
            includeProjectDirectories: true);

        Assert.Contains(sharedProject, affected, StringComparer.OrdinalIgnoreCase);
        Assert.Empty(unrelated);
        Assert.Empty(generated);
    }

    [Fact]
    public void ArbitraryGeneratorInputExtensionsInvalidateTheLoadedRootProject()
    {
        var root = Path.Combine(Path.GetTempPath(), "winui-xaml-inputs", Guid.NewGuid().ToString("N"));
        var appProject = Path.Combine(root, "App", "App.csproj");
        var input = Path.Combine(root, "GeneratorInputs", "settings.json");
        var tracker = new ProjectInputTracker();
        tracker.Register(appProject, [appProject], [input]);

        var affected = tracker.GetProjectsToInvalidate(
            input,
            includeProjectDirectories: false);

        Assert.Contains(appProject, affected, StringComparer.OrdinalIgnoreCase);
    }

    [Fact]
    public void ReRegisteringAProjectDropsInputsRemovedFromItsGraph()
    {
        var root = Path.Combine(Path.GetTempPath(), "winui-xaml-inputs", Guid.NewGuid().ToString("N"));
        var appProject = Path.Combine(root, "App", "App.csproj");
        var oldInput = Path.Combine(root, "old.json");
        var newInput = Path.Combine(root, "new.json");
        var tracker = new ProjectInputTracker();
        tracker.Register(appProject, [appProject], [oldInput]);
        tracker.Register(appProject, [appProject], [newInput]);

        Assert.Empty(tracker.GetProjectsToInvalidate(oldInput, includeProjectDirectories: false));
        Assert.Contains(
            appProject,
            tracker.GetProjectsToInvalidate(newInput, includeProjectDirectories: false),
            StringComparer.OrdinalIgnoreCase);
    }
}
