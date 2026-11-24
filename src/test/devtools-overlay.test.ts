/**
 * The overlay highlight decision.
 *
 * These exist because the panel once cleared a highlight by calling
 * `Overlay.hide`, which hides the DevTools *toolbar* rather than the highlight
 * adorner. The user saw their overlay vanish seemingly at random — it was
 * actually the pointer leaving the tree with nothing selected.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { highlightTarget, NO_HIGHLIGHT } from '../devtools/overlay';

test('hovering a row highlights that row', () => {
    assert.strictEqual(highlightTarget('123', undefined), '123');
});

test('the hovered row wins over the selection', () => {
    assert.strictEqual(highlightTarget('123', '456'), '123');
});

test('leaving the tree falls back to the selected element', () => {
    // Without this the adorner flickers off every time the pointer crosses a
    // gap between rows.
    assert.strictEqual(highlightTarget(undefined, '456'), '456');
});

test('leaving the tree with no selection clears the highlight, not the toolbar', () => {
    // The engine's null handle. The point of the whole module is that this is
    // a highlight call and never Overlay.hide.
    assert.strictEqual(highlightTarget(undefined, undefined), NO_HIGHLIGHT);
    assert.strictEqual(NO_HIGHLIGHT, '0');
});

test('an empty handle is treated as no handle', () => {
    assert.strictEqual(highlightTarget('', ''), NO_HIGHLIGHT);
});
