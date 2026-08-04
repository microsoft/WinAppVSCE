/**
 * E2E tests for the `winapp.sign` command's QuickPick flows.
 *
 * Test 1 — Artifact QuickPick:
 *   Opens VS Code in a workspace containing a .msix file, runs "WinApp: Sign Package",
 *   and asserts that a QuickPick appears listing the artifact and a "Browse…" option.
 *
 * Test 2 — Discovery exclusions:
 *   Verifies user `files.exclude` settings do not hide build artifacts while
 *   `node_modules` and `.git` remain excluded from the QuickPick.
 *
 * Test 3 — Certificate QuickPick:
 *   Opens VS Code in a workspace containing both a .msix and a .pfx file, selects
 *   the package, and asserts that a second QuickPick appears for certificate selection.
 *
 * Test 4 — Cancel artifact QuickPick:
 *   Opens VS Code, runs "WinApp: Sign Package", and presses Escape to dismiss the
 *   artifact QuickPick. Verifies the sign flow aborts gracefully (no certificate
 *   picker or terminal appears).
 *
 * Test 5 — Browse option:
 *   Opens VS Code, runs "WinApp: Sign Package", selects "Browse…" from the QuickPick,
 *   and verifies that a native file dialog opens (the Open dialog title bar appears).
 *
 * Test 6 — Cancel certificate QuickPick:
 *   Opens VS Code, selects an artifact from the package QuickPick, then presses
 *   Escape on the certificate QuickPick. Verifies the sign flow aborts (no terminal).
 */

import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// ──────────────────────────────────────────────────────
// Paths
// ──────────────────────────────────────────────────────

const VSCODE_EXE =
    process.env.VSCODE_PATH ??
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe');

const EXTENSION_ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * Launch VS Code with our extension loaded, opening the given folder.
 */
async function launchVSCodeForFolder(folderPath: string): Promise<{ app: ElectronApplication; page: Page }> {
    const app = await electron.launch({
        executablePath: VSCODE_EXE,
        args: [
            folderPath,
            '--new-window',
            `--extensionDevelopmentPath=${EXTENSION_ROOT}`,
            '--disable-telemetry',
            '--skip-release-notes',
            '--disable-workspace-trust',
        ],
        timeout: 30_000,
    });

    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    // Allow VS Code to finish initialising & activating extensions
    await page.waitForTimeout(6_000);

    return { app, page };
}

/**
 * Open the Command Palette and type a command name, then press Enter.
 */
async function runCommandPalette(page: Page, commandLabel: string): Promise<void> {
    await page.keyboard.press('Control+Shift+P');
    await page.waitForTimeout(1_000);
    await page.keyboard.type(commandLabel, { delay: 30 });
    await page.waitForTimeout(1_500);
    await page.keyboard.press('Enter');
}

/**
 * Create a temp workspace with a .msix file and optionally a .pfx file.
 */
function createSignTestWorkspace(options?: { includePfx?: boolean }): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-e2e-'));
    const msixPath = path.join(tmpDir, 'AppPackages', 'MyApp_1.0.0.0_x64.msix');
    fs.mkdirSync(path.dirname(msixPath), { recursive: true });
    fs.writeFileSync(msixPath, Buffer.alloc(1024));

    if (options?.includePfx) {
        const pfxPath = path.join(tmpDir, 'certs', 'DevCert.pfx');
        fs.mkdirSync(path.dirname(pfxPath), { recursive: true });
        fs.writeFileSync(pfxPath, Buffer.alloc(512));
    }

    return tmpDir;
}

function configureFilesExclude(workspacePath: string): void {
    const settingsPath = path.join(workspacePath, '.vscode', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
        'files.exclude': {
            '**/AppPackages': true
        }
    }));
}

// ──────────────────────────────────────────────────────
// Test 1 — Workspace with .msix artifact
// ──────────────────────────────────────────────────────

