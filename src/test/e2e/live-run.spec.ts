/**
 * Live test for real CLI project-mode build, deploy, and launch; opt in with E2E_LIVE_RUN=1.
 */

import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const VSCODE_EXE =
    process.env.VSCODE_PATH ??
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe');

const EXTENSION_ROOT = path.resolve(__dirname, '..', '..', '..');

/** C# Dev Kit can steal focus and mutate build output, so it must not load. */
const INTERFERING_EXTENSIONS = [
    'ms-dotnettools.csdevkit',
    'ms-dotnettools.csharp',
    'ms-dotnettools.vscode-dotnet-runtime',
];

/** Installed-extension mode must disable only known interfering extensions. */
const EXTENSION_ARGS = process.env.E2E_USE_INSTALLED_EXTENSION === '1'
    ? INTERFERING_EXTENSIONS.flatMap((id) => ['--disable-extension', id])
    : ['--disable-extensions', `--extensionDevelopmentPath=${EXTENSION_ROOT}`];

/** A build, deploy, and launch takes far longer than the suite's default. */
const LIVE_RUN_TIMEOUT_MS = 8 * 60 * 1000;

/** How long to wait for the app to appear after the command is dispatched. */
const LAUNCH_TIMEOUT_MS = 6 * 60 * 1000;

// ──────────────────────────────────────────────────────
// Shell helpers
// ──────────────────────────────────────────────────────

function ps(command: string, timeoutMs = 120_000): string {
    return execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', command],
        { encoding: 'utf8', timeout: timeoutMs, windowsHide: true }
    ).trim();
}

function tryPs(command: string, timeoutMs = 120_000): string | undefined {
    try {
        return ps(command, timeoutMs);
    } catch {
        return undefined;
    }
}

/** The full name of a registered package with the given identity, if any. */
function findRegisteredPackage(identityName: string): string | undefined {
    const result = tryPs(
        `(Get-AppxPackage -Name '${identityName}' -ErrorAction SilentlyContinue).PackageFullName`
    );
    return result ? result.split(/\r?\n/)[0].trim() || undefined : undefined;
}

function removeRegisteredPackage(identityName: string): void {
    const fullName = findRegisteredPackage(identityName);
    if (!fullName) {
        return;
    }
    tryPs(`Remove-AppxPackage -Package '${fullName}' -ErrorAction SilentlyContinue`);
}

function isProcessRunning(processName: string): boolean {
    const result = tryPs(
        `@(Get-Process -Name '${processName}' -ErrorAction SilentlyContinue).Count`
    );
    return Number(result ?? '0') > 0;
}

/** Stop-Process returns before handles are released, so wait for exit. */
function killProcess(processName: string): void {
    tryPs(
        `Get-Process -Name '${processName}' -ErrorAction SilentlyContinue `
        + `| ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }`
    );

    for (let attempt = 1; attempt <= 15; attempt += 1) {
        if (!isProcessRunning(processName)) {
            return;
        }
        sleepSync(1_000);
    }
}

// ──────────────────────────────────────────────────────
// Prerequisites
// ──────────────────────────────────────────────────────

/** Describes why the live test cannot run here, or `undefined` when it can. */
function findMissingPrerequisite(): string | undefined {
    if (tryPs('dotnet --version', 60_000) === undefined) {
        return 'the .NET SDK is not available on PATH';
    }

    const templates = tryPs('dotnet new list winui', 90_000) ?? '';
    if (!/\bwinui\b/.test(templates)) {
        return 'the WinUI template pack is not installed (run: winapp new --list)';
    }

    // The extension resolves its bundled CLI first and falls back to PATH, so
    // either is acceptable; this only checks that *something* will resolve.
    const bundled = ['win-arm64', 'win-x64'].some(arch =>
        fs.existsSync(path.join(EXTENSION_ROOT, 'bin', arch, 'winapp.exe'))
    );
    if (!bundled && tryPs('winapp --version', 60_000) === undefined) {
        return 'no winapp CLI is bundled or on PATH';
    }

    return undefined;
}

const missingPrerequisite = findMissingPrerequisite();
const liveRunEnabled = process.env.E2E_LIVE_RUN === '1';

// ──────────────────────────────────────────────────────
// Fixture scaffolding
// ──────────────────────────────────────────────────────

interface ScaffoldedApp {
    /** Directory containing the .csproj — the workspace VS Code opens. */
    projectDir: string;
    /** Temporary root to delete afterwards. */
    tempRoot: string;
    /** Project/process name, unique per scaffold. */
    appName: string;
    /** Package identity from the generated manifest, needed for cleanup. */
    identityName: string;
}

/** Identities registered by this suite, swept in afterAll if a test dies. */
const scaffolded: ScaffoldedApp[] = [];

