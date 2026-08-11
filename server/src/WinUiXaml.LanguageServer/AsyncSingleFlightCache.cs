namespace WinUiXaml.LanguageServer;

/// <summary>Generation-aware single-flight cache with a non-blocking ready-value lookup.</summary>
internal sealed class AsyncSingleFlightCache<TKey, TValue> where TKey : notnull where TValue : class
{
    private readonly object _gate = new();
    private readonly Dictionary<TKey, Entry> _entries;
    private readonly Dictionary<TKey, TValue> _ready;
    private long _generation;

    public AsyncSingleFlightCache(IEqualityComparer<TKey>? comparer = null)
    {
        _entries = new Dictionary<TKey, Entry>(comparer);
        _ready = new Dictionary<TKey, TValue>(comparer);
    }

    public Task<TValue?> GetOrStart(TKey key, Func<Task<TValue?>> factory)
    {
        Entry entry;
        lock (_gate)
        {
            if (_entries.TryGetValue(key, out entry!))
            {
                return entry.Task.Value;
            }

            var generation = _generation;
            entry = null!;
            entry = new Entry(new Lazy<Task<TValue?>>(
                () => RunAsync(key, entry, generation, factory),
                LazyThreadSafetyMode.ExecutionAndPublication));
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

    public void Invalidate(TKey key)
    {
        lock (_gate)
        {
            _entries.Remove(key);
            _ready.Remove(key);
        }
    }

    public void InvalidateAll()
    {
        lock (_gate)
        {
            _generation++;
            _entries.Clear();
            _ready.Clear();
        }
    }

    private async Task<TValue?> RunAsync(
        TKey key,
        Entry entry,
        long generation,
        Func<Task<TValue?>> factory)
    {
        try
        {
            var value = await factory().ConfigureAwait(false);
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
                }
            }

            return value;
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
    }

    private sealed record Entry(Lazy<Task<TValue?>> Task);
}
