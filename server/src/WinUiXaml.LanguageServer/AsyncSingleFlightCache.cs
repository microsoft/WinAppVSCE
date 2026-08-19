namespace WinUiXaml.LanguageServer;

/// <summary>Generation-aware single-flight cache with a non-blocking ready-value lookup.</summary>
internal sealed class AsyncSingleFlightCache<TKey, TValue> where TKey : notnull where TValue : class
{
    private readonly object _gate = new();
    private readonly Dictionary<TKey, Entry> _entries;
    private readonly Dictionary<TKey, TValue> _ready;
    private readonly Dictionary<TKey, TValue> _latest;
    private long _generation;

    public AsyncSingleFlightCache(IEqualityComparer<TKey>? comparer = null)
    {
        _entries = new Dictionary<TKey, Entry>(comparer);
        _ready = new Dictionary<TKey, TValue>(comparer);
        _latest = new Dictionary<TKey, TValue>(comparer);
    }

    public Task<TValue?> GetOrStart(TKey key, Func<Task<TValue?>> factory)
        => GetOrStart(key, _ => factory());

    public Task<TValue?> GetOrStart(
        TKey key,
        Func<CancellationToken, Task<TValue?>> factory)
        => GetOrStart(key, (cancellationToken, _) => factory(cancellationToken));

    public Task<TValue?> GetOrStart(
        TKey key,
        Func<CancellationToken, Func<TValue, bool>, Task<TValue?>> factory)
    {
        Entry entry;
        lock (_gate)
        {
            if (_entries.TryGetValue(key, out entry!))
            {
                return entry.Task.Value;
            }

            var generation = _generation;
            var cancellation = new AsyncCancellationLifetime();
            entry = null!;
            entry = new Entry(new Lazy<Task<TValue?>>(
                () => RunAsync(key, entry, generation, factory),
                LazyThreadSafetyMode.ExecutionAndPublication),
                cancellation);
            _entries.Add(key, entry);
        }

        return entry.Task.Value;
    }

    public bool TryGetReady(TKey key, out TValue value)
    {
        lock (_gate)
        {
            return _ready.TryGetValue(key, out value!);
        }
    }

    public bool TryGetLatest(TKey key, out TValue value)
    {
        lock (_gate)
        {
            return _latest.TryGetValue(key, out value!);
        }
    }

    public void Invalidate(TKey key, bool discardLatest = false)
    {
        Entry? removed;
        lock (_gate)
        {
            _entries.Remove(key, out removed);
            _ready.Remove(key);
            if (discardLatest)
            {
                _latest.Remove(key);
            }
        }

        if (removed is not null)
        {
            CancelIfRunning(removed);
        }
    }

    public void InvalidateAll(bool discardLatest = true)
    {
        Entry[] removed;
        lock (_gate)
        {
            _generation++;
            removed = _entries.Values.ToArray();
            _entries.Clear();
            _ready.Clear();
            if (discardLatest)
            {
                _latest.Clear();
            }
        }

        foreach (var entry in removed)
        {
            CancelIfRunning(entry);
        }
    }

    private static void CancelIfRunning(Entry entry)
        => entry.Cancel();

    private async Task<TValue?> RunAsync(
        TKey key,
        Entry entry,
        long generation,
        Func<CancellationToken, Func<TValue, bool>, Task<TValue?>> factory)
    {
        var cancellationToken = entry.CancellationToken;
        try
        {
            var value = await factory(
                cancellationToken,
                intermediate => TryPublishIntermediate(
                    key,
                    entry,
                    generation,
                    intermediate)).ConfigureAwait(false);
            lock (_gate)
            {
                if (!_entries.TryGetValue(key, out var current) ||
                    !ReferenceEquals(current, entry) ||
                    generation != _generation)
                {
                    return null;
                }

                if (value is null)
                {
                    _entries.Remove(key);
                }
                else
                {
                    _ready[key] = value;
                    _latest[key] = value;
                }
            }

            return value;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return null;
        }
        catch
        {
            lock (_gate)
            {
                if (_entries.TryGetValue(key, out var current) && ReferenceEquals(current, entry))
                {
                    _entries.Remove(key);
                    _ready.Remove(key);
                }
            }
            throw;
        }
        finally
        {
            await entry.DisposeCancellationAsync().ConfigureAwait(false);
        }
    }

    private bool TryPublishIntermediate(
        TKey key,
        Entry entry,
        long generation,
        TValue value)
    {
        lock (_gate)
        {
            if (!_entries.TryGetValue(key, out var current) ||
                !ReferenceEquals(current, entry) ||
                generation != _generation)
            {
                return false;
            }

            _latest[key] = value;
            return true;
        }
    }

    private sealed class Entry
    {
        private readonly AsyncCancellationLifetime _cancellation;

        internal Entry(
            Lazy<Task<TValue?>> task,
            AsyncCancellationLifetime cancellation)
        {
            Task = task;
            _cancellation = cancellation;
            CancellationToken = cancellation.Token;
        }

        internal Lazy<Task<TValue?>> Task { get; }
        internal CancellationToken CancellationToken { get; }

        internal void Cancel()
            => _cancellation.Cancel();

        internal async ValueTask DisposeCancellationAsync()
            => await _cancellation.DisposeAsync().ConfigureAwait(false);
    }
}
