using System.Collections.Generic;

namespace WinUiXaml.LanguageServer;

/// <summary>Maps WinUI font-weight names to OpenType weight classes for completion details.</summary>
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
