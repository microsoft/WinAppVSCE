/**
 * Shared helpers for Playwright E2E tests of the VS Code manifest editor.
 *
 * Provides launch/teardown of VS Code, webview frame acquisition, and
 * reusable actions (tab switching, field edits, button clicks, etc.).
 */

import { _electron as electron, expect, type ElectronApplication, type Page, type FrameLocator } from '@playwright/test';
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

const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');

// ──────────────────────────────────────────────────────
// Launch helpers
// ──────────────────────────────────────────────────────

export interface VSCodeTestContext {
    app: ElectronApplication;
    page: Page;
    workspacePath: string;
    /** Isolated profile directories created for this launch; removed on teardown. */
    profileDirs: string[];
}

export interface LaunchedVSCode {
    app: ElectronApplication;
    page: Page;
    /** Isolated profile directories created for this launch; removed on teardown. */
    profileDirs: string[];
}

/**
 * Creates the isolated profile directories every launch must use.
 *
 * Without `--user-data-dir`, a `Code.exe` started while the developer already has
 * VS Code running delegates its window to that existing instance and exits
 * immediately. Playwright's `app.firstWindow()` then never resolves and the
 * launch times out, which is why nearly the whole suite failed on dev machines.
 * An isolated user-data dir forces a genuinely separate instance. The matching
 * `--extensions-dir` keeps the developer's installed extensions out of the run.
 */
function createProfileDirs(): { userDataDir: string; extensionsDir: string; profileDirs: string[] } {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'winapp-e2e-user-'));
    const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'winapp-e2e-ext-'));
    return { userDataDir, extensionsDir, profileDirs: [userDataDir, extensionsDir] };
}

/**
 * Dismisses the Welcome / Trust modal that a brand-new profile shows on first
 * start. That dialog holds keyboard focus and swallows the first `Ctrl+Shift+P`,
 * so it must be closed before any keyboard interaction. Tolerant by design: it
 * is a no-op when no dialog appears.
 */
export async function dismissWelcomeDialog(page: Page): Promise<void> {
    const welcomeDialog = page.getByRole('dialog', { name: /Welcome to Visual Studio Code/i });
    const welcomeAppeared = await welcomeDialog
        .waitFor({ state: 'visible', timeout: 5_000 })
        .then(() => true, () => false);

    if (welcomeAppeared) {
        const closeButton = welcomeDialog.getByRole('button', { name: 'Close' });
        const clicked = await closeButton.click({ timeout: 2_000 }).then(() => true, () => false);
        if (!clicked) {
            await page.keyboard.press('Escape');
        }
        await welcomeDialog.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => { /* already gone */ });
    }

    // Any other modal (workspace trust, release notes prompt, …) — Escape it away.
    for (let attempt = 0; attempt < 3; attempt++) {
        const remaining = await page.getByRole('dialog').filter({ visible: true }).count().catch(() => 0);
        if (remaining === 0) {
            return;
        }
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
    }
}

/**
 * Launches an isolated VS Code instance with the extension under test loaded.
 * `openTargets` are the folder/file paths passed on the command line.
 *
 * This is the single launch path for the whole E2E suite — every spec should go
 * through it so the isolation and welcome-dialog handling stay in one place.
 */
export async function launchVSCodeApp(openTargets: string[]): Promise<LaunchedVSCode> {
    const { userDataDir, extensionsDir, profileDirs } = createProfileDirs();

    const app = await electron.launch({
        executablePath: VSCODE_EXE,
        args: [
            ...openTargets,
            '--new-window',
            `--user-data-dir=${userDataDir}`,
            `--extensions-dir=${extensionsDir}`,
            ...EXTENSION_ARGS,
            '--disable-telemetry',
            '--skip-release-notes',
            '--disable-workspace-trust',
        ],
        timeout: 60_000,
    });

    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.locator('.monaco-workbench').waitFor({ state: 'visible', timeout: 30_000 });
    await dismissWelcomeDialog(page);

    return { app, page, profileDirs };
}

/**
 * Waits for a quick-input row matching `itemLabel` to be listed. Used instead of
 * a fixed sleep before pressing Enter: on a cold isolated profile the extension
 * can take several seconds to activate, and a blind Enter would otherwise run
 * the wrong entry (or nothing at all).
 */
export async function waitForQuickInputItem(page: Page, itemLabel: string, timeout = 30_000): Promise<void> {
    await page
        .locator('.quick-input-widget .quick-input-list .monaco-list-row')
        .filter({ hasText: itemLabel })
        .first()
        .waitFor({ state: 'visible', timeout });
}

