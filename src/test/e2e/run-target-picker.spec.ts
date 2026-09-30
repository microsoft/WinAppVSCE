/**
 * E2E tests for the run-target picker used by `winapp.run`, `winapp.runAdvanced`,
 * and the `winapp` debug adapter.
 *
 * These cover the discovery behavior that unit tests cannot reach, because it
 * depends on VS Code's own `findFiles` indexing and on real workspace-folder
 * resolution:
 *
 * Test 1 — Projects are discovered and listed:
 *   A workspace with two .csproj files shows both, plus the build-output search
 *   and browse entries.
 *
 * Test 2 — Solution members are deduplicated:
 *   A .sln listing a member .csproj shows one entry for the solution, not two.
 *
 * Test 3 — Multi-root discovery:
 *   A .code-workspace with two folders shows projects from *both*, which is the
 *   multi-root fix — discovery previously only ever saw workspaceFolders[0].
 *
 * Test 4 — Advanced command always prompts:
 *   A workspace with a single project auto-selects for "Run Application" but
 *   still prompts for "Run Application (Advanced)".
 *
 * Test 5 — Library-only workspaces reach folder mode:
 *   A workspace whose only project is a class library hides that library and
 *   falls through to the build-output scan, keeping `winapp run <folder>`
 *   reachable.
 *
 * Test 6 — Libraries and test projects are hidden:
 *   A workspace mixing an app with a class library and a test project offers
 *   only the app.
 *
 * Test 7 — A project outranks its own build output:
 *   A workspace with both a .csproj and a populated bin/ offers the project
 *   only, so the run rebuilds instead of launching stale output.
 *
 * Test 8 — Project-less apps (Electron, Rust, …) still resolve:
 *   A workspace with no project file finds its dist/ output while skipping the
 *   electron.exe vendored under node_modules.
 *
 * Test 9 — Multi-app solutions prompt for `--project`:
 *   Selecting a .sln with two runnable apps asks which one to run.
 *
 * Test 10 — Single-app solutions do not:
 *   The same flow with one app and one library moves straight on, because the
 *   CLI resolves `--project` itself.
 *
 * Test 11 — Long project lists are capped:
 *   More than ten projects are truncated with a pointer at the browse entry.
 *
 * Every test dismisses the picker with Escape, so the winapp CLI is never
 * actually invoked and nothing is built, deployed, or registered.
 */

import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const VSCODE_EXE =
    process.env.VSCODE_PATH ??
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe');

const EXTENSION_ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * Extensions that interfere with this suite and must not load.
 *
 * The fixtures are real .csproj files, which activates C# Dev Kit. It then
 * contributes status-bar items and announcement UI that can take focus while
 * the command palette is opening, and the palette keystroke is swallowed.
 */
const INTERFERING_EXTENSIONS = [
    'ms-dotnettools.csdevkit',
    'ms-dotnettools.csharp',
    'ms-dotnettools.vscode-dotnet-runtime',
];

/**
 * Isolate the extension under test from other installed extensions.
 *
 * `--disable-extensions` is exempt for `--extensionDevelopmentPath`, so it is
 * correct when the extension is loaded from disk. It cannot be used when the
 * *installed* build is under test, because it would disable that build too;
 * that mode names the interfering extensions individually instead.
 */
const EXTENSION_ARGS = process.env.E2E_USE_INSTALLED_EXTENSION === '1'
    ? INTERFERING_EXTENSIONS.flatMap((id) => ['--disable-extension', id])
    : ['--disable-extensions', `--extensionDevelopmentPath=${EXTENSION_ROOT}`];

const MINIMAL_CSPROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>WinExe</OutputType>
    <TargetFramework>net8.0-windows10.0.19041.0</TargetFramework>
  </PropertyGroup>
