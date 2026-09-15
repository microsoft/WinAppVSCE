/**
 * Scaffold integration tests for `winapp.new`, covering the half the QuickPick
 * spec can't reach past the native folder dialog: `buildNewArgs` -> real CLI ->
 * `parseScaffoldResult`, then the files on disk. Skips unless a pack installed.
 */

import { test, expect } from '@playwright/test';
import { execFile, execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { promisify } from 'util';
import { getWinappCliPath } from '../../winapp-cli-utils';
import { buildNewArgs, parseScaffoldResult, isNonEmptyOutputFailure, NEW_EXIT } from '../../new-command-utils';

const execFileAsync = promisify(execFile);

const EXTENSION_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI_PATH = getWinappCliPath(EXTENSION_ROOT);

/** A real scaffold runs `dotnet new` plus a NuGet restore. */
const SCAFFOLD_TIMEOUT = 300_000;

/**
 * Whether a WinUI template pack is already installed. `--template-version
 * installed` is a purely local query. Run from temp so a repo `global.json`
 * can't make a present SDK look missing.
 */
function hasInstalledTemplatePack(): boolean {
    try {
        const output = execFileSync(
            CLI_PATH,
            ['new', '--list', '--json', '--template-version', 'installed'],
            { cwd: os.tmpdir(), encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }
        );
        return /"Listed"\s*:\s*true/.test(output);
    } catch {
        // Non-zero exit means no pack (or no SDK) — either way, don't install one.
        return false;
    }
}

/** Temp directories to remove once the whole spec finishes. */
const pendingDirectories = new Set<string>();

function makeTempDirectory(prefix: string): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    pendingDirectories.add(directory);
    return directory;
}

test.afterAll(() => {
    for (const directory of pendingDirectories) {
        try {
            fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch {
            // A leftover temp directory must never fail an otherwise green run.
        }
    }
    pendingDirectories.clear();
});

/** Every file under `root`, as paths relative to it. */
function listFilesRecursively(root: string): string[] {
    const found: string[] = [];
    const walk = (directory: string) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else {
                found.push(path.relative(root, full));
            }
        }
    };
    walk(root);
    return found;
}

/**
 * Compare two Windows paths for identity. `os.tmpdir()` reports the 8.3 short
 * form while the CLI reports the long form, and `path.resolve` won't reconcile
 * them — `realpathSync` does.
 */
function canonicalize(target: string): string {
    return fs.realpathSync.native(path.resolve(target)).toLowerCase();
}

/**
 * Run a scaffold exactly as the command handler does: args from `buildNewArgs`,
 * cwd the chosen parent, pack pinned to `installed` so the run never reaches a
 * feed or changes which pack is on the machine.
 */
