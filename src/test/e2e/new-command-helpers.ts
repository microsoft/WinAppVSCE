/**
 * Shared fixtures for the two `winapp.new` E2E specs: template-pack detection
 * and temp directories. Not a spec itself — the Playwright default testMatch
 * only collects `*.spec.ts` / `*.test.ts`.
 */

import { execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { getWinappCliPath } from '../../winapp-cli-utils';

export const EXTENSION_ROOT = path.resolve(__dirname, '..', '..', '..');
export const CLI_PATH = getWinappCliPath(EXTENSION_ROOT);

/**
 * Whether a WinUI template pack is already installed. `--template-version
 * installed` is a purely local query. Run from temp so a repo `global.json`
 * can't make a present SDK look missing.
 */
export function hasInstalledTemplatePack(): boolean {
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

/** Temp directories to remove once the spec that made them finishes. */
const pendingDirectories = new Set<string>();

/**
 * Create a temp directory swept up by {@link cleanupTempDirectories}. Deferred
 * rather than per-test because VS Code can hold a handle on the workspace for a
 * moment after the Electron app closes, which makes an immediate delete fail.
 */
export function makeTempDirectory(prefix: string): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    pendingDirectories.add(directory);
    return directory;
}

/** Remove every directory handed out by {@link makeTempDirectory}. */
export function cleanupTempDirectories(): void {
    for (const directory of pendingDirectories) {
        try {
            fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch {
            // A leftover temp directory must never fail an otherwise green run.
        }
    }
    pendingDirectories.clear();
}
