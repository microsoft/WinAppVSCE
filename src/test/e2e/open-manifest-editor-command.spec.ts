/**
 * E2E tests: `winapp.openManifestEditor` invocation paths.
 *
 * - Editor title bar button → opens the active manifest directly (no quick pick).
 * - Command Palette → shows the quick pick of manifests in the workspace.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import {
    createTempWorkspace,
    launchVSCode,
    getWebviewFrame,
    teardown,
    type VSCodeTestContext,
} from './helpers';

let ctx: VSCodeTestContext;

const QUICK_INPUT = '.quick-input-widget';
const TITLE_BAR_BUTTON = '.editor-actions a.action-label[aria-label*="Open Manifest Editor"]';

test.beforeAll(async () => {
    const tmpDir = createTempWorkspace('winui-gallery.appxmanifest');
    // A second manifest so the Command Palette quick pick has multiple entries.
    const secondDir = path.join(tmpDir, 'Second');
    fs.mkdirSync(secondDir, { recursive: true });
    fs.copyFileSync(path.join(tmpDir, 'AppxManifest.xml'), path.join(secondDir, 'AppxManifest.xml'));

    ctx = await launchVSCode(tmpDir);
});

test.afterAll(async () => {
    if (ctx) { await teardown(ctx); }
});

test('title bar button opens the active manifest without a quick pick', async () => {
    // The manifest was opened in the default text editor by the launch args.
    const button = ctx.page.locator(TITLE_BAR_BUTTON).first();
    await expect(button).toBeVisible({ timeout: 15_000 });

    await button.click();
    // No manifest picker should appear — the active file is used directly.
    await ctx.page.waitForTimeout(2_000);
    await expect(ctx.page.locator(QUICK_INPUT)).toBeHidden();

    // The custom editor should have taken over for the active manifest.
    const frame = await getWebviewFrame(ctx.page);
    await expect(frame.locator('.tab-bar')).toBeVisible();

    // Button is hidden once the custom editor is active.
    await expect(ctx.page.locator(TITLE_BAR_BUTTON)).toHaveCount(0);
});

test('Command Palette invocation shows the manifest quick pick', async () => {
    await ctx.page.keyboard.press('Control+Shift+P');
    await ctx.page.waitForTimeout(1_000);
    await ctx.page.keyboard.type('WinApp: Open Manifest Editor', { delay: 30 });
    await ctx.page.waitForTimeout(1_500);
    await ctx.page.keyboard.press('Enter');
    await ctx.page.waitForTimeout(2_000);

    const quickInput = ctx.page.locator(QUICK_INPUT);
    await expect(quickInput).toBeVisible();
    await expect(quickInput.locator('input.input')).toHaveAttribute(
        'placeholder',
        'Select an app manifest to open',
    );

    // Both workspace manifests plus the Browse… entry should be listed.
    const rows = quickInput.locator('.quick-input-list .monaco-list-row');
    await expect(rows).toHaveCount(3);
    await expect(quickInput).toContainText('Browse');

    await ctx.page.keyboard.press('Escape');
    await ctx.page.waitForTimeout(500);
    await expect(quickInput).toBeHidden();
});