async function runScaffold(
    parentDirectory: string,
    options: { template: string; name: string; output: string; force?: boolean }
): Promise<{ code: number; output: string }> {
    const args = buildNewArgs({ ...options, templateVersion: 'installed' });
    try {
        const { stdout, stderr } = await execFileAsync(CLI_PATH, args, {
            cwd: parentDirectory,
            encoding: 'utf8',
            timeout: SCAFFOLD_TIMEOUT,
            maxBuffer: 10 * 1024 * 1024
        });
        return { code: 0, output: `${stdout}${stderr}` };
    } catch (error) {
        const failure = error as { code?: number; stdout?: string; stderr?: string };
        return {
            code: typeof failure.code === 'number' ? failure.code : -1,
            output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`
        };
    }
}

test.describe('winapp.new command — scaffolding', () => {
    test.describe.configure({ timeout: SCAFFOLD_TIMEOUT + 60_000 });

    test.skip(
        () => !hasInstalledTemplatePack(),
        'No WinUI template pack installed; skipping rather than installing one machine-wide.'
    );

    test('scaffolds a WinUI app and writes a real project to disk', async () => {
        const parentDirectory = makeTempDirectory('winapp-scaffold-e2e-');
        const projectName = 'ScaffoldTestApp';
        const outputDirectory = path.join(parentDirectory, projectName);

        const result = await runScaffold(parentDirectory, {
            template: 'winui',
            name: projectName,
            output: outputDirectory
        });

        expect(result.code).toBe(NEW_EXIT.success);

        // The handler treats the parsed payload as the source of truth, so the
        // payload has to be readable and self-consistent before anything else.
        const scaffold = parseScaffoldResult(result.output);
        expect(scaffold, 'scaffold payload should be parseable').toBeDefined();
        expect(scaffold!.created).toBe(true);
        expect(scaffold!.error).toBeUndefined();
        expect(scaffold!.name).toBe(projectName);
        expect(scaffold!.template).toBe('winui');
        // The handler falls back to its own path when this is absent, so pin it.
        expect(scaffold!.projectPath).toBeTruthy();
        expect(canonicalize(scaffold!.projectPath!)).toBe(canonicalize(outputDirectory));

        // Now the part the user actually cares about: real files.
        expect(fs.existsSync(outputDirectory)).toBe(true);
        const files = listFilesRecursively(outputDirectory);

        // The template nests the project in a subdirectory rather than writing it
        // flat into the output folder, so match on basenames instead of assuming
        // a layout that is the template's to change.
        const basenames = files.map((file) => path.basename(file));
        expect(basenames).toContain(`${projectName}.csproj`);
        expect(basenames).toContain('App.xaml');
        expect(basenames).toContain('App.xaml.cs');
        expect(basenames).toContain('MainWindow.xaml');
        expect(basenames).toContain('Package.appxmanifest');

        // The project must be named after the user's input, not the template.
        const csprojPath = path.join(
            outputDirectory,
            files.find((file) => path.basename(file) === `${projectName}.csproj`)!
        );
        const csproj = fs.readFileSync(csprojPath, 'utf8');
        expect(csproj).toContain('<UseWinUI>true</UseWinUI>');

        // The manifest the extension's own editor later opens must be valid XML
        // and carry the chosen name, not the template's placeholder.
        const manifestPath = path.join(
            outputDirectory,
            files.find((file) => path.basename(file) === 'Package.appxmanifest')!
        );
        const manifest = fs.readFileSync(manifestPath, 'utf8');
        expect(manifest).toContain('<Package');
        expect(manifest).toContain(projectName);
    });

    test('refuses to scaffold over an existing project without --force', async () => {
        // Pins the CLI contract the --force retry offer is built on: an explicit
        // --name fails with "invalid args" rather than overwriting. If that ever
        // became a silent overwrite, the extension would destroy user files.
        const parentDirectory = makeTempDirectory('winapp-scaffold-e2e-');
        const projectName = 'CollisionApp';
        const outputDirectory = path.join(parentDirectory, projectName);

        // A non-empty target directory that this run did not create.
        fs.mkdirSync(outputDirectory, { recursive: true });
        const sentinelPath = path.join(outputDirectory, 'DO-NOT-DELETE.txt');
        const sentinelText = 'pre-existing user content';
        fs.writeFileSync(sentinelPath, sentinelText, 'utf8');

        const result = await runScaffold(parentDirectory, {
            template: 'winui',
            name: projectName,
            output: outputDirectory
        });

        expect(result.code).toBe(NEW_EXIT.invalidArgs);

        const scaffold = parseScaffoldResult(result.output);
        expect(scaffold?.created).not.toBe(true);

        // The extension offers a --force retry based on this failure, so pin the
        // match against real CLI output rather than a hand-written fixture.
        expect(isNonEmptyOutputFailure(result.code, scaffold)).toBe(true);

        // The user's file must still be there, untouched.
        expect(fs.existsSync(sentinelPath)).toBe(true);
        expect(fs.readFileSync(sentinelPath, 'utf8')).toBe(sentinelText);
    });
});
