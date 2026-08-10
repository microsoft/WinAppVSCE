using System;
using System.Collections.Generic;
using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Xaml;

namespace WinUiXaml.LanguageServer;

/// <summary>Provides LSP color support for complete XAML hex attribute values.</summary>
internal static class XamlColor
{
    public static List<ColorInformation> Collect(TextDocument doc)
    {
        var result = new List<ColorInformation>();
        foreach (var node in doc.Parsed.DescendantNodesAndSelf())
        {
            if (node is not XamlAttribute attr || attr.IsNamespaceDeclaration)
            {
                continue;
            }

            if (attr.Value is not { IsMarkupExtension: false } value)
            {
                continue;
            }

            string raw = value.Text;
            string trimmed = raw.Trim();
            if (!TryParseHex(trimmed, out byte a, out byte r, out byte g, out byte b))
            {
                continue;
            }

            int lead = 0;
            while (lead < raw.Length && char.IsWhiteSpace(raw[lead]))
            {
                lead++;
            }

            int start = value.InnerSpan.Start + lead;
            var span = new TextSpan(start, start + trimmed.Length);
            result.Add(new ColorInformation { Range = doc.RangeOf(span), Color = ToColor(a, r, g, b) });
        }

        return result;
    }

    /// <summary>Offers hex write-backs for a picked color, over the exact range of the existing literal.</summary>
    public static List<ColorPresentation> Present(Lsp.Color color, Lsp.Range range)
    {
        byte a = ToByte(color.Alpha);
        byte r = ToByte(color.Red);
        byte g = ToByte(color.Green);
        byte b = ToByte(color.Blue);

        string rgb = $"#{r:X2}{g:X2}{b:X2}";
        string argb = $"#{a:X2}{r:X2}{g:X2}{b:X2}";

        var list = new List<ColorPresentation>();
        if (a == 255)
        {
            Add(list, rgb, range);
            Add(list, argb, range);
        }
        else
        {
            Add(list, argb, range);
            Add(list, rgb, range);
        }

        return list;
    }

    /// <summary>Parses a XAML hex color. Returns false unless the whole string is a valid #RGB/#ARGB/#RRGGBB/#AARRGGBB.</summary>
    public static bool TryParseHex(string text, out byte a, out byte r, out byte g, out byte b)
    {
        a = r = g = b = 0;
        if (string.IsNullOrEmpty(text) || text[0] != '#')
        {
            return false;
        }

        int n = text.Length - 1;
        if (n != 3 && n != 4 && n != 6 && n != 8)
        {
            return false;
        }

        for (int i = 1; i < text.Length; i++)
        {
            if (!IsHex(text[i]))
            {
                return false;
            }
        }

        switch (n)
        {
            case 3: // RGB  -> each nibble doubled
                a = 255;
                r = (byte)(Nibble(text[1]) * 17);
                g = (byte)(Nibble(text[2]) * 17);
                b = (byte)(Nibble(text[3]) * 17);
                break;
            case 4: // ARGB (nibbles)
                a = (byte)(Nibble(text[1]) * 17);
                r = (byte)(Nibble(text[2]) * 17);
                g = (byte)(Nibble(text[3]) * 17);
                b = (byte)(Nibble(text[4]) * 17);
                break;
            case 6: // RRGGBB
                a = 255;
                r = Byte(text, 1);
                g = Byte(text, 3);
                b = Byte(text, 5);
                break;
            case 8: // AARRGGBB
                a = Byte(text, 1);
                r = Byte(text, 3);
                g = Byte(text, 5);
                b = Byte(text, 7);
                break;
        }

        return true;
    }

    private static Lsp.Color ToColor(byte a, byte r, byte g, byte b) => new()
    {
        Red = r / 255.0,
        Green = g / 255.0,
        Blue = b / 255.0,
        Alpha = a / 255.0,
    };

    private static void Add(List<ColorPresentation> list, string hex, Lsp.Range range) =>
        list.Add(new ColorPresentation { Label = hex, TextEdit = new TextEdit { Range = range, NewText = hex } });

    private static byte ToByte(double channel) => (byte)Math.Clamp((int)Math.Round(channel * 255.0), 0, 255);

    private static bool IsHex(char c) =>
        (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');

    private static int Nibble(char c) =>
        c <= '9' ? c - '0' : (char.ToLowerInvariant(c) - 'a' + 10);

    private static byte Byte(string text, int index) =>
        (byte)((Nibble(text[index]) << 4) | Nibble(text[index + 1]));
}
