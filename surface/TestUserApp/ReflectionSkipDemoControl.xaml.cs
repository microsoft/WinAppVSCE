using System.Collections;
using System.Collections.ObjectModel;
using Microsoft.UI.Xaml.Controls;

namespace TestUserApp;

/// <summary>
/// M3 hardening SKIP demo (defect <c>dtd-reflect-overreach</c>): a ZERO-CONFIG UserControl whose empty
/// items-host collection has a NON-cleanly-constructible element type (<see cref="NonConstructibleItem"/>,
/// which declares a <c>required</c> member — mirroring the gallery's model-domain records). It proves the
/// hardened reflection fallback SKIPS such a collection instead of fabricating into it: the injector finds
/// the empty <c>ItemsControl</c> (lever a), sees the non-constructible element type (lever b), and cleanly
/// no-ops — leaving <see cref="ItemCountText"/> at "0 items" and logging <c>DTD-SKIP</c> — even with the
/// fallback opted in (env <c>SURFACE_DTD_REFLECT=1</c>).
/// </summary>
public sealed partial class ReflectionSkipDemoControl : UserControl
{
    // The backing collection's element type is deliberately NON-constructible. It is exposed to XAML as a
    // non-generic IEnumerable so the WinUI XAML type-info generator (which would otherwise emit an activator +
    // property setters for the element type) never sees NonConstructibleItem — yet at runtime the injector
    // still discovers the concrete element type via reflection on this object and must SKIP it (lever b).
    private readonly ObservableCollection<NonConstructibleItem> _items = new();

    /// <summary>x:Bind-backed items source; the concrete collection has a non-constructible element type.</summary>
    public IEnumerable Items => _items;

    /// <summary>x:Bind (OneTime) source; stays "0 items" because the injector cleanly skips <see cref="Items"/>.</summary>
    public string ItemCountText => $"{_items.Count} items";

    public ReflectionSkipDemoControl()
    {
        // Zero-config: no seeding. With the fallback opted in the injector still must NOT fill the collection,
        // because its element type is not cleanly constructible (lever b) — proving the over-reach guard.
        this.InitializeComponent();
    }
}
