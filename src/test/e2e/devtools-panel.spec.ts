/**
 * E2E tests: the WinUI DevTools panel, driven against a real running WinUI app.
 *
 * This is the only test that covers `devtools-panel.ts` and the panel's webview
 * running inside real VS Code against a real DevTools engine. Everything below
 * the panel (the JSON-RPC client, the protocol types) has fast unit coverage;
 * what is unique here is the wiring — F5 launches the app, the extension spawns
 * `winapp run --devtools`, connects over the named pipe, and renders the tree.
 *
 * The launch config sets `noDebug`, so no language-debugger extension is needed.
 * That keeps the spec runnable on a clean machine and in CI.
 */

import { test, expect } from '@playwright/test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
    launchVSCode,
    getWebviewFrameWaitingFor,
    teardown,
    type VSCodeTestContext,
} from './helpers';
import {
    ensureFixtureAppBuilt,
    createDevToolsWorkspace,
    snapshotOwnedPids,
    killProcessesStartedSinceWithRetry,
    FIXTURE_APP_DIR,
} from './devtools-fixture';

// One VS Code instance and one launched app shared by the whole file: starting a
// WinUI app per test would multiply the slowest part of the run.
test.describe.configure({ mode: 'serial' });

let ctx: VSCodeTestContext | undefined;
let launchFailure: string | undefined;
let preLaunchPids = new Set<number>();

/** The DevTools panel's webview root; present only once the panel has rendered. */
const TREE_VIEWPORT = '#tree-viewport';

function hasDotnet(): boolean {
    const probe = spawnSync('dotnet', ['--version'], { shell: true, encoding: 'utf-8' });
    return probe.status === 0;
}

test.beforeAll(async () => {
    // A cold build restores the Windows App SDK, which dominates this budget.
    test.setTimeout(20 * 60_000);

    if (!hasDotnet()) {
        launchFailure = 'the .NET SDK is not available';
        return;
    }

    const inputFolder = ensureFixtureAppBuilt();
    const workspace = createDevToolsWorkspace(inputFolder);

    // Recorded before anything launches so teardown can tell our processes apart
    // from any the developer already had running.
    preLaunchPids = snapshotOwnedPids();

    // The workspace holds only a launch.json — there is no manifest to open.
    ctx = await launchVSCode(workspace, { openManifest: false });

    // F5 runs the sole configuration in launch.json.
    await ctx.page.keyboard.press('F5');
});

test.afterAll(async () => {
    if (!ctx) {
        return;
    }
    // Stop the debug session first so the extension's own teardown runs.
    try {
        await ctx.page.keyboard.press('Shift+F5');
        await ctx.page.waitForTimeout(3_000);
    } catch { /* window may already be gone */ }

    await teardown(ctx);

    // Backstop: a leaked app or CLI process keeps its DevTools named pipe open,
    // which makes a subsequent run fail to open the panel. Shutting VS Code down
    // does not reliably stop it, so clean up explicitly.
    await killProcessesStartedSinceWithRetry(preLaunchPids);
});

/**
 * Acquires the DevTools webview, failing with a useful message when the panel
 * never appeared — otherwise every assertion in the file reports the same
 * opaque frame-not-found error.
 *
 * The default budget is generous because the first acquisition covers a cold
 * WinUI app start plus the engine handshake over the named pipe.
 */
async function devToolsFrame(timeout = 180_000) {
    if (launchFailure) {
        test.skip(true, `DevTools E2E skipped: ${launchFailure}`);
    }
    if (!ctx) {
        throw new Error('VS Code was not launched');
    }
    return getWebviewFrameWaitingFor(ctx.page, TREE_VIEWPORT, timeout);
}

test('launching with DevTools opens the panel and renders the visual tree @winui-app', async () => {
    test.setTimeout(260_000);

    const frame = await devToolsFrame();

    // The tree is populated from the live app, so any rows at all prove the
    // full chain: app launched, engine up, pipe connected, tree enumerated.
    const rows = frame.locator('.tree-row');
    await expect(rows.first()).toBeVisible({ timeout: 60_000 });
    expect(await rows.count()).toBeGreaterThan(0);
});

