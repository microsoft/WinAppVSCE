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
    runCommand,
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
    const fixtureXml = fs.readFileSync(src, 'utf-8');
    fs.copyFileSync(src, dest);
    // Give the editor time to detect the file change and reload
    await ctx.page.waitForTimeout(2_000);
    // Re-acquire the webview frame (it may have reloaded with new content)
    sharedFrame = await getWebviewFrame(ctx.page);

    // The watcher-driven reload is best-effort — VS Code will not pick the new content
    // up while the document still holds edits from the previous spec. Wait for a value
    // only this fixture carries, and force a revert from disk if it does not arrive.
    const identityName = /<Identity\b[^>]*\bName="([^"]*)"/.exec(fixtureXml)?.[1];
    if (!identityName) {
        return sharedFrame;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
        const loaded = await expect(sharedFrame.locator('#identity-name'))
            .toHaveValue(identityName, { timeout: 10_000 })
            .then(() => true)
            .catch(() => false);
        if (loaded) {
            return sharedFrame;
        }
        await runCommand(ctx.page, 'File: Revert File');
        sharedFrame = await getWebviewFrame(ctx.page);
    }
    await expect(sharedFrame.locator('#identity-name')).toHaveValue(identityName, { timeout: 15_000 });
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
