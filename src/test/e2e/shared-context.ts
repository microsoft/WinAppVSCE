/**
 * Singleton VS Code instance shared across all E2E spec files.
 * Since Playwright runs with workers:1, all specs execute in the same process.
 */
import { expect, type FrameLocator } from '@playwright/test';
import {
    createTempWorkspace,
    launchVSCode,
    openManifestEditor,
    getWebviewFrame,
    teardown,
    type VSCodeTestContext,
} from './helpers';
import * as fs from 'fs';
import * as path from 'path';

let sharedCtx: VSCodeTestContext | null = null;
let sharedFrame: FrameLocator | null = null;
const FIXTURE_NAME = 'winui-gallery.appxmanifest';
const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');

/**
 * Returns the shared VS Code instance, launching it on first call.
 * Subsequent calls return the existing instance.
 */
export async function ensureEditor(): Promise<{ ctx: VSCodeTestContext; frame: FrameLocator }> {
    if (sharedCtx && sharedFrame) {
        return { ctx: sharedCtx, frame: sharedFrame };
    }
    sharedCtx = await launchVSCode(createTempWorkspace(FIXTURE_NAME));
    sharedFrame = await openManifestEditor(sharedCtx.page);
    return { ctx: sharedCtx, frame: sharedFrame };
}

/**
 * Resets the manifest file to the given fixture (or the default one).
 * The editor auto-reloads when the file changes on disk.
 * Returns the (possibly refreshed) webview frame.
 */
export async function resetManifest(ctx: VSCodeTestContext, fixtureName: string = FIXTURE_NAME): Promise<FrameLocator> {
    const src = path.join(FIXTURES_DIR, fixtureName);
    const dest = path.join(ctx.workspacePath, 'AppxManifest.xml');
    const expectedIdentityName = /<Identity\b[^>]*\bName="([^"]+)"/.exec(fs.readFileSync(src, 'utf-8'))?.[1];
    fs.copyFileSync(src, dest);
    // Give the editor time to detect the file change and reload
    await ctx.page.waitForTimeout(2_000);
    // Re-acquire the webview frame (it may have reloaded with new content)
    sharedFrame = await getWebviewFrame(ctx.page);
    // The reload is asynchronous: wait for the new fixture's content to actually
    // land in the webview instead of assuming a fixed delay was long enough.
    if (expectedIdentityName) {
        await expect(sharedFrame.locator('#identity-name'))
            .toHaveValue(expectedIdentityName, { timeout: 20_000 });
    }
    return sharedFrame;
}

/**
 * Tears down the shared VS Code instance. Called from globalTeardown.
 */
export async function closeSharedEditor(): Promise<void> {
    if (sharedCtx) {
        await teardown(sharedCtx);
        sharedCtx = null;
        sharedFrame = null;
    }
}
