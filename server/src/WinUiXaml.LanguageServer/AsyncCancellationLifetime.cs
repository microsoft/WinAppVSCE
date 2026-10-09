namespace WinUiXaml.LanguageServer;

/// <summary>Signals cancellation without running callbacks on the caller and owns final CTS disposal.</summary>
internal sealed class AsyncCancellationLifetime : IAsyncDisposable
{
    private readonly object _gate = new();
    private CancellationTokenSource? _source = new();
    private Task? _cancellationTask;
    private readonly CancellationToken _token;

    internal AsyncCancellationLifetime()
    {
        _token = _source.Token;
    }

    internal CancellationToken Token => _token;
    internal bool IsCancellationRequested => _token.IsCancellationRequested;

    internal void Cancel()
    {
        lock (_gate)
        {
            if (_source is not null && _cancellationTask is null)
            {
                _cancellationTask = _source.CancelAsync();
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        CancellationTokenSource? source;
        Task? cancellationTask;
        lock (_gate)
        {
            source = _source;
            cancellationTask = _cancellationTask;
            _source = null;
            _cancellationTask = null;
        }

        if (cancellationTask is not null)
        {
            await cancellationTask.ConfigureAwait(false);
        }

        source?.Dispose();
    }
}