/** Random names prevent leaked apps or packages from satisfying this run. */
function scaffoldWinUiApp(prefix: string): ScaffoldedApp {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${SCAFFOLD_PREFIX}${prefix}-`));
    const appName = `LiveRun${Math.random().toString(36).slice(2, 8)}`;
    const projectDir = path.join(tempRoot, appName);

    execFileSync(
        'dotnet',
        ['new', 'winui', '-n', appName, '-o', projectDir],
        { encoding: 'utf8', timeout: 180_000, windowsHide: true }
    );

    const manifestPath = path.join(projectDir, 'Package.appxmanifest');
    const manifest = fs.readFileSync(manifestPath, 'utf8');
    const identityName = /<Identity[^>]*?\bName\s*=\s*"([^"]+)"/s.exec(manifest)?.[1];
    if (!identityName) {
        throw new Error(`Could not read the package identity from ${manifestPath}`);
    }

    const app: ScaffoldedApp = { projectDir, tempRoot, appName, identityName };
    scaffolded.push(app);
    return app;
}

/** App scaffold prefix; must not match VS Code profile directories. */
const SCAFFOLD_PREFIX = 'live-run-app-';

/** Prefix for the throwaway VS Code user-data directories this spec creates. */
const PROFILE_PREFIX = 'live-run-profile-';

/** Blocks the current thread; usable from synchronous teardown. */
function sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Orphaned scaffolds exclude directories still tracked by this run. */
function findOrphanedScaffolds(): string[] {
    const active = new Set([
        ...scaffolded.map(app => path.resolve(app.tempRoot)),
        ...userDataDirs.map(dir => path.resolve(dir)),
    ]);

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true });
    } catch {
        return [];
    }

    return entries
        .filter(entry => entry.isDirectory() && entry.name.startsWith(SCAFFOLD_PREFIX))
        .map(entry => path.resolve(path.join(os.tmpdir(), entry.name)))
        .filter(dir => !active.has(dir));
}

/** Orphaned scaffolds can leave unique registered packages behind. */
function reclaimOrphanedScaffold(orphanDir: string): void {
    let projectDirs: fs.Dirent[];
    try {
        projectDirs = fs.readdirSync(orphanDir, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of projectDirs) {
        if (!entry.isDirectory()) {
            continue;
        }

        const manifestPath = path.join(orphanDir, entry.name, 'Package.appxmanifest');
        let manifest: string;
        try {
            manifest = fs.readFileSync(manifestPath, 'utf8');
        } catch {
            // Not a deployed app directory, so its name is not an app name.
            // Killing by name here would target an unrelated process.
            continue;
        }

        // The project directory is named after the app, which is also the
        // process name.
        killProcess(entry.name);

        const identityName = /<Identity[^>]*?\bName\s*=\s*"([^"]+)"/s.exec(manifest)?.[1];
        if (identityName) {
            removeRegisteredPackage(identityName);
        }
    }
}

/** Cleanup returns leaks so undeleted real packages and processes fail the test. */
function cleanUp(app: ScaffoldedApp): string[] {
    const leaks: string[] = [];

    // Order matters: the app must exit before its package can be removed
    // cleanly, and the package must be deregistered before the loose layout
    // under bin/ releases its handles.
    killProcess(app.appName);
    if (isProcessRunning(app.appName)) {
        leaks.push(`process ${app.appName} is still running`);
    }

    removeRegisteredPackage(app.identityName);
    for (let attempt = 1; attempt <= 15; attempt += 1) {
        if (findRegisteredPackage(app.identityName) === undefined) {
            break;
        }
        sleepSync(1_000);
    }
    if (findRegisteredPackage(app.identityName) !== undefined) {
        leaks.push(`package ${app.identityName} is still registered`);
    }

    if (!removeDirectory(app.tempRoot)) {
        leaks.push(`directory ${app.tempRoot} could not be removed`);
    }

    return leaks;
}

/** Deletes a directory, retrying while Windows releases lingering handles. */
function removeDirectory(target: string): boolean {
    for (let attempt = 1; attempt <= 15; attempt += 1) {
        try {
            fs.rmSync(target, { recursive: true, force: true });
            if (!fs.existsSync(target)) {
                return true;
            }
        } catch {
            // Retry below; deployment handles are released asynchronously.
        }
        sleepSync(2_000);
    }

    return !fs.existsSync(target);
}

/** Recursively finds the built executable under a given build configuration. */
function findBuiltExecutable(projectDir: string, configuration: string, appName: string): string | undefined {
    const binDir = path.join(projectDir, 'bin');
    if (!fs.existsSync(binDir)) {
        return undefined;
    }

    const target = `${appName}.exe`.toLowerCase();
    const stack = [binDir];

    while (stack.length > 0) {
        const current = stack.pop()!;
        // The layout is bin/<Platform>/<Configuration>/<tfm>/<rid>, but
        // Platform is only present for some projects, so match a path segment
        // rather than assuming a fixed depth.
        const underConfiguration = path.relative(binDir, current)
            .split(path.sep)
            .some(segment => segment.toLowerCase() === configuration.toLowerCase());

        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
            } else if (underConfiguration && entry.name.toLowerCase() === target) {
                return full;
            }
        }
    }

    return undefined;
}

// ──────────────────────────────────────────────────────
// VS Code driving
// ──────────────────────────────────────────────────────

const userDataDirs: string[] = [];

async function launchVSCode(targetPath: string): Promise<{ app: ElectronApplication; page: Page }> {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), PROFILE_PREFIX));
    userDataDirs.push(userDataPath);

    // Seed the fresh profile rather than relying on CLI flags, which do not
    // cover this. A brand new profile opens the Welcome tab and focuses the
    // chat input, and either one swallows the command palette shortcut.
    const userSettingsDir = path.join(userDataPath, 'User');
    fs.mkdirSync(userSettingsDir, { recursive: true });
    fs.writeFileSync(
        path.join(userSettingsDir, 'settings.json'),
        JSON.stringify({
            'workbench.startupEditor': 'none',
            'workbench.tips.enabled': false,
            'workbench.welcomePage.walkthroughs.openOnInstall': false,
            'security.workspace.trust.enabled': false,
            'update.mode': 'none',
            'telemetry.telemetryLevel': 'off',
            'chat.commandCenter.enabled': false,
            // xterm renders to a canvas when accelerated, leaving no text in
            // the DOM. Without this the failure diagnostic below cannot read
            // the terminal and silently reports that none was opened.
            'terminal.integrated.gpuAcceleration': 'off',
        }, null, 2)
    );

    const app = await electron.launch({
        executablePath: VSCODE_EXE,
        args: [
            targetPath,
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
    await page.waitForTimeout(6_000);

    return { page, app };
}

const PALETTE_PLACEHOLDER = /Type the name of a command to run/;

/** Retry until the palette has focus; startup UI can swallow the shortcut. */
async function openCommandPalette(page: Page) {
    const input = page.locator('.quick-input-widget .quick-input-filter input[type="text"]');

    for (let attempt = 1; attempt <= 3; attempt += 1) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
        await page.keyboard.press('Control+Shift+P');

        try {
            await expect(input).toHaveAttribute('placeholder', PALETTE_PLACEHOLDER, { timeout: 10_000 });
            return input;
        } catch {
            if (attempt === 3) {
                throw new Error('The command palette never opened after 3 attempts.');
            }
            await page.waitForTimeout(2_000);
        }
    }

    throw new Error('unreachable');
}

/** Wait for the palette placeholder so typed commands cannot land in an editor. */
async function runCommandPalette(page: Page, commandLabel: string): Promise<void> {
    const input = await openCommandPalette(page);

    await page.keyboard.type(commandLabel, { delay: 30 });
    await page.waitForTimeout(1_500);

    // Guard against the palette being dismissed mid-type.
    await expect(input).toBeFocused({ timeout: 5_000 });
    await page.keyboard.press('Enter');
}

/**
 * Answer an open QuickPick by filtering to `label` and accepting it.
 *
 * Typing rather than clicking a row keeps this independent of where the item
 * lands in the list, which varies with the architectures the host reports.
 */
async function pickQuickItem(page: Page, label: string): Promise<void> {
    const input = page.locator('.quick-input-widget .quick-input-filter input[type="text"]');
    await expect(input).toBeVisible({ timeout: 30_000 });
    await input.fill(label);
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
}

/** Terminal visibility proves the command dispatched before launch polling begins. */
async function waitForCliTerminal(page: Page): Promise<void> {
    await expect(page.locator('.terminal-wrapper, .terminal .xterm-rows').first())
        .toBeVisible({ timeout: 60_000 });
}

/** Terminal text is only for explaining build failures that would otherwise time out. */
async function readTerminalText(page: Page): Promise<string> {
    try {
        const rows = page.locator('.xterm-rows');
        if (await rows.count() === 0) {
            return '(no terminal was opened)';
        }
        const text = ((await rows.first().innerText()) ?? '').trim();
        return text || '(terminal was empty)';
    } catch {
        return '(terminal output could not be read)';
    }
}

/** Polls until `predicate` is true, or fails with `description` on timeout. */
async function waitFor(
    predicate: () => boolean,
    description: string,
    page: Page,
    timeoutMs = LAUNCH_TIMEOUT_MS
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) {
            return;
        }
        await page.waitForTimeout(3_000);
    }

    const terminal = await readTerminalText(page);
    throw new Error(
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${description}.\n`
        + `--- WinApp CLI terminal ---\n${terminal}`
    );
}

