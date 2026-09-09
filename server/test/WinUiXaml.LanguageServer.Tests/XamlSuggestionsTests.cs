using System;
using System.Collections.Generic;
using System.Linq;
using WinUiXaml.LanguageServer;
using Xunit;

namespace WinUiXaml.LanguageServer.Tests;

/// <summary>
/// Hermetic coverage for <see cref="XamlSuggestions"/>, the "Did you mean …?" ranker that powers the
/// unknown-name quick fixes. Pure and deterministic — no server, no project load. Asserts near-match
/// ranking, the case-insensitive scoring that makes a XAML casing slip the top fix, the adaptive threshold
/// that keeps unrelated names out, the max cap, edge inputs, and the deterministic ordering.
/// </summary>
public class XamlSuggestionsTests
{
    [Fact]
    public void NearMisspelling_RanksTheIntendedNameFirst()
    {
        var result = XamlSuggestions.Nearest("Buton", new[] { "Button", "TextBlock", "Border", "Grid" });
        Assert.Equal("Button", result[0]);
    }

    [Fact]
    public void CasingOnlySlip_ScoresBestAndRanksFirst()
    {
        // XAML is case-sensitive, so 'background' is invalid and 'Background' is the fix. A pure casing
        // difference is distance 0 under the case-insensitive metric, beating any real edit.
        var result = XamlSuggestions.Nearest("background", new[] { "Foreground", "Background" });
        Assert.Equal("Background", result[0]);
    }

    [Fact]
    public void CaseDifferentExactMatch_IsOffered_ButOrdinalEqualIsSkipped()
    {
        // 'Button' differs from 'button' only in case -> a real, offerable fix.
        Assert.Contains("Button", XamlSuggestions.Nearest("button", new[] { "Button" }));

        // An ordinal-equal candidate would be a no-op edit -> never offered.
        Assert.Empty(XamlSuggestions.Nearest("Button", new[] { "Button" }));
    }

    [Fact]
    public void FarName_IsRejectedByThreshold()
    {
        // "Xyz" (len 3 -> threshold 1) is nowhere near "Button".
        Assert.Empty(XamlSuggestions.Nearest("Xyz", new[] { "Button" }));
    }

    [Fact]
    public void LongName_AllowsMoreSlackThanShortName()
    {
        // "HorizontalAligment" -> "HorizontalAlignment" is a single insertion in a long name (threshold 3).
        Assert.Equal("HorizontalAlignment", XamlSuggestions.Nearest("HorizontalAligment", new[] { "HorizontalAlignment", "VerticalAlignment" })[0]);
    }

    [Fact]
    public void ResultIsCappedAtMax()
    {
        var candidates = new[] { "Grid", "Gird", "Grod", "Griz", "Grix", "Grib" };
        var result = XamlSuggestions.Nearest("Grid", candidates, max: 3);
        Assert.True(result.Count <= 3);
    }

    [Fact]
    public void SmallerDistanceOutranksLargerDistance()
    {
        // "Buton" -> "Button" is distance 1; "Border" is farther.
        var result = XamlSuggestions.Nearest("Buton", new[] { "Border", "Button" });
        Assert.Equal("Button", result[0]);
    }

    [Fact]
    public void SharedFirstLetter_BreaksTiesOverAlphabetical()
    {
        // Both "Bxrd" and "Aord" are one substitution from "Bord". Alphabetically "Aord" sorts first, but
        // the shared-first-letter tiebreak must promote "Bxrd" (same initial as the target).
        var result = XamlSuggestions.Nearest("Bord", new[] { "Aord", "Bxrd" });
        Assert.Equal(new[] { "Bxrd", "Aord" }, result);
    }

    [Fact]
    public void Ordering_IsDeterministic()
    {
        var candidates = new[] { "Button", "Buton", "Btton", "Border" };
        var a = XamlSuggestions.Nearest("Buttn", candidates);
        var b = XamlSuggestions.Nearest("Buttn", candidates);
        Assert.Equal(a, b);
    }

    [Fact]
    public void EmptyOrNullInputs_ReturnEmpty()
    {
        Assert.Empty(XamlSuggestions.Nearest("", new[] { "Button" }));
        Assert.Empty(XamlSuggestions.Nearest(null!, new[] { "Button" }));
        Assert.Empty(XamlSuggestions.Nearest("Button", null!));
        Assert.Empty(XamlSuggestions.Nearest("Button", Array.Empty<string>()));
    }

    [Fact]
    public void EmptyAndDuplicateCandidates_AreIgnored()
    {
        var result = XamlSuggestions.Nearest("Buton", new[] { "", "Button", "Button", null! }.Where(x => x != null).ToArray());
        Assert.Equal(new[] { "Button" }, result);
    }
}
