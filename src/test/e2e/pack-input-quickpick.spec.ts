/**
 * E2E tests for the separate normal and sparse packaging commands.
 *
 * `winapp.pack` offers build output folders for payload-containing packages.
 * `winapp.packSparse` offers sparse manifests for identity-only packages.
 * Keeping these surfaces separate prevents users from having to infer package
 * type from a mixed folder/file picker.
 *
 * Test 1 — Separate discovery:
 *   The normal command lists only folders; the sparse command lists only
 *   sparse manifests.
 *
 * Test 2 — Content-based sparse detection:
 *   A manifest is classified by its `AllowExternalContent` element, not by
 *   living in a `sparse/` folder. A full packaged manifest inside `sparse/`
 *   must not be offered, and a sparse manifest outside it must be.
 *
 * Test 3 — Browse rows:
 *   Each command has one unambiguous Browse row for its own input kind.
 *
 * Test 4 — Cancel:
 *   Escaping the picker aborts packing without opening a terminal.
 *
 * Test 5 — Identity-only prompt skipping:
 *   Selecting a sparse manifest skips the self-contained prompt, which is
 *   meaningless for a package that carries no binaries; selecting a folder
 *   still asks.
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

// Discovery scans the whole workspace, and VS Code's search service needs a
// moment to come up, so these run well past the default per-test timeout.
test.describe.configure({ timeout: 180_000 });

/** Generous because the first workspace scan after launch is the slow one. */
const DISCOVERY_TIMEOUT = 60_000;

/** A sparse identity-only manifest — the `AllowExternalContent` element is the marker. */
const SPARSE_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
         xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10">
  <Identity Name="MyApp" Publisher="CN=Contoso" Version="1.0.0.0" />
  <Properties>
    <DisplayName>MyApp</DisplayName>
    <PublisherDisplayName>Contoso</PublisherDisplayName>
    <Logo>Assets\\StoreLogo.png</Logo>
    <uap10:AllowExternalContent>true</uap10:AllowExternalContent>
  </Properties>
</Package>`;

/** A normal packaged manifest — same file name, but no `AllowExternalContent`. */
const FULL_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10">
  <Identity Name="MyApp" Publisher="CN=Contoso" Version="1.0.0.0" />
  <Properties>
    <DisplayName>MyApp</DisplayName>
    <PublisherDisplayName>Contoso</PublisherDisplayName>
    <Logo>Assets\\StoreLogo.png</Logo>
  </Properties>
</Package>`;

async function launchVSCodeForFolder(
    folderPath: string
): Promise<{ app: ElectronApplication; page: Page; userDataDir: string }> {
    // A throwaway profile plus --disable-extensions keeps startup fast and
    // deterministic: no unrelated extensions competing for activation, and no
    // Welcome/sign-in surfaces stealing focus from the QuickPick. The
    // extension under test is still loaded, since
    // --extensionDevelopmentPath is exempt from --disable-extensions.
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-e2e-udd-'));

    const app = await electron.launch({
        executablePath: VSCODE_EXE,
        args: [
            folderPath,
            '--new-window',
            ...EXTENSION_ARGS,
            `--user-data-dir=${userDataDir}`,
            '--disable-extensions',
            '--disable-telemetry',
            '--disable-updates',
            '--skip-release-notes',
            '--skip-welcome',
            '--disable-workspace-trust',
        ],
        timeout: 60_000,
    });

    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(8_000);

    return { app, page, userDataDir };
}

/**
 * Run the pack command and wait for its input QuickPick.
 *
 * Waits for the discovery progress notification to clear first — asserting
 * while the workspace scan is still running is the main source of flakiness.
 */
async function openPackPicker(page: Page) {
    await runCommandPalette(page, 'WinApp: Create MSIX Package');

    const rows = packQuickPickRows(page);
    await expect(rows.first()).toBeVisible({ timeout: DISCOVERY_TIMEOUT });

    // The command palette is itself a QuickPick, so confirm we are looking at
    // the extension's picker before reading any rows.
    const inputBox = page.locator('.quick-input-widget .quick-input-filter input[type="text"]');
    await expect(inputBox).toHaveAttribute('placeholder', /build output folder containing your app/, {
        timeout: DISCOVERY_TIMEOUT,
    });

    return rows;
}

