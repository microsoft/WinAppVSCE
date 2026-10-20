using WinUiXaml.LanguageServer;
using Xunit;

namespace WinUiXaml.LanguageServer.Tests;

public class ProjectPromptLatchTests
{
    [Fact]
    public void NotifiesOnceWhileTheConditionHolds()
    {
        var latch = new ProjectPromptLatch();

        Assert.True(latch.ShouldNotify(@"C:\app\App.csproj"));
        Assert.False(latch.ShouldNotify(@"C:\app\App.csproj"));
        Assert.False(latch.ShouldNotify(@"C:\app\App.csproj"));
    }

    [Fact]
    public void TreatsProjectPathsCaseInsensitively()
    {
        var latch = new ProjectPromptLatch();

        Assert.True(latch.ShouldNotify(@"C:\app\App.csproj"));
        Assert.False(latch.ShouldNotify(@"c:\APP\app.csproj"));
    }

    [Fact]
    public void LatchesEachProjectIndependently()
    {
        var latch = new ProjectPromptLatch();

        Assert.True(latch.ShouldNotify(@"C:\app\App.csproj"));
        Assert.True(latch.ShouldNotify(@"C:\other\Other.csproj"));
    }

    // The regression this exists for: a user builds, the project loads, then the outputs go away
    // again (clean, branch switch). Without the re-arm the second outage is completely silent,
    // which is the failure mode the prompt was added to remove.
    [Fact]
    public void ReArmsAfterTheConditionClears()
    {
        var latch = new ProjectPromptLatch();
        Assert.True(latch.ShouldNotify(@"C:\app\App.csproj"));
        Assert.False(latch.ShouldNotify(@"C:\app\App.csproj"));

        latch.Clear(@"C:\app\App.csproj");

        Assert.True(latch.ShouldNotify(@"C:\app\App.csproj"));
    }

    [Fact]
    public void ClearsCaseInsensitivelyToMatchNotification()
    {
        var latch = new ProjectPromptLatch();
        latch.ShouldNotify(@"C:\app\App.csproj");

        latch.Clear(@"c:\APP\app.csproj");

        Assert.True(latch.ShouldNotify(@"C:\app\App.csproj"));
    }

    [Fact]
    public void ClearingAnUnknownProjectIsHarmless()
    {
        var latch = new ProjectPromptLatch();

        latch.Clear(@"C:\never\Seen.csproj");

        Assert.True(latch.ShouldNotify(@"C:\never\Seen.csproj"));
    }

    [Fact]
    public void ClearingOneProjectLeavesOthersLatched()
    {
        var latch = new ProjectPromptLatch();
        latch.ShouldNotify(@"C:\app\App.csproj");
        latch.ShouldNotify(@"C:\other\Other.csproj");

        latch.Clear(@"C:\app\App.csproj");

        Assert.True(latch.ShouldNotify(@"C:\app\App.csproj"));
        Assert.False(latch.ShouldNotify(@"C:\other\Other.csproj"));
    }
}