// ──────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────

/** Final backstop for crashed or interrupted tests; current-run leaks are failures. */
test.afterAll(() => {
    // This hook is file-scoped, so it also runs when the suite below is
    // skipped. Sweeping the machine on a run that never created anything is
    // not this hook's job.
    if (!liveRunEnabled) {
        return;
    }

    const leaks: string[] = [];

    for (const app of scaffolded) {
        leaks.push(...cleanUp(app));
    }

    for (const dir of userDataDirs) {
        if (!removeDirectory(dir)) {
            leaks.push(`VS Code profile ${dir} could not be removed`);
        }
    }

    const stranded: string[] = [];
    for (const orphan of findOrphanedScaffolds()) {
        reclaimOrphanedScaffold(orphan);
        if (removeDirectory(orphan)) {
            console.log(`🧹 Removed an orphaned scaffold from an earlier run: ${orphan}`);
        } else {
            stranded.push(orphan);
        }
    }

    if (stranded.length > 0) {
        console.warn(
            `⚠️  Residue from an earlier run could not be removed (usually a VS Code `
            + `instance from a crashed run still holding its profile):\n  - ${stranded.join('\n  - ')}`
        );
    }

    if (leaks.length > 0) {
        throw new Error(
            `The live run test leaked resources that must be cleaned up manually:\n  - ${leaks.join('\n  - ')}`
        );
    }
});

