namespace WinUiXaml.LanguageServer;

/// <summary>Converts LSP document URIs to Windows paths.</summary> <remarks>Handles percent-encoded drive colons that <see cref="System.Uri.LocalPath"/> misinterprets.</remarks>
internal static class LspUri
{
    public static string? ToPath(string? uri)
    {
        if (string.IsNullOrWhiteSpace(uri))
        {
            return null;
        }

        // Non-file URI schemes have no local path.
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
