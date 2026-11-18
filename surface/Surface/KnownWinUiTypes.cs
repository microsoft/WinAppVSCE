using System;
using System.Collections.Generic;
using System.IO;

namespace Surface;

/// <summary>
/// Every public <c>Microsoft.UI.Xaml.*</c> type name in the newest WinAppSDK (generated into the embedded
/// KnownWinUiTypes.txt by surface\Update-KnownWinUiTypes.ps1). A type this host's WinUI lacks is "newer" only
/// when it's on this list; anything else (a typo, a made-up name) is a genuine XAML error.
/// </summary>
internal static class KnownWinUiTypes
{
    internal const string ResourceName = "Surface.KnownWinUiTypes.txt";

    private static readonly Lazy<HashSet<string>> Names = new(Load);

    internal static bool Contains(string simpleName) => Names.Value.Contains(simpleName);

    internal static int Count => Names.Value.Count;

    private static HashSet<string> Load()
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        try
        {
            using var stream = typeof(KnownWinUiTypes).Assembly.GetManifestResourceStream(ResourceName);
            if (stream is null) return names;
            using var reader = new StreamReader(stream);
            while (reader.ReadLine() is string line)
            {
                line = line.Trim();
                if (line.Length > 0 && line[0] != '#') names.Add(line);
            }
        }
        catch (Exception)
        {
            // Empty list: every unknown type is reported as an error, the pre-newer-types behavior.
        }

        return names;
    }
}
