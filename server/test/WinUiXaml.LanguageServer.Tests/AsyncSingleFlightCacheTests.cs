namespace WinUiXaml.LanguageServer.Tests;

public sealed class AsyncSingleFlightCacheTests
{
    [Fact]
    public async Task ConcurrentRequestsShareOneLoadPerKey()
    {
        var cache = new AsyncSingleFlightCache<string, Value>();
        var release = new TaskCompletionSource<Value?>(TaskCreationOptions.RunContinuationsAsynchronously);
        var loads = 0;

        var tasks = Enumerable.Range(0, 20)
            .Select(_ => cache.GetOrStart("page", () =>
            {
                Interlocked.Increment(ref loads);
                return release.Task;
            }))
            .ToArray();

        Assert.Equal(1, Volatile.Read(ref loads));
        release.SetResult(new Value("ready"));
        await Task.WhenAll(tasks);
        Assert.True(cache.TryGetReady("page", out var ready));
        Assert.Equal("ready", ready.Name);
    }

    [Fact]
    public async Task NullFaultAndCancellationAreEvictedForRetry()
    {
        var cache = new AsyncSingleFlightCache<string, Value>();
        var attempts = 0;

        Assert.Null(await cache.GetOrStart("page", () =>
        {
            attempts++;
            return Task.FromResult<Value?>(null);
        }));
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            cache.GetOrStart("page", () =>
            {
                attempts++;
                return Task.FromException<Value?>(new InvalidOperationException("transient"));
            }));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            cache.GetOrStart("page", () =>
            {
                attempts++;
                return Task.FromCanceled<Value?>(new CancellationToken(canceled: true));
            }));

        var recovered = await cache.GetOrStart("page", () =>
        {
            attempts++;
            return Task.FromResult<Value?>(new Value("recovered"));
        });

        Assert.Equal(4, attempts);
        Assert.Equal("recovered", recovered?.Name);
    }

    [Fact]
    public async Task InvalidatedLoadCannotPublishAfterReplacement()
    {
        var cache = new AsyncSingleFlightCache<string, Value>();
        var staleRelease = new TaskCompletionSource<Value?>(TaskCreationOptions.RunContinuationsAsynchronously);
        var stale = cache.GetOrStart("page", () => staleRelease.Task);

        cache.InvalidateAll();
        var fresh = await cache.GetOrStart(
            "page",
            () => Task.FromResult<Value?>(new Value("fresh")));
        staleRelease.SetResult(new Value("stale"));
        Assert.Null(await stale);

        Assert.Equal("fresh", fresh?.Name);
        Assert.True(cache.TryGetReady("page", out var ready));
        Assert.Equal("fresh", ready.Name);
    }

    [Fact]
    public async Task PerKeyInvalidatedLoadCannotPublishAfterReplacement()
    {
        var cache = new AsyncSingleFlightCache<string, Value>();
        var staleRelease = new TaskCompletionSource<Value?>(TaskCreationOptions.RunContinuationsAsynchronously);
        var stale = cache.GetOrStart("page", () => staleRelease.Task);

        cache.Invalidate("page");
        var fresh = await cache.GetOrStart(
            "page",
            () => Task.FromResult<Value?>(new Value("fresh")));
        staleRelease.SetResult(new Value("stale"));
        Assert.Null(await stale);

        Assert.Equal("fresh", fresh?.Name);
        Assert.True(cache.TryGetReady("page", out var ready));
        Assert.Equal("fresh", ready.Name);
    }

    private sealed record Value(string Name);
}
