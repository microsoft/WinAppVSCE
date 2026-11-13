namespace Surface;

/// <summary>
/// Scroll-offset maths for zooming the centred design board. While the zoomed board is smaller than the
/// viewport, the ScrollViewer centres it (offset 0, padding on both sides); the anchor maths has to account
/// for that padding or a zoom-in lands far from the anchor and pushes the page out of view.
/// </summary>
internal static class ZoomMath
{
    /// <summary>
    /// The scroll offset (one axis) that keeps the content point under <paramref name="anchor"/> (viewport
    /// coordinates) fixed when zooming from <paramref name="oldZoom"/> to <paramref name="newZoom"/>.
    /// </summary>
    public static double AnchoredOffset(double offset, double viewport, double canvas, double oldZoom, double newZoom, double anchor)
    {
        if (oldZoom <= 0) { oldZoom = 1.0; }
        if (viewport <= 0 || canvas <= 0) { return 0; }

        double padOld = Math.Max(0, (viewport - canvas * oldZoom) / 2.0);
        double padNew = Math.Max(0, (viewport - canvas * newZoom) / 2.0);

        // Content coordinate under the anchor, clamped onto the page (an anchor in the padding pins the edge).
        double content = (offset + anchor - padOld) / oldZoom;
        content = Math.Max(0, Math.Min(canvas, content));

        double target = content * newZoom + padNew - anchor;
        double max = Math.Max(0, canvas * newZoom - viewport);
        return Math.Max(0, Math.Min(max, target));
    }
}
