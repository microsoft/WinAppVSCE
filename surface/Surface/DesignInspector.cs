using System;
using System.Collections.Generic;
using System.Globalization;
using System.Reflection;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Markup;
using Microsoft.UI.Xaml.Media;
using Windows.UI;

namespace Surface;

/// <summary>
/// A single reflected property of a selected element, formatted for the design-time property panel.
/// </summary>
internal sealed class DesignPropInfo
{
    public string Name = "";
    public string Category = "";
    public string TypeName = "";
    public string Value = "";
    public bool ReadOnly;

    /// <summary>
    /// The closed set of legal values for this property, when it has one — enum member names, or
    /// <c>True</c>/<c>False</c> for a boolean. Drives a dropdown editor in the property panel (Phase C).
    /// Null for free-text properties (strings, numbers, Thickness, brushes, …).
    /// </summary>
    public List<string>? Options;
}

/// <summary>
/// Clean-room, reflection-based property reader for the design surface. Given a selected element it
/// returns a curated, grouped list of its scalar/convertible properties (the kind a WPF/Blend property
/// browser shows) — skipping object graphs, collections, and non-displayable types so the panel stays
/// readable. <see cref="Describe"/> reads; <see cref="TrySet"/> is the Phase C write-back path (same
/// name/value contract), converting the panel's string back to the property type.
/// </summary>
internal static class DesignInspector
{
    private const int MaxProps = 120;

    // Category display order (lower = earlier). "Misc" sinks to the bottom.
    private static readonly string[] Categories =
    {
        "Common", "Content", "Layout", "Appearance", "Text", "Interaction", "Focus & Keyboard", "Transform",
        "Theme & Language", "Misc",
    };

    // Exact property -> category. Checked before the pattern rules in Categorize.
    private static readonly Dictionary<string, string> CategoryMap = BuildCategoryMap();

    private static Dictionary<string, string> BuildCategoryMap()
    {
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        void Add(string category, params string[] names)
        {
            foreach (var n in names)
            {
                map[n] = category;
            }
        }

        Add("Common", "Name", "Tag", "IsEnabled", "Visibility", "Opacity", "IsLoaded");
        Add("Content",
            "Text", "Content", "Header", "PlaceholderText", "Description", "Title", "Subtitle", "Label", "Message",
            "Glyph", "Symbol", "OnContent", "OffContent", "IsOn", "IsChecked", "IsThreeState", "IsReadOnly",
            "Value", "Minimum", "Maximum", "SmallChange", "LargeChange", "StepFrequency", "SelectedIndex",
            "SelectedValue", "SelectedValuePath", "DisplayMemberPath", "IsOpen", "IsActive", "IsIndeterminate",
            "ShowPaused", "ShowError", "MaxLength", "GroupName", "IsExpanded", "ExpandDirection", "Severity",
            "IsClosable", "IsIconVisible", "PlaceholderValue", "Date", "Time", "ClockIdentifier", "MinuteIncrement",
            "IsSelected", "IsDropDownOpen", "IsEditable", "Stretch", "StretchDirection");
        Add("Layout",
            "Width", "Height", "MinWidth", "MinHeight", "MaxWidth", "MaxHeight", "ActualWidth", "ActualHeight",
            "Margin", "Padding", "HorizontalAlignment", "VerticalAlignment", "HorizontalContentAlignment",
            "VerticalContentAlignment", "Orientation", "Spacing", "RowSpacing", "ColumnSpacing", "UseLayoutRounding",
            "BackgroundSizing", "FlowDirection");
        Add("Appearance",
            "Background", "Foreground", "BorderBrush", "BorderThickness", "CornerRadius", "Fill", "Stroke",
            "StrokeThickness", "OpacityTransition", "ElementSoundMode");
        Add("Text",
            "CharacterSpacing", "LineHeight", "LineStackingStrategy", "MaxLines", "IsTextSelectionEnabled",
            "IsTextScaleFactorEnabled", "IsColorFontEnabled", "HorizontalTextAlignment", "OpticalMarginAlignment",
            "SelectionHighlightColor", "IsSpellCheckEnabled", "IsTextPredictionEnabled", "AcceptsReturn",
            "PreventKeyboardDisplayOnProgrammaticFocus", "DesiredCandidateWindowAlignment", "SelectionStart",
            "SelectionLength", "SelectedText", "InputScope");
        Add("Interaction",
            "IsHitTestVisible", "AllowDrop", "CanDrag", "ManipulationMode", "IsTapEnabled", "IsDoubleTapEnabled",
            "IsRightTapEnabled", "IsHoldingEnabled", "RequiresPointer", "ClickMode", "CanBeScrollAnchor",
            "IsPointerOver", "IsPressed");
        Add("Focus & Keyboard",
            "IsTabStop", "TabIndex", "TabNavigation", "TabFocusNavigation", "UseSystemFocusVisuals",
            "AllowFocusOnInteraction", "AllowFocusWhenDisabled", "IsFocusEngaged", "IsFocusEngagementEnabled",
            "IsAccessKeyScope", "ExitDisplayModeOnAccessKeyInvoked", "KeyboardAcceleratorPlacementMode",
            "IsTemplateFocusTarget", "IsTemplateKeyTipTarget");
        Add("Transform",
            "Rotation", "RotationAxis", "Scale", "Translation", "CenterPoint", "RenderTransformOrigin",
            "TransformMatrix");
        Add("Theme & Language", "RequestedTheme", "ActualTheme", "HighContrastAdjustment", "Language");
        return map;
    }

