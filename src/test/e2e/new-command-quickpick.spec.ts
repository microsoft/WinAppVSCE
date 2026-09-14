/**
 * E2E tests for the `winapp.new` ("WinApp: Create WinUI App") QuickPick flow.
 *
 * Test 1 — Template QuickPick:
 *   Opens VS Code in an empty workspace, runs "WinApp: Create WinUI App", and
 *   asserts that a template QuickPick appears listing the official WinUI
 *   templates (blank app, NavigationView shell, MVVM, class library, …).
 *
 * Test 2 — Name input:
 *   Selects a template and asserts the name InputBox appears prefilled with the
 *   CLI's default, and that an invalid name is rejected inline rather than
 *   reaching the CLI.
 *
 * Test 3 — Cancel:
 *   Escapes out of the template QuickPick and verifies nothing further happens
 *   (no name prompt, no folder dialog).
 *
 * These tests drive the real `winapp new --list --json`, but only ever the
 * purely local `--template-version installed` path: the suite skips itself
 * unless a WinUI template pack is already on the machine. Without that guard a
 * test run on a clean machine would fall through to the unpinned listing, which
 * installs the pack machine-wide for every tool that uses `dotnet new` — a side
 * effect a test must never cause. The install/fallback decisions that guard is
 * stepping around are covered deterministically in
 * `src/test/new-command-utils.test.ts`, so nothing is lost by skipping.
 */

import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const VSCODE_EXE =
    process.env.VSCODE_PATH ??
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe');

const EXTENSION_ROOT = path.resolve(__dirname, '..', '..', '..');
const EXTENSION_ARGS = process.env.E2E_USE_INSTALLED_EXTENSION === '1'
    ? []
    : [`--extensionDevelopmentPath=${EXTENSION_ROOT}`];

/**
 * Resolve the CLI the extension itself would run, mirroring `getWinappCliPath`.
 */
function resolveCliPath(): string {
    const arch = os.arch() === 'arm64' ? 'win-arm64' : 'win-x64';
    const candidates = [
        path.join(EXTENSION_ROOT, 'bin', arch, 'winapp.exe'),
        path.join(EXTENSION_ROOT, '..', 'bin', arch, 'winapp.exe')
    ];
    return candidates.find((candidate) => fs.existsSync(candidate)) ?? 'winapp';
}

/**
 * Whether a WinUI template pack is already installed on this machine.
 *
 * Probed with `--template-version installed`, which is a purely local query —
 * it reports what is on disk and never contacts a feed or installs anything.
 * Run from a temp directory so a `global.json` in the repo can't make a present
 * SDK look missing.
 */
function hasInstalledTemplatePack(): boolean {
    try {
        const output = execFileSync(
            resolveCliPath(),
            ['new', '--list', '--json', '--template-version', 'installed'],
            { cwd: os.tmpdir(), encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }
        );
        return /"Listed"\s*:\s*true/.test(output);
    } catch {
        // Non-zero exit means no pack (or no SDK) — either way, don't install one.
        return false;
    }
}

/** How long the local `winapp new --list` may take. */
const TEMPLATE_LOAD_TIMEOUT = 120_000;

/** Temp directories to remove once the whole spec finishes. */
const pendingDirectories = new Set<string>();

/**
 * Create a temp directory that is swept up after the whole spec finishes.
 *
 * Cleanup is deferred rather than done per test because VS Code can still hold
 * a handle on the workspace (or its user-data dir) for a moment after the
 * Electron app closes, which makes an immediate delete fail.
 */
function makeTempDirectory(prefix: string): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    pendingDirectories.add(directory);
    return directory;
}

test.afterAll(() => {
    for (const directory of pendingDirectories) {
        try {
            fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch {
            // A leftover temp directory must never fail an otherwise green run.
        }
    }
    pendingDirectories.clear();
});

async function launchVSCodeForFolder(folderPath: string): Promise<{ app: ElectronApplication; page: Page }> {
    // An isolated user-data-dir is required: with a VS Code already running,
    // a plain --new-window is delegated to that instance and the process we
    // launched exits immediately, leaving Playwright with no window.
    const userDataPath = makeTempDirectory('winapp-new-e2e-user-');

    const app = await electron.launch({
        executablePath: VSCODE_EXE,
        args: [
            folderPath,
            '--new-window',
            `--user-data-dir=${userDataPath}`,
            ...EXTENSION_ARGS,
            '--disable-telemetry',
            '--skip-release-notes',
            '--disable-workspace-trust',
        ],
        timeout: 60_000,
    });

    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('.monaco-workbench')).toBeVisible({ timeout: 60_000 });

    // A fresh user-data-dir always shows the welcome dialog, which would
    // otherwise swallow the Command Palette keystroke.
    const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Visual Studio Code' });
    const welcomeAppeared = await welcomeDialog.waitFor({ state: 'visible', timeout: 10_000 })
        .then(() => true, () => false);
    if (welcomeAppeared) {
        await welcomeDialog.getByRole('button', { name: 'Close' }).click();
        await expect(welcomeDialog).toBeHidden({ timeout: 10_000 });
    }

    // Give the extension host time to activate before driving the palette.
    await page.waitForTimeout(5_000);

    return { app, page };
}

