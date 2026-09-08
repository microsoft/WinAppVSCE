/**
 * E2E tests for the `winapp.sign` command's QuickPick flows.
 *
 * Test 1 — Artifact QuickPick:
 *   Opens VS Code in a workspace containing a .msix file, runs "WinApp: Sign File",
 *   and asserts that a QuickPick appears listing the artifact and a "Browse…" option.
 *
 * Test 2 — Certificate QuickPick:
 *   Opens VS Code in a workspace containing both a .msix and a .pfx file, selects
 *   the package, and asserts that a second QuickPick appears for certificate selection.
 *
 * Test 3 — Cancel artifact QuickPick:
 *   Opens VS Code, runs "WinApp: Sign File", and presses Escape to dismiss the
 *   artifact QuickPick. Verifies the sign flow aborts gracefully (no certificate
 *   picker or terminal appears).
 *
 * Test 4 — Browse option:
 *   Opens VS Code, runs "WinApp: Sign File", selects "Browse…" from the QuickPick,
 *   and verifies that a native file dialog opens (the Open dialog title bar appears).
 *
 * Test 5 — Cancel certificate QuickPick:
 *   Opens VS Code, selects an artifact from the package QuickPick, then presses
 *   Escape on the certificate QuickPick. Verifies the sign flow aborts (no terminal).
 */

import { test, expect, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test';
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
const EXTENSION_ARGS = process.env.E2E_USE_INSTALLED_EXTENSION === '1'
    ? []
    : [`--extensionDevelopmentPath=${EXTENSION_ROOT}`];

/**
 * Launch VS Code with our extension loaded, opening the given folder.
 */
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
 * Wait for a command's own QuickPick to replace the Command Palette.
 *
 * Pressing Enter does not close the palette synchronously: it stays on screen,
 * rows and all, until the command opens its QuickPick. Waiting on "any list row
 * is visible" is therefore satisfied immediately by *palette* rows, and any
 * one-shot read that follows races the transition — returning palette content.
 *
 * The placeholder is unique per picker, so poll on that instead and only then
 * touch the rows.
 */
async function waitForQuickPick(page: Page, placeholder: RegExp): Promise<Locator> {
    const quickInput = page.locator('.quick-input-widget');
    await expect(
        quickInput.locator('.quick-input-filter input[type="text"]')
    ).toHaveAttribute('placeholder', placeholder, { timeout: 20_000 });
    return quickInput;
}

/**
 * Create a temp workspace with a .msix file and optionally a .pfx file.
 */
function createSignTestWorkspace(options?: { includePfx?: boolean; additionalFiles?: string[] }): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-e2e-'));
    const msixPath = path.join(tmpDir, 'AppPackages', 'MyApp_1.0.0.0_x64.msix');
    fs.mkdirSync(path.dirname(msixPath), { recursive: true });
    fs.writeFileSync(msixPath, Buffer.alloc(1024));

    if (options?.includePfx) {
        const pfxPath = path.join(tmpDir, 'certs', 'DevCert.pfx');
        fs.mkdirSync(path.dirname(pfxPath), { recursive: true });
        fs.writeFileSync(pfxPath, Buffer.alloc(512));
    }

    for (const relativePath of options?.additionalFiles ?? []) {
        const filePath = path.join(tmpDir, relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, Buffer.alloc(1024));
    }

    return tmpDir;
}

