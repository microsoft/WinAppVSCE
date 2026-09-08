using System.Text;
using WinUiXaml.LanguageServer.Lsp;

namespace WinUiXaml.LanguageServer.Tests;

public class JsonRpcConnectionTests
{
    [Fact]
    public async Task CancelNotificationInterruptsInflightRequest()
    {
        var request = Frame("""{"jsonrpc":"2.0","id":1,"method":"slow"}""");
        var cancel = Frame("""{"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":1}}""");
        await using var input = new MemoryStream(request.Concat(cancel).ToArray());
        await using var output = new MemoryStream();
        var connection = new JsonRpcConnection(input, output)
        {
            OnRequest = async (_, _, cancellationToken) =>
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
                return null;
            },
        };

        await connection.RunAsync();

        var response = Encoding.UTF8.GetString(output.ToArray());
        Assert.Contains("\"code\":-32800", response);
    }

    [Fact]
    public async Task SlowRequestDoesNotBlockLaterRequest()
    {
        var first = Frame("""{"jsonrpc":"2.0","id":1,"method":"slow"}""");
        var second = Frame("""{"jsonrpc":"2.0","id":2,"method":"fast"}""");
        await using var input = new MemoryStream(first.Concat(second).ToArray());
        await using var output = new MemoryStream();
        var releaseSlow = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var fastHandled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var connection = new JsonRpcConnection(input, output)
        {
            OnRequest = async (method, _, _) =>
            {
                if (method == "slow")
                {
                    await releaseSlow.Task;
                }
                else
                {
                    fastHandled.SetResult();
                }
                return method;
            },
        };

        var run = connection.RunAsync();
        await fastHandled.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.False(run.IsCompleted, "The slow request should still be in flight when the fast request runs.");
        releaseSlow.SetResult();
        await run;

        var response = Encoding.UTF8.GetString(output.ToArray());
        Assert.Contains("\"id\":1", response);
        Assert.Contains("\"id\":2", response);
    }

    [Fact]
    public async Task SlowRequestDoesNotBlockLaterNotification()
    {
        var request = Frame("""{"jsonrpc":"2.0","id":1,"method":"slow"}""");
        var notification = Frame("""{"jsonrpc":"2.0","method":"textDocument/didChange"}""");
        await using var input = new MemoryStream(request.Concat(notification).ToArray());
        await using var output = new MemoryStream();
        var releaseSlow = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var notificationHandled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var connection = new JsonRpcConnection(input, output)
        {
            OnRequest = async (_, _, _) =>
            {
                await releaseSlow.Task;
                return null;
            },
            OnNotification = (method, _) =>
            {
                if (method == "textDocument/didChange")
                {
                    notificationHandled.SetResult();
                }
                return Task.CompletedTask;
            },
        };

        var run = connection.RunAsync();
        await notificationHandled.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.False(run.IsCompleted, "The notification should run before the slow request completes.");
        releaseSlow.SetResult();
        await run;
    }

    [Fact]
    public async Task EndOfInputCancelsInflightRequest()
    {
        await using var input = new MemoryStream(
            Frame("""{"jsonrpc":"2.0","id":1,"method":"slow"}"""));
        await using var output = new MemoryStream();
        var connection = new JsonRpcConnection(input, output)
        {
            OnRequest = async (_, _, cancellationToken) =>
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
                return null;
            },
        };

        await connection.RunAsync().WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Contains("\"code\":-32800", Encoding.UTF8.GetString(output.ToArray()));
    }

    [Fact]
    public async Task ExpectedRequestFailureUsesLspRequestFailedCode()
    {
        await using var input = new MemoryStream(
            Frame("""{"jsonrpc":"2.0","id":1,"method":"fail"}"""));
        await using var output = new MemoryStream();
        var connection = new JsonRpcConnection(input, output)
        {
            OnRequest = (_, _, _) =>
                throw new RequestFailedException("Expected capability failure"),
        };

        await connection.RunAsync();

        var response = Encoding.UTF8.GetString(output.ToArray());
        Assert.Contains("\"code\":-32803", response);
        Assert.Contains("Expected capability failure", response);
    }

    [Fact]
    public async Task OversizedContentLengthIsRejectedWithoutAllocating()
    {
        // Without the bound this reaches `new byte[int.MaxValue]` and dies with OutOfMemoryException.
        var frame = Encoding.ASCII.GetBytes($"Content-Length: {int.MaxValue}\r\n\r\n");
        await using var input = new MemoryStream(frame);
        await using var output = new MemoryStream();
        var handled = false;
        var connection = new JsonRpcConnection(input, output)
        {
            OnRequest = (_, _, _) => { handled = true; return Task.FromResult<object?>(null); },
        };

        await connection.RunAsync().WaitAsync(TimeSpan.FromSeconds(5));

        Assert.False(handled, "An oversized frame should never reach a handler.");
    }

    [Fact]
    public async Task UnparsableContentLengthEndsTheConnectionInsteadOfFramingAnEmptyBody()
    {
        // A silent fall-through leaves Content-Length at 0, frames an empty body, and leaves the
        // real body bytes in the stream to be misread as the next frame's headers.
        var malformed = Encoding.ASCII.GetBytes("Content-Length: not-a-number\r\n\r\n");
        var valid = Frame("""{"jsonrpc":"2.0","id":1,"method":"ping"}""");
        await using var input = new MemoryStream(malformed.Concat(valid).ToArray());
        await using var output = new MemoryStream();
        var methods = new List<string>();
        var connection = new JsonRpcConnection(input, output)
        {
            OnRequest = (method, _, _) => { methods.Add(method); return Task.FromResult<object?>(null); },
        };

        await connection.RunAsync().WaitAsync(TimeSpan.FromSeconds(5));

        Assert.Empty(methods);
    }

    [Fact]
    public async Task NegativeContentLengthIsRejected()
    {
        await using var input = new MemoryStream(Encoding.ASCII.GetBytes("Content-Length: -5\r\n\r\n"));
        await using var output = new MemoryStream();
        var connection = new JsonRpcConnection(input, output);

        await connection.RunAsync().WaitAsync(TimeSpan.FromSeconds(5));

        Assert.Empty(output.ToArray());
    }

    [Fact]
    public async Task OverlongHeaderLineEndsTheConnection()
    {
        // Exceeds the per-line limit while staying under the header-block limit, so this pins the
        // line cap specifically. Without it the oversized line is simply ignored and the following
        // frame dispatches normally.
        var overlong = Encoding.ASCII.GetBytes(new string('x', 16 * 1024) + "\r\n");
        var valid = Frame("""{"jsonrpc":"2.0","id":1,"method":"ping"}""");
        await using var input = new MemoryStream(overlong.Concat(valid).ToArray());
        await using var output = new MemoryStream();
        var handled = false;
        var connection = new JsonRpcConnection(input, output)
        {
            OnRequest = (_, _, _) => { handled = true; return Task.FromResult<object?>(null); },
        };

        await connection.RunAsync().WaitAsync(TimeSpan.FromSeconds(5));

        Assert.False(handled, "A frame behind an oversized header line should never reach a handler.");
    }

    [Fact]
    public async Task OversizedHeaderBlockEndsTheConnection()
    {
        // Every line is short, so only the accumulated block size can reject this.
        var filler = Encoding.ASCII.GetBytes(
            string.Concat(Enumerable.Repeat("X-Pad: 0123456789\r\n", 8 * 1024)));
        var valid = Frame("""{"jsonrpc":"2.0","id":1,"method":"ping"}""");
        await using var input = new MemoryStream(filler.Concat(valid).ToArray());
        await using var output = new MemoryStream();
        var handled = false;
        var connection = new JsonRpcConnection(input, output)
        {
            OnRequest = (_, _, _) => { handled = true; return Task.FromResult<object?>(null); },
        };

        await connection.RunAsync().WaitAsync(TimeSpan.FromSeconds(5));

        Assert.False(handled, "A frame behind an oversized header block should never reach a handler.");
    }

    [Fact]
    public async Task HeadersWithinTheLimitsStillDispatch()
    {
        var frame = Encoding.ASCII.GetBytes("X-Pad: 0123456789\r\n")
            .Concat(Frame("""{"jsonrpc":"2.0","id":1,"method":"ping"}"""))
            .ToArray();
        await using var input = new MemoryStream(frame);
        await using var output = new MemoryStream();
        var connection = new JsonRpcConnection(input, output)
        {
            OnRequest = (method, _, _) => Task.FromResult<object?>(method),
        };

        await connection.RunAsync().WaitAsync(TimeSpan.FromSeconds(5));

        Assert.Contains("\"result\":\"ping\"", Encoding.UTF8.GetString(output.ToArray()));
    }

    private static byte[] Frame(string json)
    {
        var body = Encoding.UTF8.GetBytes(json);
        return Encoding.ASCII
            .GetBytes($"Content-Length: {body.Length}\r\n\r\n")
            .Concat(body)
            .ToArray();
    }
}