async function runCommandPalette(page: Page, commandLabel: string): Promise<void> {
    await page.keyboard.press('Control+Shift+P');
    await page.waitForTimeout(1_000);
    await page.keyboard.type(commandLabel, { delay: 30 });
    await page.waitForTimeout(1_500);
    await page.keyboard.press('Enter');
}

function quickInputPlaceholder(page: Page): Promise<string | null> {
    return page
        .locator('.quick-input-widget .quick-input-filter input[type="text"]')
        .getAttribute('placeholder');
}

/**
 * Run the command and advance past the template-pack QuickPick.
 *
 * The suite only runs when a pack is installed, so this step is expected — but
 * it keys off the placeholder rather than assuming, and picks the
 * non-destructive "use installed" option so the run never changes the machine.
 */
async function openTemplatePicker(page: Page): Promise<void> {
    await runCommandPalette(page, 'WinApp: Create WinUI App');

    // Poll the placeholder rather than waiting on list rows: the Command Palette
    // has rows of its own, so a row-visibility wait succeeds instantly while the
    // palette is still open and the CLI is still being invoked.
    await expect.poll(
        () => quickInputPlaceholder(page),
        { timeout: TEMPLATE_LOAD_TIMEOUT, message: 'template or template-pack QuickPick never appeared' }
    ).toMatch(/Which WinUI templates|Select a WinUI template/);

    if ((await quickInputPlaceholder(page))?.includes('Which WinUI templates')) {
        // "Use installed templates" is first and pre-selected — no machine change.
        await page.keyboard.press('Enter');
        await expect.poll(
            () => quickInputPlaceholder(page),
            { timeout: TEMPLATE_LOAD_TIMEOUT, message: 'template QuickPick never appeared' }
        ).toContain('Select a WinUI template');
    }
}

test.describe('winapp.new command — template selection', () => {
    // Launching an isolated VS Code plus the template listing comfortably
    // exceeds the default per-test budget.
    test.describe.configure({ timeout: 240_000 });

    // Never let a test run install a template pack machine-wide. The decision
    // logic behind that install is unit-tested instead.
    test.skip(
        () => !hasInstalledTemplatePack(),
        'No WinUI template pack installed; skipping rather than installing one machine-wide.'
    );

    test('lists the official WinUI templates with no folder open', async () => {
        const tmpDir = makeTempDirectory('winapp-new-e2e-');

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCodeForFolder(tmpDir);
            app = launched.app;
            const page = launched.page;

            await openTemplatePicker(page);

            const rows = page.locator('.quick-input-widget .quick-input-list .monaco-list-row');
            const rowText = await rows.allTextContents();

            // The blank app is the anchor template and sorts first.
            expect(rowText[0]).toContain('WinUI Blank App');
            // The pack ships several templates; the picker shouldn't collapse to
            // one entry, and every row should be a WinUI template.
            expect(rowText.length).toBeGreaterThan(1);
            expect(rowText.every(text => /winui/i.test(text))).toBe(true);

            await page.keyboard.press('Escape');
        } finally {
            if (app) {
                await app.close().catch(() => {});
            }
        }
    });

    test('prompts for a name and rejects an invalid one inline', async () => {
        const tmpDir = makeTempDirectory('winapp-new-e2e-');

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCodeForFolder(tmpDir);
            app = launched.app;
            const page = launched.page;

            await openTemplatePicker(page);
            await page.keyboard.press('Enter');

            const input = page.locator('.quick-input-widget .quick-input-box input[type="text"]');
            await expect(input).toBeVisible({ timeout: 20_000 });
            await expect(input).toHaveValue('WinUIApp');

            // A name with a path separator can never produce a valid project.
            await page.keyboard.press('Control+a');
            await page.keyboard.type('bad/name', { delay: 30 });
            await expect(
                page.locator('.quick-input-widget .quick-input-message')
            ).toBeVisible({ timeout: 10_000 });

            // Enter must not advance while the name is invalid.
            await page.keyboard.press('Enter');
            await page.waitForTimeout(1_000);
            await expect(input).toBeVisible();

            await page.keyboard.press('Escape');
        } finally {
            if (app) {
                await app.close().catch(() => {});
            }
        }
    });

    test('cancelling the template QuickPick ends the flow', async () => {
        const tmpDir = makeTempDirectory('winapp-new-e2e-');

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCodeForFolder(tmpDir);
            app = launched.app;
            const page = launched.page;

            await openTemplatePicker(page);
            await page.keyboard.press('Escape');
            await page.waitForTimeout(2_000);

            // No follow-up prompt should be showing.
            await expect(page.locator('.quick-input-widget')).toBeHidden({ timeout: 10_000 });
        } finally {
            if (app) {
                await app.close().catch(() => {});
            }
        }
    });
});
