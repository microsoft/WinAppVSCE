using System.Collections.Concurrent;

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
        Assert.True(cache.TryGetLatest("page", out var latest));
        Assert.Equal("fresh", latest.Name);
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

    [Fact]
    public async Task PerKeyInvalidationCancelsSupersededLoad()
    {
        var cache = new AsyncSingleFlightCache<string, Value>();
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var cancelled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var stale = cache.GetOrStart("page", async cancellationToken =>
        {
            started.SetResult();
            try
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
                return new Value("stale");
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                cancelled.SetResult();
                throw;
            }
        });
        await started.Task;

        cache.Invalidate("page");
        await cancelled.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Null(await stale);

        var fresh = await cache.GetOrStart(
            "page",
            _ => Task.FromResult<Value?>(new Value("fresh")));
        Assert.Equal("fresh", fresh?.Name);
    }

    [Fact]
    public async Task GlobalInvalidationCancelsEverySupersededLoad()
    {
        var cache = new AsyncSingleFlightCache<string, Value>();
        var started = new CountdownEvent(2);
        var cancelled = new ConcurrentBag<string>();

        Task<Value?> Start(string key) => cache.GetOrStart(key, async cancellationToken =>
        {
            started.Signal();
            try
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
                return new Value(key);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                cancelled.Add(key);
                throw;
            }
        });

        var first = Start("first");
        var second = Start("second");
        Assert.True(started.Wait(TimeSpan.FromSeconds(5)));

        cache.InvalidateAll();

        Assert.Null(await first);
        Assert.Null(await second);
        Assert.Equal(new[] { "first", "second" }, cancelled.OrderBy(key => key));
    }

    [Fact]
    public async Task InvalidationDoesNotWaitForCancellationCallbacks()
    {
        var cache = new AsyncSingleFlightCache<string, Value>();
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var callbackRelease =
            new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var stale = cache.GetOrStart("page", async cancellationToken =>
        {
            using var registration = cancellationToken.Register(
                () => callbackRelease.Task.GetAwaiter().GetResult());
            started.SetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            return new Value("stale");
        });
        await started.Task;

        var invalidate = Task.Run(() => cache.Invalidate("page"));
        try
        {
            await invalidate.WaitAsync(TimeSpan.FromSeconds(1));
        }
        finally
        {
            callbackRelease.TrySetResult();
        }

        Assert.Null(await stale);
    }

    [Fact]
    public async Task CompletionRacingInvalidationNeverThrowsOrPublishesStaleValue()
    {
        for (var iteration = 0; iteration < 250; iteration++)
        {
            var cache = new AsyncSingleFlightCache<string, Value>();
            var release = new TaskCompletionSource<Value?>(
                TaskCreationOptions.RunContinuationsAsynchronously);
            var stale = cache.GetOrStart("page", _ => release.Task);

            var invalidate = Task.Run(() => cache.Invalidate("page"));
            release.TrySetResult(new Value("stale"));
            await invalidate;
            await stale;

            var fresh = await cache.GetOrStart(
                "page",
                _ => Task.FromResult<Value?>(new Value("fresh")));
            Assert.Equal("fresh", fresh?.Name);
            Assert.True(cache.TryGetReady("page", out var ready));
            Assert.Equal("fresh", ready.Name);
        }
    }

    [Fact]
    public async Task AcceptedSnapshotRemainsAvailableDuringPerKeyReplacement()
    {
        var cache = new AsyncSingleFlightCache<string, Value>();
        await cache.GetOrStart(
            "page",
            () => Task.FromResult<Value?>(new Value("first")));

        cache.Invalidate("page");
        var replacementRelease =
            new TaskCompletionSource<Value?>(TaskCreationOptions.RunContinuationsAsynchronously);
        var replacement = cache.GetOrStart(
            "page",
            () => replacementRelease.Task);

        Assert.False(cache.TryGetReady("page", out _));
        Assert.True(cache.TryGetLatest("page", out var first));
        Assert.Equal("first", first.Name);

        replacementRelease.SetResult(new Value("second"));
        Assert.Equal("second", (await replacement)?.Name);
        Assert.True(cache.TryGetLatest("page", out var second));
        Assert.Equal("second", second.Name);
    }

    [Fact]
    public async Task PerKeyDiscardRemovesAcceptedSnapshot()
    {
        var cache = new AsyncSingleFlightCache<string, Value>();
        await cache.GetOrStart(
            "page",
            () => Task.FromResult<Value?>(new Value("first")));

        cache.Invalidate("page", discardLatest: true);

        Assert.False(cache.TryGetReady("page", out _));
        Assert.False(cache.TryGetLatest("page", out _));
    }

    [Fact]
    public async Task GlobalDiscardRemovesAllAcceptedSnapshots()
    {
        var cache = new AsyncSingleFlightCache<string, Value>();
        await cache.GetOrStart(
            "page",
            () => Task.FromResult<Value?>(new Value("first")));
        await cache.GetOrStart(
            "app",
            () => Task.FromResult<Value?>(new Value("second")));

        cache.InvalidateAll(discardLatest: true);

        Assert.False(cache.TryGetLatest("page", out _));
        Assert.False(cache.TryGetLatest("app", out _));
    }

    private sealed record Value(string Name);
}
