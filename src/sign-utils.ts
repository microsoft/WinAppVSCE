import * as fs from 'node:fs';
import { glob } from 'glob';
import { escapePowerShellArg } from './winapp-cli-utils';

/** Glob patterns for packaged MSIX/APPX artifacts within a workspace. */
export const SIGNABLE_ARTIFACT_GLOBS = ['**/*.msix', '**/*.msixbundle', '**/*.appx', '**/*.appxbundle'];

/** Glob patterns for PFX certificate files within a workspace. */
export const CERTIFICATE_GLOBS = ['**/*.pfx'];

const SIGNABLE_ARTIFACT_IGNORES = ['**/node_modules/**', '**/.git/**'];

/**
 * Build the CLI argument string for `winapp sign`.
 *
 * The CLI expects positional arguments: `sign <file-path> <cert-path>`.
 * Both paths are escaped for PowerShell.
 */
export function buildSignCommand(filePath: string, certPath: string): string {
	return `sign ${escapePowerShellArg(filePath)} ${escapePowerShellArg(certPath)}`;
}

/**
 * Find files matching the given glob patterns within a workspace root.
 *
 * Results are sorted by modification time (newest first) so the most recently
 * packaged artifact appears at the top of the QuickPick.
 */
export async function findWorkspaceArtifacts(
	workspacePath: string,
	patterns: string[] = SIGNABLE_ARTIFACT_GLOBS
): Promise<string[]> {
	const results: string[] = [];
	for (const pattern of patterns) {
		const matches = await glob(pattern, {
			cwd: workspacePath,
			absolute: true,
			nodir: true,
			ignore: SIGNABLE_ARTIFACT_IGNORES
		});
		results.push(...matches);
	}

	// Sort by mtime descending (newest first); if stat fails, push to end.
	const withStats = await Promise.all(
		results.map(async (p) => {
			try {
				const stat = await fs.promises.stat(p);
				return { path: p, mtime: stat.mtimeMs };
			} catch {
				return { path: p, mtime: 0 };
			}
		})
	);
	withStats.sort((a, b) => b.mtime - a.mtime);
	return withStats.map((s) => s.path);
}