</Project>
`;

/** Temporary VS Code profiles to remove once the suite finishes. */
const userDataDirs: string[] = [];

test.afterAll(() => {
    for (const dir of userDataDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/** Launch VS Code with the extension loaded, opening a folder or .code-workspace. */
async function launchVSCode(targetPath: string): Promise<{ app: ElectronApplication; page: Page }> {
    // Each launch gets its own profile so "recently used" palette entries and
    // other persisted state cannot leak between tests.
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'run-target-e2e-profile-'));
    userDataDirs.push(userDataPath);

    // Seed the fresh profile rather than relying on CLI flags, which do not
    // cover this. A brand new profile opens the Welcome dialog and focuses the
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
        timeout: 30_000,
    });

    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    // Allow VS Code to finish initialising & activating extensions
    await page.waitForTimeout(6_000);

    return { app, page };
}

const PALETTE_PLACEHOLDER = /Type the name of a command to run/;

/**
 * Dismisses first-run UI that takes focus.
 *
 * A fresh profile can show a "Welcome to Visual Studio Code" sign-in dialog and
 * notification toasts. Neither is suppressed by `workbench.startupEditor`, and
 * while either holds focus the palette shortcut is swallowed.
 */
async function dismissFirstRunUI(page: Page): Promise<void> {
    for (const name of [/Continue without Signing In/, /^Close$/]) {
        const button = page.getByRole('button', { name });
        try {
            if (await button.first().isVisible({ timeout: 1_000 })) {
                await button.first().click({ timeout: 2_000 });
                await page.waitForTimeout(500);
            }
        } catch { /* the dialog is absent, which is the common case */ }
    }
}

/**
 * Opens the command palette, retrying until it genuinely has focus.
 *
 * Typing blind is unsafe: anything that takes focus while the palette opens
 * sends the keystrokes into an editor instead, and the command silently never
 * runs. Asserting on the palette's own placeholder makes that failure loud.
 */
async function openCommandPalette(page: Page) {
    const input = page.locator('.quick-input-widget .quick-input-filter input[type="text"]');

    for (let attempt = 1; attempt <= 3; attempt += 1) {
        await dismissFirstRunUI(page);
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

async function runCommandPalette(page: Page, commandLabel: string): Promise<void> {
    const input = await openCommandPalette(page);
    await page.keyboard.type(commandLabel, { delay: 30 });
    await page.waitForTimeout(1_500);
    await expect(input).toBeFocused({ timeout: 5_000 });
    await page.keyboard.press('Enter');
}

/** Write a project file, creating intermediate directories. */
function writeProject(root: string, relativePath: string, contents: string = MINIMAL_CSPROJ): string {
    const fullPath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, contents);
    return fullPath;
}

/** The rows currently shown in the quick input list. */
function quickPickRows(page: Page) {
    return page.locator('.quick-input-widget .quick-input-list .monaco-list-row');
}

/** The exact placeholder of the run-target picker. */
// Matching loosely on "to run" is not safe: the command palette's own
// placeholder is "Type the name of a command to run", so a loose pattern
// matches the palette and reads its rows instead of the picker's.
const RUN_TARGET_PLACEHOLDER = /Select the project, solution, or build output folder to run/;

/** The placeholder of the second prompt, which disambiguates `--project`. */
const PROJECT_PICKER_PLACEHOLDER = /Which project in .+ would you like to run\?/;

/** The placeholder of the advanced command's first build-settings prompt. */
const BUILD_CONFIG_PLACEHOLDER = /^Build configuration$/;

/**
 * Wait for a quick pick identified by its placeholder and return every row.
 *
 * The picker is identified by its placeholder rather than by waiting for rows:
 * the command palette's own rows are visible the instant Enter is pressed, so
 * reading rows immediately captures the palette instead of the picker that
 * replaces it.
 */
async function readPickerRows(page: Page, placeholder: RegExp): Promise<string[]> {
    const input = page.locator('.quick-input-widget .quick-input-filter input[type="text"]');
    await expect(input).toHaveAttribute('placeholder', placeholder, { timeout: 30_000 });

    const rows = quickPickRows(page);
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    // Let the list settle so we do not read a partially rendered set of rows.
    await page.waitForTimeout(750);

    const texts: string[] = [];
    const count = await rows.count();
    for (let index = 0; index < count; index += 1) {
        texts.push((await rows.nth(index).textContent()) ?? '');
    }
    return texts;
}

async function readRunTargetPicker(page: Page): Promise<string[]> {
    return readPickerRows(page, RUN_TARGET_PLACEHOLDER);
}

test.describe('run target picker', () => {
    test('hides class libraries and test projects', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-target-filter-e2e-'));
        writeProject(tmpDir, path.join('AppOne', 'AppOne.csproj'));
        writeProject(tmpDir, path.join('CoreLib', 'CoreLib.csproj'), `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Library</OutputType>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
</Project>
`);
        writeProject(tmpDir, path.join('AppOne.Tests', 'AppOne.Tests.csproj'), `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />
  </ItemGroup>
