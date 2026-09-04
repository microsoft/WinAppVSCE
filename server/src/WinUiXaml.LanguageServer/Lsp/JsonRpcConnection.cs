using System.Buffers;
using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;

namespace WinUiXaml.LanguageServer.Lsp;

/// <summary>Signals JSON-RPC error -32601.</summary>
internal sealed class MethodNotFoundException : Exception
{
    public MethodNotFoundException(string method) : base($"Method not found: {method}") { }
}

/// <summary>Signals LSP RequestFailed (-32803) for expected request-specific failures.</summary>
internal class RequestFailedException : Exception
{
    public RequestFailedException(string message) : base(message) { }
}

/// <summary>Provides concurrent JSON-RPC 2.0 requests over LSP framing.</summary>
internal sealed class JsonRpcConnection
{
    private const string ContentLengthHeader = "Content-Length:";

    private readonly Stream _input;
    private readonly Stream _output;
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _requestCancellations = new();
    private readonly ConcurrentDictionary<long, Task> _inflightRequests = new();
    private long _nextRequestSequence;

    public JsonRpcConnection(Stream input, Stream output)
    {
        _input = input;
        _output = output;
    }

    /// <summary>Handles a request (id + method). Return value is serialized as the JSON-RPC result.</summary>
    public Func<string, JsonElement?, CancellationToken, Task<object?>>? OnRequest { get; set; }

    /// <summary>Handles a notification (method, no id).</summary>
    public Func<string, JsonElement?, Task>? OnNotification { get; set; }

    /// <summary>Reads and dispatches messages until the input stream ends.</summary>
    public async Task RunAsync(CancellationToken cancellationToken = default)
    {
        using var connectionCancellation =
            CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        while (!connectionCancellation.IsCancellationRequested)
        {
            var body = await ReadMessageAsync(connectionCancellation.Token).ConfigureAwait(false);
            if (body == null)
            {
                connectionCancellation.Cancel();
                break;
            }

            await DispatchAsync(body, connectionCancellation.Token).ConfigureAwait(false);
        }

        if (_inflightRequests.Count > 0)
        {
            await Task.WhenAll(_inflightRequests.Values).ConfigureAwait(false);
        }
    }

    public Task SendNotificationAsync(string method, object @params)
    {
        var payload = new Dictionary<string, object?>
        {
            ["jsonrpc"] = "2.0",
            ["method"] = method,
            ["params"] = @params,
        };
        return WriteMessageAsync(payload);
    }

