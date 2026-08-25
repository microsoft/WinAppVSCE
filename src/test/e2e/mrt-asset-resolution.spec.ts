/**
 * E2E tests: MRT-qualified asset resolution for visual asset fields.
 *
 * Regression coverage for issue #191 — a manifest that references the unqualified
 * asset name (Assets\MrtLogo.png) while only qualifier-suffixed files exist on
 * disk (Assets\MrtLogo.scale-200.png) is correct MRT authoring and must not be
 * reported as "Image not found in package directory".
 */

import { test, expect, type FrameLocator } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import {
    switchTab,
    switchAppSubTab,
    getValidationMessage,
    type VSCodeTestContext,
} from './helpers';
import { ensureEditor, resetManifest } from './shared-context';

let ctx: VSCodeTestContext;
let frame: FrameLocator;
let assetsDir: string;

/** Files this spec writes into the shared workspace, removed individually in afterAll. */
const ASSET_FILES = [
    'MrtLogo.scale-100.png',
    'MrtLogo.scale-200.png',
    'MrtLogo.targetsize-24_altform-unplated.png',
    'OnlyBackup.backup.png',
    'PlainLogo.png',
];

/** Minimal valid 1×1 PNG so the editor can read dimensions. */
const PNG_1X1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
);

/** Validation message for a visual asset field of the first application. */
async function appAssetMessage(field: string): Promise<string> {
    const group = frame.locator(`.form-group[data-field="applications.0.visualElements.${field}"]`);
    return (await group.locator('.validation-msg').textContent())?.trim() ?? '';
}

test.beforeAll(async () => {
    const shared = await ensureEditor();
    ctx = shared.ctx;

    assetsDir = path.join(ctx.workspacePath, 'Assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    // Only qualifier-suffixed files — no unqualified MrtLogo.png, matching the
    // standard WinUI 3 / Windows App SDK template layout.
    for (const name of ASSET_FILES) {
        fs.writeFileSync(path.join(assetsDir, name), PNG_1X1);
    }

    // The image check runs when the editor renders the manifest, so load a fixture
    // that already references these assets rather than typing paths in.
    frame = await resetManifest(ctx, 'mrt-assets.appxmanifest');
    await ctx.page.waitForTimeout(2_000);
});

test.afterAll(async () => {
    // Other specs share this workspace and its Assets folder — remove only what we wrote.
    if (!assetsDir) { return; }
    for (const name of ASSET_FILES) {
        fs.rmSync(path.join(assetsDir, name), { force: true });
    }
});

test('unqualified logo backed only by MRT variants is not reported as missing', async () => {
    await switchTab(frame, 'properties');

    const msg = await getValidationMessage(frame, 'properties.logo');
    expect(msg).not.toContain('not found');
    expect(msg).toContain('Resolved via MRT');
    expect(msg).toContain('MrtLogo.scale-200.png');
});

test('logo preview falls back to the resolved MRT variant', async () => {
    await switchTab(frame, 'properties');

    const src = await frame.locator('#store-logo-preview').getAttribute('src');
    expect(src).toContain('MrtLogo.scale-200.png');
});

test('application visual assets resolve through MRT variants', async () => {
    await switchTab(frame, 'applications');
    await switchAppSubTab(frame, 0, 'visual');

    const msg = await appAssetMessage('square150x150Logo');
    expect(msg).not.toContain('not found');
    expect(msg).toContain('Resolved via MRT');
});

test('application logo preview falls back to the resolved MRT variant', async () => {
    await switchTab(frame, 'applications');
    await switchAppSubTab(frame, 0, 'visual');

    const src = await frame.locator('.app-logo-preview[data-app-idx="0"]').getAttribute('src');
    expect(src).toContain('MrtLogo.scale-200.png');
});

test('an unqualified file that exists is used as-is with no note', async () => {
    await switchTab(frame, 'applications');
    await switchAppSubTab(frame, 0, 'visual');

    expect(await appAssetMessage('square44x44Logo')).toBe('');
});

test('a non-variant sibling does not satisfy the reference', async () => {
    await switchTab(frame, 'applications');
    await switchAppSubTab(frame, 0, 'visual');

    expect(await appAssetMessage('wide310x150Logo')).toContain('not found');
});

test('a genuinely missing asset still warns', async () => {
    await switchTab(frame, 'applications');
    await switchAppSubTab(frame, 0, 'visual');

    expect(await appAssetMessage('splashScreenImage')).toContain('not found');
});

