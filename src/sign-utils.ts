import * as fs from 'node:fs';
import * as path from 'node:path';
import { escapePowerShellArg } from './winapp-cli-utils';
import { ARTIFACT_GLOBS } from './artifact-types';

/** Glob patterns for PFX certificate files within a workspace. */
export const CERTIFICATE_GLOBS = ['**/*.pfx'];

/** Glob patterns for executable files that can be signed. */
export const EXECUTABLE_GLOBS = ['**/*.exe', '**/*.dll'];

const SIGNABLE_ARTIFACT_IGNORES = new Set(['node_modules', '.git']);

export type WorkspaceFileFinder = (
	includePattern: string,
	signal?: AbortSignal
) => Promise<string[]>;

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
	findFiles: WorkspaceFileFinder,
	patterns: string[] = ARTIFACT_GLOBS,
	signal?: AbortSignal
): Promise<string[]> {
	if (signal?.aborted) {
		return [];
	}

	const includePattern = patterns.length === 1 ? patterns[0] : `{${patterns.join(',')}}`;
	let results: string[];
	try {
		results = await findFiles(includePattern, signal);
	} catch (error) {
		if (signal?.aborted && isCancellationError(error)) {
			return [];
		}
		throw error;
	}

	// Sort by mtime descending (newest first); if stat fails, push to end.
	const withStats: Array<{ path: string; mtime: number }> = [];
	for (const filePath of results) {
		if (signal?.aborted) {
			return [];
		}
		if (isIgnoredWorkspacePath(workspacePath, filePath)) {
			continue;
		}
		try {
			const stat = await fs.promises.stat(filePath);
			withStats.push({ path: filePath, mtime: stat.mtimeMs });
		} catch {
			withStats.push({ path: filePath, mtime: 0 });
		}
	}

	withStats.sort((a, b) => b.mtime - a.mtime);
	return withStats.map((s) => s.path);
}

function isIgnoredWorkspacePath(workspacePath: string, filePath: string): boolean {
	return path.relative(workspacePath, filePath)
		.split(path.sep)
		.some(segment => SIGNABLE_ARTIFACT_IGNORES.has(
			process.platform === 'win32' ? segment.toLowerCase() : segment
		));
}

function isCancellationError(error: unknown): boolean {
	if (typeof error !== 'object' || error === null || !('name' in error)) {
		return false;
	}
	const name = (error as { name?: unknown }).name;
	return name === 'AbortError' || name === 'Canceled' || name === 'CancellationError';
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