</Project>
`);

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCode(tmpDir);
            app = launched.app;
            const page = launched.page;

            // Only one runnable project survives filtering, which "Run
            // Application" would auto-select and launch. The advanced command
            // always shows the picker without invoking the CLI.
            await runCommandPalette(page, 'WinApp: Run Application (Advanced)');

            const rows = await readRunTargetPicker(page);
            const joined = rows.join('\n');

            expect(joined).toContain('AppOne.csproj');
            expect(joined).not.toContain('CoreLib.csproj');
            expect(joined).not.toContain('AppOne.Tests.csproj');

            await page.keyboard.press('Escape');
            console.log('✅ PASS: library and test projects filtered out of the picker');
        } finally {
            if (app) {
                await app.close().catch(() => {});
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // Folder mode is how `winapp run <build output folder>` works. A workspace
    // whose only project is a library must not offer that library — the CLI
    // would degrade to folder mode and report "Manifest file not found", which
    // says nothing about the real problem — but it must still reach the build
    // output folder, which is the one target that can actually run.
    test('falls back to build output when the only project is a library', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-target-libonly-e2e-'));
        writeProject(tmpDir, path.join('CoreLib', 'CoreLib.csproj'), `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Library</OutputType>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
</Project>
`);
        const outputDir = path.join(tmpDir, 'CoreLib', 'bin', 'Debug', 'net8.0');
        fs.mkdirSync(outputDir, { recursive: true });
        fs.writeFileSync(path.join(outputDir, 'CoreLib.Sample.exe'), '');

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCode(tmpDir);
            app = launched.app;
            const page = launched.page;

            await runCommandPalette(page, 'WinApp: Run Application (Advanced)');

            const rows = await readRunTargetPicker(page);
            const joined = rows.join('\n');

            // The library is gone, and discovery pressed on to folder mode
            // rather than stopping at "nothing to run".
            expect(joined).not.toContain('CoreLib.csproj');
            expect(joined).toContain('net8.0');

            await page.keyboard.press('Escape');
            console.log('✅ PASS: library-only workspace falls through to build output');
        } finally {
            if (app) {
                await app.close().catch(() => {});
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // A project always beats its own build output: the .exe scan only runs
    // when discovery finds no project at all. Without this the picker would
    // offer both, and picking the folder would launch stale output instead of
    // rebuilding.
    test('prefers the project over its own build output folder', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-target-prefer-e2e-'));
        writeProject(tmpDir, path.join('App', 'App.csproj'));
        const outputDir = path.join(tmpDir, 'App', 'bin', 'Debug', 'net8.0-windows10.0.19041.0');
        fs.mkdirSync(outputDir, { recursive: true });
        fs.writeFileSync(path.join(outputDir, 'App.exe'), '');

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCode(tmpDir);
            app = launched.app;
            const page = launched.page;

            await runCommandPalette(page, 'WinApp: Run Application (Advanced)');

            const joined = (await readRunTargetPicker(page)).join('\n');

            expect(joined).toContain('App.csproj');
            // No row carries the target framework, so the bin folder is absent.
            expect(joined).not.toContain('net8.0-windows');

            await page.keyboard.press('Escape');
            console.log('✅ PASS: project preferred over its own build output');
        } finally {
            if (app) {
                await app.close().catch(() => {});
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // Apps with no project file — Electron, Rust, and anything else that only
    // produces an .exe — reach folder mode through the build-output scan. The
    // scan must look inside dist/ and target/, which .csproj discovery skips,
    // while still skipping node_modules: every Electron workspace ships an
    // electron.exe there that would otherwise bury the real app.
    test('finds output for a project-less app without surfacing node_modules', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-target-noproj-e2e-'));
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{ "name": "sample-app" }');

        const appOutput = path.join(tmpDir, 'dist', 'win-unpacked');
        fs.mkdirSync(appOutput, { recursive: true });
        fs.writeFileSync(path.join(appOutput, 'SampleApp.exe'), '');

        const vendored = path.join(tmpDir, 'node_modules', 'electron', 'dist');
        fs.mkdirSync(vendored, { recursive: true });
        fs.writeFileSync(path.join(vendored, 'electron.exe'), '');

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCode(tmpDir);
            app = launched.app;
            const page = launched.page;

            await runCommandPalette(page, 'WinApp: Run Application (Advanced)');

            const joined = (await readRunTargetPicker(page)).join('\n');

            expect(joined).toContain('win-unpacked');
            expect(joined).not.toContain('node_modules');

            await page.keyboard.press('Escape');
            console.log('✅ PASS: project-less app resolved to its build output');
        } finally {
            if (app) {
                await app.close().catch(() => {});
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // The second prompt, which supplies `--project`. Selecting the solution
    // from the first picker must lead to a project prompt listing both apps,
    // because `winapp run` cannot resolve a multi-app solution on its own.
    test('asks which project to run inside a multi-app solution', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-target-sln-project-e2e-'));
        writeProject(tmpDir, path.join('Alpha', 'Alpha.csproj'));
        writeProject(tmpDir, path.join('Beta', 'Beta.csproj'));
        fs.writeFileSync(path.join(tmpDir, 'MySln.sln'),
            'Microsoft Visual Studio Solution File, Format Version 12.00\r\n'
            + 'Project("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "Alpha", "Alpha\\Alpha.csproj", '
            + '"{11111111-1111-1111-1111-111111111111}"\r\nEndProject\r\n'
            + 'Project("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "Beta", "Beta\\Beta.csproj", '
            + '"{22222222-2222-2222-2222-222222222222}"\r\nEndProject\r\n');

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCode(tmpDir);
            app = launched.app;
            const page = launched.page;

            await runCommandPalette(page, 'WinApp: Run Application (Advanced)');

            // Solutions sort ahead of projects, so the first row is the
            // solution and its members are already folded into it.
            const targets = await readRunTargetPicker(page);
            expect(targets.join('\n')).toContain('MySln.sln');
            await page.keyboard.press('Enter');

            const projects = (await readPickerRows(page, PROJECT_PICKER_PLACEHOLDER)).join('\n');
            expect(projects).toContain('Alpha.csproj');
            expect(projects).toContain('Beta.csproj');

            await page.keyboard.press('Escape');
            console.log('✅ PASS: multi-app solution prompted for a project');
        } finally {
            if (app) {
                await app.close().catch(() => {});
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // The mirror of the test above: when a solution holds exactly one runnable
    // app the CLI resolves `--project` on its own, so prompting would be pure
    // noise. Proven by asserting the flow moves on to the run options prompt.
    test('skips the project prompt when a solution holds one runnable app', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-target-sln-single-e2e-'));
        writeProject(tmpDir, path.join('Alpha', 'Alpha.csproj'));
        writeProject(tmpDir, path.join('CoreLib', 'CoreLib.csproj'), `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Library</OutputType>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
