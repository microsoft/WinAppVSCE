using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.Json.Nodes;

namespace WinUIXamlPreview.IntegrationTests
{
    /// <summary>Line-JSON client for the TestAgent's named pipe.</summary>
    internal sealed class AgentClient : IDisposable
    {
        private readonly NamedPipeClientStream _pipe;
        private readonly StreamReader _reader;
        private readonly StreamWriter _writer;

        private AgentClient(NamedPipeClientStream pipe)
        {
            _pipe = pipe;
            _reader = new StreamReader(pipe, new UTF8Encoding(false));
            _writer = new StreamWriter(pipe, new UTF8Encoding(false)) { AutoFlush = true };
        }

        public static AgentClient? TryConnect(string name, int timeoutMs)
        {
            var pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut);
            try
            {
                pipe.Connect(timeoutMs);
                return new AgentClient(pipe);
            }
            catch (Exception)
            {
                pipe.Dispose();
                return null;
            }
        }

        private static readonly TimeSpan CallTimeout = TimeSpan.FromMinutes(2);

        public JsonNode? Call(string cmd, object? args = null)
        {
            var req = new JsonObject { ["cmd"] = cmd };
            if (args != null)
            {
                foreach (var p in args.GetType().GetProperties())
                {
                    req[p.Name] = JsonValue.Create(p.GetValue(args));
                }
            }

            _writer.WriteLine(req.ToJsonString());
            // A hidden modal dialog blocks the UI thread forever; fail the run instead of hanging it.
            var read = _reader.ReadLineAsync();
            if (!read.Wait(CallTimeout))
            {
                Dispose();
                throw new IOException($"agent did not answer '{cmd}' within {CallTimeout.TotalSeconds:0}s (VS is probably showing a modal dialog)");
            }
            var line = read.Result ?? throw new IOException("agent pipe closed during " + cmd);
            var resp = JsonNode.Parse(line)!.AsObject();
            if (resp["ok"]?.GetValue<bool>() != true)
            {
                throw new AgentException(cmd + ": " + resp["error"]);
            }
            return resp["result"];
        }

        public void Dispose()
        {
            try { _pipe.Dispose(); } catch { }
        }
    }

    internal sealed class AgentException : Exception
    {
        public AgentException(string message) : base(message) { }
    }
}
