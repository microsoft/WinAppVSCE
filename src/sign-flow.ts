/**
 * Pure logic for the sign-package flow, extracted from extension.ts so it can
 * be unit-tested without VS Code API dependencies.
 *
 * The VS Code-facing wiring (QuickPick, file dialogs, terminal) remains in
 * extension.ts; this module owns only the decision logic and delegates UI
 * operations through an injectable adapter interface.
 */

import { buildSignCommand } from './sign-utils';

// ──────────────────────────────────────────────────────
// Adapter interface — implemented by extension.ts with real VS Code APIs,
// and by tests with stubs.
// ──────────────────────────────────────────────────────

export interface SignFlowAdapter {
	/** Show a QuickPick to let the user choose a signable artifact. */
	pickSignableFile(workspacePath: string): Promise<string | undefined>;

	/** Show a QuickPick to let the user choose a signing certificate. */
	pickCertificateFile(workspacePath: string): Promise<string | undefined>;

	/** Execute the sign CLI command. */
	runSignCommand(extensionPath: string, command: string, workspacePath: string): Promise<void>;
}

// ──────────────────────────────────────────────────────
// Sign flow
// ──────────────────────────────────────────────────────

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
