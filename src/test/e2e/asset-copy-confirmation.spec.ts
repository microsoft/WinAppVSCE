/**
 * E2E tests for the native confirmation gate on copying external images
 * into the Assets folder (issue #71, H1).
 *
 * The `checkImagePath` / `copyToAssets` webview messages alone must never be
 * enough to authorize copying a file from outside the workspace — a
 * compromised webview script could otherwise drive both messages end-to-end
 * without any real user interaction. These tests verify that a native,
 * user-answerable VS Code dialog gates the actual `fs.copyFileSync` call, and
 * that cancelling it leaves the filesystem and manifest untouched.
 */

import { test, expect, type FrameLocator } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    switchTab,
    setInputValue,
    getInputValue,
    waitForDebounce,
    type VSCodeTestContext,
} from './helpers';
import { ensureEditor, resetManifest } from './shared-context';

let ctx: VSCodeTestContext;
let frame: FrameLocator;
let externalDir: string;
let externalFilePath: string;

test.beforeAll(async () => {
    const shared = await ensureEditor();
    ctx = shared.ctx;

    // A file that lives outside the manifest's workspace/package directory —
    // this is the scenario that must require explicit confirmation.
    externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-copy-e2e-'));
    externalFilePath = path.join(externalDir, 'external-logo.png');
    fs.writeFileSync(externalFilePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
});

test.afterAll(() => {
    if (externalDir) {
        fs.rmSync(externalDir, { recursive: true, force: true });
    }
    if (ctx) {
        // Leave the shared workspace's Assets folder clean for whichever spec
        // file runs next (the VS Code instance is shared — see shared-context.ts).
        fs.rmSync(path.join(ctx.workspacePath, 'Assets'), { recursive: true, force: true });
    }
});

test.beforeEach(async () => {
    // Each test below copies the same external file into Assets. Clean up any
    // artifact left by a previous test first — otherwise the collision-avoidant
    // rename (e.g. external-logo_1.png) would mask assertions on the exact
    // destination path/name (issue #71 / H2).
    const assetsDir = path.join(ctx.workspacePath, 'Assets');
    fs.rmSync(assetsDir, { recursive: true, force: true });

    // Reset to a clean manifest, then point the logo at the external file so
    // the "external" copy-to-assets link renders.
    frame = await resetManifest(ctx);
    await switchTab(frame, 'properties');
    await setInputValue(frame, 'props-logo', externalFilePath);
    await waitForDebounce(ctx.page, 2_000);
});

test.afterEach(async () => {
    // Defensively dismiss any lingering modal. The VS Code instance is shared
    // across spec files (see shared-context.ts), so a dialog left open by a
    // failing assertion here would otherwise block unrelated specs that run
    // afterward.
    await ctx.page.keyboard.press('Escape').catch(() => {});
});

test('external image path shows a native confirmation dialog naming the file before copying', async () => {
    const link = frame.locator('#tab-properties .copy-to-assets-link');
    await expect(link).toBeVisible({ timeout: 10_000 });
    await link.click();

    const dialog = ctx.page.locator('.monaco-dialog-box');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog).toContainText('external-logo.png');
    await expect(dialog).toContainText(externalFilePath);

    // Don't leave the shared editor with a lingering modal for later tests.
    await ctx.page.keyboard.press('Escape');
});

test('cancelling the confirmation copies nothing and leaves the logo path unchanged', async () => {
    const assetsDir = path.join(ctx.workspacePath, 'Assets');
    const destPath = path.join(assetsDir, 'external-logo.png');

    const link = frame.locator('#tab-properties .copy-to-assets-link');
    await expect(link).toBeVisible({ timeout: 10_000 });
    await link.click();

    const dialog = ctx.page.locator('.monaco-dialog-box');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await ctx.page.keyboard.press('Escape');
    await ctx.page.waitForTimeout(1_000);

    expect(fs.existsSync(destPath)).toBe(false);

    const value = await getInputValue(frame, 'props-logo');
    expect(value).toBe(externalFilePath);
});

test('cancelling once, then re-clicking the same link still copies the file (H1 regression)', async () => {
    // Regression for issue #71 / H1: the token behind the still-rendered
    // webview link must survive a cancelled confirmation, otherwise this
    // second click would fail with a stale/expired-token error instead of
    // re-prompting and succeeding.
    const assetsDir = path.join(ctx.workspacePath, 'Assets');
    const destPath = path.join(assetsDir, 'external-logo.png');

    const link = frame.locator('#tab-properties .copy-to-assets-link');
    await expect(link).toBeVisible({ timeout: 10_000 });

    await link.click();
    let dialog = ctx.page.locator('.monaco-dialog-box');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await ctx.page.keyboard.press('Escape');
    await ctx.page.waitForTimeout(1_000);

    expect(fs.existsSync(destPath)).toBe(false);

    // Re-click the exact same link — its data-copy-token was never refreshed.
    await link.click();
    dialog = ctx.page.locator('.monaco-dialog-box');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByRole('button', { name: 'Copy File' }).click();
    await ctx.page.waitForTimeout(1_500);

    expect(fs.existsSync(destPath)).toBe(true);

    const value = await getInputValue(frame, 'props-logo');
    expect(value).toBe('Assets\\external-logo.png');
});

test('confirming the dialog copies the file into Assets and rewrites the logo path', async () => {
    const assetsDir = path.join(ctx.workspacePath, 'Assets');
    const destPath = path.join(assetsDir, 'external-logo.png');

    const link = frame.locator('#tab-properties .copy-to-assets-link');
    await expect(link).toBeVisible({ timeout: 10_000 });
    await link.click();

    const dialog = ctx.page.locator('.monaco-dialog-box');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByRole('button', { name: 'Copy File' }).click();
    await ctx.page.waitForTimeout(1_500);

    expect(fs.existsSync(destPath)).toBe(true);

    const value = await getInputValue(frame, 'props-logo');
    expect(value).toBe('Assets\\external-logo.png');
});
