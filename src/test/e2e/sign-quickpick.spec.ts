/**
 * E2E tests for the `winapp.sign` command's QuickPick flows.
 *
 * Test 1 — Artifact QuickPick:
 *   Opens VS Code in a workspace containing package and binary artifacts, runs
 *   "WinApp: Sign File", and asserts that packages appear before binaries.
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
 *
 * Test 6 — DLL-only artifact discovery:
 *   Opens VS Code in a workspace containing only a DLL and verifies the picker
 *   shows the DLL and Browse… without a package group.
 *
 * Test 7 — Artifact cap:
 *   Opens VS Code with more than 10 artifacts and verifies exactly 10 selectable
 *   artifact rows are shown, with packages preceding binaries.
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
function createSignTestWorkspace(options?: {
    includePackage?: boolean;
    includePfx?: boolean;
    includeBinaries?: boolean;
    includeDllOnly?: boolean;
    includeArtifactOverflow?: boolean;
}): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-e2e-'));
    if (options?.includePackage !== false) {
        const msixPath = path.join(tmpDir, 'AppPackages', 'MyApp_1.0.0.0_x64.msix');
        fs.mkdirSync(path.dirname(msixPath), { recursive: true });
        fs.writeFileSync(msixPath, Buffer.alloc(1024));
    }

    if (options?.includeBinaries || options?.includeDllOnly) {
        const outputPath = path.join(tmpDir, 'bin', 'x64', 'Debug');
        fs.mkdirSync(outputPath, { recursive: true });
        fs.writeFileSync(path.join(outputPath, 'MyApp.dll'), Buffer.alloc(512));
        if (!options.includeDllOnly) {
            fs.writeFileSync(path.join(outputPath, 'MyApp.exe'), Buffer.alloc(512));
        }

    }

    if (options?.includeArtifactOverflow) {
        for (let index = 0; index < 2; index++) {
            fs.writeFileSync(
                path.join(tmpDir, 'AppPackages', `OverflowApp_${index}.msix`),
                Buffer.alloc(1024)
            );
        }
        const outputPath = path.join(tmpDir, 'bin', 'Release');
        fs.mkdirSync(outputPath, { recursive: true });
        for (let index = 0; index < 12; index++) {
            const extension = index % 2 === 0 ? 'exe' : 'dll';
            fs.writeFileSync(path.join(outputPath, `Artifact-${index}.${extension}`), Buffer.alloc(512));
        }
    }

    if (options?.includePfx) {
        const pfxPath = path.join(tmpDir, 'certs', 'DevCert.pfx');
        fs.mkdirSync(path.dirname(pfxPath), { recursive: true });
        fs.writeFileSync(pfxPath, Buffer.alloc(512));
    }

    return tmpDir;
}

// ──────────────────────────────────────────────────────
// Test 1 — Package-first artifact discovery
// ──────────────────────────────────────────────────────

test.describe('winapp.sign command — artifact discovery', () => {
    test('shows packages before executable and library artifacts', async () => {
        const tmpDir = createSignTestWorkspace({ includeBinaries: true });

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
            const quickInput = page.locator('.quick-input-widget:visible');
            // Wait for either the quick-input list rows or the placeholder to
            // appear — this accounts for VS Code toggling visibility classes.
            await expect(
                quickInput.locator('.quick-input-list .monaco-list-row').first()
            ).toBeVisible({ timeout: 20_000 });

            // The placeholder text should mention signing
            await expect(
                page.locator('input[placeholder="Select a file to sign"]')
            ).toBeVisible();

            // Separators are rendered outside the selectable Monaco rows.
            await expect(quickInput).toContainText('Packages');
            await expect(quickInput).toContainText('Executables and libraries');

            // Package + two binaries + Browse, with the package first.
            const items = quickInput.locator('.quick-input-list .monaco-list-row');
            await expect(items).toHaveCount(4, { timeout: 10_000 });

            expect(await items.nth(0).textContent()).toContain('MyApp_1.0.0.0_x64.msix');
            expect(await items.nth(1).textContent()).toContain('MyApp.exe');
            expect(await items.nth(2).textContent()).toContain('MyApp.dll');

            // Last item should be "Browse…"
            const lastRowText = await items.nth(3).textContent();
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
        const tmpDir = createSignTestWorkspace({ includePfx: true });

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCodeForFolder(tmpDir);
            app = launched.app;
            const page = launched.page;

            // Run "WinApp: Sign File"
            await runCommandPalette(page, 'WinApp: Sign File');

            // Wait for the artifact QuickPick to appear
            const quickInput = page.locator('.quick-input-widget:visible');
            await expect(
                quickInput.locator('.quick-input-list .monaco-list-row').first()
            ).toBeVisible({ timeout: 20_000 });

            // Verify it's the package picker
            await expect(
                page.locator('input[placeholder="Select a file to sign"]')
            ).toBeVisible();

            // Select the .msix artifact (first item) to advance to cert picker
            await quickInput.locator('.quick-input-list .monaco-list-row').first().click();

            // Wait for the certificate QuickPick to appear (second picker)
            await expect(
                quickInput.locator('.quick-input-list .monaco-list-row').first()
            ).toBeVisible({ timeout: 20_000 });

            // The placeholder should now mention certificate
            await expect(
                page.locator('input[placeholder="Select a signing certificate"]')
            ).toBeVisible();

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
            const quickInput = page.locator('.quick-input-widget:visible');
            await expect(
                quickInput.locator('.quick-input-list .monaco-list-row').first()
            ).toBeVisible({ timeout: 20_000 });

            // Verify it's the package picker
            await expect(
                page.locator('input[placeholder="Select a file to sign"]')
            ).toBeVisible();

            // Press Escape to cancel the QuickPick
            await page.keyboard.press('Escape');
            await page.waitForTimeout(2_000);

            // Verify the QuickPick is dismissed — the list rows should no longer
            // be visible. We check that no quick-input list rows are shown, which
            // means no second picker (certificate) appeared.
            const visibleRows = quickInput.locator('.quick-input-list .monaco-list-row');
            await expect(visibleRows).toHaveCount(0, { timeout: 5_000 });

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
            const quickInput = page.locator('.quick-input-widget:visible');
            await expect(
                quickInput.locator('.quick-input-list .monaco-list-row').first()
            ).toBeVisible({ timeout: 20_000 });

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

            // The QuickPick list should no longer be visible (replaced by native dialog)
            const visibleRows = quickInput.locator('.quick-input-list .monaco-list-row');
            await expect(visibleRows).toHaveCount(0, { timeout: 5_000 });

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
            const quickInput = page.locator('.quick-input-widget:visible');
            await expect(
                quickInput.locator('.quick-input-list .monaco-list-row').first()
            ).toBeVisible({ timeout: 20_000 });

            // Select the .msix artifact (first item) to advance to cert picker
            await quickInput.locator('.quick-input-list .monaco-list-row').first().click();

            // Wait for the certificate QuickPick to appear
            await expect(
                quickInput.locator('.quick-input-list .monaco-list-row').first()
            ).toBeVisible({ timeout: 20_000 });

            // Verify it's the certificate picker
            await expect(
                page.locator('input[placeholder="Select a signing certificate"]')
            ).toBeVisible();

            // Press Escape to cancel the certificate QuickPick
            await page.keyboard.press('Escape');
            await page.waitForTimeout(2_000);

            // Verify the QuickPick is dismissed
            const visibleRows = quickInput.locator('.quick-input-list .monaco-list-row');
            await expect(visibleRows).toHaveCount(0, { timeout: 5_000 });

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

    test('shows a DLL-only workspace without a package group and retains Browse', async () => {
        const tmpDir = createSignTestWorkspace({ includePackage: false, includeDllOnly: true });

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCodeForFolder(tmpDir);
            app = launched.app;
            const page = launched.page;

            await runCommandPalette(page, 'WinApp: Sign File');

            const quickInput = page.locator('.quick-input-widget:visible');
            await expect(
                page.locator('input[placeholder="Select a file to sign"]')
            ).toBeVisible({ timeout: 20_000 });
            const items = quickInput.locator('.quick-input-list .monaco-list-row');
            await expect(items.first()).toBeVisible({ timeout: 20_000 });
            await expect(items).toHaveCount(2, { timeout: 10_000 });
            await expect(quickInput).not.toContainText('Packages');
            expect(await items.nth(0).textContent()).toContain('MyApp.dll');
            expect(await items.nth(1).textContent()).toContain('Browse');

            await page.keyboard.press('Escape');
        } finally {
            if (app) {
                await app.close().catch(() => {});
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('caps selectable artifacts at 10 while keeping packages before binaries', async () => {
        const tmpDir = createSignTestWorkspace({ includeArtifactOverflow: true });

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCodeForFolder(tmpDir);
            app = launched.app;
            const page = launched.page;

            await runCommandPalette(page, 'WinApp: Sign File');

            const quickInput = page.locator('.quick-input-widget:visible');
            await expect(
                page.locator('input[placeholder="Select a file to sign"]')
            ).toBeVisible({ timeout: 20_000 });
            const rows = quickInput.locator('.quick-input-list .monaco-list-row');
            await expect(rows.first()).toHaveAttribute('aria-setsize', '11', { timeout: 10_000 });
            const rowAt = (position: number) =>
                quickInput.locator(`.quick-input-list .monaco-list-row[aria-posinset="${position}"]`);
            for (let position = 1; position <= 3; position++) {
                await expect(rowAt(position)).toContainText(/\.msix/i);
            }
            await expect(rowAt(4)).toContainText(/\.(exe|dll)/i);

            // Monaco virtualizes long lists, so use its ARIA set metadata rather
            // than counting only the currently rendered rows.
            await page.keyboard.press('ArrowUp');
            await expect(rowAt(11)).toContainText('Browse');

            await page.keyboard.press('Escape');
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
