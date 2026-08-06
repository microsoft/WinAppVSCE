using System;

namespace WinUiXaml.LanguageServer;

/// <summary>
/// A curated set of common WinUI 3 (Windows App SDK) theme resource keys — Fluent brushes, text
/// styles, colors, and corner radii that ship in <c>XamlControlsResources</c>. These feed
/// <c>{StaticResource}</c>/<c>{ThemeResource}</c> key completion alongside the project's own
/// document-local and App.xaml resources.
/// <para>
/// The Windows App SDK compiles its theme dictionaries into the framework (they are not restored as
/// loose XAML), so this list is hand-curated to the well-established, high-confidence keys rather than
/// extracted from the SDK. It is intentionally a common subset, not exhaustive; it errs toward names
/// that have been stable across releases. It is only used for completion suggestions, never for
/// validation, so an occasional omission simply means a key is not suggested.
/// </para>
/// </summary>
internal static class WinUiThemeResources
{
    /// <summary>The curated theme resource keys, in no particular order (the client sorts by key).</summary>
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

    /// <summary>
    /// Infers the metadata type name of a curated theme resource from its key-name suffix convention
    /// (<c>*Brush</c> → <c>Brush</c>, <c>*CornerRadius</c> → <c>CornerRadius</c>, <c>*Style</c> →
    /// <c>Style</c>, <c>*Color</c>/<c>SystemAccentColor*</c> → <c>Color</c>). Returns <c>null</c> when
    /// the name matches none of the recognized conventions — such a key is then ALWAYS offered (never
    /// hidden), so an unrecognized name can never be wrongly filtered out of type-scoped completion.
    /// <para>
    /// <c>*Brush</c> is checked first so an <c>AccentFillColorDefaultBrush</c> (which contains "Color"
    /// mid-name) is a brush, not a color.
    /// </para>
    /// </summary>
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
