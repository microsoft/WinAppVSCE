using System;
using System.Collections.Generic;
using System.Linq;

namespace WinUiXaml.LanguageServer;

/// <summary>"Did you mean …?" spelling correction: ranks a set of valid candidate names by their closeness to a mistyped name so a code action can offer the nearest matches.</summary>
internal static class XamlSuggestions
{
    /// <summary>Returns up to max candidate names within an adaptive edit-distance threshold of target, best first.</summary>
    public static IReadOnlyList<string> Nearest(string target, IEnumerable<string> candidates, int max = 3)
    {
        if (string.IsNullOrEmpty(target) || candidates is null)
        {
            return Array.Empty<string>();
        }

        // Allow more slack for longer names, but never so much that unrelated names slip in.
        int threshold = target.Length <= 4 ? 1 : target.Length <= 8 ? 2 : 3;

        var scored = new List<(string Name, int Dist)>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var candidate in candidates)
        {
            if (string.IsNullOrEmpty(candidate) || !seen.Add(candidate) ||
                string.Equals(candidate, target, StringComparison.Ordinal))
            {
                continue;
            }

            int distance = Distance(target, candidate, threshold);
            if (distance <= threshold)
            {
                scored.Add((candidate, distance));
            }
        }

        return scored
            .OrderBy(s => s.Dist)
            .ThenByDescending(s => SharesFirstLetter(target, s.Name))
            .ThenBy(s => s.Name, StringComparer.OrdinalIgnoreCase)
            .Take(max)
            .Select(s => s.Name)
            .ToList();
    }

    private static bool SharesFirstLetter(string a, string b) =>
        a.Length > 0 && b.Length > 0 && char.ToLowerInvariant(a[0]) == char.ToLowerInvariant(b[0]);

    /// <summary>Case-insensitive Levenshtein distance, bailing out early (returning threshold + 1) once every cell in a row exceeds the threshold — the caller only cares about near matches.</summary>
    private static int Distance(string a, string b, int threshold)
    {
        int n = a.Length;
        int m = b.Length;
        if (Math.Abs(n - m) > threshold)
        {
            return threshold + 1;
        }
        if (n == 0)
        {
            return m;
        }
        if (m == 0)
        {
            return n;
        }

        var prev = new int[m + 1];
        var cur = new int[m + 1];
        for (int j = 0; j <= m; j++)
        {
            prev[j] = j;
        }

        for (int i = 1; i <= n; i++)
        {
            cur[0] = i;
            int rowMin = cur[0];
            char ai = char.ToLowerInvariant(a[i - 1]);
            for (int j = 1; j <= m; j++)
            {
                int cost = ai == char.ToLowerInvariant(b[j - 1]) ? 0 : 1;
                cur[j] = Math.Min(Math.Min(cur[j - 1] + 1, prev[j] + 1), prev[j - 1] + cost);
                if (cur[j] < rowMin)
                {
                    rowMin = cur[j];
                }
            }

            if (rowMin > threshold)
            {
                return threshold + 1;
            }

            (prev, cur) = (cur, prev);
        }

        return prev[m];
    }
}
