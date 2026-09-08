namespace TestUserApp;

/// <summary>
/// A deliberately NON-cleanly-constructible item type for the M3 reflection-fallback SKIP test. It declares a
/// <c>required</c> member — mirroring the gallery's model-domain records (e.g. <c>AddHFModelView.Result</c>,
/// whose required init properties made reflective fabrication null-fill and drove the model-page hang). The
/// hardened injector's lever (b) must therefore SKIP any empty collection whose element type is this,
/// fabricating nothing rather than partial/null-filling it.
/// </summary>
public sealed class NonConstructibleItem
{
    /// <summary>A required member: a reflective parameterless construction cannot satisfy it, so the injector
    /// treats the whole collection as non-constructible and leaves it alone.</summary>
    public required string Title { get; init; }
}
