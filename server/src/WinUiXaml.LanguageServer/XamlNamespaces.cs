namespace WinUiXaml.LanguageServer;

internal static class XamlNamespaces
{
    public const string DesignTime2008 = "http://schemas.microsoft.com/expression/blend/2008";
    public const string DesignTime2006 = "http://schemas.microsoft.com/expression/blend/2006";
    public const string MarkupCompatibility = "http://schemas.openxmlformats.org/markup-compatibility/2006";

    public static bool IsDesignTime(string? uri) =>
        uri == DesignTime2008 || uri == DesignTime2006;
}
