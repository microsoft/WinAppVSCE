using System;

namespace WinUiXaml.LanguageServer;

/// <summary>Provides common stable WinUI theme-resource keys for completion.</summary>
internal static class WinUiThemeResources
{
    /// <summary>Theme-resource keys sorted by the client.</summary>
    public static readonly string[] Keys =
    {
        // --- Text block styles ---
        "CaptionTextBlockStyle",
        "BodyTextBlockStyle",
        "BodyStrongTextBlockStyle",
        "SubtitleTextBlockStyle",
        "TitleTextBlockStyle",
        "TitleLargeTextBlockStyle",
        "DisplayTextBlockStyle",

        // --- Control styles ---
        "AccentButtonStyle",

        // --- Corner radii ---
        "ControlCornerRadius",
        "OverlayCornerRadius",

        // --- Accent colors ---
        "SystemAccentColor",
        "SystemAccentColorLight1",
        "SystemAccentColorLight2",
        "SystemAccentColorLight3",
        "SystemAccentColorDark1",
        "SystemAccentColorDark2",
        "SystemAccentColorDark3",

        // --- Accent fill brushes ---
        "AccentFillColorDefaultBrush",
        "AccentFillColorSecondaryBrush",
        "AccentFillColorTertiaryBrush",
        "AccentFillColorDisabledBrush",

        // --- Text fill brushes ---
        "TextFillColorPrimaryBrush",
        "TextFillColorSecondaryBrush",
        "TextFillColorTertiaryBrush",
        "TextFillColorDisabledBrush",
        "TextOnAccentFillColorPrimaryBrush",
        "TextOnAccentFillColorSecondaryBrush",
        "TextOnAccentFillColorDisabledBrush",

        // --- Control fill brushes ---
        "ControlFillColorDefaultBrush",
        "ControlFillColorSecondaryBrush",
        "ControlFillColorTertiaryBrush",
        "ControlFillColorDisabledBrush",

        // --- Subtle fill brushes ---
        "SubtleFillColorTransparentBrush",
        "SubtleFillColorSecondaryBrush",
        "SubtleFillColorTertiaryBrush",
        "SubtleFillColorDisabledBrush",

        // --- Card brushes ---
        "CardBackgroundFillColorDefaultBrush",
        "CardBackgroundFillColorSecondaryBrush",
        "CardStrokeColorDefaultBrush",

        // --- Layer brushes ---
        "LayerFillColorDefaultBrush",

        // --- Solid background brushes ---
        "SolidBackgroundFillColorBaseBrush",
        "SolidBackgroundFillColorSecondaryBrush",
        "SolidBackgroundFillColorTertiaryBrush",
        "SolidBackgroundFillColorBaseAltBrush",

        // --- Stroke brushes ---
        "ControlStrokeColorDefaultBrush",
        "ControlStrokeColorSecondaryBrush",
        "ControlStrongStrokeColorDefaultBrush",
        "ControlStrongStrokeColorDisabledBrush",
        "DividerStrokeColorDefaultBrush",
        "SurfaceStrokeColorDefaultBrush",
        "FocusStrokeColorOuterBrush",
        "FocusStrokeColorInnerBrush",

        // --- System state brushes ---
        "SystemFillColorSuccessBrush",
        "SystemFillColorCautionBrush",
        "SystemFillColorCriticalBrush",
        "SystemFillColorAttentionBrush",
        "SystemFillColorNeutralBrush",
        "SystemFillColorSuccessBackgroundBrush",
        "SystemFillColorCautionBackgroundBrush",
        "SystemFillColorCriticalBackgroundBrush",
        "SystemFillColorAttentionBackgroundBrush",
        "SystemFillColorNeutralBackgroundBrush",
    };

    /// <summary>Infers the metadata type name of a curated theme resource from its key-name suffix convention (*Brush → Brush, *CornerRadius → CornerRadius, *Style → Style</summary>
    public static string? InferTypeMetadataName(string key)
    {
        if (key.EndsWith("Brush", StringComparison.Ordinal))
        {
            return "Microsoft.UI.Xaml.Media.Brush";
        }

        if (key.EndsWith("CornerRadius", StringComparison.Ordinal))
        {
            return "Microsoft.UI.Xaml.CornerRadius";
        }

        if (key.EndsWith("Style", StringComparison.Ordinal))
        {
            return "Microsoft.UI.Xaml.Style";
        }

        if (key.EndsWith("Color", StringComparison.Ordinal) ||
            key.StartsWith("SystemAccentColor", StringComparison.Ordinal))
        {
            return "Windows.UI.Color";
        }

        return null;
    }
}
