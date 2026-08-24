/**
 * E2E tests: the visual editor must keep its UI state when the manifest XML is
 * edited outside the webview (text editor / external tooling), including while
 * the XML is transiently unparseable mid-edit.
 *
 * Regression coverage for #192.
 */

import { test, expect, type FrameLocator } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import {
    createTempWorkspace,
    launchVSCode,
    openManifestEditor,
    switchTab,
    switchAppSubTab,
    teardown,
    type VSCodeTestContext,
} from './helpers';

let ctx: VSCodeTestContext;
let frame: FrameLocator;
let manifestPath: string;
let original: string;

/** Writes the manifest to disk, mimicking an edit made in the text editor. */
function writeManifest(contents: string): void {
    fs.writeFileSync(manifestPath, contents, 'utf-8');
}

// This spec drives external, on-disk edits, which conflict with the unsaved webview
// edits other specs leave in the shared editor. Use a dedicated VS Code instance.
test.beforeAll(async () => {
    const tmpDir = createTempWorkspace('winui-gallery.appxmanifest');
    manifestPath = path.join(tmpDir, 'AppxManifest.xml');
    original = fs.readFileSync(manifestPath, 'utf-8');
    ctx = await launchVSCode(tmpDir);
    frame = await openManifestEditor(ctx.page);
});

test.afterAll(async () => {
    if (ctx) { await teardown(ctx); }
});

test('keeps the selected tab, app sub-tab and scroll position across an external edit that breaks the XML mid-way', async () => {
    // Put the editor into a distinctive state: Applications tab, Visual Assets sub-tab, scrolled down.
    await switchTab(frame, 'applications');
    await switchAppSubTab(frame, 0, 'visual');
    await expect(frame.locator('.app-sub-tab[data-subtab="visual"]').first()).toHaveClass(/active/);

    const panel = frame.locator('#tab-applications');
    await panel.evaluate(el => { el.scrollTop = 150; });
    await ctx.page.waitForTimeout(500);
    const scrollBefore = await panel.evaluate(el => el.scrollTop);
    expect(scrollBefore).toBeGreaterThan(0);

    // Typing `<Capability Name="internetClient" />` in the text editor passes through
    // many transiently-invalid states. Replay a few of them, then land on valid XML.
    const partials = ['<', '<Capability', '<Capability Name="internetClient"'];
    for (const partial of partials) {
        writeManifest(original.replace('</Capabilities>', `  ${partial}\n  </Capabilities>`));
        await ctx.page.waitForTimeout(400);
    }
    writeManifest(original.replace('</Capabilities>', '  <Capability Name="internetClient" />\n  </Capabilities>'));

    // The capability lands in the editor and the parse-error overlay clears…
    await expect(frame.locator('input[data-capability="internetClient"]')).toBeChecked({ timeout: 20_000 });
    await expect(frame.locator('#parse-error-overlay')).toBeHidden({ timeout: 20_000 });
    // …and the UI state must have survived the round trip.
    await expect(frame.locator('.tab-btn[data-tab="applications"]')).toHaveClass(/active/);
    await expect(panel).toBeVisible();
    await expect(frame.locator('.app-sub-tab[data-subtab="visual"]').first()).toHaveClass(/active/);
    expect(await panel.evaluate(el => el.scrollTop)).toBe(scrollBefore);
});

test('exactly one top-level tab button is marked active after an external edit', async () => {
    await expect(frame.locator('.tab-btn.active')).toHaveCount(1);
    await expect(frame.locator('.tab-content.active')).toHaveCount(1);
});

test('shows an in-place overlay — not a rebuilt document — while the XML is invalid', async () => {
    writeManifest(original.replace('</Package>', '<Unclosed>'));

    // The editor document is still alive behind the overlay.
    await expect(frame.locator('#parse-error-overlay')).toBeVisible({ timeout: 20_000 });
    await expect(frame.locator('#parse-error-detail')).not.toBeEmpty();
    await expect(frame.locator('.tab-bar')).toBeAttached();
    await expect(frame.locator('.tab-btn[data-tab="applications"]')).toHaveClass(/active/);

    // The overlay offers the same recovery action as the standalone error page…
    await expect(frame.locator('#parse-error-open-text')).toBeVisible();
    // …and is modal: the form behind it must not stay reachable by keyboard or AT.
    await expect(frame.locator('.tab-bar')).toHaveAttribute('inert', '');
    await expect(frame.locator('.tab-bar')).toHaveAttribute('aria-hidden', 'true');

    // Restoring valid XML clears the overlay and keeps the selected tab.
    writeManifest(original);
    await expect(frame.locator('#parse-error-overlay')).toBeHidden({ timeout: 20_000 });
    await expect(frame.locator('.tab-btn[data-tab="applications"]')).toHaveClass(/active/);
    await expect(frame.locator('.tab-bar')).not.toHaveAttribute('inert', '');
});
