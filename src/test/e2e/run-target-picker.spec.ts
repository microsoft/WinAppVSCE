/**
 * E2E picker coverage for VS Code findFiles/workspace behavior; Escape prevents CLI invocation.
 */

import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const VSCODE_EXE =
    process.env.VSCODE_PATH ??
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe');

const EXTENSION_ROOT = path.resolve(__dirname, '..', '..', '..');

/** C# Dev Kit UI can steal focus while the command palette opens. */
const INTERFERING_EXTENSIONS = [
    'ms-dotnettools.csdevkit',
    'ms-dotnettools.csharp',
    'ms-dotnettools.vscode-dotnet-runtime',
];

/** Installed-extension mode must disable only known interfering extensions. */
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

/** Fresh VS Code profiles can show first-run UI that swallows palette shortcuts. */
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

/** Retry until the palette has focus; startup UI can swallow the shortcut. */
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

/**
 * Run a command by its full palette label.
 *
 * Pressing Enter takes whatever VS Code highlights, which is ordered by recent
 * use. "WinApp: Run Application" is a strict prefix of "WinApp: Run Application
 * With Options...", so the highlighted row is not reliably the one asked for.
 * Clicking the shortest row that starts with the label picks the exact command.
 */
async function runCommandPalette(page: Page, commandLabel: string): Promise<void> {
    await openCommandPalette(page);
    await page.keyboard.type(commandLabel, { delay: 30 });
    await page.waitForTimeout(1_500);

    const rows = quickPickRows(page);
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });

    const count = await rows.count();
    let best: { index: number; length: number } | undefined;
    for (let index = 0; index < count; index += 1) {
        const text = ((await rows.nth(index).textContent()) ?? '').replace(/\s+/g, ' ').trim();
        if (text.startsWith(commandLabel) && (!best || text.length < best.length)) {
            best = { index, length: text.length };
        }
    }

    if (!best) {
        throw new Error(`The command palette never offered "${commandLabel}".`);
    }

    await rows.nth(best.index).click();
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

/** The placeholder of the With Options command's first build-settings prompt. */
const BUILD_CONFIG_PLACEHOLDER = /^Build configuration$/;