</Project>
`);
        fs.writeFileSync(path.join(tmpDir, 'MySln.sln'),
            'Microsoft Visual Studio Solution File, Format Version 12.00\r\n'
            + 'Project("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "Alpha", "Alpha\\Alpha.csproj", '
            + '"{11111111-1111-1111-1111-111111111111}"\r\nEndProject\r\n'
            + 'Project("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "CoreLib", "CoreLib\\CoreLib.csproj", '
            + '"{22222222-2222-2222-2222-222222222222}"\r\nEndProject\r\n');

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCode(tmpDir);
            app = launched.app;
            const page = launched.page;

            await runCommandPalette(page, 'WinApp: Run Application (Advanced)');

            const targets = await readRunTargetPicker(page);
            expect(targets.join('\n')).toContain('MySln.sln');
            await page.keyboard.press('Enter');

            // The project prompt precedes build settings, so landing on the
            // configuration prompt proves it never appeared.
            const options = await readPickerRows(page, BUILD_CONFIG_PLACEHOLDER);
            expect(options.join('\n')).toContain('Debug');

            await page.keyboard.press('Escape');
            console.log('✅ PASS: single-app solution skipped the project prompt');
        } finally {
            if (app) {
                await app.close().catch(() => {});
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('caps the list and points at browse when many projects are found', async () => {        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-target-cap-e2e-'));
        const total = 14;
        for (let index = 0; index < total; index += 1) {
            const name = `App${String(index).padStart(2, '0')}`;
            writeProject(tmpDir, path.join(name, `${name}.csproj`));
        }

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCode(tmpDir);
            app = launched.app;
            const page = launched.page;

            await runCommandPalette(page, 'WinApp: Run Application');

            const topRows = await readRunTargetPicker(page);
            // The list virtualizes, so the tail — including the cap separator
            // and the browse entries — is not in the DOM until it scrolls into
            // view. ArrowUp from the first item wraps to the last.
            await page.keyboard.press('ArrowUp');
            await page.waitForTimeout(750);
            const bottomRows = await readRunTargetPicker(page);

            const rows = [...topRows, ...bottomRows];
            const joined = rows.join('\n');
            const projectNames = new Set(
                rows.map(row => /App\d\d\.csproj/.exec(row)?.[0]).filter((name): name is string => !!name)
            );

            expect(projectNames.size).toBeLessThanOrEqual(10);
            expect(joined).toContain(`Showing 10 of ${total}`);
            expect(joined).toContain('Browse for a project or solution');

            await page.keyboard.press('Escape');
            console.log('✅ PASS: project list capped at 10 with a browse hint');
        } finally {
            if (app) {
                await app.close().catch(() => {});
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('lists every discovered project in the workspace', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-target-e2e-'));
        writeProject(tmpDir, path.join('AppOne', 'AppOne.csproj'));
        writeProject(tmpDir, path.join('AppTwo', 'AppTwo.csproj'));

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCode(tmpDir);
            app = launched.app;
            const page = launched.page;

            await runCommandPalette(page, 'WinApp: Run Application');

            const rows = await readRunTargetPicker(page);
            const joined = rows.join('\n');

            expect(joined).toContain('AppOne.csproj');
            expect(joined).toContain('AppTwo.csproj');
            // The expensive .exe scan is offered, not performed up front.
            expect(joined).toContain('Search for build output folders');
            expect(joined).toContain('Browse for a project or solution');
            expect(joined).toContain('Browse for a folder');

            await page.keyboard.press('Escape');
            console.log('✅ PASS: both projects listed with search and browse entries');
        } finally {
            if (app) {
                await app.close().catch(() => {});
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('shows a solution once rather than also listing its member projects', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-target-sln-e2e-'));
        writeProject(tmpDir, path.join('AppOne', 'AppOne.csproj'));
        fs.writeFileSync(
            path.join(tmpDir, 'MySolution.sln'),
            'Microsoft Visual Studio Solution File, Format Version 12.00\r\n'
            + 'Project("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "AppOne", "AppOne\\AppOne.csproj", '
            + '"{11111111-2222-3333-4444-555555555555}"\r\nEndProject\r\n'
        );

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCode(tmpDir);
            app = launched.app;
            const page = launched.page;

            // Deduplication leaves a single candidate, which "Run Application"
            // would auto-select and launch. Use the advanced command so the
            // picker is always shown and the CLI is never invoked.
            await runCommandPalette(page, 'WinApp: Run Application (Advanced)');

            const rows = await readRunTargetPicker(page);
            const joined = rows.join('\n');

            expect(joined).toContain('MySolution.sln');
            // The member project is reachable through the solution, so listing
            // it separately would just be a duplicate of the same app.
            expect(joined).not.toContain('AppOne.csproj');

            await page.keyboard.press('Escape');
            console.log('✅ PASS: solution listed once, member project deduplicated');
        } finally {
            if (app) {
                await app.close().catch(() => {});
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('discovers projects in every folder of a multi-root workspace', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-target-multiroot-e2e-'));
        const frontend = path.join(tmpDir, 'frontend');
        const backend = path.join(tmpDir, 'backend');
        writeProject(frontend, path.join('Shell', 'Shell.csproj'));
        writeProject(backend, path.join('Service', 'Service.csproj'));

        const workspaceFile = path.join(tmpDir, 'combined.code-workspace');
        fs.writeFileSync(workspaceFile, JSON.stringify({
            folders: [{ path: 'frontend' }, { path: 'backend' }]
        }, null, 2));

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCode(workspaceFile);
            app = launched.app;
            const page = launched.page;

            await runCommandPalette(page, 'WinApp: Run Application');

            const rows = await readRunTargetPicker(page);
            const joined = rows.join('\n');

            // The whole point of the multi-root fix: discovery previously only
            // ever looked at workspaceFolders[0], so Service.csproj was
            // unreachable from the palette.
            expect(joined).toContain('Shell.csproj');
            expect(joined).toContain('Service.csproj');

            await page.keyboard.press('Escape');
            console.log('✅ PASS: projects from both workspace folders listed');
        } finally {
            if (app) {
                await app.close().catch(() => {});
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('advanced command prompts even when a single project would auto-select', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-target-advanced-e2e-'));
        writeProject(tmpDir, path.join('OnlyApp', 'OnlyApp.csproj'));

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCode(tmpDir);
            app = launched.app;
            const page = launched.page;

            await runCommandPalette(page, 'WinApp: Run Application (Advanced)');

            const rows = await readRunTargetPicker(page);
            expect(rows.join('\n')).toContain('OnlyApp.csproj');

            await page.keyboard.press('Escape');
            console.log('✅ PASS: advanced command prompted for a single candidate');
        } finally {
            if (app) {
                await app.close().catch(() => {});
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
