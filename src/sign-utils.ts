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