    /// <summary>Exact map first, then naming-pattern rules (Font*, XYFocus*, KeyTip*, *Brush, …), else Misc.</summary>
    private static string Categorize(string name)
    {
        if (CategoryMap.TryGetValue(name, out var cat))
        {
            return cat;
        }

        if (name.StartsWith("Focus", StringComparison.Ordinal) || name.StartsWith("XYFocus", StringComparison.Ordinal) ||
            name.StartsWith("AccessKey", StringComparison.Ordinal) || name.StartsWith("KeyTip", StringComparison.Ordinal) ||
            name.StartsWith("KeyboardAccelerator", StringComparison.Ordinal))
        {
            return "Focus & Keyboard";
        }

        if (name.StartsWith("Font", StringComparison.Ordinal) || name.StartsWith("Text", StringComparison.Ordinal))
        {
            return "Text";
        }

        if (name.StartsWith("Manipulation", StringComparison.Ordinal) || name.StartsWith("IsDrag", StringComparison.Ordinal))
        {
            return "Interaction";
        }

        if (name.EndsWith("Brush", StringComparison.Ordinal) || name.EndsWith("Color", StringComparison.Ordinal) ||
            name.EndsWith("ground", StringComparison.Ordinal) ||
            name.StartsWith("Border", StringComparison.Ordinal) || name.StartsWith("Stroke", StringComparison.Ordinal))
        {
            return "Appearance";
        }

        if (name.EndsWith("Width", StringComparison.Ordinal) || name.EndsWith("Height", StringComparison.Ordinal) ||
            name.EndsWith("Alignment", StringComparison.Ordinal) || name.EndsWith("Spacing", StringComparison.Ordinal))
        {
            return "Layout";
        }

        if (name.EndsWith("Content", StringComparison.Ordinal) || name.EndsWith("Text", StringComparison.Ordinal) ||
            name.EndsWith("Header", StringComparison.Ordinal) || name.EndsWith("Label", StringComparison.Ordinal))
        {
            return "Content";
        }

        return "Misc";
    }

    private static int CategoryRank(string category)
    {
        int i = Array.IndexOf(Categories, category);
        return i < 0 ? Categories.Length : i;
    }

    public static List<DesignPropInfo> Describe(FrameworkElement element)
    {
        var result = new List<DesignPropInfo>();
        if (element is null)
        {
            return result;
        }

        PropertyInfo[] props;
        try
        {
            props = element.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance);
        }
        catch
        {
            return result;
        }