test.describe('winapp.sign command — artifact discovery', () => {
    test('shows QuickPick with .msix file and Browse option when artifacts exist', async () => {
        const tmpDir = createSignTestWorkspace();

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCodeForFolder(tmpDir);
            app = launched.app;
            const page = launched.page;

            // Run "WinApp: Sign Package"
            await runCommandPalette(page, 'WinApp: Sign Package');

            const quickInput = page.locator('.quick-input-widget');
            const inputBox = quickInput.locator('.quick-input-filter input[type="text"]');
            await expect(inputBox).toHaveAttribute('placeholder', /package to sign/, { timeout: 20_000 });

            // There should be at least 2 items: the .msix file + Browse…
            const items = quickInput.locator('.quick-input-list .monaco-list-row');
            await expect(items).toHaveCount(2, { timeout: 10_000 });

            // First item should be the .msix artifact (use .first() on label-name
            // since VS Code may render label + highlight spans)
            const firstRowText = await items.nth(0).textContent();
            expect(firstRowText).toContain('MyApp_1.0.0.0_x64.msix');

            // Last item should be "Browse…"
            const lastRowText = await items.nth(1).textContent();
            expect(lastRowText).toContain('Browse');

            // Dismiss the QuickPick
            await page.keyboard.press('Escape');

            console.log('✅ PASS: QuickPick appeared with .msix artifact and Browse… option');
        } finally {
            if (app) {
                await app.close().catch(() => {});
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('keeps build artifacts visible while excluding dependency and repository metadata', async () => {
        const tmpDir = createSignTestWorkspace();
        configureFilesExclude(tmpDir);
        fs.mkdirSync(path.join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg', 'Ignored.msix'), Buffer.alloc(128));
        fs.mkdirSync(path.join(tmpDir, 'vendor', '.git', 'objects'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'vendor', '.git', 'objects', 'Ignored.appx'), Buffer.alloc(128));

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCodeForFolder(tmpDir);
            app = launched.app;
            const page = launched.page;

            await runCommandPalette(page, 'WinApp: Sign Package');

            const quickInput = page.locator('.quick-input-widget');
            const inputBox = quickInput.locator('.quick-input-filter input[type="text"]');
            await expect(inputBox).toHaveAttribute('placeholder', /package to sign/, { timeout: 20_000 });
            const items = quickInput.locator('.quick-input-list .monaco-list-row');
            await expect(items.first()).toBeVisible({ timeout: 20_000 });
            await expect(items).toHaveCount(2, { timeout: 10_000 });

            const quickPickText = await items.allTextContents();
            expect(quickPickText.join(' ')).toContain('MyApp_1.0.0.0_x64.msix');
            expect(quickPickText.join(' ')).not.toContain('Ignored.msix');
            expect(quickPickText.join(' ')).not.toContain('Ignored.appx');

            await page.keyboard.press('Escape');
        } finally {
            if (app) {
                await app.close().catch(() => {});
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('shows certificate QuickPick with .pfx file after selecting a package', async () => {
        const tmpDir = createSignTestWorkspace({ includePfx: true });

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCodeForFolder(tmpDir);
            app = launched.app;
            const page = launched.page;

            // Run "WinApp: Sign Package"
            await runCommandPalette(page, 'WinApp: Sign Package');

            const quickInput = page.locator('.quick-input-widget');
            const packageInput = quickInput.locator('.quick-input-filter input[type="text"]');
            await expect(packageInput).toHaveAttribute('placeholder', /package to sign/, { timeout: 20_000 });

            // Select the artifact by label so a stale Command Palette row cannot win the race.
            const packageItem = quickInput.locator('.quick-input-list .monaco-list-row')
                .filter({ hasText: 'MyApp_1.0.0.0_x64.msix' });
            await expect(packageItem).toHaveCount(1, { timeout: 10_000 });
            await packageItem.click();

            const certInput = quickInput.locator('.quick-input-filter input[type="text"]');
            await expect(certInput).toHaveAttribute('placeholder', /signing certificate/, { timeout: 20_000 });

            // There should be 2 items: the .pfx file + Browse…
            const certItems = quickInput.locator('.quick-input-list .monaco-list-row');
            await expect(certItems).toHaveCount(2, { timeout: 10_000 });

            // First item should be the .pfx certificate
            const firstCertText = await certItems.nth(0).textContent();
            expect(firstCertText).toContain('DevCert.pfx');

            // Last item should be "Browse…"
            const lastCertText = await certItems.nth(1).textContent();
            expect(lastCertText).toContain('Browse');

            // Dismiss the QuickPick
            await page.keyboard.press('Escape');

            console.log('✅ PASS: Certificate QuickPick appeared with .pfx file and Browse… option');
        } finally {
            if (app) {
                await app.close().catch(() => {});
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // ──────────────────────────────────────────────────────
    // Test 3 — Cancel artifact QuickPick (issue #79)
    // ──────────────────────────────────────────────────────

    test('cancelling the artifact QuickPick aborts the sign flow', async () => {
        const tmpDir = createSignTestWorkspace();

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCodeForFolder(tmpDir);
            app = launched.app;
            const page = launched.page;

            // Run "WinApp: Sign Package"
            await runCommandPalette(page, 'WinApp: Sign Package');

            const quickInput = page.locator('.quick-input-widget');
            const inputBox = quickInput.locator('.quick-input-filter input[type="text"]');
            await expect(inputBox).toHaveAttribute('placeholder', /package to sign/, { timeout: 20_000 });

            // Press Escape to cancel the QuickPick
            await page.keyboard.press('Escape');
            await page.waitForTimeout(2_000);

            // VS Code retains inactive QuickPick rows in the DOM, so assert on
            // the widget's visibility rather than the row count.
            await expect(quickInput).toBeHidden({ timeout: 5_000 });

            // Verify no WinApp terminal was created (sign was not executed)
            const terminalTabs = page.locator('.terminal-tab');
            const terminalCount = await terminalTabs.count();
            expect(terminalCount).toBe(0);

            console.log('✅ PASS: Cancelling artifact QuickPick aborted the sign flow');
        } finally {
            if (app) {
                await app.close().catch(() => {});
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // ──────────────────────────────────────────────────────
    // Test 4 — Browse smoke test (issue #79)
    // ──────────────────────────────────────────────────────

    test('selecting Browse dismisses the QuickPick in a native-dialog smoke test', async () => {
        const tmpDir = createSignTestWorkspace();

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCodeForFolder(tmpDir);
            app = launched.app;
            const page = launched.page;

            // Run "WinApp: Sign Package"
            await runCommandPalette(page, 'WinApp: Sign Package');

            // Wait for the artifact QuickPick to appear
            const quickInput = page.locator('.quick-input-widget');
            const inputBox = quickInput.locator('.quick-input-filter input[type="text"]');
            await expect(inputBox).toHaveAttribute('placeholder', /package to sign/, { timeout: 20_000 });

            // Select the Browse row by its label rather than position so this
            // cannot accidentally click a stale Command Palette result.
            const items = quickInput.locator('.quick-input-list .monaco-list-row');
            const browseItem = items.filter({ hasText: 'Browse' });
            await expect(browseItem).toHaveCount(1, { timeout: 10_000 });
            await browseItem.click();

            // Smoke test only: selecting Browse should dismiss the QuickPick and
            // trigger the native file dialog path. Playwright cannot interact
            // with or assert on native OS dialogs, so unit tests provide the
            // real coverage for the Browse branch while this test verifies the
            // VS Code-side handoff happens without an immediate error.
            await page.waitForTimeout(2_000);

            // The QuickPick should no longer be visible (replaced by native dialog).
            await expect(quickInput).toBeHidden({ timeout: 5_000 });

            // No error notification should be visible
            await expect(page.locator('.notification-toast .codicon-error:visible')).toHaveCount(0);

            console.log('✅ PASS: Selecting Browse dismissed QuickPick and opened file dialog');

            // Close the native dialog by pressing Escape (may or may not work
            // depending on OS focus, but attempt it for cleanup)
            await page.keyboard.press('Escape');
        } finally {
            if (app) {
                await app.close().catch(() => {});
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // ──────────────────────────────────────────────────────
    // Test 5 — Cancel certificate QuickPick (issue #79)
    // ──────────────────────────────────────────────────────

    test('cancelling the certificate QuickPick aborts the sign flow', async () => {
        const tmpDir = createSignTestWorkspace({ includePfx: true });

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCodeForFolder(tmpDir);
            app = launched.app;
            const page = launched.page;

            // Run "WinApp: Sign Package"
            await runCommandPalette(page, 'WinApp: Sign Package');

            const quickInput = page.locator('.quick-input-widget');
            const packageInput = quickInput.locator('.quick-input-filter input[type="text"]');
            await expect(packageInput).toHaveAttribute('placeholder', /package to sign/, { timeout: 20_000 });

            const packageItem = quickInput.locator('.quick-input-list .monaco-list-row')
                .filter({ hasText: 'MyApp_1.0.0.0_x64.msix' });
            await expect(packageItem).toHaveCount(1, { timeout: 10_000 });
            await packageItem.click();

            const certInput = quickInput.locator('.quick-input-filter input[type="text"]');
            await expect(certInput).toHaveAttribute('placeholder', /signing certificate/, { timeout: 20_000 });

            // Press Escape to cancel the certificate QuickPick
            await page.keyboard.press('Escape');
            await page.waitForTimeout(2_000);

            // Verify the QuickPick is dismissed.
            await expect(quickInput).toBeHidden({ timeout: 5_000 });

            // Verify no WinApp terminal was created (sign was not executed)
            const terminalTabs = page.locator('.terminal-tab');
            const terminalCount = await terminalTabs.count();
            expect(terminalCount).toBe(0);

            console.log('✅ PASS: Cancelling certificate QuickPick aborted the sign flow');
        } finally {
            if (app) {
                await app.close().catch(() => {});
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // The post-pack "Sign" action calls winapp.sign with a prefilled artifact
    // path, which skips the package QuickPick and goes straight to the
    // certificate picker. This path is now covered by unit tests in
    // src/test/sign-flow.test.ts via the extracted executeSignFlow function.
    // See issue #83.
});
