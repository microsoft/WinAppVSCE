/**
 * E2E tests for the `winapp.sign` command's QuickPick flows.
 *
 * Test 1 — Artifact QuickPick:
 *   Opens VS Code in a workspace containing a .msix file, runs "WinApp: Sign Package",
 *   and asserts that a QuickPick appears listing the artifact and a "Browse…" option.
 *
 * Test 2 — Certificate QuickPick:
 *   Opens VS Code in a workspace containing both a .msix and a .pfx file, selects
 *   the package, and asserts that a second QuickPick appears for certificate selection.
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

    test('shows certificate QuickPick with .pfx file after selecting a package', async () => {
        // Create a temp workspace containing both a .msix and a .pfx file
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-e2e-cert-'));
        const msixPath = path.join(tmpDir, 'AppPackages', 'MyApp_1.0.0.0_x64.msix');
        const pfxPath = path.join(tmpDir, 'certs', 'DevCert.pfx');
        fs.mkdirSync(path.dirname(msixPath), { recursive: true });
        fs.writeFileSync(msixPath, Buffer.alloc(1024));
        fs.mkdirSync(path.dirname(pfxPath), { recursive: true });
        fs.writeFileSync(pfxPath, Buffer.alloc(512));

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCodeForFolder(tmpDir);
            app = launched.app;
            const page = launched.page;

            // Run "WinApp: Sign Package"
            await runCommandPalette(page, 'WinApp: Sign Package');

            // Wait for the artifact QuickPick to appear
            const quickInput = page.locator('.quick-input-widget');
            await expect(
                quickInput.locator('.quick-input-list .monaco-list-row').first()
            ).toBeVisible({ timeout: 20_000 });

            // Verify it's the package picker
            const packageInput = quickInput.locator('.quick-input-filter input[type="text"]');
            const packagePlaceholder = await packageInput.getAttribute('placeholder');
            expect(packagePlaceholder).toContain('package to sign');

            // Select the .msix artifact (first item) to advance to cert picker
            await quickInput.locator('.quick-input-list .monaco-list-row').first().click();

            // Wait for the certificate QuickPick to appear (second picker)
            await expect(
                quickInput.locator('.quick-input-list .monaco-list-row').first()
            ).toBeVisible({ timeout: 20_000 });

            // The placeholder should now mention certificate
            const certInput = quickInput.locator('.quick-input-filter input[type="text"]');
            const certPlaceholder = await certInput.getAttribute('placeholder');
            expect(certPlaceholder).toContain('signing certificate');

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

    // The post-pack "Sign" action calls winapp.sign with a prefilled artifact
    // path, which skips the package QuickPick and goes straight to the
    // certificate picker. This flow cannot be tested from Playwright because
    // executeCommand with arguments requires VS Code extension test host
    // infrastructure (vscode-test). The command registration was updated to
    // accept an optional path argument so this path IS testable once the
    // extension test host is configured. See issue #83.
    test.skip('skips package QuickPick when invoked with prefilled path (needs extension test host)', () => {
        // Intended assertions when extension test host is available:
        // 1. Call vscode.commands.executeCommand('winapp.sign', '/path/to/app.msix')
        // 2. Assert the package QuickPick is NOT shown
        // 3. Assert the certificate QuickPick appears directly
        // 4. Assert the prefilled path is passed to the sign terminal command
    });
});
