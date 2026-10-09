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

    [Fact]
    public async Task CompletionCanUseFullStaleContextOnlyWhileReplacementLoads()
    {
        var cache = new AsyncSingleFlightCache<string, ProjectStage>();
        await cache.GetOrStart(
            "page",
            () => Task.FromResult<ProjectStage?>(
                new ProjectStage(XamlLanguageServer.XamlProjectStage.Full)));
        cache.RestartAllPreservingLatest();

        var releaseReplacement = new TaskCompletionSource<ProjectStage?>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var replacement = cache.GetOrStart("page", () => releaseReplacement.Task);

        Assert.True(cache.TryGetStale("page", out var stale));
        var completion = XamlLanguageServer.ApplyProjectStageToCompletionList(
            new CompletionList
            {
                Items = [new CompletionItem { Label = "ProjectMember" }],
            },
            stale.Stage);
        Assert.False(completion.IsIncomplete);
        Assert.Equal("ProjectMember", Assert.Single(completion.Items).Label);

        releaseReplacement.SetResult(null);
        Assert.Null(await replacement);
        Assert.False(cache.TryGetStale("page", out _));
    }

    private sealed record ProjectStage(XamlLanguageServer.XamlProjectStage Stage);
}