    private async Task DispatchAsync(byte[] body, CancellationToken connectionToken)
    {
        IncomingMessage? message;
        try
        {
            message = JsonSerializer.Deserialize<IncomingMessage>(body, LspJson.Options);
        }
        catch (JsonException ex)
        {
            Log($"malformed message: {ex.Message}");
            return;
        }

        if (message?.Method == null)
        {
            return; // a response to a server->client request; nothing to do yet
        }

        if (message.Id is { } id)
        {
            var sequence = Interlocked.Increment(ref _nextRequestSequence);
            var task = HandleRequestAsync(id, message.Method, message.Params, connectionToken);
            _inflightRequests[sequence] = task;
            _ = task.ContinueWith(
                completed => _inflightRequests.TryRemove(sequence, out _),
                CancellationToken.None,
                TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
        }
        else if (message.Method == "$/cancelRequest")
        {
            CancelRequest(message.Params);
        }
        else if (OnNotification != null)
        {
            try
            {
                await OnNotification(message.Method, message.Params).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                Log($"notification '{message.Method}' failed: {ex}");
            }
        }
    }

    private async Task HandleRequestAsync(
        JsonElement id,
        string method,
        JsonElement? @params,
        CancellationToken connectionToken)
    {
        object? result = null;
        ResponseError? error = null;
        var requestKey = id.GetRawText();
        using var requestCancellation = CancellationTokenSource.CreateLinkedTokenSource(connectionToken);
        _requestCancellations[requestKey] = requestCancellation;

        try
        {
            result = OnRequest != null
                ? await OnRequest(method, @params, requestCancellation.Token).ConfigureAwait(false)
                : throw new MethodNotFoundException(method);
        }
        catch (MethodNotFoundException)
        {
            error = new ResponseError(-32601, $"Method not found: {method}");
        }
        catch (OperationCanceledException) when (requestCancellation.IsCancellationRequested)
        {
            error = new ResponseError(-32800, $"Request cancelled: {method}");
        }
        catch (RequestFailedException ex)
        {
            error = new ResponseError(-32803, ex.Message);
        }
        catch (Exception ex)
        {
            Log($"request '{method}' failed: {ex}");
            error = new ResponseError(-32603, ex.Message);
        }

        finally
        {
            _requestCancellations.TryRemove(requestKey, out _);
        }

        var payload = new Dictionary<string, object?>
        {
            ["jsonrpc"] = "2.0",
            ["id"] = id,
        };
        if (error != null)
        {
            payload["error"] = error;
        }
        else
        {
            payload["result"] = result;
        }

        await WriteMessageAsync(payload).ConfigureAwait(false);
    }

    private void CancelRequest(JsonElement? @params)
    {
        if (@params is not { ValueKind: JsonValueKind.Object } value
            || !value.TryGetProperty("id", out var id))
        {
            return;
        }

        if (_requestCancellations.TryGetValue(id.GetRawText(), out var cancellation))
        {
            cancellation.Cancel();
        }
    }

    private async Task<byte[]?> ReadMessageAsync(CancellationToken cancellationToken)
    {
        int contentLength = -1;

        while (true)
        {
            var line = await ReadHeaderLineAsync(cancellationToken).ConfigureAwait(false);
            if (line == null)
            {
                return null; // stream closed
            }

            if (line.Length == 0)
            {
                break; // blank line ends the header block
            }

            if (line.StartsWith(ContentLengthHeader, StringComparison.OrdinalIgnoreCase))
            {
                var value = line.Substring(ContentLengthHeader.Length).Trim();
                int.TryParse(value, out contentLength);
            }
        }

        if (contentLength < 0)
        {
            Log("missing Content-Length header");
            return null;
        }

        var buffer = new byte[contentLength];
        int read = 0;
        while (read < contentLength)
        {
            int n = await _input.ReadAsync(buffer.AsMemory(read, contentLength - read), cancellationToken).ConfigureAwait(false);
            if (n == 0)
            {
                return null; // truncated
            }

            read += n;
        }

        return buffer;
    }

    private async Task<string?> ReadHeaderLineAsync(CancellationToken cancellationToken)
    {
        var bytes = new ArrayBufferWriter<byte>(64);
        var one = new byte[1];
        int prev = -1;

        while (true)
        {
            int n = await _input.ReadAsync(one.AsMemory(0, 1), cancellationToken).ConfigureAwait(false);
            if (n == 0)
            {
                return bytes.WrittenCount == 0 ? null : Encoding.ASCII.GetString(bytes.WrittenSpan);
            }

            int b = one[0];
            if (b == '\n')
            {
                var span = bytes.WrittenSpan;
                int length = span.Length;
                if (prev == '\r' && length > 0)
                {
                    length--; // drop the trailing CR
                }

                return Encoding.ASCII.GetString(span.Slice(0, length));
            }

            bytes.Write(one.AsSpan(0, 1));
            prev = b;
        }
    }

    private async Task WriteMessageAsync(object payload)
    {
        var json = JsonSerializer.SerializeToUtf8Bytes(payload, LspJson.Options);
        var header = Encoding.ASCII.GetBytes($"Content-Length: {json.Length}\r\n\r\n");

        await _writeLock.WaitAsync().ConfigureAwait(false);
        try
        {
            await _output.WriteAsync(header).ConfigureAwait(false);
            await _output.WriteAsync(json).ConfigureAwait(false);
            await _output.FlushAsync().ConfigureAwait(false);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    private static void Log(string message) => Console.Error.WriteLine($"[winui-xaml-ls] {message}");
}
