using System;
using System.Globalization;
using System.Linq;
using Microsoft.CodeAnalysis;
using WinUiXaml.Workspace;

namespace WinUiXaml.LanguageServer;

/// <summary>Validates literal forms for XAML types whose conversions are defined by WinUI or the CLR.</summary>
internal static class XamlValueConverter
{
    public static bool TryValidate(
        string text,
        ITypeSymbol type,
        XamlTypeSystem typeSystem,
        out bool isValid)
    {
        text = text.Trim();
        type = UnwrapNullable(type);

        if (type.TypeKind == TypeKind.Enum)
        {
            isValid = IsValidEnum(text, type);
            return true;
        }

        switch (type.SpecialType)
        {
            case SpecialType.System_Boolean:
                isValid = bool.TryParse(text, out _);
                return true;
            case SpecialType.System_Byte:
                isValid = byte.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out _);
                return true;
            case SpecialType.System_SByte:
                isValid = sbyte.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out _);
                return true;
            case SpecialType.System_Int16:
                isValid = short.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out _);
                return true;
            case SpecialType.System_UInt16:
                isValid = ushort.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out _);
                return true;
            case SpecialType.System_Int32:
                isValid = int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out _);
                return true;
            case SpecialType.System_UInt32:
                isValid = uint.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out _);
                return true;
            case SpecialType.System_Int64:
                isValid = long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out _);
                return true;
            case SpecialType.System_UInt64:
                isValid = ulong.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out _);
                return true;
            case SpecialType.System_Single:
                isValid = IsValidFloatingPoint(text, single: true);
                return true;
            case SpecialType.System_Double:
                isValid = IsValidFloatingPoint(text, single: false);
                return true;
            case SpecialType.System_Decimal:
                isValid = decimal.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out _);
                return true;
            case SpecialType.System_Char:
                isValid = text.Length == 1;
                return true;
        }

        if (IsThickness(type, typeSystem) ||
            SymbolEqualityComparer.Default.Equals(type, typeSystem.Capabilities.CornerRadius))
        {
            isValid = IsValidDoubleList(text, minimumCount: 1, maximumCount: 4);
            return true;
        }

        if (IsGridLength(type, typeSystem))
        {
            isValid = IsValidGridLength(text);
            return true;
        }

        if (IsBrush(type, typeSystem) || IsColor(type, typeSystem))
        {
            isValid = XamlColor.TryParseHex(text, out _, out _, out _, out _) ||
                typeSystem.GetNamedColors().Any(
                    name => string.Equals(name, text, StringComparison.OrdinalIgnoreCase));
            return true;
        }

        if (IsFontWeight(type, typeSystem))
        {
            isValid = ushort.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out _) ||
                typeSystem.GetFontWeights().Any(
                    name => string.Equals(name, text, StringComparison.OrdinalIgnoreCase));
            return true;
        }

        isValid = true;
        return false;
    }

    public static ITypeSymbol UnwrapNullable(ITypeSymbol type) =>
        type is INamedTypeSymbol { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T } nullable
            ? nullable.TypeArguments[0]
            : type;

    public static bool IsGridLength(ITypeSymbol type, XamlTypeSystem typeSystem) =>
        SymbolEqualityComparer.Default.Equals(type, typeSystem.Capabilities.GridLength);

    public static bool IsThickness(ITypeSymbol type, XamlTypeSystem typeSystem) =>
        SymbolEqualityComparer.Default.Equals(type, typeSystem.Capabilities.Thickness);

    public static bool IsFontFamily(ITypeSymbol type, XamlTypeSystem typeSystem) =>
        typeSystem.Capabilities.FontFamily is { } fontFamily &&
        SymbolEqualityComparer.Default.Equals(type, fontFamily);

    public static bool IsGridDefinitionCollection(ITypeSymbol type, XamlTypeSystem typeSystem) =>
        typeSystem.IsGridDefinitionCollection(type);

    public static bool IsBrush(ITypeSymbol type, XamlTypeSystem typeSystem) =>
        type is INamedTypeSymbol named &&
        typeSystem.Capabilities.Brush is { } brush &&
        XamlTypeSystem.IsAssignableTo(named, brush);

    public static bool IsColor(ITypeSymbol type, XamlTypeSystem typeSystem) =>
        SymbolEqualityComparer.Default.Equals(type, typeSystem.Capabilities.Color);

    public static bool IsFontWeight(ITypeSymbol type, XamlTypeSystem typeSystem) =>
        SymbolEqualityComparer.Default.Equals(type, typeSystem.Capabilities.FontWeight);

    private static bool IsValidEnum(string text, ITypeSymbol type)
    {
        if (long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out _))
        {
            return true;
        }

        var names = type.GetMembers().OfType<IFieldSymbol>()
            .Where(field => field.HasConstantValue)
            .Select(field => field.Name)
            .ToHashSet(StringComparer.Ordinal);
        return text.Length > 0 && text.Split(',').All(part => names.Contains(part.Trim()));
    }

    private static bool IsValidFloatingPoint(string text, bool single) =>
        string.Equals(text, "Auto", StringComparison.OrdinalIgnoreCase) ||
        (single
            ? float.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out _)
            : double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out _));

    private static bool IsValidDoubleList(string text, int minimumCount, int maximumCount)
    {
        if (text.Length == 0)
        {
            return false;
        }

        string[] parts;
        if (text.Contains(','))
        {
            parts = text.Split(',');
            if (parts.Any(part => part.Trim().Length == 0))
            {
                return false;
            }
        }
        else
        {
            parts = text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        }

        return parts.Length >= minimumCount &&
            parts.Length <= maximumCount &&
            parts.All(part => double.TryParse(
                part.Trim(),
                NumberStyles.Float,
                CultureInfo.InvariantCulture,
                out _));
    }

    private static bool IsValidGridLength(string text)
    {
        if (string.Equals(text, "Auto", StringComparison.OrdinalIgnoreCase) || text == "*")
        {
            return true;
        }

        var number = text.EndsWith("*", StringComparison.Ordinal)
            ? text.Substring(0, text.Length - 1)
            : text;
        return number.Length > 0 &&
            double.TryParse(number, NumberStyles.Float, CultureInfo.InvariantCulture, out _);
    }
}