test('the tree contains the fixture app element names @winui-app', async () => {
    test.setTimeout(120_000);

    const frame = await devToolsFrame();

    // Filter rather than expand: the tree is virtualised and collapsed by
    // default, and filtering is itself part of the panel's contract.
    const filter = frame.locator('#filter');
    await filter.fill('FixtureButton');

    const named = frame.locator('.tree-row .node-name', { hasText: 'FixtureButton' });
    await expect(named.first()).toBeVisible({ timeout: 30_000 });
});

test('the tree reports the XAML file each element came from @winui-app', async () => {
    test.setTimeout(120_000);

    const frame = await devToolsFrame();

    await frame.locator('#filter').fill('FixtureHeading');
    const row = frame.locator('.tree-row', { hasText: 'FixtureHeading' }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });

    // Source attribution is what makes "go to source" possible; assert the
    // element is traced back to the fixture's page, not just that it exists.
    await expect(row.locator('.node-file')).toContainText('MainPage.xaml');
});

test('selecting an element populates the property grid @winui-app', async () => {
    test.setTimeout(120_000);

    const frame = await devToolsFrame();

    await frame.locator('#filter').fill('FixtureHeading');
    const row = frame.locator('.tree-row', { hasText: 'FixtureHeading' }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();

    // The header names the selected element and the grid fills with its
    // properties — an empty grid here means the properties request failed.
    await expect(frame.locator('#props-header')).toContainText('FixtureHeading', { timeout: 30_000 });
    await expect(frame.locator('#props-viewport')).not.toBeEmpty();
});

test('the property grid shows a value set in the fixture XAML @winui-app', async () => {
    test.setTimeout(120_000);

    const frame = await devToolsFrame();

    await frame.locator('#filter').fill('FixtureHeading');
    const row = frame.locator('.tree-row', { hasText: 'FixtureHeading' }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();
    await expect(frame.locator('#props-header')).toContainText('FixtureHeading', { timeout: 30_000 });

    // MainPage.xaml sets Text="DevTools Fixture" on this element. Reading it
    // back proves real property values cross the pipe, not just property names.
    await frame.locator('#prop-filter').fill('Text');
    await expect(frame.locator('#props-viewport')).toContainText('DevTools Fixture', { timeout: 30_000 });
});

test('switching to the Comments tab shows the comments view @winui-app', async () => {
    test.setTimeout(120_000);

    const frame = await devToolsFrame();

    await frame.locator('#tab-comments').click();
    await expect(frame.locator('#comments-viewport')).toBeVisible();
    await expect(frame.locator('#compose-add')).toBeVisible();

    // Return to the tree so a retry of a later test starts from the default view.
    await frame.locator('#tab-tree').click();
    await expect(frame.locator(TREE_VIEWPORT)).toBeVisible();
});

test('the fixture app source is committed without build output @winui-app', async () => {
    // Guards the fixture's own contract: the app is built on demand, so a
    // committed bin/ would bloat the repo and go stale silently.
    // --cached --others --exclude-standard lists both committed and
    // not-yet-committed files while still honouring .gitignore, so this guard
    // works before the fixture is committed as well as after.
    const tracked = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '.'], {
        cwd: FIXTURE_APP_DIR,
        encoding: 'utf-8',
        shell: true,
    });
    expect(tracked.status).toBe(0);

    const files = tracked.stdout.split('\n').map(f => f.trim()).filter(Boolean);
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter(f => /(^|\/)(bin|obj)\//.test(f))).toEqual([]);

    // The csproj references these publish profiles by name and the repo-root
    // .gitignore excludes *.pubxml globally, so verify the fixture's own
    // negation is still in force.
    expect(files.some(f => f.endsWith('.pubxml'))).toBe(true);
    expect(fs.existsSync(path.join(FIXTURE_APP_DIR, 'MainPage.xaml'))).toBe(true);
});
