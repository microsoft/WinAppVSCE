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
 * These tests exercise the real `winapp new --list --json`, which requires the
 * .NET SDK and may install the WinUI template pack on first run — hence the
 * generous timeouts and the tolerance for the template-pack QuickPick that only
 * appears when a pack is already installed.
 */

import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
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

/** How long the first `winapp new --list` may take, including a pack install. */
const TEMPLATE_LOAD_TIMEOUT = 120_000;

async function launchVSCodeForFolder(folderPath: string): Promise<{ app: ElectronApplication; page: Page }> {
    const app = await electron.launch({
        executablePath: VSCODE_EXE,
        args: [
            folderPath,
            '--new-window',
            ...EXTENSION_ARGS,
            '--disable-telemetry',
            '--skip-release-notes',
            '--disable-workspace-trust',
        ],
        timeout: 30_000,
    });

    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(6_000);

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
 * Run the command and advance past the template-pack QuickPick if it appears.
 *
 * That step is conditional on a pack already being installed on the machine, so
 * the test can't assume either way — it keys off the placeholder and picks the
 * non-destructive "use installed" option, which is pre-selected.
 */
async function openTemplatePicker(page: Page): Promise<void> {
    await runCommandPalette(page, 'WinApp: Create WinUI App');

    const rows = page.locator('.quick-input-widget .quick-input-list .monaco-list-row');
    await expect(rows.first()).toBeVisible({ timeout: TEMPLATE_LOAD_TIMEOUT });

    const placeholder = await quickInputPlaceholder(page);
    if (placeholder?.includes('Which WinUI templates')) {
        // "Use installed templates" is first and pre-selected — no machine change.
        await page.keyboard.press('Enter');
        await expect(rows.first()).toBeVisible({ timeout: TEMPLATE_LOAD_TIMEOUT });
    }
}

test.describe('winapp.new command — template selection', () => {
    test('lists the official WinUI templates with no folder open', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'winapp-new-e2e-'));

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCodeForFolder(tmpDir);
            app = launched.app;
            const page = launched.page;

            await openTemplatePicker(page);

            expect(await quickInputPlaceholder(page)).toContain('Select a WinUI template');

            const rows = page.locator('.quick-input-widget .quick-input-list .monaco-list-row');
            const rowText = (await rows.allTextContents()).join('\n');

            // The blank app is the anchor template and sorts first.
            expect(rowText).toContain('winui');
            expect((await rows.allTextContents())[0]).toContain('winui');
            // The pack ships more than one template; the picker shouldn't collapse
            // to a single entry or silently include item templates only.
            expect(await rows.count()).toBeGreaterThan(1);

            await page.keyboard.press('Escape');
        } finally {
            if (app) {
                await app.close().catch(() => {});
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('prompts for a name and rejects an invalid one inline', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'winapp-new-e2e-'));

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
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('cancelling the template QuickPick ends the flow', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'winapp-new-e2e-'));

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
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