test.describe('live winapp run (project mode)', () => {
    test.skip(!liveRunEnabled, 'Set E2E_LIVE_RUN=1 to run the live build-and-launch test.');
    test.skip(
        liveRunEnabled && missingPrerequisite !== undefined,
        `Live run prerequisites unavailable: ${missingPrerequisite}`
    );

    test('builds, deploys, and launches a WinUI project', async () => {
        test.setTimeout(LIVE_RUN_TIMEOUT_MS);

        const app = scaffoldWinUiApp('basic');
        expect(findRegisteredPackage(app.identityName), 'identity should be unused before the run')
            .toBeUndefined();

        let codeApp: ElectronApplication | undefined;
        try {
            const launched = await launchVSCode(app.projectDir);
            codeApp = launched.app;
            const page = launched.page;

            // A single .csproj is an unambiguous target, so this runs without
            // showing the picker at all.
            await runCommandPalette(page, 'WinApp: Run Application');
            await waitForCliTerminal(page);

            await waitFor(
                () => findRegisteredPackage(app.identityName) !== undefined,
                `package ${app.identityName} to be registered`,
                page
            );

            await waitFor(
                () => isProcessRunning(app.appName),
                `process ${app.appName} to start`,
                page
            );

            // Registration and launch both succeeded, so the build must have
            // produced output; assert it explicitly to pin project mode rather
            // than some pre-existing layout being deployed.
            const exePath = findBuiltExecutable(app.projectDir, 'Debug', app.appName);
            expect(exePath, 'a Debug build output should exist').toBeTruthy();

            console.log(`✅ PASS: built ${exePath}, registered ${app.identityName}, launched ${app.appName}`);
        } finally {
            if (codeApp) {
                await codeApp.close().catch(() => {});
            }
            cleanUp(app);
        }
    });

    // The With Options prompts are the only way to vary a build now that the
    // palette carries no workspace settings, so one run drives the whole chain
    // and checks both answers reached the CLI.
    test('applies the With Options build prompts to a project-mode build', async () => {
        test.setTimeout(LIVE_RUN_TIMEOUT_MS);

        const app = scaffoldWinUiApp('buildprompts');

        let codeApp: ElectronApplication | undefined;
        try {
            const launched = await launchVSCode(app.projectDir);
            codeApp = launched.app;
            const page = launched.page;

            await runCommandPalette(page, 'WinApp: Run Application With Options');

            await pickQuickItem(page, 'Release');
            await pickQuickItem(page, 'x64');
            // The toggle picker is multi-select; accept it with nothing chosen.
            await page.keyboard.press('Enter');

            await waitForCliTerminal(page);

            await waitFor(
                () => findBuiltExecutable(app.projectDir, 'Release', app.appName) !== undefined,
                `a Release build of ${app.appName}`,
                page
            );

            // Debug is the CLI's default, so its absence is what shows the
            // prompt answer was honoured rather than ignored.
            expect(
                findBuiltExecutable(app.projectDir, 'Debug', app.appName),
                'the Debug default should not have been built'
            ).toBeUndefined();

            const exePath = findBuiltExecutable(app.projectDir, 'Release', app.appName)!;
            expect(
                exePath.toLowerCase().split(path.sep).includes('win-x64'),
                `expected an x64 runtime-identifier output, got ${exePath}`
            ).toBe(true);

            console.log(`✅ PASS: With Options produced ${exePath}`);
        } finally {
            if (codeApp) {
                await codeApp.close().catch(() => {});
            }
            cleanUp(app);
        }
    });
});
