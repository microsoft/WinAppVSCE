using Microsoft.CodeAnalysis;

namespace WinUiXaml.Workspace
{
    /// <summary>
    /// Immutable framework symbols resolved once for a project compilation. A missing symbol means
    /// that capability is unavailable; callers must not substitute a handwritten semantic catalog.
    /// </summary>
    public sealed class WinUiSdkCapabilities
    {
        internal WinUiSdkCapabilities(Compilation compilation)
        {
            FrameworkTemplate = compilation.GetTypeByMetadataName("Microsoft.UI.Xaml.FrameworkTemplate");
            RelativePanel = compilation.GetTypeByMetadataName("Microsoft.UI.Xaml.Controls.RelativePanel");
            UIElement = compilation.GetTypeByMetadataName("Microsoft.UI.Xaml.UIElement");
            Setter = compilation.GetTypeByMetadataName("Microsoft.UI.Xaml.Setter");
            Style = compilation.GetTypeByMetadataName("Microsoft.UI.Xaml.Style");
            ControlTemplate = compilation.GetTypeByMetadataName("Microsoft.UI.Xaml.Controls.ControlTemplate");
            DataTemplate = compilation.GetTypeByMetadataName("Microsoft.UI.Xaml.DataTemplate");
            ResourceDictionary = compilation.GetTypeByMetadataName("Microsoft.UI.Xaml.ResourceDictionary");
            Storyboard = compilation.GetTypeByMetadataName("Microsoft.UI.Xaml.Media.Animation.Storyboard");
            MarkupExtension = compilation.GetTypeByMetadataName("Microsoft.UI.Xaml.Markup.MarkupExtension");
            Binding = compilation.GetTypeByMetadataName("Microsoft.UI.Xaml.Data.Binding");
            RelativeSource = compilation.GetTypeByMetadataName("Microsoft.UI.Xaml.Data.RelativeSource");
            Brush = compilation.GetTypeByMetadataName("Microsoft.UI.Xaml.Media.Brush");
            Color = compilation.GetTypeByMetadataName("Windows.UI.Color");
        }

        public INamedTypeSymbol? FrameworkTemplate { get; }
        public INamedTypeSymbol? RelativePanel { get; }
        public INamedTypeSymbol? UIElement { get; }
        public INamedTypeSymbol? Setter { get; }
        public INamedTypeSymbol? Style { get; }
        public INamedTypeSymbol? ControlTemplate { get; }
        public INamedTypeSymbol? DataTemplate { get; }
        public INamedTypeSymbol? ResourceDictionary { get; }
        public INamedTypeSymbol? Storyboard { get; }
        public INamedTypeSymbol? MarkupExtension { get; }
        public INamedTypeSymbol? Binding { get; }
        public INamedTypeSymbol? RelativeSource { get; }
        public INamedTypeSymbol? Brush { get; }
        public INamedTypeSymbol? Color { get; }

        /// <summary>
        /// Whether every SDK type needed to identify x:Name reference forms is available. Rename must
        /// not emit a partial edit when any of these semantic classifiers is unavailable.
        /// </summary>
        public bool HasCompleteNameReferenceSemantics =>
            RelativePanel is not null &&
            UIElement is not null &&
            Setter is not null &&
            Storyboard is not null &&
            MarkupExtension is not null &&
            Binding is not null;
    }
}
