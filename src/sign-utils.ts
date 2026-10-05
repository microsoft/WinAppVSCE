import * as fs from 'node:fs';
import * as path from 'node:path';
import { escapePowerShellArg } from './winapp-cli-utils';
import { ARTIFACT_EXTENSIONS } from './artifact-types';
import { walkDirectoryTree } from './directory-walk';

/** Certificate file extensions discoverable in a workspace. */
export const CERTIFICATE_EXTENSIONS = ['pfx'];

/** Executable extensions that can be signed. */
export const EXECUTABLE_EXTENSIONS = ['exe', 'dll'];

/**
 * Package extensions the QuickPick surfaces first. Everything else in
 * {@link ARTIFACT_EXTENSIONS} falls into the tier below, so a new artifact
 * type stays discoverable without edits here.
 */
const PRIMARY_PACKAGE_EXTENSIONS: ReadonlySet<string> = new Set(['msix', 'msixbundle']);

/**
 * Signable extensions in QuickPick priority order: MSIX packages, other
 * package types, then loose executables. A lower tier only contributes rows
 * that higher tiers left unfilled.
 */
export const SIGNABLE_ARTIFACT_TIERS: readonly (readonly string[])[] = [
	ARTIFACT_EXTENSIONS.filter((ext) => PRIMARY_PACKAGE_EXTENSIONS.has(ext)),
	ARTIFACT_EXTENSIONS.filter((ext) => !PRIMARY_PACKAGE_EXTENSIONS.has(ext)),
	EXECUTABLE_EXTENSIONS
];

/** Single-tier ordering used by the certificate picker. */
export const CERTIFICATE_TIERS: readonly (readonly string[])[] = [CERTIFICATE_EXTENSIONS];

/**
 * Directories never descended into when scanning for signable files.
 *
 * Deliberately much smaller than `project-detection`'s `SKIP_DIRS`: build
 * output such as `bin`, `obj`, and `Release` is exactly where artifacts live.
 * Hidden directories (`.git`, `.vs`) are pruned by the walker itself.
 */
const SIGNABLE_SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules']);

/** Maximum number of discovered files offered in a QuickPick before "Browse…". */
export const MAX_QUICKPICK_RESULTS = 10;

/**
 * Runaway guard on how many candidates a single scan collects. Only reachable
 * in pathological trees; below it, newest-first ordering is exact.
 */
export const MAX_SCAN_CANDIDATES = 2000;

/** How many `stat` calls to keep in flight while ordering candidates. */
const STAT_CONCURRENCY = 64;

export interface FindWorkspaceArtifactsOptions {
	/** Extension tiers in priority order. Defaults to {@link SIGNABLE_ARTIFACT_TIERS}. */
	tiers?: readonly (readonly string[])[];
	/** Maximum paths returned. Defaults to {@link MAX_QUICKPICK_RESULTS}. */
	limit?: number;
	signal?: AbortSignal;
	/** Override the runaway guard. Tests use this to force truncation. */
	maxCandidates?: number;
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
 * Find signable files under `workspacePath`, newest-first within each tier and
 * capped at `limit`.
 *
 * A single pruned breadth-first walk collects every candidate, so ignored
 * directories are never read rather than filtered out afterwards. Tiers are
 * ordered one at a time, so a scan that fills up on MSIX packages never pays
 * to `stat` the far larger `.exe`/`.dll` bucket.
 */
export async function findWorkspaceArtifacts(
	workspacePath: string,
	options: FindWorkspaceArtifactsOptions = {}
): Promise<string[]> {
	const {
		tiers = SIGNABLE_ARTIFACT_TIERS,
		limit = MAX_QUICKPICK_RESULTS,
		signal,
		maxCandidates = MAX_SCAN_CANDIDATES
	} = options;

	if (limit <= 0 || tiers.length === 0 || signal?.aborted) {
		return [];
	}

	const tierByExtension = new Map<string, number>();
	tiers.forEach((extensions, tier) => {
		for (const extension of extensions) {
			tierByExtension.set(extension.toLowerCase(), tier);
		}
	});

	const buckets: string[][] = tiers.map(() => []);
	let collected = 0;

	await walkDirectoryTree(
		workspacePath,
		(directory, entries) => {
			for (const entry of entries) {
				if (!entry.isFile()) {
					continue;
				}
				const tier = tierByExtension.get(path.extname(entry.name).slice(1).toLowerCase());
				if (tier === undefined) {
					continue;
				}
				buckets[tier].push(path.join(directory, entry.name));
				if (++collected >= maxCandidates) {
					return 'stop';
				}
			}
			return 'descend';
		},
		{ skipDirs: SIGNABLE_SKIP_DIRS, signal }
	);

	if (signal?.aborted) {
		return [];
	}

	const ordered: string[] = [];
	for (const bucket of buckets) {
		if (ordered.length >= limit) {
			break;
		}

		const modifiedTimes = await collectModifiedTimes(bucket, signal);
		if (signal?.aborted) {
			return [];
		}

		bucket.sort((left, right) =>
			(modifiedTimes.get(right) ?? 0) - (modifiedTimes.get(left) ?? 0));
		ordered.push(...bucket.slice(0, limit - ordered.length));
	}

	return ordered;
}

/**
 * Resolve modification times with bounded concurrency. Statting sequentially
 * dominated the previous implementation's cost; unreadable files sort last.
 */
async function collectModifiedTimes(
	filePaths: readonly string[],
	signal?: AbortSignal
): Promise<Map<string, number>> {
	const modifiedTimes = new Map<string, number>();
	let cursor = 0;

	const workers = Array.from(
		{ length: Math.min(STAT_CONCURRENCY, filePaths.length) },
		async () => {
			while (cursor < filePaths.length) {
				if (signal?.aborted) {
					return;
				}
				const filePath = filePaths[cursor++];
				try {
					const stat = await fs.promises.stat(filePath);
					modifiedTimes.set(filePath, stat.mtimeMs);
				} catch {
					modifiedTimes.set(filePath, 0);
				}
			}
		}
	);

	await Promise.all(workers);
	return modifiedTimes;
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