/** Placeholder matching avoids reading stale command-palette rows. */
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
        // A second runnable app keeps the picker on screen; a lone survivor
        // would be auto-selected and the CLI invoked, which this suite avoids.
        writeProject(tmpDir, path.join('AppTwo', 'AppTwo.csproj'));
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

            // Only runnable projects survive filtering; the library and test
            // projects must not appear next to the two apps.
            await runCommandPalette(page, 'WinApp: Run Application With Options');

            const rows = await readRunTargetPicker(page);
            const joined = rows.join('\n');

            expect(joined).toContain('AppOne.csproj');
            expect(joined).toContain('AppTwo.csproj');
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

    // Library-only workspaces must skip the library but still reach folder mode;
    // otherwise the CLI reports a misleading missing-manifest error.
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
        // A second build output keeps the picker on screen; a lone candidate
        // is auto-selected and handed straight to the CLI.
        const extraOutput = path.join(tmpDir, 'dist', 'win-unpacked');
        fs.mkdirSync(extraOutput, { recursive: true });
        fs.writeFileSync(path.join(extraOutput, 'Sample.exe'), '');

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCode(tmpDir);
            app = launched.app;
            const page = launched.page;

            await runCommandPalette(page, 'WinApp: Run Application With Options');

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

    // A project beats its own build output; otherwise stale output could launch
    // instead of rebuilding.
    test('prefers the project over its own build output folder', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-target-prefer-e2e-'));
        writeProject(tmpDir, path.join('App', 'App.csproj'));
        // A second project keeps the picker on screen so its rows can be read.
        writeProject(tmpDir, path.join('Other', 'Other.csproj'));
        const outputDir = path.join(tmpDir, 'App', 'bin', 'Debug', 'net8.0-windows10.0.19041.0');
        fs.mkdirSync(outputDir, { recursive: true });
        fs.writeFileSync(path.join(outputDir, 'App.exe'), '');

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCode(tmpDir);
            app = launched.app;
            const page = launched.page;

            await runCommandPalette(page, 'WinApp: Run Application With Options');

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

    // Project-less apps reach folder mode through dist/ or target/, but
    // node_modules must stay hidden because Electron ships electron.exe there.
    test('finds output for a project-less app without surfacing node_modules', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-target-noproj-e2e-'));
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{ "name": "sample-app" }');

        const appOutput = path.join(tmpDir, 'dist', 'win-unpacked');
        fs.mkdirSync(appOutput, { recursive: true });
        fs.writeFileSync(path.join(appOutput, 'SampleApp.exe'), '');

        const vendored = path.join(tmpDir, 'node_modules', 'electron', 'dist');
        fs.mkdirSync(vendored, { recursive: true });
        fs.writeFileSync(path.join(vendored, 'electron.exe'), '');

        // A second real output folder keeps the picker on screen; one candidate
        // would be auto-selected and run.
        const toolOutput = path.join(tmpDir, 'build', 'release');
        fs.mkdirSync(toolOutput, { recursive: true });
        fs.writeFileSync(path.join(toolOutput, 'Tool.exe'), '');

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCode(tmpDir);
            app = launched.app;
            const page = launched.page;

            await runCommandPalette(page, 'WinApp: Run Application With Options');

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

    // The second prompt, which supplies `--project`. The solution is the only
    // run target, so it is auto-selected and the flow must land on a project
    // prompt listing both apps: `winapp run` cannot resolve a multi-app
    // solution on its own.
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

            await runCommandPalette(page, 'WinApp: Run Application With Options');

            // Solutions fold their members in, so the solution is the single
            // candidate and selection is skipped entirely.
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

            await runCommandPalette(page, 'WinApp: Run Application With Options');

            // The solution is the only run target, so it is auto-selected. The
            // project prompt precedes build settings, so landing on the
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
            expect(joined).toContain('Browse');

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
            // One browse entry, not a separate line per dialog kind; the kind
            // is settled by a sub-prompt after it is chosen.
            expect(joined).toContain('Browse');
            expect(joined).not.toContain('Search for build output folders');

            await page.keyboard.press('Escape');
            console.log('✅ PASS: both projects listed with a single browse entry');
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
        // A standalone app outside the solution keeps the picker on screen; a
        // lone candidate is auto-selected and handed straight to the CLI.
        writeProject(tmpDir, path.join('Standalone', 'Standalone.csproj'));
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

            // Deduplication folds AppOne into the solution, leaving it beside
            // the standalone app.
            await runCommandPalette(page, 'WinApp: Run Application With Options');

            const rows = await readRunTargetPicker(page);
            const joined = rows.join('\n');

            expect(joined).toContain('MySolution.sln');
            expect(joined).toContain('Standalone.csproj');
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

    // The two run commands must agree on which target to run; With Options
    // varies how that target is built, not which one is chosen.
    test('With Options command skips the target prompt for a single project', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-target-with-options-e2e-'));
        writeProject(tmpDir, path.join('OnlyApp', 'OnlyApp.csproj'));

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCode(tmpDir);
            app = launched.app;
            const page = launched.page;

            await runCommandPalette(page, 'WinApp: Run Application With Options');

            // Landing on the build prompt proves the target was auto-selected:
            // it is the prompt that follows target selection.
            const rows = await readPickerRows(page, BUILD_CONFIG_PLACEHOLDER);
            expect(rows.join('\n')).toContain('Release');

            await page.keyboard.press('Escape');
            console.log('✅ PASS: With Options auto-selected the only project');
        } finally {
            if (app) {
                await app.close().catch(() => {});
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
    /** F5 without `input` must fall through to the run-target picker. */
    test('F5 with no input in launch.json prompts for a run target', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-target-f5-e2e-'));
        // Two runnable projects, deliberately: a single candidate auto-selects
        // and the adapter goes straight on to invoke the CLI, which this suite
        // must never do.
        writeProject(tmpDir, path.join('AppOne', 'AppOne.csproj'));
        writeProject(tmpDir, path.join('AppTwo', 'AppTwo.csproj'));
        fs.mkdirSync(path.join(tmpDir, '.vscode'));
        fs.writeFileSync(
            path.join(tmpDir, '.vscode', 'launch.json'),
            JSON.stringify({
                version: '0.2.0',
                configurations: [{
                    type: 'winapp',
                    request: 'launch',
                    name: 'Run without input',
                    // Avoids the ms-dotnettools.csharp install prompt, which
                    // this suite cannot answer: it runs --disable-extensions.
                    debuggerType: 'node'
                }]
            }, null, 2)
        );

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCode(tmpDir);
            app = launched.app;
            const page = launched.page;

            // Use the palette helper because it retries until focus is proven;
            // a raw F5 can land in chat and do nothing.
            await runCommandPalette(page, 'Debug: Start Debugging');

            // With no configuration yet selected in the Run and Debug view,
            // VS Code may first ask which one to start. The workspace has
            // exactly one, so accept it when the prompt appears; some builds
            // start it outright and go straight to the run-target picker.
            const quickInput = page.locator('.quick-input-widget .quick-input-filter input[type="text"]');
            try {
                await expect(quickInput).toHaveAttribute(
                    'placeholder',
                    /Type the name of a launch configuration to run/,
                    { timeout: 5_000 }
                );
                await page.keyboard.press('Enter');
            } catch { /* the configuration was started without asking */ }

            const rows = await readRunTargetPicker(page);
            expect(rows.join('\n')).toContain('AppOne.csproj');
            expect(rows.join('\n')).toContain('AppTwo.csproj');

            await page.keyboard.press('Escape');
            console.log('✅ PASS: F5 without input prompted for a run target');
        } finally {
            if (app) {
                await app.close().catch(() => {});
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
