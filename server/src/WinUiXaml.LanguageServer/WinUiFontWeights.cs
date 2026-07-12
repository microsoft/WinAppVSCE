using System.Collections.Generic;

namespace WinUiXaml.LanguageServer;

/// <summary>
/// The numeric OpenType weight class (100–950) for each WinUI 3 named font weight
/// (<c>Microsoft.UI.Text.FontWeights</c>), used ONLY to enrich font-weight value completion — the
/// completion item's <c>Detail</c> is set to this number so the author sees, e.g., <c>Bold</c> ⇒ <c>700</c>,
/// matching the numeric weight Visual Studio surfaces.
/// <para>
/// The completion NAMES themselves come from the live SDK
/// (<see cref="Workspace.XamlTypeSystem.GetFontWeights"/>), so this table only needs to COVER those names:
/// a name absent from the map is still offered (with a generic detail), so the feature degrades gracefully
/// and carries no SDK-drift risk. The numbers are the standard USWeightClass values WinUI's
/// <c>FontWeights</c> uses (including the Windows-specific <c>SemiLight</c> = 350 and <c>ExtraBlack</c> = 950).
/// </para>
/// </summary>
internal static class WinUiFontWeights
{
    /// <summary>Named font weight ⇒ its numeric weight class (as a string, for the completion <c>Detail</c>).</summary>
    public static readonly IReadOnlyDictionary<string, string> WeightByName = new Dictionary<string, string>(System.StringComparer.Ordinal)
    {
        ["Thin"] = "100",
        ["ExtraLight"] = "200",
        ["Light"] = "300",
        ["SemiLight"] = "350",
        ["Normal"] = "400",
        ["Medium"] = "500",
        ["SemiBold"] = "600",
        ["Bold"] = "700",
        ["ExtraBold"] = "800",
        ["Black"] = "900",
        ["ExtraBlack"] = "950",
    };
}
