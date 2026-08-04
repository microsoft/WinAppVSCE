import * as fs from 'node:fs';
import { glob } from 'glob';
import { escapePowerShellArg } from './winapp-cli-utils';
import { ARTIFACT_GLOBS } from './artifact-types';
import {
	runWithCancellation,
	type CancellationResult,
	type CancellationTokenLike
} from './cancellation';

/** Glob patterns for PFX certificate files within a workspace. */
export const CERTIFICATE_GLOBS = ['**/*.pfx'];

/** Maximum number of discovered files shown in the sign QuickPick. */
export const SIGNABLE_FILE_MAX_RESULTS = 10;

const SIGNABLE_ARTIFACT_IGNORES = ['**/node_modules/**', '**/.git/**'];

export interface SignableFileGroups {
	packagePaths: string[];
	binaryPaths: string[];
}

export type RankBinaryPaths = (paths: string[], maxResults: number) => string[];

/**
 * Fill the remaining picker slots by merging bounded EXE and DLL candidates
 * and ranking them together.
 */
export async function discoverSignableFiles(
	packagePaths: string[],
	findExecutablePaths: (maxResults: number) => Promise<string[]>,
	findLibraryPaths: (maxResults: number) => Promise<string[]>,
	maxResults: number = SIGNABLE_FILE_MAX_RESULTS,
	rankBinaryPaths: RankBinaryPaths = (paths, limit) => paths.slice(0, limit),
	isCancelled: () => boolean = () => false
): Promise<SignableFileGroups> {
	const limitedPackages = packagePaths.slice(0, maxResults);
	const remainingSlots = Math.max(0, maxResults - limitedPackages.length);
	if (remainingSlots === 0 || isCancelled()) {
		return { packagePaths: limitedPackages, binaryPaths: [] };
	}

	const executablePaths = await findExecutablePaths(remainingSlots);
	if (isCancelled()) {
		return { packagePaths: limitedPackages, binaryPaths: [] };
	}
	const libraryPaths = await findLibraryPaths(remainingSlots);
	if (isCancelled()) {
		return { packagePaths: limitedPackages, binaryPaths: [] };
	}
	return {
		packagePaths: limitedPackages,
		binaryPaths: rankBinaryPaths([...executablePaths, ...libraryPaths], remainingSlots)
	};
}

/**
 * Runs package-first signable discovery while adapting cancellation for glob scanning.
 */
export function discoverSignableFilesWithCancellation(
	token: CancellationTokenLike,
	findPackagePaths: (signal: AbortSignal) => Promise<string[]>,
	findExecutablePaths: (maxResults: number) => Promise<string[]>,
	findLibraryPaths: (maxResults: number) => Promise<string[]>,
	rankBinaryPaths?: RankBinaryPaths
): Promise<CancellationResult<SignableFileGroups>> {
	return runWithCancellation(token, async signal => {
		const packagePaths = await findPackagePaths(signal);
		if (signal.aborted) {
			return { packagePaths: [], binaryPaths: [] };
		}
		return discoverSignableFiles(
			packagePaths,
			findExecutablePaths,
			findLibraryPaths,
			SIGNABLE_FILE_MAX_RESULTS,
			rankBinaryPaths,
			() => signal.aborted
		);
	});
}

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
	patterns: string[] = ARTIFACT_GLOBS,
	signal?: AbortSignal
): Promise<string[]> {
	const results: string[] = [];
	try {
		for (const pattern of patterns) {
			if (signal?.aborted) {
				return [];
			}
			const matches = await glob(pattern, {
				cwd: workspacePath,
				absolute: true,
				nodir: true,
				ignore: SIGNABLE_ARTIFACT_IGNORES,
				signal
			});
			if (signal?.aborted) {
				return [];
			}
			results.push(...matches);
		}
	} catch (error) {
		if (
			signal?.aborted
			&& typeof error === 'object'
			&& error !== null
			&& 'name' in error
			&& error.name === 'AbortError'
		) {
			return [];
		}
		throw error;
	}

	if (signal?.aborted) {
		return [];
	}

	// Sort by mtime descending (newest first); if stat fails, push to end.
	const withStats: Array<{ path: string; mtime: number }> = [];
	for (const resultPath of results) {
		if (signal?.aborted) {
			return [];
		}
		try {
			const stat = await fs.promises.stat(resultPath);
			withStats.push({ path: resultPath, mtime: stat.mtimeMs });
		} catch {
			withStats.push({ path: resultPath, mtime: 0 });
		}
	}
	if (signal?.aborted) {
		return [];
	}
	withStats.sort((a, b) => b.mtime - a.mtime);
	return withStats.map((s) => s.path);
}

// ──────────────────────────────────────────────────────
// Sign flow — adapter-based orchestration for testability.
// The VS Code-facing wiring (QuickPick, file dialogs, terminal) remains in
// extension.ts; this section owns only the decision logic and delegates UI
// operations through an injectable adapter interface.
// ──────────────────────────────────────────────────────

export interface SignFlowAdapter {
	/** Show a QuickPick to let the user choose a signable artifact. */
	pickSignableFile(workspacePath: string): Promise<string | undefined>;

	/** Show a QuickPick to let the user choose a signing certificate. */
	pickCertificateFile(workspacePath: string): Promise<string | undefined>;

	/** Execute the sign CLI command. */
	runSignCommand(extensionPath: string, command: string, workspacePath: string): Promise<void>;
}

export interface SignFlowResult {
	/** Whether the file picker was shown (false when prefilled path provided). */
	filePickerShown: boolean;
	/** Whether the certificate picker was shown. */
	certPickerShown: boolean;
	/** The CLI command string that was executed, if any. */
	commandExecuted: string | undefined;
	/** The file path that was signed, if any. */
	filePath: string | undefined;
	/** The certificate path used, if any. */
	certPath: string | undefined;
}

/**
 * Run the sign-package flow.
 *
 * When `prefilledFilePath` is provided (e.g. from the post-pack "Sign" action),
 * the file picker is skipped and the flow proceeds directly to the certificate
 * picker. When omitted, the full QuickPick discovery flow is used.
 *
 * @returns A result object describing what happened during the flow.
 */
export async function executeSignFlow(
	adapter: SignFlowAdapter,
	extensionPath: string,
	workspacePath: string,
	prefilledFilePath?: string
): Promise<SignFlowResult> {
	const result: SignFlowResult = {
		filePickerShown: false,
		certPickerShown: false,
		commandExecuted: undefined,
		filePath: undefined,
		certPath: undefined
	};

	let filePath = prefilledFilePath;
	if (!filePath) {
		result.filePickerShown = true;
		filePath = await adapter.pickSignableFile(workspacePath);
	}

	if (!filePath) {
		return result;
	}
	result.filePath = filePath;

	result.certPickerShown = true;
	const certPath = await adapter.pickCertificateFile(workspacePath);
	if (!certPath) {
		return result;
	}
	result.certPath = certPath;

	const command = buildSignCommand(filePath, certPath);
	result.commandExecuted = command;
	await adapter.runSignCommand(extensionPath, command, workspacePath);

	return result;
}
