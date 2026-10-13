/**
 * Choosing what the app's overlay should highlight.
 *
 * The overlay domain covers two independent things: the DevTools *toolbar*
 * the user sees floating over their app (`Overlay.show` / `Overlay.hide`,
 * reported as `toolbarVisible`) and the element *highlight* adorner
 * (`Overlay.highlight`, reported as `highlightHandle`). They are easy to
 * confuse, and confusing them is destructive in one direction: calling
 * `Overlay.hide` to clear a highlight takes the user's toolbar down with it
 * and there is no event to tell anyone why it vanished.
 *
 * So the rule lives here, as a pure function, and the panel never reaches for
 * `Overlay.hide` at all.
 */

/**
 * The engine's null handle. Highlighting it clears the adorner and leaves
 * `toolbarVisible` untouched — verified against the live engine.
 */
export const NO_HIGHLIGHT = '0';

/**
 * The handle the overlay should highlight as the pointer moves over the tree.
 *
 * @param hovered the row under the pointer, if any.
 * @param selected the currently selected element, if any.
 */
export function highlightTarget(
    hovered: string | undefined,
    selected: string | undefined,
): string {
    if (hovered) { return hovered; }
    // Falling back to the selection stops the adorner flickering off every
    // time the pointer crosses a gap between rows.
    if (selected) { return selected; }
    return NO_HIGHLIGHT;
}
