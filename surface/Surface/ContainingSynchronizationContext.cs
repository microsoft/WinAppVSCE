using System;
using System.Threading;

namespace Surface;

/// <summary>
/// UI-thread SynchronizationContext that contains app-code exceptions escaping posted callbacks (see
/// <see cref="App.TryContainCallbackException"/>). Host exceptions still propagate and stay fatal.
/// </summary>
internal sealed class ContainingSynchronizationContext : SynchronizationContext
{
    private readonly SynchronizationContext _inner;

    public ContainingSynchronizationContext(SynchronizationContext inner) => _inner = inner;

    public override void Post(SendOrPostCallback d, object? state) => _inner.Post(Wrap(d), state);

    public override void Send(SendOrPostCallback d, object? state) => _inner.Send(d, state);

    public override SynchronizationContext CreateCopy() => this;

    private static SendOrPostCallback Wrap(SendOrPostCallback d) => s =>
    {
        try
        {
            d(s);
        }
        catch (Exception ex) when (App.TryContainCallbackException(ex))
        {
        }
    };
}
