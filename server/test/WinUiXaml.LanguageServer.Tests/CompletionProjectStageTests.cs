using WinUiXaml.LanguageServer.Lsp;

namespace WinUiXaml.LanguageServer.Tests;

public sealed class CompletionProjectStageTests
{
    [Fact]
    public async Task FrameworkReadyCompletionRemainsIncompleteUntilFullProjectContext()
    {
        var cache = new AsyncSingleFlightCache<string, ProjectStage>();
        var frameworkPublished = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseFullProject = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var load = cache.GetOrStart(
            "page",
            async (_, publishIntermediate) =>
            {
                Assert.True(publishIntermediate(
                    new ProjectStage(XamlLanguageServer.XamlProjectStage.Framework)));
                frameworkPublished.SetResult();
                await releaseFullProject.Task;
                return new ProjectStage(XamlLanguageServer.XamlProjectStage.Full);
            });

        await frameworkPublished.Task;
        Assert.True(cache.TryGetLatest("page", out var frameworkStage));
        var frameworkReady = XamlLanguageServer.ApplyProjectStageToCompletionList(
            new CompletionList
            {
                Items = new List<CompletionItem>
                {
                    new() { Label = "Button" },
                },
            },
            frameworkStage.Stage);

        Assert.True(frameworkReady.IsIncomplete);
        Assert.Equal("Button", Assert.Single(frameworkReady.Items).Label);

        releaseFullProject.SetResult();
        var fullStage = Assert.IsType<ProjectStage>(await load);
        var projectReady = XamlLanguageServer.ApplyProjectStageToCompletionList(
            new CompletionList(),
            fullStage.Stage);

        Assert.False(projectReady.IsIncomplete);
    }

    private sealed record ProjectStage(XamlLanguageServer.XamlProjectStage Stage);
}
