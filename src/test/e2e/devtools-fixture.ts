/**
 * Build + workspace helpers for the DevTools E2E spec.
 *
 * The DevTools panel can only be reached through a real debug launch, so this
 * spec needs an actual WinUI app rather than a manifest fixture. The app source
 * lives in `src/test/fixtures/devtools-app` and is built on demand here — the
 * binaries are deliberately not committed.
 *
 * The launch uses `noDebug`, so no language-debugger extension (C# Dev Kit) is
 * required. That is what makes this spec runnable on a clean machine.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Source directory of the committed WinUI fixture app. */
export const FIXTURE_APP_DIR = path.resolve(__dirname, '..', 'fixtures', 'devtools-app');

const FIXTURE_EXE = 'DevToolsFixtureApp.exe';

/**
 * Locates the fixture's build output directory.
 *
 * The target framework and runtime identifier are both machine-dependent (the
 * csproj derives the RID from the host architecture), so the directory is found
 * by searching for the produced executable rather than hard-coded.
 */
function findBuildOutput(): string | undefined {
    const binDir = path.join(FIXTURE_APP_DIR, 'bin', 'Debug');
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
            if (entry.isDirectory()) {
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
    const result = spawnSync('dotnet', ['build', '-c', 'Debug'], {
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
            `The fixture app built but ${FIXTURE_EXE} was not found under bin/Debug.`,
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
export function createDevToolsWorkspace(inputFolder: string): string {
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
                    useDevTools: true,
                },
            ],
        }, null, 2),
    );

    return tmpDir;
}

/** Image names the fixture launch is responsible for: the app and the CLI host. */
const OWNED_IMAGES = ['DevToolsFixtureApp.exe', 'winapp.exe'];

/** Process IDs currently running for the images this fixture launches. */
export function snapshotOwnedPids(): Set<number> {
    const pids = new Set<number>();
    for (const image of OWNED_IMAGES) {
        const result = spawnSync(
            'tasklist',
            ['/FI', `"IMAGENAME eq ${image}"`, '/NH', '/FO', 'CSV'],
            { encoding: 'utf-8', shell: true },
        );
        for (const line of (result.stdout ?? '').split('\n')) {
            // CSV rows look like: "winapp.exe","1234","Console","1","12,345 K"
            const match = /^"[^"]+","(\d+)"/.exec(line.trim());
            if (match) {
                pids.add(Number(match[1]));
            }
        }
    }
    return pids;
}

/**
 * Kills app/CLI processes that appeared after `before` was taken.
 *
 * Stopping the debug session should do this, but it is not reliable while VS
 * Code is shutting down — and a leaked process holds its DevTools named pipe,
 * which makes the *next* run fail to open the panel at all. Only processes
 * started after the snapshot are touched, so a developer's own `winapp` session
 * running alongside the test is never killed.
 */
export function killProcessesStartedSince(before: Set<number>): number[] {
    const killed: number[] = [];
    for (const pid of snapshotOwnedPids()) {
        if (before.has(pid)) {
            continue;
        }
        try {
            process.kill(pid);
            killed.push(pid);
        } catch {
            // Already gone — the session tore down cleanly.
        }
    }
    return killed;
}

/**
 * Sweeps repeatedly, because a process can still be starting when the first
 * sweep runs and would otherwise be missed and leak into the next run.
 */
export async function killProcessesStartedSinceWithRetry(
    before: Set<number>,
    attempts = 4,
    delayMs = 2_000,
): Promise<number[]> {
    const killed: number[] = [];
    for (let i = 0; i < attempts; i++) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
        killed.push(...killProcessesStartedSince(before));
    }
    return killed;
}
