using System;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Text.RegularExpressions;

namespace Surface;

/// <summary>
/// A generated placeholder picture for image slots in sample data (an <c>Image.Source</c> bound to a photo path, a
/// <c>Thumbnail</c> URI). The app's own assets aren't reachable from the preview, and a web URL or a word renders
/// nothing, so image slots get a local file showing a neutral "landscape" picture.
/// </summary>
internal static class SampleImage
{
    private const int Width = 240, Height = 160;
    private static readonly Lazy<string> LazyUri = new(Create);

    /// <summary><c>file:///…/placeholder.png</c>, written on first use.</summary>
    public static string Uri => LazyUri.Value;

    /// <summary>True for a member name that holds an image location (<c>ImagePath</c>, <c>Thumbnail</c>, <c>AvatarUrl</c>).</summary>
    public static bool IsImageName(string name) =>
        Regex.IsMatch(name.ToLowerInvariant(),
            "(image|img|photo|picture|thumbnail|thumb|avatar|logo|cover|banner|poster|artwork|headshot|portrait|backdrop)" +
            "(path|uri|url|location|source|src|file|filename|link)?$") ||
        Regex.IsMatch(name.ToLowerInvariant(), "^(icon|imagesource)(path|uri|url|location|src|file)$");

    private static string Create()
    {
        try
        {
            var dir = Path.Combine(Path.GetTempPath(), "wxp-sample");
            Directory.CreateDirectory(dir);
            var path = Path.Combine(dir, $"placeholder-{Width}x{Height}.png");
            if (!File.Exists(path))
            {
                var tmp = path + "." + Environment.ProcessId + ".tmp";
                File.WriteAllBytes(tmp, Png());
                try
                {
                    File.Move(tmp, path, overwrite: true);
                }
                catch (IOException)
                {
                    File.Delete(tmp); // another host wrote it first
                }
            }
            return new System.Uri(path).AbsoluteUri;
        }
        catch (Exception ex)
        {
            App.Log($"SAMPLE: placeholder image unavailable: {ex.GetType().Name}: {ex.Message}");
            return "ms-appx:///placeholder.png";
        }
    }

    /// <summary>A light-grey frame with a sun and two hills — the usual "picture goes here" glyph.</summary>
    internal static byte[] Png()
    {
        var raw = new byte[Height * (1 + Width * 3)];
        for (int y = 0; y < Height; y++)
        {
            int row = y * (1 + Width * 3);
            raw[row] = 0; // filter: none
            for (int x = 0; x < Width; x++)
            {
                byte r = 0xE6, g = 0xE8, b = 0xEB;
                double sx = x - Width * 0.72, sy = y - Height * 0.3;
                if (sx * sx + sy * sy < 14 * 14)
                {
                    (r, g, b) = (0xC4, 0xC9, 0xD0);
                }
                double hill1 = Height * 0.62 + Math.Abs(x - Width * 0.33) * 0.75;
                double hill2 = Height * 0.72 + Math.Abs(x - Width * 0.7) * 0.6;
                if (y > hill2)
                {
                    (r, g, b) = (0xA9, 0xB0, 0xBA);
                }
                else if (y > hill1)
                {
                    (r, g, b) = (0xB8, 0xBE, 0xC6);
                }
                int i = row + 1 + x * 3;
                raw[i] = r;
                raw[i + 1] = g;
                raw[i + 2] = b;
            }
        }

        using var ms = new MemoryStream();
        ms.Write(new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A });
        var ihdr = new byte[13];
        WriteBE(ihdr, 0, Width);
        WriteBE(ihdr, 4, Height);
        ihdr[8] = 8; // bit depth
        ihdr[9] = 2; // truecolour RGB
        Chunk(ms, "IHDR", ihdr);
        using (var z = new MemoryStream())
        {
            using (var zs = new ZLibStream(z, CompressionLevel.Optimal, leaveOpen: true))
            {
                zs.Write(raw);
            }
            Chunk(ms, "IDAT", z.ToArray());
        }
        Chunk(ms, "IEND", Array.Empty<byte>());
        return ms.ToArray();
    }

    private static void Chunk(Stream s, string type, byte[] data)
    {
        var len = new byte[4];
        WriteBE(len, 0, data.Length);
        s.Write(len);
        var typeBytes = Encoding.ASCII.GetBytes(type);
        s.Write(typeBytes);
        s.Write(data);
        uint crc = Crc(Crc(0xFFFFFFFFu, typeBytes), data) ^ 0xFFFFFFFFu;
        var c = new byte[4];
        WriteBE(c, 0, unchecked((int)crc));
        s.Write(c);
    }

    private static uint Crc(uint crc, byte[] data)
    {
        foreach (var d in data)
        {
            crc ^= d;
            for (int k = 0; k < 8; k++)
            {
                crc = (crc & 1) != 0 ? 0xEDB88320u ^ (crc >> 1) : crc >> 1;
            }
        }
        return crc;
    }

    private static void WriteBE(byte[] buf, int offset, int value)
    {
        buf[offset] = (byte)(value >> 24);
        buf[offset + 1] = (byte)(value >> 16);
        buf[offset + 2] = (byte)(value >> 8);
        buf[offset + 3] = (byte)value;
    }
}
