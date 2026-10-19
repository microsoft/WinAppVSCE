/**
 * E2E picker coverage for VS Code findFiles/workspace behavior; Escape prevents CLI invocation.
 */

import { test, expect, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { extensionLaunchArgs } from './helpers';

const VSCODE_EXE =
    process.env.VSCODE_PATH ??
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe');

/** C# Dev Kit UI can steal focus while the command palette opens. */
const INTERFERING_EXTENSIONS = [
    'ms-dotnettools.csdevkit',
    'ms-dotnettools.csharp',
    'ms-dotnettools.vscode-dotnet-runtime',
];

const EXTENSION_ARGS = extensionLaunchArgs(INTERFERING_EXTENSIONS);

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
        await cancelAndExpectNoFollowUp(page);
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

/**
 * A multi-select row carries its own checked state.
 *
 * VS Code gives the row `role="checkbox"`, so `aria-checked` on the row is the
 * rendered tick — it is what the user sees, not just what we asked for.
 */
function expectChecked(row: Locator, checked: boolean, timeout = 10_000) {
    return expect(row).toHaveAttribute('aria-checked', String(checked), { timeout });
}

/** The exact placeholder of the run-target picker. */
// Matching loosely on "to run" is not safe: the command palette's own
// placeholder is "Type the name of a command to run", so a loose pattern
// matches the palette and reads its rows instead of the picker's.
const RUN_TARGET_PLACEHOLDER = /Select the project, solution, or build output folder to run/;

/** The placeholder of the second prompt, which disambiguates `--project`. */
const PROJECT_PICKER_PLACEHOLDER = /Which project in .+ would you like to run\?/;

/** The placeholder of the With Options command's first build-settings prompt. */
const BUILD_CONFIG_PLACEHOLDER = /^Build configuration/;

/** The placeholder of the toggle prompt, which follows the build prompts. */
const RUN_OPTIONS_PLACEHOLDER = /^Select run options/;

/** The placeholder of the sub-prompt that picks which browse dialog to open. */
const BROWSE_KIND_PLACEHOLDER = /^What would you like to browse for\?$/;

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

/**
 * Cancel the open prompt and prove the flow actually stopped.
 *
 * A bare Escape asserts nothing: a command that swallowed the cancellation and
 * went on to invoke the CLI, or that left a prompt behind, would still pass.
 */
async function cancelAndExpectNoFollowUp(page: Page): Promise<void> {
    await page.keyboard.press('Escape');

    // The widget is reused rather than destroyed, so hidden is the signal.
    await expect(page.locator('.quick-input-widget')).toBeHidden({ timeout: 15_000 });

    // Nothing may replace it: no follow-up prompt, and no progress or error
    // toast from a run that should never have started.
    await page.waitForTimeout(1_500);
    await expect(page.locator('.quick-input-widget')).toBeHidden();
    await expect(page.locator('.notifications-toasts .notification-list-item')).toHaveCount(0);
    await expect(page.locator('.monaco-dialog-box')).toHaveCount(0);
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

            await cancelAndExpectNoFollowUp(page);
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

            await cancelAndExpectNoFollowUp(page);
            console.log('✅ PASS: library-only workspace falls through to build output');
        } finally {
            if (app) {
                await app.close().catch(() => {});
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('explains why an unbuilt native-only solution is not offered', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-target-unbuilt-native-e2e-'));
        fs.writeFileSync(path.join(tmpDir, 'App.sln'), [
            'Microsoft Visual Studio Solution File, Format Version 12.00',
            'Project("{BC8A1FFA-BEE3-4634-8014-F334798102B3}") = "App", "App\\App.vcxproj", "{11111111-1111-1111-1111-111111111111}"',
            'EndProject',
        ].join('\r\n'));

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCode(tmpDir);
            app = launched.app;
            const page = launched.page;

            await runCommandPalette(page, 'WinApp: Run Application With Options');

            const warning = page
                .locator('.notifications-toasts .notification-list-item')
                .filter({ hasText: 'Solutions were found' });
            await expect(warning).toHaveCount(1);
            await expect(warning).toContainText('Solutions were found');
            await expect(warning).toContainText('Build the app first');
            await expect(warning).not.toContainText('No projects, solutions');

            const browseRows = (await readPickerRows(page, BROWSE_KIND_PLACEHOLDER)).join('\n');
            expect(browseRows).toContain('Project or solution file');
            expect(browseRows).toContain('Project directory or build output folder');

            await page.keyboard.press('Escape');
            await expect(page.locator('.quick-input-widget')).toBeHidden();
            await expect(page.locator('.monaco-dialog-box')).toHaveCount(0);
            console.log('✅ PASS: unbuilt native-only solution showed an accurate build-first warning');
        } finally {
            if (app) {
                await app.close().catch(() => {});
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // CLI v0.7.1 cannot build a .vcxproj through solution mode. Keeping the
    // solution would auto-select an input that always fails and hide the
    // folder-mode path the released extension used for native apps.
    test('falls back to native build output when a solution has no supported members', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-target-native-e2e-'));
        fs.writeFileSync(path.join(tmpDir, 'App.sln'), [
            'Microsoft Visual Studio Solution File, Format Version 12.00',
            'Project("{BC8A1FFA-BEE3-4634-8014-F334798102B3}") = "App", "App\\App.vcxproj", "{11111111-1111-1111-1111-111111111111}"',
            'EndProject',
        ].join('\r\n'));

        const appOutput = path.join(tmpDir, 'x64', 'Debug', 'App');
        fs.mkdirSync(appOutput, { recursive: true });
        fs.writeFileSync(path.join(appOutput, 'App.exe'), '');

        // Keep the fallback picker visible so the selected candidate can be
        // asserted instead of immediately dispatching a fake executable.
        const toolOutput = path.join(tmpDir, 'x64', 'Debug', 'Tool');
        fs.mkdirSync(toolOutput, { recursive: true });
        fs.writeFileSync(path.join(toolOutput, 'Tool.exe'), '');

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCode(tmpDir);
            app = launched.app;
            const page = launched.page;

            await runCommandPalette(page, 'WinApp: Run Application With Options');

            const joined = (await readRunTargetPicker(page)).join('\n');
            expect(joined).not.toContain('App.sln');
            expect(joined).toContain(path.join('x64', 'Debug', 'App'));

            await cancelAndExpectNoFollowUp(page);
            console.log('✅ PASS: native-only solution fell through to build output');
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

            await cancelAndExpectNoFollowUp(page);
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

            await cancelAndExpectNoFollowUp(page);
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

            await cancelAndExpectNoFollowUp(page);
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

            await cancelAndExpectNoFollowUp(page);
            console.log('✅ PASS: single-app solution skipped the project prompt');
        } finally {
            if (app) {
                await app.close().catch(() => {});
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('keeps every project reachable by typing when many are found', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-target-cap-e2e-'));
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
            await readRunTargetPicker(page);

            // The 13th project sorts well past any short display cap, so it is
            // only reachable if every candidate was handed to the QuickPick:
            // VS Code filters over the items it was given, never re-queries.
            await page.keyboard.type('App12');
            await page.waitForTimeout(750);

            const filtered = await readRunTargetPicker(page);
            expect(filtered.join('\n')).toContain('App12.csproj');

            await cancelAndExpectNoFollowUp(page);
            console.log('✅ PASS: typing reached a project past the old display cap');
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

            await cancelAndExpectNoFollowUp(page);
            console.log('✅ PASS: both projects listed with a single browse entry');
        } finally {
            if (app) {
                await app.close().catch(() => {});
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('Browse opens a sub-prompt that chooses between a file and a folder dialog', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-target-browse-e2e-'));
        writeProject(tmpDir, path.join('AppOne', 'AppOne.csproj'));
        writeProject(tmpDir, path.join('AppTwo', 'AppTwo.csproj'));

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCode(tmpDir);
            app = launched.app;
            const page = launched.page;

            await runCommandPalette(page, 'WinApp: Run Application');
            await readRunTargetPicker(page);

            // The browse entry is last; ArrowUp from the first row wraps to it.
            await page.keyboard.press('ArrowUp');
            await page.waitForTimeout(500);
            await page.keyboard.press('Enter');

            const subRows = await readPickerRows(page, BROWSE_KIND_PLACEHOLDER);
            const joined = subRows.join('\n');

            // Both dialog kinds are reachable, and the folder entry names
            // project directories — the CLI accepts a directory containing a
            // project, not only a build-output folder.
            expect(joined).toContain('Project or solution file');
            expect(joined).toContain('Project directory or build output folder');

            // Escaping the sub-prompt must unwind the whole flow without
            // opening a native dialog or invoking the CLI.
            await cancelAndExpectNoFollowUp(page);
            await page.waitForTimeout(1_000);
            await expect(page.locator('.quick-input-widget')).toBeHidden({ timeout: 10_000 });

            console.log('✅ PASS: Browse sub-prompt offers both dialog kinds and cancels cleanly');
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

            await cancelAndExpectNoFollowUp(page);
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

            await cancelAndExpectNoFollowUp(page);
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

            await cancelAndExpectNoFollowUp(page);
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

            await cancelAndExpectNoFollowUp(page);
            console.log('✅ PASS: F5 without input prompted for a run target');
        } finally {
            if (app) {
                await app.close().catch(() => {});
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
    // Build settings are MSBuild concepts. A build output folder is already
    // built, so offering a configuration or architecture there would collect
    // answers the CLI must then ignore.
    test('With Options skips the build prompts in folder mode', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-target-folder-options-e2e-'));
        // No project anywhere, so the only candidate is the output folder.
        const outputDir = path.join(tmpDir, 'bin', 'Debug');
        fs.mkdirSync(outputDir, { recursive: true });
        fs.writeFileSync(path.join(outputDir, 'OnlyApp.exe'), '');

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCode(tmpDir);
            app = launched.app;
            const page = launched.page;

            await runCommandPalette(page, 'WinApp: Run Application With Options');

            // Landing straight on the toggle prompt proves both build prompts
            // were skipped: it is what normally follows them.
            const rows = await readPickerRows(page, RUN_OPTIONS_PLACEHOLDER);
            const text = rows.join('\n');
            expect(text).toContain('Clean application data');
            // Project-only toggles must be gated out of folder mode too.
            expect(text).not.toContain('Skip build');
            expect(text).not.toContain('Skip restore');

            await cancelAndExpectNoFollowUp(page);
            console.log('✅ PASS: folder mode skipped the build prompts');
        } finally {
            if (app) {
                await app.close().catch(() => {});
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // --symbols does nothing without --debug-output. Ticking the prerequisite
    // in place beats silently dropping the flag or warning about a choice the
    // user already made.
    test('checking Download symbols also checks Capture debug output', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-target-implies-e2e-'));
        const outputDir = path.join(tmpDir, 'bin', 'Debug');
        fs.mkdirSync(outputDir, { recursive: true });
        fs.writeFileSync(path.join(outputDir, 'OnlyApp.exe'), '');

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCode(tmpDir);
            app = launched.app;
            const page = launched.page;

            await runCommandPalette(page, 'WinApp: Run Application With Options');
            await readPickerRows(page, RUN_OPTIONS_PLACEHOLDER);

            // Anchored: the symbols detail line mentions the other label.
            const symbols = quickPickRows(page).filter({ hasText: /^Download symbols/ });
            const debugOutput = quickPickRows(page).filter({ hasText: /^Capture debug output/ });

            // Nothing is checked until the user checks something.
            await expectChecked(debugOutput, false);

            await symbols.click();

            await expectChecked(symbols, true);
            await expectChecked(debugOutput, true);

            // The implication is one-way: the prerequisite stands on its own.
            await symbols.click();
            await expectChecked(symbols, false);
            await expectChecked(debugOutput, true);

            await cancelAndExpectNoFollowUp(page);
            console.log('✅ PASS: Download symbols implied Capture debug output');
        } finally {
            if (app) {
                await app.close().catch(() => {});
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('project packaging collects architectures, configuration, and signing', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-project-options-e2e-'));
        writeProject(tmpDir, path.join('App', 'App.csproj'));

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCode(tmpDir);
            app = launched.app;
            const page = launched.page;

            await runCommandPalette(page, 'WinApp: Create MSIX Package or Bundle');

            const sources = (await readPickerRows(page, /^What would you like to package\?$/)).join('\n');
            expect(sources).toContain('Build and package a .NET project');
            expect(sources).toContain('Package existing build output');
            await quickPickRows(page).filter({ hasText: /Build and package a \.NET project/ }).click();

            await readPickerRows(page, /^Select target architecture/);
            const current = os.arch() === 'arm64' ? 'arm64' : os.arch() === 'ia32' ? 'x86' : 'x64';
            const second = current === 'x64' ? 'arm64' : 'x64';
            await expectChecked(quickPickRows(page).filter({ hasText: new RegExp(`^${current}`) }), true);
            await quickPickRows(page).filter({ hasText: new RegExp(`^${second}`) }).click();
            await page.keyboard.press('Enter');

            const configurations = (await readPickerRows(page, /^Build configuration/)).join('\n');
            expect(configurations).toContain('Default');
            expect(configurations).toContain('Release');
            await quickPickRows(page).filter({ hasText: /^Debug/ }).click();

            const signing = (await readPickerRows(page, /^How should the package be signed\?$/)).join('\n');
            expect(signing).toContain('Use project signing settings');
            expect(signing).toContain('Generate and install a development certificate');
            expect(signing).toContain('Create an unsigned package');
            await quickPickRows(page).filter({ hasText: /^Create an unsigned package/ }).click();

            const selfContained = (await readPickerRows(page, /self-contained/)).join('\n');
            expect(selfContained).toContain('Yes');
            expect(selfContained).toContain('No');

            await cancelAndExpectNoFollowUp(page);
            console.log('✅ PASS: project pack flow collected project-specific options');
        } finally {
            if (app) {
                await app.close().catch(() => {});
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('project packaging resolves a solution to one concrete project', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-solution-project-e2e-'));
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

            await runCommandPalette(page, 'WinApp: Create MSIX Package or Bundle');
            await readPickerRows(page, /^What would you like to package\?$/);
            await quickPickRows(page).filter({ hasText: /Build and package a \.NET project/ }).click();

            const projects = (
                await readPickerRows(page, /Which project in MySln\.sln would you like to package\?/)
            ).join('\n');
            expect(projects).toContain('Alpha.csproj');
            expect(projects).toContain('Beta.csproj');
            await quickPickRows(page).filter({ hasText: /Alpha\.csproj/ }).click();

            // Pack cannot pass the solution through to the CLI. Reaching the
            // architecture prompt proves the chosen member became the input.
            await readPickerRows(page, /^Select target architecture/);
            await cancelAndExpectNoFollowUp(page);
            console.log('✅ PASS: pack solution resolved to an explicit project choice');
        } finally {
            if (app) {
                await app.close().catch(() => {});
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('existing-output packaging keeps multi-folder bundle selection', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-folder-bundle-e2e-'));
        const x64 = path.join(tmpDir, 'publish', 'x64');
        const arm64 = path.join(tmpDir, 'publish', 'arm64');
        fs.mkdirSync(x64, { recursive: true });
        fs.mkdirSync(arm64, { recursive: true });
        fs.writeFileSync(path.join(x64, 'App.exe'), '');
        fs.writeFileSync(path.join(arm64, 'App.exe'), '');

        let app: ElectronApplication | undefined;
        try {
            const launched = await launchVSCode(tmpDir);
            app = launched.app;
            const page = launched.page;

            await runCommandPalette(page, 'WinApp: Create MSIX Package or Bundle');
            await readPickerRows(page, /^What would you like to package\?$/);
            await quickPickRows(page).filter({ hasText: /Package existing build output/ }).click();

            const folders = (
                await readPickerRows(page, /^Select build output folder\(s\)/)
            ).join('\n');
            expect(folders).toContain(path.join('publish', 'x64'));
            expect(folders).toContain(path.join('publish', 'arm64'));

            await quickPickRows(page).filter({ hasText: /publish[\\/]x64/ }).click();
            await quickPickRows(page).filter({ hasText: /publish[\\/]arm64/ }).click();
            await page.keyboard.press('Enter');

            await readPickerRows(page, /^Generate and install a development certificate\?$/);
            await quickPickRows(page).filter({ hasText: /^No/ }).click();

            await readPickerRows(page, /runtime into each package/);
            await cancelAndExpectNoFollowUp(page);
            console.log('✅ PASS: existing-output pack flow retained multi-folder bundles');
        } finally {
            if (app) {
                await app.close().catch(() => {});
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});