async function openSparsePackPicker(page: Page) {
    await runCommandPalette(page, 'WinApp: Create Sparse Identity Package');

    const rows = packQuickPickRows(page);
    await expect(rows.first()).toBeVisible({ timeout: DISCOVERY_TIMEOUT });
    await expect(quickPickPlaceholder(page)).toHaveAttribute(
        'placeholder',
        /sparse identity manifest to package/,
        { timeout: DISCOVERY_TIMEOUT }
    );

    return rows;
}

async function runCommandPalette(page: Page, commandLabel: string): Promise<void> {
    await page.keyboard.press('Control+Shift+P');
    await page.waitForTimeout(1_000);
    await page.keyboard.type(commandLabel, { delay: 30 });
    await page.waitForTimeout(1_500);
    await page.keyboard.press('Enter');
}

function writeFile(root: string, relativePath: string, contents: string | Buffer): string {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
    return filePath;
}

/**
 * Build a workspace with a buildable project.
 *
 * The `.exe` is what makes a folder a build-output candidate, and the
 * `.csproj` anchors the project root.
 */
function createPackWorkspace(options?: {
    sparseManifests?: string[];
    fullManifests?: string[];
    includeBuildOutput?: boolean;
}): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-e2e-'));

    writeFile(tmpDir, path.join('src', 'App', 'App.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />');

    if (options?.includeBuildOutput !== false) {
        writeFile(
            tmpDir,
            path.join('src', 'App', 'bin', 'x64', 'Debug', 'net8.0', 'App.exe'),
            Buffer.alloc(1024)
        );
    }

    for (const relativePath of options?.sparseManifests ?? []) {
        writeFile(tmpDir, relativePath, SPARSE_MANIFEST);
    }
    for (const relativePath of options?.fullManifests ?? []) {
        writeFile(tmpDir, relativePath, FULL_MANIFEST);
    }

    return tmpDir;
}

function packQuickPickRows(page: Page) {
    return page.locator('.quick-input-widget .quick-input-list .monaco-list-row');
}

/** The placeholder of whichever QuickPick is currently showing. */
function quickPickPlaceholder(page: Page) {
    return page.locator('.quick-input-widget .quick-input-filter input[type="text"]');
}

/**
 * Filter the open picker down to one row and accept it.
 *
 * Typing is used rather than arrow keys so the test states *which* row it
 * wants instead of depending on row ordering.
 */
async function choosePackRow(page: Page, filterText: string): Promise<void> {
    await page.keyboard.type(filterText, { delay: 30 });
    await page.waitForTimeout(1_500);
    await page.keyboard.press('Enter');
}

async function chooseQuickPickOption(page: Page, option: string): Promise<void> {
    await page.keyboard.type(option, { delay: 30 });
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
}

async function expectWinAppTerminal(page: Page): Promise<void> {
    await expect(page.locator('.terminal-wrapper')).toBeVisible({ timeout: DISCOVERY_TIMEOUT });
}

/** Close VS Code and remove the throwaway workspace and profile. */
async function cleanup(
    app: ElectronApplication | undefined,
    workspaceDir: string,
    userDataDir?: string
): Promise<void> {
    if (app) {
        for (const page of app.windows()) {
            const killTerminal = page.getByRole('button', { name: 'Kill Terminal', exact: true });
            while (await killTerminal.count()) {
                await killTerminal.first().click().catch(() => {});
                await page.waitForTimeout(250);
            }
        }
        await app.close().catch(() => {});
        // Terminal-launched CLI processes may briefly retain the workspace as
        // their cwd after Electron exits. Give Windows time to release it.
        await new Promise(resolve => setTimeout(resolve, 2_000));
    }
    fs.rmSync(workspaceDir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 500,
    });
    if (userDataDir) {
        fs.rmSync(userDataDir, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 500,
        });
    }
}