/** Opens the Command Palette, filters to `commandLabel`, and runs it. */
export async function runCommand(page: Page, commandLabel: string): Promise<void> {
    const paletteInput = page.locator('.quick-input-widget .quick-input-filter input[type="text"]');

    // The palette keystroke can be dropped while VS Code is still settling.
    for (let attempt = 0; attempt < 5; attempt++) {
        await page.keyboard.press('Control+Shift+P');
        const opened = await paletteInput
            .waitFor({ state: 'visible', timeout: 3_000 })
            .then(() => true, () => false);
        if (opened) {
            break;
        }
        await page.waitForTimeout(1_000);
    }
    await paletteInput.waitFor({ state: 'visible', timeout: 5_000 });

    await page.keyboard.type(commandLabel, { delay: 30 });
    await waitForQuickInputItem(page, commandLabel);
    await page.keyboard.press('Enter');

    // Do not return while the palette is still on screen: the quick-input widget
    // is reused by whatever the command shows next, so a caller that inspects it
    // too early reads the dismissing palette instead of the command's own UI.
    await expect
        .poll(async () => {
            const visible = await paletteInput.isVisible().catch(() => false);
            if (!visible) {
                return '';
            }
            return (await paletteInput.getAttribute('placeholder').catch(() => '')) ?? '';
        }, { timeout: 15_000 })
        .not.toContain('Type the name of a command to run');
}

/** Closes a launched VS Code instance and removes its isolated profile directories. */export async function closeVSCodeApp(launched: { app: ElectronApplication; profileDirs: string[] }): Promise<void> {
    try {
        await launched.app.close();
    } catch { /* already closed */ }
    for (const dir of launched.profileDirs) {
        try {
            fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
        } catch { /* best-effort */ }
    }
}

/**
 * Prepares a temporary workspace with a copy of the given fixture manifest.
 * Returns the path to the workspace directory.
 */
export function createTempWorkspace(fixtureName: string): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-e2e-'));
    const src = path.join(FIXTURES_DIR, fixtureName);
    const dest = path.join(tmpDir, 'AppxManifest.xml');
    fs.copyFileSync(src, dest);
    return tmpDir;
}

/**
 * Launches VS Code with the extension under test, opens the given workspace,
 * and returns the Electron app + main window page.
 */
export async function launchVSCode(workspacePath: string): Promise<VSCodeTestContext> {
    const manifestPath = path.join(workspacePath, 'AppxManifest.xml');
    const launched = await launchVSCodeApp([workspacePath, manifestPath]);

    // Wait for VS Code to settle and extensions to activate.
    await launched.page.waitForTimeout(5_000);

    return { ...launched, workspacePath };
}

/**
 * Opens the AppxManifest.xml file in the workspace, triggering the
 * custom manifest editor. Then locates and returns the webview FrameLocator.
 */
export async function openManifestEditor(page: Page): Promise<FrameLocator> {
    // The file is already open from launch args, but a brand-new profile may
    // also open a Get Started tab — make sure the manifest is the active editor
    // before driving the Command Palette.
    const manifestTab = page.locator('.tab').filter({ hasText: 'AppxManifest.xml' }).first();
    await manifestTab.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => { /* tolerated */ });
    await manifestTab.click({ timeout: 5_000 }).catch(() => { /* tolerated */ });
    // Move the pointer off the tab: its hover tooltip renders over the editor
    // area and would intercept later clicks inside the webview.
    await page.mouse.move(0, 0);
    await page.locator('.hover-contents').waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => { /* none shown */ });

    // Reopen with the custom editor via Command Palette.
    await runCommand(page, 'View: Reopen Editor With...');
    await page.waitForTimeout(2_000);

    // Now the editor picker appears — select "AppxManifest Editor"
    await page.keyboard.type('AppxManifest Editor', { delay: 30 });
    await waitForQuickInputItem(page, 'AppxManifest Editor');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(5_000);

    return getWebviewFrame(page);
}

/**
 * Locates and returns the webview FrameLocator for the manifest editor.
 * Useful for re-acquiring the frame after the webview reloads (e.g., fixture swap).
 */
export async function getWebviewFrame(page: Page): Promise<FrameLocator> {
    // The custom editor renders inside VS Code webview frames.
    // VS Code uses a named iframe for the webview container, and a nested
    // iframe with name="pending-frame" (or "active-frame") for the actual content.
    // We navigate the frame tree to find the inner content frame.
    const webviewOuterFrame = page.frames().find(f => f.url().includes('vscode-webview://') && !f.url().includes('fake.html'));
    if (!webviewOuterFrame) {
        throw new Error('Could not find webview outer frame');
    }
    const innerFrame = webviewOuterFrame.frameLocator('#active-frame');

    // Wait for the editor to render (the tab bar should appear)
    await innerFrame.locator('.tab-bar').waitFor({ state: 'visible', timeout: 15_000 });

    return innerFrame;
}

/**
 * Cleans up: closes VS Code and removes the temporary workspace.
 */
export async function teardown(ctx: VSCodeTestContext): Promise<void> {
    await closeVSCodeApp(ctx);
    try {
        fs.rmSync(ctx.workspacePath, { recursive: true, force: true });
    } catch { /* best-effort */ }
}

// ──────────────────────────────────────────────────────
// Webview interaction helpers
// ──────────────────────────────────────────────────────

/** Click a top-level tab by name (Identity, Properties, etc.). */
export async function switchTab(frame: FrameLocator, tabName: string): Promise<void> {
    await frame.locator(`.tab-btn[data-tab="${tabName.toLowerCase()}"]`).click();
    await frame.locator(`#tab-${tabName.toLowerCase()}`).waitFor({ state: 'visible' });
}

