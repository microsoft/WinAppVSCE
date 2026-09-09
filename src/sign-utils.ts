import * as fs from 'node:fs';
import * as path from 'node:path';
import { escapePowerShellArg } from './winapp-cli-utils';
import { ARTIFACT_EXTENSIONS, ARTIFACT_GLOBS } from './artifact-types';

/** Glob patterns for PFX certificate files within a workspace. */
export const CERTIFICATE_GLOBS = ['**/*.pfx'];

/** Glob patterns for executable files that can be signed. */
export const EXECUTABLE_GLOBS = ['**/*.exe', '**/*.dll'];

/**
 * Package extensions the QuickPick surfaces first. Everything else in
 * {@link ARTIFACT_EXTENSIONS} falls into the tier below, so a new artifact
 * type stays discoverable without edits here.
 */
const PRIMARY_PACKAGE_EXTENSIONS: ReadonlySet<string> = new Set(['msix', 'msixbundle']);

const toGlobs = (extensions: readonly string[]): string[] => extensions.map((ext) => `**/*.${ext}`);

/**
 * Signable globs in QuickPick priority order: MSIX packages, other package
 * types, then loose executables. Lower tiers are searched only when higher
 * ones leave slots unfilled.
 */
export const SIGNABLE_ARTIFACT_TIERS: string[][] = [
	toGlobs(ARTIFACT_EXTENSIONS.filter((ext) => PRIMARY_PACKAGE_EXTENSIONS.has(ext))),
	toGlobs(ARTIFACT_EXTENSIONS.filter((ext) => !PRIMARY_PACKAGE_EXTENSIONS.has(ext))),
	EXECUTABLE_GLOBS
];

const SIGNABLE_ARTIFACT_IGNORES = new Set(['node_modules', '.git']);

/** Maximum number of discovered files offered in a QuickPick before "Browse…". */
export const MAX_QUICKPICK_RESULTS = 10;

/**
 * Candidates to collect per remaining slot. A "Browse…" entry always backs the
 * QuickPick, so a small overshoot keeps newest-first ordering meaningful
 * without paying for a full workspace walk.
 */
const CANDIDATE_POOL_MULTIPLIER = 4;

export interface WorkspaceFileSearch {
	/** Upper bound on matches to collect. Always set — discovery stays bounded. */
	maxResults: number;
	signal?: AbortSignal;
}

export type WorkspaceFileFinder = (
	includePattern: string,
	search: WorkspaceFileSearch
) => Promise<string[]>;

/**
 * The subset of `vscode.workspace.findFiles` that artifact discovery uses.
 * `exclude` is typed `null` rather than `GlobPattern | null` on purpose — see
 * {@link createWorkspaceFileFinder}.
 */
export type FindFilesApi<TPattern, TUri> = (
	include: TPattern,
	exclude: null,
	maxResults: number
) => Thenable<TUri[]>;

/**
 * Adapt a `findFiles`-shaped API into a {@link WorkspaceFileFinder}. `exclude`
 * is pinned to `null`: any pattern makes VS Code *also* apply `files.exclude`,
 * emptying the picker for anyone hiding their package output folder.
 */
export function createWorkspaceFileFinder<TPattern, TUri>(
	toPattern: (includePattern: string) => TPattern,
	findFiles: FindFilesApi<TPattern, TUri>,
	toPath: (uri: TUri) => string
): WorkspaceFileFinder {
	return async (includePattern, search) => {
		const matches = await findFiles(toPattern(includePattern), null, search.maxResults);
		return matches.map(toPath);
	};
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
 * Find files matching `patterns`, bounded to `limit * CANDIDATE_POOL_MULTIPLIER`
 * matches and returning at most `limit`, newest first. `node_modules`/`.git` are
 * filtered after the search — passing an exclude glob would apply `files.exclude`.
 */
export async function findWorkspaceArtifacts(
	workspacePath: string,
	findFiles: WorkspaceFileFinder,
	patterns: string[] = ARTIFACT_GLOBS,
	signal?: AbortSignal,
	limit: number = MAX_QUICKPICK_RESULTS
): Promise<string[]> {
	if (signal?.aborted || limit <= 0) {
		return [];
	}

	const includePattern = patterns.length === 1 ? patterns[0] : `{${patterns.join(',')}}`;
	const poolSize = limit * CANDIDATE_POOL_MULTIPLIER;

	const results = await search(includePattern, poolSize);
	const candidates = results.filter((filePath) => !isIgnoredWorkspacePath(workspacePath, filePath));

	// Sort by mtime descending (newest first); if stat fails, push to end.
	const withStats: Array<{ path: string; mtime: number }> = [];
	for (const filePath of candidates) {
		if (signal?.aborted) {
			return [];
		}
		try {
			const stat = await fs.promises.stat(filePath);
			withStats.push({ path: filePath, mtime: stat.mtimeMs });
		} catch {
			withStats.push({ path: filePath, mtime: 0 });
		}
	}

	withStats.sort((a, b) => b.mtime - a.mtime);
	return withStats.map((s) => s.path).slice(0, limit);

	// `maxResults` is required, so discovery can never fall back to an unbounded walk.
	async function search(include: string, maxResults: number): Promise<string[]> {
		if (signal?.aborted) {
			return [];
		}
		try {
			return await findFiles(include, { maxResults, signal });
		} catch (error) {
			if (signal?.aborted && isCancellationError(error)) {
				return [];
			}
			throw error;
		}
	}
}

/**
 * Search `tiers` in priority order, stopping once `limit` files are found. Each
 * tier sorts newest-first independently, so higher-priority types always rank
 * above lower-priority ones regardless of mtime.
 */
export async function findWorkspaceArtifactsByTier(
	workspacePath: string,
	findFiles: WorkspaceFileFinder,
	tiers: string[][],
	signal?: AbortSignal,
	limit: number = MAX_QUICKPICK_RESULTS
): Promise<string[]> {
	const collected: string[] = [];
	const seen = new Set<string>();

	for (const patterns of tiers) {
		if (signal?.aborted || collected.length >= limit) {
			break;
		}

		const tierResults = await findWorkspaceArtifacts(
			workspacePath,
			findFiles,
			patterns,
			signal,
			limit - collected.length
		);

		for (const filePath of tierResults) {
			const key = process.platform === 'win32' ? filePath.toLowerCase() : filePath;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			collected.push(filePath);
		}
	}

	return signal?.aborted ? [] : collected.slice(0, limit);
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
