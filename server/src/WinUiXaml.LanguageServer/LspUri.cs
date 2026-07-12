namespace WinUiXaml.LanguageServer;

/// <summary>
/// Conversions between LSP document URIs and Windows filesystem paths.
/// </summary>
/// <remarks>
/// Kept separate (and internal, exposed to tests via InternalsVisibleTo) because the encoding rules
/// are subtle: VS Code sends file URIs with a <b>percent-encoded drive colon</b> (<c>file:///c%3A/…</c>),
/// and <see cref="System.Uri.LocalPath"/> mishandles that form — it yields <c>\c:\…</c>, which later
/// roots against the current drive as <c>C:\c:\…</c> and breaks every project lookup. We decode the
/// absolute path ourselves so both <c>file:///c:/…</c> and <c>file:///c%3A/…</c> converge.
/// </remarks>
internal static class LspUri
{
    public static string? ToPath(string? uri)
    {
        if (string.IsNullOrWhiteSpace(uri))
        {
            return null;
        }

        // Already a Windows filesystem path (drive-letter or UNC)? Accept defensively. Any other
        // scheme (untitled:, http:, git:, …) has no local file to resolve, so return null.
        if (!uri.StartsWith("file:", StringComparison.OrdinalIgnoreCase))
        {
            return IsWindowsPath(uri) ? uri : null;
        }

        Uri parsed;
        try
        {
            parsed = new Uri(uri);
        }
        catch (UriFormatException)
        {
            return null;
        }

        if (!parsed.IsFile)
        {
            return null;
        }

        var path = Uri.UnescapeDataString(parsed.AbsolutePath).Replace('/', '\\');

        if (!string.IsNullOrEmpty(parsed.Host))
        {
            // UNC: file://server/share/... -> \\server\share\...
            return $"\\\\{parsed.Host}{path}";
        }

        // Drop the spurious leading slash before a "<drive>:" segment ("\c:\Users" -> "c:\Users").
        if (path.Length >= 3 && path[0] == '\\' && char.IsLetter(path[1]) && path[2] == ':')
        {
            path = path[1..];
        }

        return path;
    }

    public static string FromPath(string path) => new Uri(path).AbsoluteUri;

    private static bool IsWindowsPath(string s) =>
        (s.Length >= 2 && char.IsLetter(s[0]) && s[1] == ':') ||
        s.StartsWith(@"\\", StringComparison.Ordinal);
}
