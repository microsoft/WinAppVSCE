#nullable enable

using System.Collections.Generic;
using System.Text;

namespace WinUIXamlPreview.Protocol
{
    /// <summary>
    /// Buffers raw socket chunks and yields complete newline-delimited UTF-8 lines. Base64 image
    /// payloads never contain a newline, so splitting on '\n' is a safe framing boundary. Mirrors
    /// the <c>LineDecoder</c> in <c>protocol.ts</c>.
    /// </summary>
    internal sealed class LineDecoder
    {
        private readonly List<byte> _buffer = new List<byte>(64 * 1024);

        public IEnumerable<string> Push(byte[] chunk, int count)
        {
            for (int i = 0; i < count; i++)
            {
                byte b = chunk[i];
                if (b == (byte)'\n')
                {
                    yield return Flush();
                }
                else
                {
                    _buffer.Add(b);
                }
            }
        }

        private string Flush()
        {
            // Tolerate CRLF by trimming a trailing '\r'.
            int len = _buffer.Count;
            if (len > 0 && _buffer[len - 1] == (byte)'\r')
            {
                len--;
            }

            var s = Encoding.UTF8.GetString(_buffer.ToArray(), 0, len);
            _buffer.Clear();
            return s;
        }
    }
}
