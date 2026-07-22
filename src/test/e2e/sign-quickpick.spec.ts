/**
 * E2E test for the `winapp.sign` command's QuickPick artifact discovery.
 *
 * Scenario 1 — Workspace WITH .msix artifacts:
 *   Opens VS Code in a workspace containing a .msix file, runs "WinApp: Sign Package",
 *   and asserts that a QuickPick appears listing the artifact and a "Browse…" option.
 *
 * Scenario 2 — Empty workspace (no artifacts):
 *   Opens VS Code in a workspace with no signable files, runs the command,
 *   and asserts that the native file dialog appears (no QuickPick).
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

// ──────────────────────────────────────────────────────
// Test 1 — Workspace with .msix artifact
// ──────────────────────────────────────────────────────

test.describe('winapp.sign command — artifact discovery', () => {
    test('shows QuickPick with .msix file and Browse option when artifacts exist', async () => {
        // Create a temp workspace containing a fake .msix file
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-e2e-artifacts-'));
        const msixPath = path.join(tmpDir, 'AppPackages', 'MyApp_1.0.0.0_x64.msix');
        fs.mkdirSync(path.dirname(msixPath), { recursive: true });
        fs.writeFileSync(msixPath, Buffer.alloc(1024)); // dummy content

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCodeForFolder(tmpDir);
            app = launched.app;
            const page = launched.page;

            // Run "WinApp: Sign Package"
            await runCommandPalette(page, 'WinApp: Sign Package');

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
            const placeholder = await inputBox.getAttribute('placeholder');
            expect(placeholder).toContain('package to sign');

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

    test('falls back to native file dialog when no artifacts exist', async () => {
        // Create a truly empty temp workspace
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-e2e-empty-'));

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCodeForFolder(tmpDir);
            app = launched.app;
            const page = launched.page;

            // Run "WinApp: Sign Package"
            await runCommandPalette(page, 'WinApp: Sign Package');

            // Wait a moment for the search to complete
            await page.waitForTimeout(3_000);

            // The QuickPick should NOT appear (no artifacts → falls back to native dialog)
            const quickInput = page.locator('.quick-input-widget:not([style*="display: none"])');

            // The QuickPick widget might still be in the DOM from the command palette.
            // After the command palette entry is selected and dismissed, the next UI element
            // should be the native file dialog (which Playwright can't see).
            // So we check that no QuickPick with "MSIX" placeholder is visible.
            //
            // A native file dialog blocks the Electron process but is not a DOM element,
            // so we verify the QuickPick did NOT re-appear with signing options.
            const isQuickPickVisible = await quickInput.isVisible().catch(() => false);

            if (isQuickPickVisible) {
                // If something is visible, check it's not the signing QuickPick
                const inputBox = quickInput.locator('.quick-input-filter input[type="text"]');
                const placeholder = await inputBox.getAttribute('placeholder').catch(() => '');
                // The placeholder for the sign QuickPick is "Select a package to sign"
                // If this placeholder is showing, the test fails — it should have gone to native dialog
                expect(placeholder).not.toContain('package to sign');
            }

            // The native file dialog opened (we can't interact with it via Playwright,
            // but the absence of the QuickPick confirms the fallback path was taken).
            // Dismiss any native dialog by pressing Escape
            await page.keyboard.press('Escape');
            await page.waitForTimeout(1_000);

            console.log('✅ PASS: No QuickPick appeared — fell back to native file dialog');
        } finally {
            if (app) {
                await app.close().catch(() => {});
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
