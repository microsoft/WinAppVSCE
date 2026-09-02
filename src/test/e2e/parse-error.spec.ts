/**
 * E2E tests: Parse error handling – verifies the error view when
 * opening a malformed XML file, and recovery when fixed.
 */

import { test, expect, type FrameLocator } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import {
    createTempWorkspace,
    getWebviewFrame,
    launchVSCode,
    teardown,
    type VSCodeTestContext,
} from './helpers';

let ctx: VSCodeTestContext;
let innerFrame: FrameLocator;
// Tracked separately from `ctx` so a failed launch still cleans up the workspace.
let tmpDir: string | undefined;

// Launching VS Code with a malformed manifest is shared setup rather than the work of the
// first test, so each test in this file can run on its own (e.g. under --grep).
test.beforeAll(async () => {
    // Create a workspace with a broken manifest
    tmpDir = createTempWorkspace('winui-gallery.appxmanifest');
    const manifestPath = path.join(tmpDir, 'AppxManifest.xml');
    fs.writeFileSync(manifestPath, '<Package><broken xml here', 'utf-8');

    ctx = await launchVSCode(tmpDir);

    // Open the manifest file via Quick Open (Ctrl+P)
    await ctx.page.keyboard.press('Control+P');
    await ctx.page.waitForTimeout(1_000);
    await ctx.page.keyboard.type('AppxManifest.xml', { delay: 30 });
    await ctx.page.waitForTimeout(1_500);
    await ctx.page.keyboard.press('Enter');
    await ctx.page.waitForTimeout(2_000);

    // Reopen with the custom editor
    await ctx.page.keyboard.press('Control+Shift+P');
    await ctx.page.waitForTimeout(1_000);
    await ctx.page.keyboard.type('View: Reopen Editor With...', { delay: 30 });
    await ctx.page.waitForTimeout(1_500);
    await ctx.page.keyboard.press('Enter');
    await ctx.page.waitForTimeout(2_000);
    await ctx.page.keyboard.type('AppxManifest Editor', { delay: 30 });
    await ctx.page.waitForTimeout(1_000);
    await ctx.page.keyboard.press('Enter');
    await ctx.page.waitForTimeout(5_000);

    // Navigate into the webview frames
    const webviewOuterFrame = ctx.page.frames().find(f => f.url().includes('vscode-webview://') && !f.url().includes('fake.html'));
    expect(webviewOuterFrame).toBeTruthy();
    innerFrame = webviewOuterFrame!.frameLocator('#active-frame');
});

test.afterAll(async () => {
    if (ctx) {
        await teardown(ctx);
    } else if (tmpDir) {
        // Launch failed before `ctx` existed, so teardown can't clean the workspace.
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});

test('shows the parse-error overlay for malformed XML', async () => {
    const overlay = innerFrame.locator('#parse-error-overlay');
    await expect(overlay).toBeVisible({ timeout: 15_000 });
    await expect(innerFrame.locator('#parse-error-title')).toContainText('Unable to read the manifest');
    await expect(innerFrame.locator('#parse-error-detail')).toBeVisible();
    await expect(innerFrame.locator('#parse-error-open-text')).toContainText('Open in Text Editor');
});

test('recovers into the editor once the XML is fixed', async () => {
    // Repair the file on disk, as the user would in the text editor. The overlay must clear
    // and the form must populate.
    const manifestPath = path.join(ctx.workspacePath, 'AppxManifest.xml');
    const validXml = fs.readFileSync(
        path.resolve(__dirname, '..', 'fixtures', 'winui-gallery.appxmanifest'),
        'utf-8'
    );
    fs.writeFileSync(manifestPath, validXml, 'utf-8');

    const frame = await getWebviewFrame(ctx.page);
    await expect(frame.locator('.tab-bar')).toBeVisible({ timeout: 20_000 });
    // The form is populated from the repaired document, not left blank.
    await expect(frame.locator('#identity-name')).not.toHaveValue('', { timeout: 20_000 });
    await expect(frame.locator('#parse-error-overlay')).toBeHidden();
});
