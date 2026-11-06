#nullable enable

using System;

namespace WinUIXamlPreview
{
    /// <summary>Stable identifiers for the package and its tool window. Freshly generated for
    /// this extension — not shared with any other VSIX.</summary>
    internal static class PackageGuids
    {
        public const string PackageGuidString = "d4245f7f-5871-4a4d-97c1-84595921b383";
        public const string ToolWindowGuidString = "019aaf07-5cd5-483d-9231-159c5d00dfb7";
        public const string PropertiesToolWindowGuidString = "6b1e9d4a-7c83-4f2e-a1d6-2b9c8e5f0a37";
        public const string OutputPaneGuidString = "8c12b75b-6d92-4bb5-83b4-da11b7cfb63a";

        public static readonly Guid OutputPaneGuid = new Guid(OutputPaneGuidString);

        /// <summary>Command set for the View → Other Windows entry (must match VSCommandTable.vsct).</summary>
        public const string CommandSetGuidString = "5c97e212-6033-4935-8de3-82e1bd9245df";

        public static readonly Guid CommandSet = new Guid(CommandSetGuidString);

        /// <summary>ID of the "WinUI XAML Preview" button (must match VSCommandTable.vsct).</summary>
        public const int ShowPreviewCommandId = 0x0100;
    }
}
