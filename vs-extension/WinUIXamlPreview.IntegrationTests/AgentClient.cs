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
            var line = _reader.ReadLine() ?? throw new IOException("agent pipe closed during " + cmd);
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
