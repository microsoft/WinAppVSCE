using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Workspace;
using WinUiXaml.Xaml;

namespace WinUiXaml.LanguageServer;

/// <summary>Provides LSP color support for complete XAML hex and named attribute values.</summary>
internal static class XamlColor
{
    /// <summary>
    /// Named-color tables, cached per <see cref="XamlTypeSystem.GetNamedColors"/> result instance.
    /// That method caches its list on the (immutable) compilation, so the list reference is a safe
    /// and self-invalidating cache key.
    /// </summary>
    private static readonly ConditionalWeakTable<object, NamedColorTable> Tables = new();

    public static List<ColorInformation> Collect(TextDocument doc, XamlTypeSystem typeSystem)
    {
        var result = new List<ColorInformation>();
        foreach (var node in doc.Parsed.DescendantNodesAndSelf())
        {
            if (node is not XamlAttribute attr || attr.IsNamespaceDeclaration)
            {
                continue;
            }

            if (attr.Value is not { IsMarkupExtension: false } value ||
                !XamlSemanticFacts.IsColorAttribute(attr, typeSystem))
            {
                continue;
            }

            string raw = value.Text;
            string trimmed = raw.Trim();
            if (!TryParseHex(trimmed, out byte a, out byte r, out byte g, out byte b) &&
                !TryParseNamedColor(trimmed, typeSystem, out a, out r, out g, out b))
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

    /// <summary>
    /// Offers write-backs for a picked color, over the exact range of the existing literal.
    /// When the picked color is exactly a WinUI named color, that name is offered too; if the literal
    /// being replaced was itself a name, the name is offered FIRST so that accepting the default does
    /// not silently rewrite a symbolic <c>Red</c> into <c>#FFFF0000</c>.
    /// </summary>
    public static List<ColorPresentation> Present(
        Lsp.Color color,
        Lsp.Range range,
        XamlTypeSystem typeSystem,
        string? existingText)
    {
        byte a = ToByte(color.Alpha);
        byte r = ToByte(color.Red);
        byte g = ToByte(color.Green);
        byte b = ToByte(color.Blue);

        string rgb = $"#{r:X2}{g:X2}{b:X2}";
        string argb = $"#{a:X2}{r:X2}{g:X2}{b:X2}";

        string? name = FindColorName(a, r, g, b, typeSystem, existingText);
        bool preferName = name is not null &&
            existingText is not null &&
            IsKnownColorName(existingText.Trim(), typeSystem, out _);

        var list = new List<ColorPresentation>();
        if (preferName)
        {
            Add(list, name!, range);
        }

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

        if (name is not null && !preferName)
        {
            Add(list, name, range);
        }

        return list;
    }

    /// <summary>
    /// Resolves a WinUI named color (<c>Red</c>, <c>CornflowerBlue</c>, <c>Transparent</c>, …) to its ARGB.
    /// </summary>
    /// <remarks>
    /// Membership is gated on <see cref="XamlTypeSystem.GetNamedColors"/>, which discovers the real
    /// <c>Microsoft.UI.Colors</c> surface from the referenced SDK. <see cref="System.Drawing.Color.FromName"/>
    /// is used ONLY to look up the channel values of a name that already passed that gate: it also resolves
    /// .NET *system* colors (<c>Control</c>, <c>Desktop</c>, <c>ActiveBorder</c>, <c>Highlight</c>, …) that
    /// WinUI does not have and that throw <c>XamlParseException</c> at runtime, so it must never decide validity.
    /// Matching is case-insensitive because the WinUI XAML parser accepts <c>red</c> and <c>RED</c> as readily
    /// as <c>Red</c>, matching <see cref="XamlValueConverter"/>'s validation.
    /// </remarks>
    public static bool TryParseNamedColor(
        string text,
        XamlTypeSystem typeSystem,
        out byte a,
        out byte r,
        out byte g,
        out byte b)
    {
        a = r = g = b = 0;
        if (!IsKnownColorName(text, typeSystem, out uint packed))
        {
            return false;
        }

        a = (byte)(packed >> 24);
        r = (byte)(packed >> 16);
        g = (byte)(packed >> 8);
        b = (byte)packed;
        return true;
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

    private static bool IsKnownColorName(string text, XamlTypeSystem typeSystem, out uint packed)
    {
        packed = 0;
        return !string.IsNullOrEmpty(text) && GetTable(typeSystem).ByName.TryGetValue(text, out packed);
    }

    /// <summary>
    /// The WinUI color name whose ARGB is exactly the given channels, or null. Several names can share a
    /// value (Aqua/Cyan, Fuchsia/Magenta); the caller's existing spelling wins so a picked color that did
    /// not change keeps the exact token the user wrote, otherwise the first declared name is used.
    /// </summary>
    private static string? FindColorName(
        byte a,
        byte r,
        byte g,
        byte b,
        XamlTypeSystem typeSystem,
        string? existingText)
    {
        uint packed = ((uint)a << 24) | ((uint)r << 16) | ((uint)g << 8) | b;
        var table = GetTable(typeSystem);

        string? existing = existingText?.Trim();
        if (!string.IsNullOrEmpty(existing) &&
            table.ByName.TryGetValue(existing, out uint existingPacked) &&
            existingPacked == packed)
        {
            return existing;
        }

        foreach (var (name, value) in table.Ordered)
        {
            if (value == packed)
            {
                return name;
            }
        }

        return null;
    }

    private static NamedColorTable GetTable(XamlTypeSystem typeSystem)
    {
        var names = typeSystem.GetNamedColors();
        return Tables.GetValue(names, static key => NamedColorTable.Build((IReadOnlyList<string>)key));
    }

    private static Lsp.Color ToColor(byte a, byte r, byte g, byte b) => new()
    {
        Red = r / 255.0,
        Green = g / 255.0,
        Blue = b / 255.0,
        Alpha = a / 255.0,
    };

    private static void Add(List<ColorPresentation> list, string label, Lsp.Range range) =>
        list.Add(new ColorPresentation { Label = label, TextEdit = new TextEdit { Range = range, NewText = label } });

    private static byte ToByte(double channel) => (byte)Math.Clamp((int)Math.Round(channel * 255.0), 0, 255);

    private static bool IsHex(char c) =>
        (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');

    private static int Nibble(char c) =>
        c <= '9' ? c - '0' : (char.ToLowerInvariant(c) - 'a' + 10);

    private static byte Byte(string text, int index) =>
        (byte)((Nibble(text[index]) << 4) | Nibble(text[index + 1]));

    /// <summary>A resolved WinUI-name -> ARGB map, plus the declared order for stable reverse lookups.</summary>
    private sealed class NamedColorTable
    {
        private NamedColorTable(Dictionary<string, uint> byName, List<(string Name, uint Argb)> ordered)
        {
            ByName = byName;
            Ordered = ordered;
        }

        public Dictionary<string, uint> ByName { get; }

        public List<(string Name, uint Argb)> Ordered { get; }

        public static NamedColorTable Build(IReadOnlyList<string> names)
        {
            var byName = new Dictionary<string, uint>(names.Count, StringComparer.OrdinalIgnoreCase);
            var ordered = new List<(string, uint)>(names.Count);

            foreach (var name in names)
            {
                // Color.FromName is pure managed lookup (no GDI+) and resolves every WinUI color name to
                // its exact W3C ARGB. A WinUI name it does not know (future SDK drift) simply gets no swatch.
                var color = System.Drawing.Color.FromName(name);
                if (!color.IsKnownColor)
                {
                    continue;
                }

                uint packed = ((uint)color.A << 24) | ((uint)color.R << 16) | ((uint)color.G << 8) | color.B;
                if (byName.TryAdd(name, packed))
                {
                    ordered.Add((name, packed));
                }
            }

            return new NamedColorTable(byName, ordered);
        }
    }
}
