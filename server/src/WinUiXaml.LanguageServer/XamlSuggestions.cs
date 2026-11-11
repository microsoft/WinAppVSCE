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

    /// <summary>The one name that completes a partially typed name or differs from it by a single whole word; null when none or several match.</summary>
    public static string? RelatedName(string target, IEnumerable<string> candidates)
    {
        if (string.IsNullOrEmpty(target) || target.Length < 3 || candidates is null)
        {
            return null;
        }

        var targetWords = Words(target);
        string? match = null;
        foreach (var candidate in candidates.Distinct(StringComparer.Ordinal))
        {
            if (string.IsNullOrEmpty(candidate) || string.Equals(candidate, target, StringComparison.Ordinal) ||
                !candidate.StartsWith(target, StringComparison.OrdinalIgnoreCase) &&
                !DifferByOneWord(targetWords, Words(candidate)))
            {
                continue;
            }

            if (match is not null)
            {
                return null;
            }
            match = candidate;
        }

        return match;
    }

    // PascalCase words; an acronym ends before a capital that starts a lowercase word (UIElement -> UI, Element).
    private static string[] Words(string name)
    {
        var words = new List<string>();
        int start = 0;
        for (int i = 1; i < name.Length; i++)
        {
            if (char.IsUpper(name[i]) &&
                (!char.IsUpper(name[i - 1]) || i + 1 < name.Length && char.IsLower(name[i + 1])))
            {
                words.Add(name.Substring(start, i - start));
                start = i;
            }
        }
        words.Add(name.Substring(start));
        return words.ToArray();
    }

    private static bool DifferByOneWord(string[] a, string[] b)
    {
        var (shorter, longer) = a.Length < b.Length ? (a, b) : (b, a);
        if (longer.Length != shorter.Length + 1)
        {
            return false;
        }

        for (int skip = 0; skip < longer.Length; skip++)
        {
            if (longer.Where((_, i) => i != skip).SequenceEqual(shorter, StringComparer.OrdinalIgnoreCase))
            {
                return true;
            }
        }
        return false;
    }

    /// <summary>Case-insensitive edit distance counting adjacent swaps as one typo, bailing out (returning threshold + 1) once a row exceeds the threshold.</summary>
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

        var beforePrev = new int[m + 1];
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
                // Swapped letters count as one typo, except in 2-letter words where a swap reverses the word.
                if (i > 1 && j > 1 && n >= 3 &&
                    ai == char.ToLowerInvariant(b[j - 2]) &&
                    char.ToLowerInvariant(a[i - 2]) == char.ToLowerInvariant(b[j - 1]))
                {
                    cur[j] = Math.Min(cur[j], beforePrev[j - 2] + 1);
                }
                if (cur[j] < rowMin)
                {
                    rowMin = cur[j];
                }
            }

            if (rowMin > threshold)
            {
                return threshold + 1;
            }

            (beforePrev, prev, cur) = (prev, cur, beforePrev);
        }

        return prev[m];
    }
}