test.describe('WinApp packaging command input discovery', () => {
    test('keeps normal and sparse package inputs in separate commands', async () => {
        const tmpDir = createPackWorkspace({
            sparseManifests: [path.join('src', 'App', 'sparse', 'appxmanifest.xml')],
        });

        let app: ElectronApplication | undefined;
        let userDataDir: string | undefined;
        try {
            const launched = await launchVSCodeForFolder(tmpDir);
            app = launched.app;
            userDataDir = launched.userDataDir;

            const regularRows = await openPackPicker(launched.page);
            const regularText = await regularRows.allTextContents();
            expect(regularText).toHaveLength(2);
            expect(regularText[0]).toContain('net8.0');
            expect(regularText.some(text => text.includes('appxmanifest.xml'))).toBe(false);
            expect(regularText[1]).toContain('Browse');
            await launched.page.keyboard.press('Escape');

            const sparseRows = await openSparsePackPicker(launched.page);
            const sparseText = await sparseRows.allTextContents();
            expect(sparseText).toHaveLength(2);
            expect(sparseText[0]).toContain('appxmanifest.xml');
            expect(sparseText.some(text => text.includes('net8.0'))).toBe(false);
            expect(sparseText[1]).toContain('Browse');

            await launched.page.keyboard.press('Escape');
            console.log('✅ PASS: normal and sparse package inputs use separate commands');
        } finally {
            await cleanup(app, tmpDir, userDataDir);
        }
    });

    test('classifies manifests by content, not by their folder name', async () => {
        // A full manifest parked in sparse/ must be rejected, and a sparse
        // manifest living elsewhere must still be offered.
        const tmpDir = createPackWorkspace({
            includeBuildOutput: false,
            fullManifests: [path.join('src', 'App', 'sparse', 'appxmanifest.xml')],
            sparseManifests: [path.join('identity', 'appxmanifest.xml')],
        });

        let app: ElectronApplication | undefined;
        let userDataDir: string | undefined;
        try {
            const launched = await launchVSCodeForFolder(tmpDir);
            app = launched.app;
            userDataDir = launched.userDataDir;

            const rows = await openSparsePackPicker(launched.page);
            const rowText = await rows.allTextContents();
            const manifestRows = rowText.filter(
                text => text.includes('appxmanifest.xml') && !text.includes('Browse')
            );

            expect(manifestRows).toHaveLength(1);
            // VS Code renders the drive letter lower-cased in descriptions.
            const offered = manifestRows[0].toLowerCase();
            // The offered one is the sparse manifest outside sparse/ …
            expect(offered).toContain(path.join(tmpDir, 'identity').toLowerCase());
            // … and never the full manifest that merely sits inside sparse/.
            expect(offered).not.toContain(path.join('App', 'sparse').toLowerCase());

            await launched.page.keyboard.press('Escape');
            console.log('✅ PASS: sparse detection is content-based, not path-based');
        } finally {
            await cleanup(app, tmpDir, userDataDir);
        }
    });

    test('discovers sparse manifests after ordinary results and inside excluded folders', async () => {
        const ordinaryManifests = Array.from(
            { length: 25 },
            (_, index) => path.join('ordinary', `App${index}`, 'AppxManifest.xml')
        );
        const tmpDir = createPackWorkspace({
            includeBuildOutput: false,
            fullManifests: ordinaryManifests,
            sparseManifests: [path.join('identity', 'appxmanifest.xml')],
        });
        writeFile(
            tmpDir,
            path.join('.vscode', 'settings.json'),
            JSON.stringify({ 'files.exclude': { identity: true } })
        );

        let app: ElectronApplication | undefined;
        let userDataDir: string | undefined;
        try {
            const launched = await launchVSCodeForFolder(tmpDir);
            app = launched.app;
            userDataDir = launched.userDataDir;

            const rows = await openSparsePackPicker(launched.page);
            const rowText = await rows.allTextContents();
            expect(rowText.some(text =>
                text.toLowerCase().includes(path.join('identity', 'appxmanifest.xml').toLowerCase())
            )).toBe(true);

            await launched.page.keyboard.press('Escape');
            console.log('✅ PASS: sparse discovery ignored raw result limits and files.exclude');
        } finally {
            await cleanup(app, tmpDir, userDataDir);
        }
    });

    test('discovers a sparse manifest saved as UTF-8 with a byte-order mark', async () => {
        const tmpDir = createPackWorkspace({ includeBuildOutput: false });
        writeFile(
            tmpDir,
            path.join('identity', 'appxmanifest.xml'),
            Buffer.concat([
                Buffer.from([0xEF, 0xBB, 0xBF]),
                Buffer.from(SPARSE_MANIFEST, 'utf8'),
            ])
        );

        let app: ElectronApplication | undefined;
        let userDataDir: string | undefined;
        try {
            const launched = await launchVSCodeForFolder(tmpDir);
            app = launched.app;
            userDataDir = launched.userDataDir;

            const rows = await openSparsePackPicker(launched.page);
            const rowText = await rows.allTextContents();
            expect(rowText.some(text => text.includes('appxmanifest.xml'))).toBe(true);

            await launched.page.keyboard.press('Escape');
            console.log('✅ PASS: UTF-8 BOM sparse manifest was discovered');
        } finally {
            await cleanup(app, tmpDir, userDataDir);
        }
    });

    test('discovers a sparse manifest saved as UTF-16LE', async () => {
        const tmpDir = createPackWorkspace({ includeBuildOutput: false });
        writeFile(
            tmpDir,
            path.join('identity', 'appxmanifest.xml'),
            Buffer.concat([
                Buffer.from([0xFF, 0xFE]),
                Buffer.from(SPARSE_MANIFEST, 'utf16le'),
            ])
        );

        let app: ElectronApplication | undefined;
        let userDataDir: string | undefined;
        try {
            const launched = await launchVSCodeForFolder(tmpDir);
            app = launched.app;
            userDataDir = launched.userDataDir;

            const rows = await openSparsePackPicker(launched.page);
            const rowText = await rows.allTextContents();
            expect(rowText.some(text => text.includes('appxmanifest.xml'))).toBe(true);

            await launched.page.keyboard.press('Escape');
            console.log('✅ PASS: UTF-16LE sparse manifest was discovered');
        } finally {
            await cleanup(app, tmpDir, userDataDir);
        }
    });

    test('gives each package command one unambiguous Browse row', async () => {
        const tmpDir = createPackWorkspace({
            sparseManifests: [path.join('src', 'App', 'sparse', 'appxmanifest.xml')],
        });

        let app: ElectronApplication | undefined;
        let userDataDir: string | undefined;
        try {
            const launched = await launchVSCodeForFolder(tmpDir);
            app = launched.app;
            userDataDir = launched.userDataDir;

            const regularRows = await openPackPicker(launched.page);
            expect((await regularRows.allTextContents()).filter(text => text.includes('Browse'))).toHaveLength(1);
            await launched.page.keyboard.press('Escape');

            const sparseRows = await openSparsePackPicker(launched.page);
            expect((await sparseRows.allTextContents()).filter(text => text.includes('Browse'))).toHaveLength(1);
            await launched.page.keyboard.press('Escape');
            console.log('✅ PASS: each package command has one unambiguous Browse row');
        } finally {
            await cleanup(app, tmpDir, userDataDir);
        }
    });

    test('cancelling the picker aborts packing without running the CLI', async () => {
        const tmpDir = createPackWorkspace({
            sparseManifests: [path.join('src', 'App', 'sparse', 'appxmanifest.xml')],
        });

        let app: ElectronApplication | undefined;
        let userDataDir: string | undefined;
        try {
            const launched = await launchVSCodeForFolder(tmpDir);
            app = launched.app;
            userDataDir = launched.userDataDir;
            const page = launched.page;

            const rows = await openPackPicker(page);
            await page.keyboard.press('Escape');

            // The flow stops cleanly: the picker closes, no follow-up
            // certificate prompt appears, and no terminal is created.
            // VS Code keeps the list in the DOM, so assert on visibility.
            await expect(rows.first()).toBeHidden({ timeout: 15_000 });
            await page.waitForTimeout(3_000);
            await expect(page.locator('.quick-input-widget')).toBeHidden();
            await expect(page.locator('.terminal-wrapper')).toHaveCount(0);

            console.log('✅ PASS: cancelling the pack picker aborted the flow');
        } finally {
            await cleanup(app, tmpDir, userDataDir);
        }
    });

    test('skips the self-contained prompt for an identity-only manifest', async () => {
        const tmpDir = createPackWorkspace({
            sparseManifests: [path.join('src', 'App', 'sparse', 'appxmanifest.xml')],
        });

        let app: ElectronApplication | undefined;
        let userDataDir: string | undefined;
        try {
            const launched = await launchVSCodeForFolder(tmpDir);
            app = launched.app;
            userDataDir = launched.userDataDir;
            const page = launched.page;

            await openSparsePackPicker(page);
            await choosePackRow(page, 'appxmanifest');

            // The certificate question is common to both input kinds.
            await expect(quickPickPlaceholder(page)).toHaveAttribute(
                'placeholder',
                /development certificate/,
                { timeout: DISCOVERY_TIMEOUT }
            );
            await chooseQuickPickOption(page, 'No');

            // An identity-only package has no binaries, so there is no runtime
            // to bundle and the question must never be asked.
            await page.waitForTimeout(5_000);
            await expect(
                page.locator('.quick-input-widget input[placeholder*="self-contained"]')
            ).toHaveCount(0);

            console.log('✅ PASS: identity-only input skipped the self-contained prompt');
        } finally {
            await cleanup(app, tmpDir, userDataDir);
        }
    });

    test('still asks about self-contained for a build output folder', async () => {
        // The contrast case: without it, a prompt that never fires for any
        // input would pass the test above.
        const tmpDir = createPackWorkspace();

        let app: ElectronApplication | undefined;
        let userDataDir: string | undefined;
        try {
            const launched = await launchVSCodeForFolder(tmpDir);
            app = launched.app;
            userDataDir = launched.userDataDir;
            const page = launched.page;

            await openPackPicker(page);
            await choosePackRow(page, 'net8.0');

            await expect(quickPickPlaceholder(page)).toHaveAttribute(
                'placeholder',
                /development certificate/,
                { timeout: DISCOVERY_TIMEOUT }
            );
            await chooseQuickPickOption(page, 'No');

            await expect(quickPickPlaceholder(page)).toHaveAttribute(
                'placeholder',
                /self-contained/,
                { timeout: DISCOVERY_TIMEOUT }
            );
            await page.keyboard.press('Escape');

            console.log('✅ PASS: folder input was asked about self-contained');
        } finally {
            await cleanup(app, tmpDir, userDataDir);
        }
    });

    test('cancelling the certificate prompt aborts before packaging', async () => {
        const tmpDir = createPackWorkspace({
            sparseManifests: [path.join('src', 'App', 'sparse', 'appxmanifest.xml')],
        });

        let app: ElectronApplication | undefined;
        let userDataDir: string | undefined;
        try {
            const launched = await launchVSCodeForFolder(tmpDir);
            app = launched.app;
            userDataDir = launched.userDataDir;
            const page = launched.page;

            await openSparsePackPicker(page);
            await choosePackRow(page, 'appxmanifest');
            await expect(quickPickPlaceholder(page)).toHaveAttribute(
                'placeholder',
                /development certificate/,
                { timeout: DISCOVERY_TIMEOUT }
            );
            await page.keyboard.press('Escape');

            await page.waitForTimeout(3_000);
            await expect(page.locator('.quick-input-widget')).toBeHidden();
            expect(
                fs.readdirSync(tmpDir, { recursive: true })
                    .some(entry => String(entry).endsWith('.identity.msix'))
            ).toBe(false);

            console.log('✅ PASS: cancelling certificate selection aborted sparse packaging');
        } finally {
            await cleanup(app, tmpDir, userDataDir);
        }
    });

    test('discovers pack inputs from every workspace root', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-multiroot-e2e-'));
        const rootA = path.join(tmpDir, 'AppA');
        const rootB = path.join(tmpDir, 'AppB');
        fs.mkdirSync(rootA, { recursive: true });
        fs.mkdirSync(rootB, { recursive: true });
        writeFile(rootB, path.join('src', 'App', 'App.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />');
        writeFile(rootB, path.join('src', 'App', 'bin', 'Debug', 'App.exe'), Buffer.alloc(1024));
        writeFile(rootB, path.join('src', 'App', 'sparse', 'appxmanifest.xml'), SPARSE_MANIFEST);
        const workspaceFile = writeFile(
            tmpDir,
            'multi.code-workspace',
            JSON.stringify({ folders: [{ path: rootA }, { path: rootB }] })
        );

        let app: ElectronApplication | undefined;
        let userDataDir: string | undefined;
        try {
            const launched = await launchVSCodeForFolder(workspaceFile);
            app = launched.app;
            userDataDir = launched.userDataDir;

            const regularRows = await openPackPicker(launched.page);
            expect((await regularRows.allTextContents())
                .some(text => text.includes('AppB') && text.includes('Debug'))).toBe(true);
            await launched.page.keyboard.press('Escape');

            const sparseRows = await openSparsePackPicker(launched.page);
            expect((await sparseRows.allTextContents())
                .some(text => text.includes('AppB') && text.includes('appxmanifest.xml'))).toBe(true);
            await launched.page.keyboard.press('Escape');
            console.log('✅ PASS: both package commands included the secondary workspace root');
        } finally {
            await cleanup(app, tmpDir, userDataDir);
        }
    });

    test('skips oversized manifest candidates', async () => {
        const tmpDir = createPackWorkspace({
            includeBuildOutput: false,
            sparseManifests: [path.join('identity', 'valid', 'appxmanifest.xml')],
        });
        writeFile(
            tmpDir,
            path.join('identity', 'oversized', 'appxmanifest.xml'),
            SPARSE_MANIFEST + ' '.repeat(1024 * 1024)
        );

        let app: ElectronApplication | undefined;
        let userDataDir: string | undefined;
        try {
            const launched = await launchVSCodeForFolder(tmpDir);
            app = launched.app;
            userDataDir = launched.userDataDir;

            const rows = await openSparsePackPicker(launched.page);
            const rowText = await rows.allTextContents();
            const manifestRows = rowText.filter(text => text.includes('appxmanifest.xml'));
            expect(manifestRows).toHaveLength(1);
            expect(manifestRows[0].toLowerCase()).toContain(path.join('identity', 'valid').toLowerCase());
            expect(manifestRows[0].toLowerCase()).not.toContain('oversized');
            expect(rowText.filter(text => text.includes('Browse'))).toHaveLength(1);

            await launched.page.keyboard.press('Escape');
            console.log('✅ PASS: oversized sparse manifest candidate was skipped');
        } finally {
            await cleanup(app, tmpDir, userDataDir);
        }
    });

    test('dispatches sparse init with the selected executable and project output', async () => {
        const tmpDir = createPackWorkspace();

        let app: ElectronApplication | undefined;
        let userDataDir: string | undefined;
        try {
            const launched = await launchVSCodeForFolder(tmpDir);
            app = launched.app;
            userDataDir = launched.userDataDir;
            const page = launched.page;

            await runCommandPalette(page, 'WinApp: Create Sparse Identity Manifest');
            await expect(quickPickPlaceholder(page)).toHaveAttribute(
                'placeholder',
                /executable to grant package identity/,
                { timeout: DISCOVERY_TIMEOUT }
            );
            await choosePackRow(page, 'App.exe');

            await expectWinAppTerminal(page);

            console.log('✅ PASS: sparse init dispatched the expected CLI arguments');
        } finally {
            await cleanup(app, tmpDir, userDataDir);
        }
    });

    test('dispatches embed identity with the resolved sparse manifest', async () => {
        const tmpDir = createPackWorkspace({
            sparseManifests: [path.join('src', 'App', 'sparse', 'appxmanifest.xml')],
        });
        writeFile(tmpDir, path.join('src', 'App', 'app.manifest'), '<assembly />');

        let app: ElectronApplication | undefined;
        let userDataDir: string | undefined;
        try {
            const launched = await launchVSCodeForFolder(tmpDir);
            app = launched.app;
            userDataDir = launched.userDataDir;
            const page = launched.page;

            await runCommandPalette(page, 'WinApp: Embed Identity into Executable');
            await expect(quickPickPlaceholder(page)).toHaveAttribute(
                'placeholder',
                /executable or side-by-side manifest/,
                { timeout: DISCOVERY_TIMEOUT }
            );
            // Use the side-by-side target so the test can cover dispatch
            // without depending on VS Code's native modal-button accessibility.
            await choosePackRow(page, 'app.manifest');

            await expectWinAppTerminal(page);

            console.log('✅ PASS: embed identity dispatched an explicit sparse manifest');
        } finally {
            await cleanup(app, tmpDir, userDataDir);
        }
    });
});
