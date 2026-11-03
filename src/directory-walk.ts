import * as fs from 'fs';
import * as path from 'path';
import type { Dirent } from 'fs';

/**
 * What the walker should do with a directory after visiting it.
 *
 * - `descend` — queue its subdirectories.
 * - `skip` — visit no deeper on this branch.
 * - `stop` — end the entire walk immediately.
 */
export type WalkDecision = 'descend' | 'skip' | 'stop';

export type DirectoryVisitor = (
	directory: string,
	entries: Dirent[]
) => WalkDecision | Promise<WalkDecision>;

export interface DirectoryWalkOptions {
	/** Directory names (lowercase) that are never descended into. */
	skipDirs?: ReadonlySet<string>;
	signal?: AbortSignal;
}

/**
 * Breadth-first walk of a directory tree, pruning `skipDirs`, hidden
 * directories, and symlinks/junctions as it goes.
 *
 * Pruning happens during traversal rather than by filtering results, because
 * the VS Code `findFiles` API cannot express it: passing an `exclude` glob
 * makes VS Code *also* apply the user's `files.exclude` setting, and its glob
 * engine has no negation operator. Skipped subtrees are never read at all.
 *
 * Unreadable directories are ignored so a permissions error cannot abort a
 * scan. The walk yields to the event loop periodically to keep the UI
 * responsive on large trees.
 */
export async function walkDirectoryTree(
	root: string,
	visit: DirectoryVisitor,
	options: DirectoryWalkOptions = {}
): Promise<void> {
	const { skipDirs, signal } = options;
	const queue: string[] = [root];
	let iterations = 0;

	while (queue.length > 0) {
		if (signal?.aborted) {
			return;
		}

		const current = queue.shift()!;

		let entries: Dirent[];
		try {
			entries = await fs.promises.readdir(current, { withFileTypes: true });
		} catch {
			continue;
		}

		const decision = await visit(current, entries);
		if (decision === 'stop') {
			return;
		}

		if (decision === 'descend') {
			for (const entry of entries) {
				// Symlinks and Windows junctions are skipped so the walk cannot cycle.
				if (entry.isSymbolicLink() || !entry.isDirectory()) {
					continue;
				}
				if (entry.name.startsWith('.')) {
					continue;
				}
				if (skipDirs?.has(entry.name.toLowerCase())) {
					continue;
				}
				queue.push(path.join(current, entry.name));
			}
		}

		if (++iterations % 50 === 0) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	}
}

/**
 * The slice of `vscode.CancellationToken` a scan needs.
 *
 * Declared structurally so this module stays free of a `vscode` import and
 * remains unit-testable outside the extension host.
 */
export interface ScanCancellationToken {
	readonly isCancellationRequested: boolean;
	onCancellationRequested(listener: () => void): { dispose(): void };
}

/**
 * Visits each root in turn under one `AbortController` wired to `token`,
 * returning false when the scan was cancelled.
 *
 * Every multi-root scan needs the same scaffolding — bridge the token to an
 * abort signal, re-check cancellation between roots, dispose the subscription,
 * and discard partial results — so it lives here once rather than once per
 * scan.
 */
export async function scanRoots<TRoot>(
	roots: readonly TRoot[],
	token: ScanCancellationToken,
	visit: (root: TRoot, signal: AbortSignal) => Promise<WalkDecision | void>
): Promise<boolean> {
	const controller = new AbortController();
	const subscription = token.onCancellationRequested(() => controller.abort());

	try {
		for (const root of roots) {
			if (token.isCancellationRequested) {
				break;
			}
			if (await visit(root, controller.signal) === 'stop') {
				break;
			}
		}
	} finally {
		subscription.dispose();
	}

	return !token.isCancellationRequested;
}
