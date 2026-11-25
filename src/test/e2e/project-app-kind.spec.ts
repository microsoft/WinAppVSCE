/**
 * E2E test: the manifest editor reads the project file beside the manifest to decide whether
 * a template manifest (EntryPoint="$targetentrypoint$") is a UWP or desktop app (#263).
 */

import { test, expect, type FrameLocator } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import {
    createTempWorkspace,
    getWebviewFrame,
    launchVSCode,
    switchTab,
    teardown,
    type VSCodeTestContext,
} from './helpers';

let ctx: VSCodeTestContext;

test.beforeAll(async () => {
    // The fixture declares runFullTrust, which alone reads as a WinUI 3 desktop app. A UWP
    // project beside it must win, so the UWP-only option stays available. A .vcxproj avoids
    // waking the C# Dev Kit, whose welcome tab would steal focus from the manifest.
    const tmpDir = createTempWorkspace('winui-gallery.appxmanifest');
    fs.writeFileSync(path.join(tmpDir, 'App.vcxproj'),
        '<Project><PropertyGroup><AppContainerApplication>true</AppContainerApplication></PropertyGroup></Project>');
    ctx = await launchVSCode(tmpDir);
});

test.afterAll(async () => {
    if (ctx) { await teardown(ctx); }
});

test('a UWP project file keeps Supports Multiple Instances available for a template manifest', async () => {
    // The launch args open the manifest in the text editor; its title bar button opens the visual editor.
    const button = ctx.page.locator('.editor-actions a.action-label[aria-label*="Open Manifest Editor"]').first();
    await expect(button).toBeVisible({ timeout: 15_000 });
    await button.click();
    let frame!: FrameLocator;
    await expect(async () => { frame = await getWebviewFrame(ctx.page); }).toPass({ timeout: 30_000 });
    await switchTab(frame, 'applications');
    await expect(frame.locator('.app-card').first().locator('#add-app-0-multiinstance')).toBeVisible();
});
