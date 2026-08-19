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

    private static byte[] Frame(string json)
    {
        var body = Encoding.UTF8.GetBytes(json);
        return Encoding.ASCII
            .GetBytes($"Content-Length: {body.Length}\r\n\r\n")
            .Concat(body)
            .ToArray();
    }
}
