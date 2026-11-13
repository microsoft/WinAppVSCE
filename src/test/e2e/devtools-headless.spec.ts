/**
 * E2E: a `devTools: "headless"` launch keeps the app toolbar hidden while the VS Code panel
 * works. The engine shows the toolbar when the panel's first overlay call builds
 * it, so this pins the panel re-hiding it, against a real app and engine.
 */

import { test, expect } from '@playwright/test';
import { spawnSync } from 'child_process';
import {
    launchVSCode,
    getWebviewFrameWaitingFor,
    dismissLateStartupDialogs,
    teardown,
    type VSCodeTestContext,
} from './helpers';
import {
    ensureFixtureAppBuilt,
    createDevToolsWorkspace,
    cliSupportsDevTools,
    readOverlayState,
} from './devtools-fixture';
import { NO_HIGHLIGHT } from '../../devtools/overlay';
import { RUN_EXIT_GRACE_MS } from '../../process-tree';

test.describe.configure({ mode: 'serial' });

let ctx: VSCodeTestContext | undefined;
let launchFailure: string | undefined;

test.beforeAll(async () => {
    test.setTimeout(20 * 60_000);
    const dotnet = spawnSync('dotnet', ['--version'], { shell: true, encoding: 'utf-8' });
    if (dotnet.status !== 0) { launchFailure = 'the .NET SDK is not available'; return; }
    if (!cliSupportsDevTools()) { launchFailure = 'the winapp CLI in bin/ does not support "run --devtools"'; return; }

    const workspace = createDevToolsWorkspace(ensureFixtureAppBuilt(), { headless: true });
    ctx = await launchVSCode(workspace, { openManifest: false });
    await ctx.page.keyboard.press('F5');
});

test.afterAll(async () => {
    test.setTimeout(RUN_EXIT_GRACE_MS + 30_000);
    if (!ctx) { return; }
    try {
        await ctx.page.keyboard.press('Shift+F5');
        await ctx.page.waitForTimeout(RUN_EXIT_GRACE_MS + 1_000);
    } catch { /* window may already be gone */ }
    await teardown(ctx);
});

test('a headless launch keeps the app toolbar hidden while the panel highlights @winui-app', async () => {
    test.setTimeout(300_000);
    if (launchFailure) { test.skip(true, `DevTools E2E skipped: ${launchFailure}`); }
    const frame = await getWebviewFrameWaitingFor(ctx!.page, '#tree-viewport', 240_000);
    await dismissLateStartupDialogs(ctx!.page);
    await expect(frame.locator('.tree-row').first()).toBeVisible({ timeout: 60_000 });

    await frame.locator('#filter').fill('FixtureHeading');
    const row = frame.locator('.tree-row', { hasText: 'FixtureHeading' }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.hover();
    await row.click();

    // Highlighting builds the overlay; the toolbar must stay (or be put back) hidden.
    const deadline = Date.now() + 30_000;
    let state = readOverlayState();
    while (Date.now() < deadline && !(state && state.highlightHandle !== NO_HIGHLIGHT && !state.toolbarVisible)) {
        await new Promise(resolve => setTimeout(resolve, 500));
        state = readOverlayState();
    }
    expect(state?.highlightHandle).not.toBe(NO_HIGHLIGHT);
    expect(state?.toolbarVisible).toBe(false);

    // Settle, then confirm nothing brought it back.
    await new Promise(resolve => setTimeout(resolve, 3_000));
    expect(readOverlayState()?.toolbarVisible).toBe(false);
});
