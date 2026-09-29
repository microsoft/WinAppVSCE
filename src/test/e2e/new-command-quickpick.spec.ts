/**
 * E2E tests for the `winapp.new` QuickPick flow: template picker, name input,
 * and cancelling. Skips unless a template pack is already installed, so a run
 * never installs one machine-wide; CI installs it first (see build.yml).
 */

import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as path from 'path';
import * as os from 'os';
import {
    EXTENSION_ROOT,
    cleanupTempDirectories,
    hasInstalledTemplatePack,
    makeTempDirectory
} from './new-command-helpers';

const VSCODE_EXE =
    process.env.VSCODE_PATH ??
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe');

const EXTENSION_ARGS = process.env.E2E_USE_INSTALLED_EXTENSION === '1'
    ? []
    : [`--extensionDevelopmentPath=${EXTENSION_ROOT}`];

/** How long the local `winapp new --list` may take. */
const TEMPLATE_LOAD_TIMEOUT = 120_000;

test.afterAll(cleanupTempDirectories);

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
 * Run the command and advance past the template-pack QuickPick, picking the
 * non-destructive "use installed" option so the run never changes the machine.
 */
async function openTemplatePicker(page: Page): Promise<void> {
    await runCommandPalette(page, 'WinApp: Create WinUI App');

    // Poll the placeholder rather than list rows: the Command Palette has rows of
    // its own, so a row-visibility wait succeeds instantly while it's still open.
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

            // The CLI lists the blank app first and the picker preserves that order.
            expect(rowText[0]).toContain('WinUI Blank App');
            // Each row shows the display name and the CLI's short name, matching
            // `winapp new --list`, and nothing else.
            expect(rowText[0]).toContain('(winui)');
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

    test('prompts for a name and leaves validation to the CLI', async () => {
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

            // The extension does not re-implement the CLI's name rules, so even a
            // name the CLI rejects must not be blocked inline. The message node
            // always holds the prompt, so assert no validation error replaced it.
            await page.keyboard.press('Control+a');
            await page.keyboard.type('bad/name', { delay: 30 });
            await page.waitForTimeout(1_000);
            await expect(
                page.locator('.quick-input-widget .quick-input-message')
            ).toContainText('Name for the new app');

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
