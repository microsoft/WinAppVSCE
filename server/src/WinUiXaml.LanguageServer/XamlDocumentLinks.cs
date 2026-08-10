using System;
using System.Collections.Generic;
using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Xaml;

namespace WinUiXaml.LanguageServer;

/// <summary>Provides document links for unambiguous local XAML asset paths.</summary>
internal static class XamlDocumentLinks
{
    /// <summary>Framework elements whose named attribute carries a package file path we resolve into a ctrl+click link.</summary>
    private static readonly (string Element, string Attribute, bool AppRootRelative)[] LinkableSources =
    {
        ("ResourceDictionary", "Source", false),
        ("Image", "Source", true),
        ("ImageIcon", "Source", true),
        ("ImageBrush", "ImageSource", true),
        ("BitmapImage", "UriSource", true),
        ("SvgImageSource", "UriSource", true),
    };

    private static (string Attribute, bool AppRootRelative)? FindLinkable(string localName)
    {
        foreach (var s in LinkableSources)
        {
            if (string.Equals(s.Element, localName, StringComparison.Ordinal))
            {
                return (s.Attribute, s.AppRootRelative);
            }
        }

        return null;
    }

    public static List<DocumentLink> Collect(
        TextDocument doc,
        string? documentDirectory,
        string? projectDirectory,
        Func<string, bool>? fileExists = null)
    {
        var exists = fileExists ?? System.IO.File.Exists;
        var result = new List<DocumentLink>();

        foreach (var node in doc.Parsed.DescendantNodesAndSelf())
        {
            // Only an unprefixed framework element; a prefixed local:Image / local:ResourceDictionary is a user type that happens to share the name, never linked.
            if (node is not XamlElement element ||
                element.Name is not { HasPrefix: false } elementName)
            {
                continue;
            }

            var spec = FindLinkable(elementName.LocalName);
            if (spec is null)
            {
                continue;
            }

            // The path must be a plain (non-markup) attribute value; the guard keeps a stray "{Binding …}" (a dynamically-sourced image or dictionary) from being treated as a path.
            if (element.GetAttribute(spec.Value.Attribute) is not { Value: { IsMarkupExtension: false } value })
            {
                continue;
            }

            string raw = value.Text;
            string trimmed = raw.Trim();
            if (trimmed.Length == 0)
            {
                continue;
            }

            string? target = ResolvePath(trimmed, documentDirectory, projectDirectory, exists, spec.Value.AppRootRelative);
            if (target == null)
            {
                continue;
            }

            // Cover exactly the trimmed path token (skip any whitespace inside the quotes) so ctrl+click lands on the path, never on padding or the quotes.
            int lead = 0;
            while (lead < raw.Length && char.IsWhiteSpace(raw[lead]))
            {
                lead++;
            }

            int start = value.InnerSpan.Start + lead;
            var span = new TextSpan(start, start + trimmed.Length);

            result.Add(new DocumentLink
            {
                Range = doc.RangeOf(span),
                Target = LspUri.FromPath(target),
            });
        }

        return result;
    }

    /// <summary>Maps a source value to an existing absolute file path, or null when it cannot be resolved (unknown base directory, foreign URI scheme</summary>
    public static string? ResolvePath(
        string value,
        string? documentDirectory,
        string? projectDirectory,
        Func<string, bool> exists,
        bool bareRelativeFromAppRoot = false)
    {
        if (value.StartsWith("ms-appx:", StringComparison.OrdinalIgnoreCase))
        {
            if (!Uri.TryCreate(value, UriKind.Absolute, out var uri))
            {
                return null;
            }

            // AbsolutePath drops the package/host segment for both ms-appx:/// and ms-appx://pkg/ forms.
            string appRel = Uri.UnescapeDataString(uri.AbsolutePath).TrimStart('/');
            return Combine(projectDirectory, appRel, exists);
        }

        // A different explicit scheme (http:, pack:, file:, …) — but NOT a bare "C:\" drive letter — is not a local resource we resolve.
        if (HasForeignUriScheme(value))
        {
            return null;
        }

        string normalized = value.Replace('\\', '/');

        if (normalized.StartsWith("/", StringComparison.Ordinal))
        {
            return Combine(projectDirectory, normalized.TrimStart('/'), exists);
        }

        return Combine(bareRelativeFromAppRoot ? projectDirectory : documentDirectory, normalized, exists);
    }

    private static string? Combine(string? baseDirectory, string relative, Func<string, bool> exists)
    {
        if (string.IsNullOrEmpty(baseDirectory) || relative.Length == 0)
        {
            return null;
        }

        string full;
        try
        {
            full = System.IO.Path.GetFullPath(System.IO.Path.Combine(baseDirectory, relative));
        }
        catch (Exception ex) when (ex is ArgumentException or System.IO.PathTooLongException or NotSupportedException)
        {
            return null;
        }

        return exists(full) ? full : null;
    }

    /// <summary>True when the value begins with a URI scheme other than a single-letter Windows drive (so C:\dir\x.xaml is treated as a path, while http:/pack:/file: are rejected).</summary>
    private static bool HasForeignUriScheme(string value)
    {
        int colon = value.IndexOf(':');
        if (colon <= 1)
        {
            // No colon, or a single leading char before ':' (a drive letter like "C:").
            return false;
        }

        for (int i = 0; i < colon; i++)
        {
            char c = value[i];
            bool ok = i == 0 ? char.IsLetter(c) : char.IsLetterOrDigit(c) || c is '+' or '-' or '.';
            if (!ok)
            {
                return false;
            }
        }

        return true;
    }
}
