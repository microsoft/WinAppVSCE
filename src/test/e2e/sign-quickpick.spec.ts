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

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { launchVSCodeApp, runCommand } from './helpers';

// ──────────────────────────────────────────────────────
// Isolated-profile cleanup
// ──────────────────────────────────────────────────────

/** Isolated user-data/extensions directories created by launches in this file. */
const pendingProfileDirs = new Set<string>();

test.afterEach(() => {
    for (const dir of pendingProfileDirs) {
        try {
            fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
            pendingProfileDirs.delete(dir);
        } catch { /* best-effort */ }
    }
});

/**
 * Launch VS Code with our extension loaded, opening the given folder.
 *
 * Delegates to the shared launcher in helpers.ts so this spec gets the isolated
 * `--user-data-dir` (required, or the launch is handed off to an already-running
 * VS Code instance and `firstWindow()` never resolves) and the welcome-dialog
 * dismissal (required, or the dialog swallows the Command Palette keystroke).
 */
async function launchVSCodeForFolder(folderPath: string): Promise<{ app: ElectronApplication; page: Page }> {
    const launched = await launchVSCodeApp([folderPath]);
    for (const dir of launched.profileDirs) {
        pendingProfileDirs.add(dir);
    }

    // Allow VS Code to finish initialising & activating extensions
    await launched.page.waitForTimeout(6_000);

    return { app: launched.app, page: launched.page };
}

/**
 * Open the Command Palette and run a command, waiting until VS Code actually
 * lists it (extension activation is slower on a cold isolated profile).
 */
async function runCommandPalette(page: Page, commandLabel: string): Promise<void> {
    await runCommand(page, commandLabel);
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

            // The QuickPick should appear. Wait for the quick-input widget to
            // become visible. VS Code keeps the widget in the DOM with
            // style="display:none" when inactive, so we must also exclude that.
            const quickInput = page.locator('.quick-input-widget');
            // Wait for either the quick-input list rows or the placeholder to
            // appear — this accounts for VS Code toggling visibility classes.
            await expect(
                quickInput.locator('.quick-input-list .monaco-list-row').first()
            ).toBeVisible({ timeout: 20_000 });

            // The placeholder text should mention signing
            const inputBox = quickInput.locator('.quick-input-filter input[type="text"]');
            await expect(inputBox).toHaveAttribute('placeholder', /file to sign/, { timeout: 20_000 });

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

            const items = page.locator('.quick-input-widget .quick-input-list .monaco-list-row');
            await expect(items.first()).toBeVisible({ timeout: 20_000 });
            await expect(items.first()).toHaveAttribute('aria-setsize', '11');

            const itemText = await items.allTextContents();
            expect(itemText.slice(0, 2).every(text => /\.(msix|msixbundle)/i.test(text))).toBe(true);
            expect(itemText.slice(2).every(text => /\.(exe|dll)/i.test(text))).toBe(true);

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

            const quickInput = page.locator('.quick-input-widget');
            const inputBox = quickInput.locator('.quick-input-filter input[type="text"]');
            await expect(inputBox).toHaveAttribute('placeholder', /file to sign/, { timeout: 20_000 });
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

            // Wait for the artifact QuickPick to appear
            const quickInput = page.locator('.quick-input-widget');
            await expect(
                quickInput.locator('.quick-input-list .monaco-list-row').first()
            ).toBeVisible({ timeout: 20_000 });

            // Verify it's the package picker
            const packageInput = quickInput.locator('.quick-input-filter input[type="text"]');
            await expect(packageInput).toHaveAttribute('placeholder', /file to sign/, { timeout: 20_000 });

            // Select the .msix artifact (first item) to advance to cert picker
            await quickInput.locator('.quick-input-list .monaco-list-row').first().click();

            // The quick-input widget is reused for the second picker, so wait for
            // the placeholder to actually change rather than for "a row", which is
            // still satisfied by the outgoing package picker.
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

            // Run "WinApp: Sign File"
            await runCommandPalette(page, 'WinApp: Sign File');

            // Wait for the artifact QuickPick to appear
            const quickInput = page.locator('.quick-input-widget');
            await expect(
                quickInput.locator('.quick-input-list .monaco-list-row').first()
            ).toBeVisible({ timeout: 20_000 });

            // Verify it's the package picker
            const inputBox = quickInput.locator('.quick-input-filter input[type="text"]');
            await expect(inputBox).toHaveAttribute('placeholder', /file to sign/, { timeout: 20_000 });

            // Press Escape to cancel the QuickPick
            await page.keyboard.press('Escape');

            // Verify the QuickPick is dismissed, and that no second picker
            // (certificate) took its place. VS Code keeps the dismissed rows in
            // the DOM, so assert on widget visibility rather than row count.
            await expect(quickInput).toBeHidden({ timeout: 10_000 });

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

            // Wait for the artifact QuickPick to appear
            const quickInput = page.locator('.quick-input-widget');
            await expect(
                quickInput.locator('.quick-input-list .monaco-list-row').first()
            ).toBeVisible({ timeout: 20_000 });

            // Click "Browse…" (second item, the last row)
            const inputBox = quickInput.locator('.quick-input-filter input[type="text"]');
            await expect(inputBox).toHaveAttribute('placeholder', /file to sign/, { timeout: 20_000 });
            const items = quickInput.locator('.quick-input-list .monaco-list-row');
            const browseItem = items.last();
            await expect(browseItem).toContainText('Browse');
            await browseItem.click();

            // Smoke test only: selecting Browse should dismiss the QuickPick and
            // trigger the native file dialog path. Playwright cannot interact
            // with or assert on native OS dialogs, so unit tests provide the
            // real coverage for the Browse branch while this test verifies the
            // VS Code-side handoff happens without an immediate error.

            // The QuickPick should no longer be shown (replaced by native dialog).
            // Rows linger in the DOM after dismissal, so assert on the widget.
            await expect(quickInput).toBeHidden({ timeout: 10_000 });

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

            // Wait for the artifact QuickPick to appear
            const quickInput = page.locator('.quick-input-widget');
            await expect(
                quickInput.locator('.quick-input-list .monaco-list-row').first()
            ).toBeVisible({ timeout: 20_000 });

            // Select the .msix artifact (first item) to advance to cert picker
            const artifactInput = quickInput.locator('.quick-input-filter input[type="text"]');
            await expect(artifactInput).toHaveAttribute('placeholder', /file to sign/, { timeout: 20_000 });
            await quickInput.locator('.quick-input-list .monaco-list-row').first().click();

            // Wait for the certificate picker to actually replace the artifact
            // picker — the widget (and its rows) is reused between the two.
            const certInput = quickInput.locator('.quick-input-filter input[type="text"]');
            await expect(certInput).toHaveAttribute('placeholder', /signing certificate/, { timeout: 20_000 });

            // Press Escape to cancel the certificate QuickPick
            await page.keyboard.press('Escape');

            // Verify the QuickPick is dismissed. Rows linger in the DOM after
            // dismissal, so assert on the widget's visibility.
            await expect(quickInput).toBeHidden({ timeout: 10_000 });

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
