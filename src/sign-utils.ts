import * as fs from 'node:fs';
import * as path from 'node:path';
import { escapePowerShellArg } from './winapp-cli-utils';
import { ARTIFACT_GLOBS } from './artifact-types';

/** Glob patterns for PFX certificate files within a workspace. */
export const CERTIFICATE_GLOBS = ['**/*.pfx'];

const WORKSPACE_ARTIFACT_EXCLUDED_DIRECTORIES = new Set(['node_modules', '.git']);
const STAT_BATCH_SIZE = 100;
export const WORKSPACE_ARTIFACT_MAX_RESULTS = 500;
export const WORKSPACE_ARTIFACT_QUICK_PICK_LIMIT = 100;
const WORKSPACE_ARTIFACT_DETECTION_LIMIT = WORKSPACE_ARTIFACT_MAX_RESULTS + 1;

export type WorkspaceFileFinder = (
	includePattern: string,
	signal: AbortSignal | undefined,
	maxResults: number
) => Promise<string[]>;

export interface CancellationTokenLike {
	readonly isCancellationRequested: boolean;
	onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface CancellableResult<T> {
	cancelled: boolean;
	value: T | undefined;
}

export interface CancellationSourceLike<TToken> {
	readonly token: TToken;
	cancel(): void;
	dispose(): void;
}

export interface WorkspaceArtifactDiscovery {
	paths: string[];
	/** The source search returned more than the 500 candidates inspected. */
	sourceTruncated: boolean;
	/** More than 100 valid candidates remained after post-filtering. */
	displayTruncated: boolean;
}

export async function runWithCancellationSource<TToken, TResult>(
	signal: AbortSignal | undefined,
	createSource: () => CancellationSourceLike<TToken>,
	operation: (token: TToken) => Promise<TResult>
): Promise<TResult> {
	const source = createSource();
	const abort = () => source.cancel();
	let listenerInstalled = false;
	if (signal?.aborted) {
		abort();
	} else {
		signal?.addEventListener('abort', abort, { once: true });
		listenerInstalled = signal !== undefined;
	}

	try {
		return await operation(source.token);
	} finally {
		if (listenerInstalled) {
			signal?.removeEventListener('abort', abort);
		}
		source.dispose();
	}
}

export async function runWithCancellation<T>(
	token: CancellationTokenLike,
	operation: (signal: AbortSignal) => Promise<T>
): Promise<CancellableResult<T>> {
	const abortController = new AbortController();
	let cancelled = false;
	const cancellation = token.onCancellationRequested(() => {
		cancelled = true;
		abortController.abort();
	});

	try {
		if (token.isCancellationRequested) {
			cancelled = true;
			abortController.abort();
		}
		if (cancelled) {
			return { cancelled: true, value: undefined };
		}
		const value = await operation(abortController.signal);
		return { cancelled, value };
	} finally {
		cancellation.dispose();
	}
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
 * Up to 500 source candidates are sorted by modification time (newest first).
 * Truncation metadata distinguishes an incomplete source search from files
 * omitted only from the QuickPick.
 */
export async function findWorkspaceArtifacts(
	workspacePath: string,
	findFiles: WorkspaceFileFinder,
	patterns: string[] = ARTIFACT_GLOBS,
	signal?: AbortSignal
): Promise<WorkspaceArtifactDiscovery> {
	if (signal?.aborted) {
		return { paths: [], sourceTruncated: false, displayTruncated: false };
	}

	const includePattern = patterns.length === 1
		? patterns[0]
		: `{${patterns.join(',')}}`;

	let results: string[];
	try {
		results = await findFiles(includePattern, signal, WORKSPACE_ARTIFACT_DETECTION_LIMIT);
	} catch (error) {
		if (signal?.aborted && isAbortError(error)) {
			return { paths: [], sourceTruncated: false, displayTruncated: false };
		}
		throw error;
	}

	if (signal?.aborted) {
		return { paths: [], sourceTruncated: false, displayTruncated: false };
	}
	const sourceTruncated = results.length > WORKSPACE_ARTIFACT_MAX_RESULTS;
	results = results.slice(0, WORKSPACE_ARTIFACT_MAX_RESULTS);
	results = results.filter(filePath => !isExcludedWorkspacePath(workspacePath, filePath));
	const displayTruncated = results.length > WORKSPACE_ARTIFACT_QUICK_PICK_LIMIT;

	// Sort by mtime descending (newest first); if stat fails, push to end.
	const withStats: Array<{ path: string; mtime: number }> = [];
	for (let index = 0; index < results.length; index += STAT_BATCH_SIZE) {
		if (signal?.aborted) {
			return { paths: [], sourceTruncated: false, displayTruncated: false };
		}
		const batch = await Promise.all(
			results.slice(index, index + STAT_BATCH_SIZE).map(async (p) => {
				try {
					const stat = await fs.promises.stat(p);
					return { path: p, mtime: stat.mtimeMs };
				} catch {
					return { path: p, mtime: 0 };
				}
			})
		);
		withStats.push(...batch);
	}
	if (signal?.aborted) {
		return { paths: [], sourceTruncated: false, displayTruncated: false };
	}
	withStats.sort((a, b) => b.mtime - a.mtime);
	return {
		paths: withStats
			.slice(0, WORKSPACE_ARTIFACT_QUICK_PICK_LIMIT)
			.map((s) => s.path),
		sourceTruncated,
		displayTruncated
	};
}

function isAbortError(error: unknown): boolean {
	if (typeof error !== 'object' || error === null || !('name' in error)) {
		return false;
	}
	const name = (error as { name?: unknown }).name;
	return name === 'AbortError' || name === 'Canceled' || name === 'CancellationError';
}

function isExcludedWorkspacePath(workspacePath: string, filePath: string): boolean {
	const relativePath = path.relative(workspacePath, filePath);
	return relativePath.split(path.sep).some(segment => {
		const comparableSegment = process.platform === 'win32' ? segment.toLowerCase() : segment;
		return WORKSPACE_ARTIFACT_EXCLUDED_DIRECTORIES.has(comparableSegment);
	});
}

export interface SignFileDiscovery {
	cancelled: boolean;
	result?: WorkspaceArtifactDiscovery;
	browseRequested?: boolean;
}

export interface EmptySignFileDiscoveryWarningOptions {
	searchContext: string;
	showWarning: (message: string) => PromiseLike<string | undefined>;
}

export async function discoverSignFilesWithFallback(
	searchContext: string,
	discover: () => PromiseLike<CancellableResult<WorkspaceArtifactDiscovery>>,
	showWarning: (message: string) => PromiseLike<string | undefined>
): Promise<SignFileDiscovery> {
	try {
		const discovery = await discover();
		return { cancelled: discovery.cancelled, result: discovery.value };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const choice = await showWarning(
			`Could not search the workspace for ${searchContext}: ${message}. You can select a file manually.`
		);
		return { cancelled: false, browseRequested: choice === 'Browse…' };
	}
}

export async function handoffSignFileDiscovery(
	discovery: SignFileDiscovery,
	selectManualFile: () => PromiseLike<string | undefined>,
	emptyDiscoveryWarning?: EmptySignFileDiscoveryWarningOptions
): Promise<WorkspaceArtifactDiscovery | string | undefined> {
	if (discovery.browseRequested) {
		return selectManualFile();
	}
	if (discovery.cancelled || !discovery.result) {
		return undefined;
	}
	if (discovery.result.paths.length === 0) {
		if (discovery.result.sourceTruncated && emptyDiscoveryWarning) {
			const choice = await emptyDiscoveryWarning.showWarning(
				`Could only inspect the first ${WORKSPACE_ARTIFACT_MAX_RESULTS} workspace matches for ${emptyDiscoveryWarning.searchContext}, and none of the inspected matches can be shown here. Additional matching files may still exist. You can select a file manually.`
			);
			if (choice !== 'Browse…') {
				return undefined;
			}
		}
		return selectManualFile();
	}
	return discovery.result;
}

export interface SignWorkspaceQuickPickItem {
	label: string;
	description?: string;
	detail: string;
}

export function createWorkspaceSignFileQuickPickItem(
	workspacePath: string,
	filePath: string
): SignWorkspaceQuickPickItem {
	const relDir = path.dirname(path.relative(workspacePath, filePath));
	return {
		label: path.basename(filePath),
		description: relDir === '.' ? '' : relDir,
		detail: filePath
	};
}

export interface CoordinateWorkspaceSignFileSelectionOptions {
	searchContext: string;
	placeHolder: string;
	selectManualFile: () => PromiseLike<string | undefined>;
	showWarning: (message: string) => PromiseLike<string | undefined>;
	showQuickPick: (
		items: readonly SignWorkspaceQuickPickItem[],
		options: { placeHolder: string }
	) => PromiseLike<SignWorkspaceQuickPickItem | undefined>;
}

export async function coordinateWorkspaceSignFileSelection(
	workspacePath: string,
	discovery: SignFileDiscovery,
	options: CoordinateWorkspaceSignFileSelectionOptions
): Promise<string | undefined> {
	const handoff = await handoffSignFileDiscovery(
		discovery,
		options.selectManualFile,
		{
			searchContext: options.searchContext,
			showWarning: options.showWarning
		}
	);
	if (typeof handoff === 'string' || handoff === undefined) {
		return handoff;
	}

	const items: SignWorkspaceQuickPickItem[] = handoff.paths.map(filePath =>
		createWorkspaceSignFileQuickPickItem(workspacePath, filePath)
	);
	const browseItem = createSignBrowseItem(handoff);
	items.push(browseItem);

	const picked = await options.showQuickPick(items, {
		placeHolder: options.placeHolder
	});
	if (!picked) {
		return undefined;
	}
	if (
		picked === browseItem ||
		(
			picked.label === browseItem.label &&
			picked.description === browseItem.description &&
			picked.detail === browseItem.detail
		)
	) {
		return options.selectManualFile();
	}
	return picked.detail;
}

export function createSignBrowseItem(
	discovery: Pick<WorkspaceArtifactDiscovery, 'sourceTruncated' | 'displayTruncated'>
): SignWorkspaceQuickPickItem {
	if (discovery.sourceTruncated && discovery.displayTruncated) {
		return {
			label: '$(folder-opened) Browse… (more files available)',
			detail: 'Showing newest 100 of the first 500 workspace matches. Browse to choose a different file manually because additional workspace matches may exist'
		};
	}
	if (discovery.displayTruncated) {
		return {
			label: '$(folder-opened) Browse… (more files available)',
			detail: 'Showing newest 100 matching files. Browse to choose a different file manually'
		};
	}
	if (discovery.sourceTruncated) {
		return {
			label: '$(folder-opened) Browse… (additional files may exist)',
			detail: 'Only the first 500 workspace matches were checked. Browse to choose a different file manually because additional matches may exist'
		};
	}
	return { label: '$(folder-opened) Browse…', detail: 'Open a file picker' };
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
