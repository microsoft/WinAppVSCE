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

test.afterAll(async () => {
    if (ctx) await teardown(ctx);
});

test('shows error view for malformed XML', async () => {
    // Create a workspace with a broken manifest
    const tmpDir = createTempWorkspace('winui-gallery.appxmanifest');
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
    const innerFrame = webviewOuterFrame!.frameLocator('#active-frame');

    // Should show the error view
    const errorContainer = innerFrame.locator('.error-container');
    await expect(errorContainer).toBeVisible({ timeout: 15_000 });
    await expect(innerFrame.locator('.error-title')).toContainText('Unable to Open Manifest Editor');
    await expect(innerFrame.locator('.error-detail')).toBeVisible();
    await expect(innerFrame.locator('#open-as-text')).toBeVisible();
    await expect(innerFrame.locator('#open-as-text')).toContainText('Open in Text Editor');
});

test('recovers into the editor once the XML is fixed', async () => {
    // Repair the file on disk, as the user would in the text editor. The provider must
    // swap the standalone error page for the editor document and populate the form.
    const manifestPath = path.join(ctx.workspacePath, 'AppxManifest.xml');
    const validXml = fs.readFileSync(
        path.resolve(__dirname, '..', 'fixtures', 'winui-gallery.appxmanifest'),
        'utf-8'
    );
    fs.writeFileSync(manifestPath, validXml, 'utf-8');

    const frame = await getWebviewFrame(ctx.page);
    await expect(frame.locator('.error-container')).toHaveCount(0);
    await expect(frame.locator('.tab-bar')).toBeVisible({ timeout: 20_000 });
    // The form is populated from the repaired document, not left blank.
    await expect(frame.locator('#identity-name')).not.toHaveValue('', { timeout: 20_000 });
    await expect(frame.locator('#parse-error-overlay')).toBeHidden();
});