/** Get the value of a text input by its HTML id. */
export async function getInputValue(frame: FrameLocator, inputId: string): Promise<string> {
    return await frame.locator(`#${inputId}`).inputValue();
}

/** Set the value of a text input by its HTML id, clearing it first. */
export async function setInputValue(frame: FrameLocator, inputId: string, value: string): Promise<void> {
    const input = frame.locator(`#${inputId}`);
    await input.click();
    await input.fill(value);
    // Trigger the debounced change handler
    await input.dispatchEvent('input');
}

/** Click a button by its HTML id. */
export async function clickButton(frame: FrameLocator, buttonId: string): Promise<void> {
    await frame.locator(`#${buttonId}`).click();
}

/** Check whether a validation error message is shown for a given field group. */
export async function getValidationMessage(frame: FrameLocator, fieldDataAttr: string): Promise<string> {
    const group = frame.locator(`.form-group[data-field="${fieldDataAttr}"]`);
    const msg = group.locator('.validation-msg');
    const text = await msg.textContent();
    return text?.trim() ?? '';
}

/** Check whether a form group has the error styling class. */
export async function hasErrorClass(frame: FrameLocator, fieldDataAttr: string): Promise<boolean> {
    const group = frame.locator(`.form-group[data-field="${fieldDataAttr}"]`);
    const cls = await group.getAttribute('class') ?? '';
    return cls.includes('has-error');
}

/** Check whether a form group has the warning styling class. */
export async function hasWarningClass(frame: FrameLocator, fieldDataAttr: string): Promise<boolean> {
    const group = frame.locator(`.form-group[data-field="${fieldDataAttr}"]`);
    const cls = await group.getAttribute('class') ?? '';
    return cls.includes('has-warning');
}

/** Select a value from a custom-select dropdown. */
export async function selectCustomValue(frame: FrameLocator, selectId: string, value: string): Promise<void> {
    // Open the dropdown
    await frame.locator(`#${selectId} .custom-select-trigger`).click();
    await frame.locator(`#${selectId} .custom-select-options`).waitFor({ state: 'visible' });
    // Click the option
    await frame.locator(`#${selectId} .custom-select-option[data-value="${value}"]`).click();
}

/** Get the currently displayed value of a custom-select. */
export async function getCustomSelectValue(frame: FrameLocator, selectId: string): Promise<string> {
    const trigger = frame.locator(`#${selectId} .custom-select-trigger`);
    return (await trigger.textContent())?.trim() ?? '';
}

/** Toggle a capability checkbox (by data-capability attribute value). */
export async function toggleCapability(frame: FrameLocator, capability: string): Promise<void> {
    await frame.locator(`input[data-capability="${capability}"]`).click();
}

/** Check whether a capability checkbox is checked. */
export async function isCapabilityChecked(frame: FrameLocator, capability: string): Promise<boolean> {
    return await frame.locator(`input[data-capability="${capability}"]`).isChecked();
}

/** Read the file content from the workspace (for verifying XML changes). Saves the file first with Ctrl+S. */
export async function readManifestXml(page: Page, workspacePath: string): Promise<string> {
    await page.keyboard.press('Control+S');
    await page.waitForTimeout(1_000);
    return fs.readFileSync(path.join(workspacePath, 'AppxManifest.xml'), 'utf-8');
}

/** Wait a short time for debounced edits to propagate to the document. */
export async function waitForDebounce(page: Page, ms = 500): Promise<void> {
    await page.waitForTimeout(ms);
}

/** Count list items in a container by id. */
export async function countListItems(frame: FrameLocator, containerId: string): Promise<number> {
    return await frame.locator(`#${containerId} .list-item`).count();
}

/** Click the Nth remove button inside a list container. */
export async function removeListItem(frame: FrameLocator, containerId: string, index: number): Promise<void> {
    await frame.locator(`#${containerId} .list-item`).nth(index).locator('.btn-remove-field, .btn-remove-section, .btn-remove').first().click();
}

/** Click the move-up button on the Nth list item. */
export async function moveListItemUp(frame: FrameLocator, containerId: string, index: number): Promise<void> {
    await frame.locator(`#${containerId} .list-item`).nth(index).locator('button:has-text("▲"), button:has-text("Move Up")').first().click();
}

/** Click the move-down button on the Nth list item. */
export async function moveListItemDown(frame: FrameLocator, containerId: string, index: number): Promise<void> {
    await frame.locator(`#${containerId} .list-item`).nth(index).locator('button:has-text("▼"), button:has-text("Move Down")').first().click();
}

/** Switch an application card sub-tab (Info, Extensions, Visual Assets). */
export async function switchAppSubTab(frame: FrameLocator, appIndex: number, subTabName: string): Promise<void> {
    const card = frame.locator('.app-card').nth(appIndex);
    await card.locator(`.app-sub-tab[data-subtab="${subTabName.toLowerCase().replace(/ /g, '-')}"]`).click();
}
