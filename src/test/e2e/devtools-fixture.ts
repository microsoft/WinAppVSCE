/**
 * Build + workspace helpers for the DevTools E2E spec.
 *
 * The DevTools panel can only be reached through a real debug launch, so this
 * spec needs an actual WinUI app rather than a manifest fixture. It uses the shared
 * WinUI fixture in `test/fixtures/xaml/fixture`, built on demand here and launched
 * with `--devtools-page` so it opens on DevToolsPage.xaml.
 *
 * The launch uses `noDebug`, so no language-debugger extension (C# Dev Kit) is
 * required. That is what makes this spec runnable on a clean machine.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Source directory of the committed WinUI fixture app. */
export const FIXTURE_APP_DIR = path.resolve(__dirname, '..', '..', '..', 'test', 'fixtures', 'xaml', 'fixture');

const FIXTURE_EXE = 'SmokeFixture.exe';
const FIXTURE_RID = process.arch === 'arm64' ? 'win-arm64' : 'win-x64';

/** Repository root, three levels up from src/test/e2e. */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * Whether the winapp CLI in bin/ supports `winapp run --devtools <mode>`.
 *
 * DevTools is not in a stable CLI release yet, so CI downloads a build without
 * it and every DevTools launch fails with "Unrecognized argument: '--devtools'".
 * Probing lets those specs skip cleanly instead of reporting a product failure,
 * and they start running automatically once a CLI that supports it ships.
 *
 * The mode is part of the test: `--devtools` was a bare flag in earlier builds
 * of the feature branch, and we no longer support that form. Matching the bare
 * flag would let such a build start the suite and then fail at launch.
 */
/** Path to the winapp CLI staged in bin/ for this machine's architecture. */
function cliPath(): string {
    const arch = process.arch === 'arm64' ? 'win-arm64' : 'win-x64';
    return path.join(REPO_ROOT, 'bin', arch, 'winapp.exe');
}

export function cliSupportsDevTools(): boolean {
    const cli = cliPath();
    if (!fs.existsSync(cli)) {
        return false;
    }

    const help = spawnSync(cli, ['run', '--help'], {
        encoding: 'utf-8',
        timeout: 60_000,
    });
    return /--devtools\s*<[^>]*\bon\b[^>]*>/.test(help.stdout ?? '');
}

/** The overlay state the engine reports, as returned by `Overlay.getState`. */
export interface OverlayState {
    toolbarVisible: boolean;
    highlightHandle: string;
    layoutAdornersOn: boolean;
    revision: number;
}

/**
 * Asks the running fixture app's DevTools engine what the overlay is doing.
 *
 * Deliberately routed through the CLI rather than the panel: the panel is the
 * thing under test, so asking it to report its own effect would prove nothing.
 * This is a second, independent client of the same engine.
 *
 * Returns undefined when the app is not running or the call fails, so callers
 * can poll rather than crash on a race with app startup.
 */
export function readOverlayState(): OverlayState | undefined {
    const result = spawnSync(
        cliPath(),
        ['devtools', 'call', 'Overlay.getState', '-a', path.parse(FIXTURE_EXE).name, '--json'],
        { encoding: 'utf-8', timeout: 60_000 },
    );

    if (result.status !== 0 || !result.stdout) {
        return undefined;
    }

    try {
        // The CLI wraps protocol results in its own envelope on some commands,
        // so accept either the bare result or a { result: ... } wrapper.
        const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
        const state = (parsed.result ?? parsed) as Partial<OverlayState>;
        return typeof state.toolbarVisible === 'boolean' ? (state as OverlayState) : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Locates the fixture's build output directory.
 *
 * The target framework and runtime identifier are both machine-dependent (the
 * csproj derives the RID from the host architecture), so the directory is found
 * by searching for the produced executable rather than hard-coded.
 */
function findBuildOutput(): string | undefined {
    const binDir = path.join(FIXTURE_APP_DIR, 'bin');
    if (!fs.existsSync(binDir)) {
        return undefined;
    }

    const stack = [binDir];
    while (stack.length > 0) {
        const dir = stack.pop()!;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (entry.isFile() && entry.name === FIXTURE_EXE) {
                return dir;
            }
            // AppX is the CLI's staged copy of the build output, not the output itself.
            if (entry.isDirectory() && entry.name !== 'AppX') {
                stack.push(path.join(dir, entry.name));
            }
        }
    }
    return undefined;
}

/**
 * Builds the fixture app if it is not already built, and returns the folder
 * holding the produced binaries — the value the launch config's `inputFolder`
 * needs.
 *
 * Reuses an existing build so a local re-run costs nothing; CI pays the restore
 * and build once. Throws with the build output on failure so a broken fixture
 * reports the compiler error instead of a bare timeout later in the spec.
 */
export function ensureFixtureAppBuilt(): string {
    const existing = findBuildOutput();
    if (existing) {
        return existing;
    }

    // No --source / --registry: the machine's configured feeds must be used.
    const result = spawnSync('dotnet', ['build', '-c', 'Debug', '-r', FIXTURE_RID], {
        cwd: FIXTURE_APP_DIR,
        encoding: 'utf-8',
        shell: true,
        timeout: 15 * 60_000,
    });

    if (result.status !== 0) {
        throw new Error(
            `Failed to build the DevTools fixture app.\n` +
            `stdout:\n${result.stdout ?? ''}\nstderr:\n${result.stderr ?? ''}`,
        );
    }

    const built = findBuildOutput();
    if (!built) {
        throw new Error(
            `The fixture app built but ${FIXTURE_EXE} was not found under bin.`,
        );
    }
    return built;
}

/**
 * Creates a throwaway workspace whose launch.json points at the built fixture.
 *
 * The workspace is intentionally *not* the fixture directory: writing a
 * .vscode/launch.json into a committed fixture would dirty the repo on every
 * run. `inputFolder` is absolute, so the workspace itself can be empty.
 */
export function createDevToolsWorkspace(inputFolder: string, options: { headless?: boolean } = {}): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtools-e2e-'));
    const vscodeDir = path.join(tmpDir, '.vscode');
    fs.mkdirSync(vscodeDir, { recursive: true });

    fs.writeFileSync(
        path.join(vscodeDir, 'launch.json'),
        JSON.stringify({
            version: '0.2.0',
            configurations: [
                {
                    type: 'winapp',
                    request: 'launch',
                    name: 'DevTools E2E',
                    inputFolder,
                    // Skips the debugger-extension requirement entirely, so this
                    // spec does not depend on C# Dev Kit being installed.
                    noDebug: true,
                    devTools: options.headless ? 'headless' : 'on',
                    args: '--devtools-page',
                    unregisterOnExit: true,
                },
            ],
        }, null, 2),
    );

    return tmpDir;
}
