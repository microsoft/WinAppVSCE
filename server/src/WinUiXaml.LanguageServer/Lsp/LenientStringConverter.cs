using System.Buffers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace WinUiXaml.LanguageServer.Lsp;

/// <summary>Reads document text that System.Text.Json rejects, such as an escaped unpaired surrogate.
/// Each invalid code unit becomes U+FFFD, which keeps offsets stable and matches what the editor saves.</summary>
internal sealed class LenientStringConverter : JsonConverter<string>
{
    public override string? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.Null)
        {
            return string.Empty;
        }

        if (reader.TokenType != JsonTokenType.String)
        {
            throw new JsonException($"Expected a string but found {reader.TokenType}.");
        }

        try
        {
            return reader.GetString();
        }
        catch (InvalidOperationException)
        {
            byte[] raw = reader.HasValueSequence ? reader.ValueSequence.ToArray() : reader.ValueSpan.ToArray();
            return Decode(raw);
        }
    }

    public override void Write(Utf8JsonWriter writer, string value, JsonSerializerOptions options) =>
        writer.WriteStringValue(value);

    /// <summary>Unescapes raw JSON string bytes, decoding invalid UTF-8 and unpaired surrogates as U+FFFD.</summary>
    internal static string Decode(ReadOnlySpan<byte> raw)
    {
        var builder = new StringBuilder(raw.Length);
        var utf8 = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: false);
        int literalStart = 0;
        int i = 0;
        while (i < raw.Length)
        {
            if (raw[i] != (byte)'\\')
            {
                i++;
                continue;
            }

            builder.Append(utf8.GetString(raw.Slice(literalStart, i - literalStart)));
            char escaped = i + 1 < raw.Length ? (char)raw[i + 1] : '\\';
            i += 2;
            switch (escaped)
            {
                case 'b': builder.Append('\b'); break;
                case 'f': builder.Append('\f'); break;
                case 'n': builder.Append('\n'); break;
                case 'r': builder.Append('\r'); break;
                case 't': builder.Append('\t'); break;
                case 'u' when i + 4 <= raw.Length &&
                    ushort.TryParse(Encoding.ASCII.GetString(raw.Slice(i, 4)), System.Globalization.NumberStyles.HexNumber, null, out var code):
                    builder.Append((char)code);
                    i += 4;
                    break;
                default: builder.Append(escaped); break;
            }

            literalStart = i;
        }

        builder.Append(utf8.GetString(raw.Slice(Math.Min(literalStart, raw.Length))));
        return ReplaceUnpairedSurrogates(builder);
    }

    private static string ReplaceUnpairedSurrogates(StringBuilder text)
    {
        for (int i = 0; i < text.Length; i++)
        {
            if (char.IsHighSurrogate(text[i]) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1]))
            {
                i++;
            }
            else if (char.IsSurrogate(text[i]))
            {
                text[i] = '\uFFFD';
            }
        }

        return text.ToString();
    }
}