        foreach (var p in props)
        {
            if (!p.CanRead || p.GetIndexParameters().Length > 0)
            {
                continue;
            }

            object? value;
            try
            {
                value = p.GetValue(element);
            }
            catch
            {
                continue; // getters can throw (e.g. when a template part isn't realized)
            }

            if (!TryFormat(value, p.PropertyType, out var text, out var typeName))
            {
                continue; // not a displayable/scalar type — skip to keep the panel clean
            }

            result.Add(new DesignPropInfo
            {
                Name = p.Name,
                Category = Categorize(p.Name),
                TypeName = typeName,
                Value = text,
                ReadOnly = !p.CanWrite,
                Options = p.CanWrite ? OptionsFor(p.PropertyType) : null,
            });
        }

        result.Sort((a, b) =>
        {
            int oa = CategoryRank(a.Category);
            int ob = CategoryRank(b.Category);
            if (oa != ob)
            {
                return oa.CompareTo(ob);
            }

            int c = string.CompareOrdinal(a.Category, b.Category);
            return c != 0 ? c : string.CompareOrdinal(a.Name, b.Name);
        });

        if (result.Count > MaxProps)
        {
            result.RemoveRange(MaxProps, result.Count - MaxProps);
        }

        return result;
    }

    /// <summary>
    /// Formats <paramref name="value"/> to a display string when its declared type is a scalar/convertible
    /// XAML value type we want in the panel. Returns false for object graphs, collections, and other complex
    /// types (so the caller skips them).
    /// </summary>
    private static bool TryFormat(object? value, Type declaredType, out string text, out string typeName)
    {
        text = "";
        var underlying = Nullable.GetUnderlyingType(declaredType) ?? declaredType;
        typeName = underlying.Name;

        // Reference-typed value classes we special-case (Brush/FontFamily) can be null; scalar structs won't.
        if (typeof(Brush).IsAssignableFrom(underlying))
        {
            typeName = "Brush";
            if (value is SolidColorBrush scb)
            {
                text = FormatColor(scb.Color);
            }
            else if (value is null)
            {
                text = "(none)";
            }
            else
            {
                text = value.GetType().Name;
            }

            return true;
        }

        if (underlying == typeof(FontFamily))
        {
            typeName = "FontFamily";
            text = (value as FontFamily)?.Source ?? "";
            return true;
        }

        if (value is null)
        {
            // Only surface nulls for the simple value types below via their struct path; a null here means
            // a nullable scalar with no value — show it as empty but keep the row.
            if (underlying.IsEnum || IsSimpleScalar(underlying))
            {
                text = "";
                return true;
            }

            return false;
        }

        switch (value)
        {
            case string s:
                text = s;
                return true;
            case bool b:
                text = b ? "True" : "False";
                return true;
            case Thickness t:
                text = $"{Num(t.Left)},{Num(t.Top)},{Num(t.Right)},{Num(t.Bottom)}";
                typeName = "Thickness";
                return true;
            case CornerRadius c:
                text = $"{Num(c.TopLeft)},{Num(c.TopRight)},{Num(c.BottomRight)},{Num(c.BottomLeft)}";
                typeName = "CornerRadius";
                return true;
            case GridLength g:
                text = g.IsAuto ? "Auto" : g.IsStar ? (g.Value == 1 ? "*" : $"{Num(g.Value)}*") : Num(g.Value);
                typeName = "GridLength";
                return true;
            case Color col:
                text = FormatColor(col);
                typeName = "Color";
                return true;
            case Enum e:
                text = e.ToString();
                return true;
        }

        if (IsSimpleScalar(underlying))
        {
            text = Convert.ToString(value, CultureInfo.InvariantCulture) ?? "";
            return true;
        }

        return false;
    }

    private static bool IsSimpleScalar(Type t) =>
        t == typeof(int) || t == typeof(double) || t == typeof(float) || t == typeof(long) ||
        t == typeof(short) || t == typeof(byte) || t == typeof(decimal) || t == typeof(uint) ||
        t == typeof(ulong) || t == typeof(ushort) || t == typeof(sbyte) || t == typeof(char);

    /// <summary>Legal-value set for a dropdown editor: enum members, or True/False for a bool; else null.</summary>
    private static List<string>? OptionsFor(Type declaredType)
    {
        var underlying = Nullable.GetUnderlyingType(declaredType) ?? declaredType;
        if (underlying.IsEnum)
        {
            return new List<string>(Enum.GetNames(underlying));
        }

        if (underlying == typeof(bool))
        {
            return new List<string> { "True", "False" };
        }

        return null;
    }

    /// <summary>
    /// Phase C write-back: parse <paramref name="value"/> (a panel string) into <paramref name="name"/>'s
    /// declared type and assign it on <paramref name="element"/> via reflection. Best-effort — returns false
    /// (with <paramref name="error"/> set) for unknown/read-only properties or values that don't convert, so
    /// the caller can re-describe and let the cell revert. Never throws.
    /// </summary>
    public static bool TrySet(FrameworkElement element, string name, string value, out string? error)
    {
        error = null;
        if (element is null || string.IsNullOrEmpty(name))
        {
            error = "no element or property name";
            return false;
        }

        PropertyInfo? p;
        try
        {
            p = element.GetType().GetProperty(name, BindingFlags.Public | BindingFlags.Instance);
        }
        catch (Exception ex)
        {
            error = ex.Message;
            return false;
        }

        if (p is null || !p.CanWrite || p.GetIndexParameters().Length > 0)
        {
            error = "property is not settable";
            return false;
        }

        try
        {
            var target = Nullable.GetUnderlyingType(p.PropertyType) ?? p.PropertyType;
            object? converted = ConvertTo(target, p.PropertyType, value);
            p.SetValue(element, converted);
            return true;
        }
        catch (Exception ex)
        {
            error = ex.Message;
            return false;
        }
    }

    /// <summary>Converts a display string back to a XAML-convertible target type (the inverse of TryFormat).</summary>
    private static object? ConvertTo(Type target, Type declared, string value)
    {
        bool nullable = !target.IsValueType || Nullable.GetUnderlyingType(declared) != null;

        // Brushes: accept a color literal ("#AARRGGBB", "#RRGGBB", or a named color) -> SolidColorBrush; an
        // empty value or "(none)" clears the brush. Gradient/other brush syntaxes fall through to XAML.
        if (typeof(Brush).IsAssignableFrom(target))
        {
            if (value.Length == 0 || value == "(none)")
            {
                return null;
            }

            if (TryParseColor(value, out var brushColor))
            {
                return new SolidColorBrush(brushColor);
            }
        }

        if (target == typeof(FontFamily))
        {
            return value.Length == 0 ? null : new FontFamily(value);
        }

        // An empty string clears a nullable/reference property; for a non-nullable value type there's no
        // "empty" to assign, so let ConvertValue reject it (the edit is refused and the cell reverts).
        if (value.Length == 0 && nullable)
        {
            return null;
        }

        // Everything else — primitives, enums, bool, Thickness, CornerRadius, GridLength, Color — goes through
        // XAML's own value converter, the same one the parser uses for attribute strings.
        return XamlBindingHelper.ConvertValue(target, value);
    }

    /// <summary>Parses "#AARRGGBB", "#RRGGBB", or a named <see cref="Microsoft.UI.Colors"/> color.</summary>
    private static bool TryParseColor(string s, out Color color)
    {
        color = default;
        s = s.Trim();
        if (s.Length == 0)
        {
            return false;
        }

        if (s[0] == '#')
        {
            var hex = s.Substring(1);
            if (hex.Length == 8 && uint.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var argb))
            {
                color = Color.FromArgb((byte)(argb >> 24), (byte)(argb >> 16), (byte)(argb >> 8), (byte)argb);
                return true;
            }

            if (hex.Length == 6 && uint.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var rgb))
            {
                color = Color.FromArgb(0xFF, (byte)(rgb >> 16), (byte)(rgb >> 8), (byte)rgb);
                return true;
            }

            return false;
        }

        try
        {
            var prop = typeof(Microsoft.UI.Colors).GetProperty(
                s, BindingFlags.Public | BindingFlags.Static | BindingFlags.IgnoreCase);
            if (prop?.GetValue(null) is Color named)
            {
                color = named;
                return true;
            }
        }
        catch
        {
            // reflection lookup failed — not a named color
        }

        return false;
    }

    private static string Num(double d) =>
        d.ToString(d == Math.Floor(d) ? "0" : "0.##", CultureInfo.InvariantCulture);

    private static string FormatColor(Color c) =>
        $"#{c.A:X2}{c.R:X2}{c.G:X2}{c.B:X2}";
}