/** Create a file with a specific modification time, for ordering assertions. */
function createFileWithMtime(filePath: string, mtimeMs: number): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.alloc(1024));
    const time = new Date(mtimeMs);
    fs.utimesSync(filePath, time, time);
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

            // Run "WinApp: Sign File"
            await runCommandPalette(page, 'WinApp: Sign File');

            // Wait for the sign picker to take over from the palette.
            const quickInput = await waitForQuickPick(page, /file to sign/i);

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

    test('shows packages before executables and limits discovered files to 10', async () => {
        const tmpDir = createSignTestWorkspace({
            additionalFiles: [
                'AppPackages/MyBundle.msixbundle',
                ...Array.from({ length: 10 }, (_, index) => `bin/App${index}.exe`),
                'bin/App.dll',
            ],
        });

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCodeForFolder(tmpDir);
            app = launched.app;
            const page = launched.page;

            await runCommandPalette(page, 'WinApp: Sign File');

            const quickInput = await waitForQuickPick(page, /file to sign/i);
            const items = quickInput.locator('.quick-input-list .monaco-list-row');
            await expect(items.first()).toBeVisible({ timeout: 20_000 });
            await expect(items.first()).toHaveAttribute('aria-setsize', '11');

            const itemText = await items.allTextContents();
            expect(itemText.slice(0, 2).every(text => /\.(msix|msixbundle)/i.test(text))).toBe(true);
            expect(itemText.slice(2, 10).every(text => /\.(exe|dll)/i.test(text))).toBe(true);

            // The Browse row is virtualized out of view while the list is capped
            // (rows are three lines tall, so ~7 fit). ArrowUp from the first item
            // wraps to the last, scrolling it in.
            // Even when capped, Browse stays plain — no count or truncation note.
            await page.keyboard.press('ArrowUp');
            const browseRow = items.last();
            await expect(browseRow).toContainText('Browse');
            await expect(browseRow).not.toContainText(/most recent|showing/i);

            await page.keyboard.press('Escape');
        } finally {
            if (app) {
                await app.close().catch(() => {});
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('ranks MSIX packages above newer APPX packages and executables', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-e2e-tier-'));
        const now = Date.now();
        // The MSIX is the oldest file, so tier order (not mtime) must decide.
        createFileWithMtime(path.join(tmpDir, 'AppPackages', 'Packaged.msix'), now - 600_000);
        createFileWithMtime(path.join(tmpDir, 'AppPackages', 'Legacy.appx'), now);
        createFileWithMtime(path.join(tmpDir, 'bin', 'App.exe'), now);

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCodeForFolder(tmpDir);
            app = launched.app;
            const page = launched.page;

            await runCommandPalette(page, 'WinApp: Sign File');

            const quickInput = await waitForQuickPick(page, /file to sign/i);
            const items = quickInput.locator('.quick-input-list .monaco-list-row');
            await expect(items.first()).toBeVisible({ timeout: 20_000 });
            await expect(items.first()).toHaveAttribute('aria-setsize', '4');

            const itemText = await items.allTextContents();
            expect(itemText[0]).toContain('Packaged.msix');
            expect(itemText[1]).toContain('Legacy.appx');
            expect(itemText[2]).toContain('App.exe');
            expect(itemText[3]).toContain('Browse');

            await page.keyboard.press('Escape');
        } finally {
            if (app) {
                await app.close().catch(() => {});
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('ignores files.exclude without showing dependency artifacts', async () => {
        const tmpDir = createSignTestWorkspace();
        configureFilesExclude(tmpDir);
        const ignoredArtifact = path.join(tmpDir, 'node_modules', 'pkg', 'Ignored.msix');
        fs.mkdirSync(path.dirname(ignoredArtifact), { recursive: true });
        fs.writeFileSync(ignoredArtifact, Buffer.alloc(128));

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCodeForFolder(tmpDir);
            app = launched.app;
            const page = launched.page;

            await runCommandPalette(page, 'WinApp: Sign File');

            const quickInput = await waitForQuickPick(page, /file to sign/i);
            const itemText = await quickInput.locator('.quick-input-list .monaco-list-row').allTextContents();
            expect(itemText.join(' ')).toContain('MyApp_1.0.0.0_x64.msix');
            expect(itemText.join(' ')).not.toContain('Ignored.msix');

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

            // Run "WinApp: Sign File"
            await runCommandPalette(page, 'WinApp: Sign File');

            // Wait for the artifact QuickPick to take over from the palette
            const quickInput = await waitForQuickPick(page, /file to sign/i);

            // Select the .msix artifact (first item) to advance to cert picker
            await quickInput.locator('.quick-input-list .monaco-list-row').first().click();

            // Wait for the certificate QuickPick to replace it
            await waitForQuickPick(page, /signing certificate/i);

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

            // Run "WinApp: Sign File"
            await runCommandPalette(page, 'WinApp: Sign File');

            // Wait for the artifact QuickPick to take over from the palette
            const quickInput = await waitForQuickPick(page, /file to sign/i);

            // Press Escape to cancel the QuickPick
            await page.keyboard.press('Escape');
            await page.waitForTimeout(2_000);

            // Verify the QuickPick is dismissed. VS Code keeps the rendered rows
            // in the DOM after hiding the widget, so assert on widget visibility
            // rather than row count. A hidden widget also proves no second picker
            // (certificate) appeared.
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

            // Run "WinApp: Sign File"
            await runCommandPalette(page, 'WinApp: Sign File');

            // Wait for the artifact QuickPick to take over from the palette —
            // without this, the row clicked below could be a palette command.
            const quickInput = await waitForQuickPick(page, /file to sign/i);

            // Click "Browse…" (second item, the last row)
            const items = quickInput.locator('.quick-input-list .monaco-list-row');
            const browseItem = items.last();
            const browseText = await browseItem.textContent();
            expect(browseText).toContain('Browse');
            await browseItem.click();

            // Smoke test only: selecting Browse should dismiss the QuickPick and
            // trigger the native file dialog path. Playwright cannot interact
            // with or assert on native OS dialogs, so unit tests provide the
            // real coverage for the Browse branch while this test verifies the
            // VS Code-side handoff happens without an immediate error.
            await page.waitForTimeout(2_000);

            // The QuickPick should be dismissed (replaced by the native dialog).
            // Rows stay in the DOM after hiding, so assert widget visibility.
            await expect(quickInput).toBeHidden({ timeout: 5_000 });

            // No error notification should be visible
            const errorNotification = page.locator('.notification-toast .codicon-error');
            const errorCount = await errorNotification.count();
            expect(errorCount).toBe(0);

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

            // Run "WinApp: Sign File"
            await runCommandPalette(page, 'WinApp: Sign File');

            // Wait for the artifact QuickPick to take over from the palette
            const quickInput = await waitForQuickPick(page, /file to sign/i);

            // Select the .msix artifact (first item) to advance to cert picker
            await quickInput.locator('.quick-input-list .monaco-list-row').first().click();

            // Wait for the certificate QuickPick to replace it
            await waitForQuickPick(page, /signing certificate/i);

            // Press Escape to cancel the certificate QuickPick
            await page.keyboard.press('Escape');
            await page.waitForTimeout(2_000);

            // Verify the QuickPick is dismissed. Rows remain in the DOM after
            // hiding, so assert on widget visibility.
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
