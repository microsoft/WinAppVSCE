import * as vscode from 'vscode';
import * as path from 'path';
import {
	BUILD_OUTPUT_MAX_RESULTS,
	BUILD_OUTPUT_SKIP_DIRS,
	deduplicateBuildOutputFolders,
	isPackableDiscoveredOutput
} from './project-detection';
import { walkDirectoryTree, scanRoots, type ScanCancellationToken } from './directory-walk';
import {
	countDuplicateFolderSelections,
	mergeFolderSelections,
	resolveFolderSelection
} from './pack-args';
import { selectFolder } from './winapp-host';
import type { WorkspaceRoot } from './workspace';

/**
 * Folder selection shared by the run, pack, and project commands.
 *
 * Pack scans every workspace root with a multi-select picker so build outputs
 * can form a bundle across roots. Run borrows the same scan while also
 * offering projects and solutions.
 */

export const FOLDER_PICKER_DETAIL = 'Open a folder picker';

/** Shown whenever an executable scan comes up empty, in either picker. */
export const NO_BUILD_OUTPUT_MESSAGE =
	'No folders containing .exe files were found. Build your project first, or browse to a folder.';

/** Title of the native folder dialog used as the build-output fallback. */
export const SELECT_BUILD_OUTPUT_TITLE = 'Select build output folder';

/** Placeholder for every build-output QuickPick. */
export const SELECT_BUILD_OUTPUT_PLACEHOLDER = 'Select the build output folder containing your app';

const BUILD_OUTPUT_PROGRESS_TITLE = 'Searching for build output folders...';

/** A folder containing `.exe` files, tagged with the root it was found under. */
export interface BuildOutputFolder {
	/** The scanned root, so multi-root callers can attribute the result. */
	rootPath: string;
	path: string;
}

type BuildOutputQuickPickItem = vscode.QuickPickItem & { directory?: string };

/**
 * Prompt the user to select a folder.
 */
export { selectFolder };

/**
 * Scan every root for folders containing `.exe` files. Returns undefined if
 * the scan was cancelled.
 *
 * Takes a token rather than owning a progress notification, so a caller that
 * has already opened one — the run picker, which falls back to this scan —
 * does not stack a second popup, with a second Cancel button, on the first.
 *
 * Walks the tree directly rather than using `vscode.workspace.findFiles`.
 * Passing `findFiles` an exclude glob does not replace the user's
 * `files.exclude` setting, it adds to it, so a workspace that hides `**​/bin`
 * from the explorer would hide its own build output from this picker — the
 * one place it must never be hidden.
 */
export async function scanBuildOutputFolders(
	rootPaths: readonly string[],
	token: ScanCancellationToken,
	packOnly: boolean = false
): Promise<BuildOutputFolder[] | undefined> {
	const found: BuildOutputFolder[] = [];

	const completed = await scanRoots(rootPaths, token, async (rootPath, signal) => {
		const executables: string[] = [];
		const folders = new Set<string>();

		await walkDirectoryTree(
			rootPath,
			(directory, entries) => {
				const packable = !packOnly || isPackableDiscoveredOutput(
					directory,
					entries.filter(entry => entry.isFile()).map(entry => entry.name)
				);
				for (const entry of entries) {
					if (
						!packable
						|| !entry.isFile()
						|| path.extname(entry.name).toLowerCase() !== '.exe'
					) {
						continue;
					}
					executables.push(path.join(directory, entry.name));
					folders.add(directory);
					// Cap on distinct folders, which is what the picker shows,
					// rather than on raw hits: one output folder holds many
					// executables.
					if (folders.size > BUILD_OUTPUT_MAX_RESULTS) {
						return 'stop';
					}
				}
				return 'descend';
			},
			{ skipDirs: BUILD_OUTPUT_SKIP_DIRS, signal }
		);

		for (const folder of deduplicateBuildOutputFolders(executables, rootPath)) {
			found.push({ rootPath, path: folder });
		}
	});

	return completed ? found : undefined;
}

/**
 * {@link scanBuildOutputFolders} under its own cancellable progress
 * notification, for callers that have not already opened one.
 *
 * A single root is just the one-element case, so both the pack picker and the
 * multi-root run picker share this.
 */
export async function findBuildOutputFolders(
	rootPaths: readonly string[],
	packOnly: boolean = false
): Promise<BuildOutputFolder[] | undefined> {
	return vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: BUILD_OUTPUT_PROGRESS_TITLE, cancellable: true },
		async (_progress, token) => scanBuildOutputFolders(rootPaths, token, packOnly)
	);
}

/** Pick build output, always leaving Browse available. */
export async function pickBuildOutputFolder(workspacePath: string): Promise<string | undefined> {
	const outputFolders = await findBuildOutputFolders([workspacePath]);
	if (!outputFolders) {
		return undefined;
	}

	if (outputFolders.length === 0) {
		vscode.window.showWarningMessage(NO_BUILD_OUTPUT_MESSAGE);
		return selectFolder(SELECT_BUILD_OUTPUT_TITLE, vscode.Uri.file(workspacePath));
	}

	const picked = await vscode.window.showQuickPick(buildOutputFolderItems(workspacePath, outputFolders), {
		placeHolder: SELECT_BUILD_OUTPUT_PLACEHOLDER
	});

	if (!picked) {
		return undefined;
	}

	if (picked.detail === FOLDER_PICKER_DETAIL) {
		return selectFolder(SELECT_BUILD_OUTPUT_TITLE, vscode.Uri.file(workspacePath));
	}

	return picked.directory;
}

/** Pick one or more build outputs; multiple folders produce an MSIX bundle. */
export async function pickBuildOutputFolders(
	workspaceRoots: readonly WorkspaceRoot[]
): Promise<string[] | undefined> {
	const outputFolders = await findBuildOutputFolders(
		workspaceRoots.map(root => root.path),
		true
	);
	if (!outputFolders) {
		return undefined;
	}

	const defaultRoot = workspaceRoots[0];
	if (outputFolders.length === 0) {
		vscode.window.showWarningMessage(NO_BUILD_OUTPUT_MESSAGE);
		return selectFolders(
			'Select build output folder(s)',
			defaultRoot ? vscode.Uri.file(defaultRoot.path) : undefined
		);
	}

	while (true) {
		const picked = await vscode.window.showQuickPick(
			buildMultiRootOutputFolderItems(workspaceRoots, outputFolders),
			{
				placeHolder: 'Select build output folder(s) — pick two or more to create an MSIX bundle',
				canPickMany: true
			}
		);

		if (!picked) {
			return undefined;
		}

		const selection = resolveFolderSelection(picked, FOLDER_PICKER_DETAIL);
		switch (selection.kind) {
			case 'none':
				vscode.window.showWarningMessage('Select at least one build output folder.');
				continue;
			case 'browse': {
				const browsed = await selectFolders(
					'Select build output folders — Ctrl/Shift-click to select multiple',
					defaultRoot ? vscode.Uri.file(defaultRoot.path) : undefined
				);
				if (!browsed) {
					return selection.folders.length > 0 ? selection.folders : undefined;
				}

				const folders = mergeFolderSelections(selection.folders, browsed);
				if (countDuplicateFolderSelections(selection.folders, browsed) > 0) {
					const result = await vscode.window.showWarningMessage(
						folders.length === 1
							? 'The same folder was selected more than once. Duplicates will be ignored, so this will create a single MSIX package.'
							: 'The same folder was selected more than once. Duplicate selections will be ignored.',
						{ modal: true },
						'Continue'
					);
					if (result !== 'Continue') {
						return undefined;
					}
				}
				return folders;
			}
			case 'folders':
				return selection.folders;
		}
	}
}

function buildMultiRootOutputFolderItems(
	workspaceRoots: readonly WorkspaceRoot[],
	outputFolders: readonly BuildOutputFolder[]
): BuildOutputQuickPickItem[] {
	const onlyOutput = outputFolders.length === 1;
	const rootsByPath = new Map(
		workspaceRoots.map(root => [path.resolve(root.path).toLowerCase(), root])
	);
	const items: BuildOutputQuickPickItem[] = outputFolders.map(output => {
		const root = rootsByPath.get(path.resolve(output.rootPath).toLowerCase());
		const relative = path.relative(output.rootPath, output.path) || '.';
		return {
			label: workspaceRoots.length > 1 && root ? `${root.name} — ${relative}` : relative,
			detail: output.path,
			directory: output.path,
			picked: onlyOutput
		};
	});

	items.push({ label: '$(folder-opened) Browse…', detail: FOLDER_PICKER_DETAIL, alwaysShow: true });
	return items;
}

function buildOutputFolderItems(
	workspacePath: string,
	outputFolders: readonly BuildOutputFolder[]
): BuildOutputQuickPickItem[] {
	const items: BuildOutputQuickPickItem[] = outputFolders.map(({ path: folderPath }) => ({
		label: path.relative(workspacePath, folderPath) || '.',
		detail: folderPath,
		directory: folderPath
	}));

	// alwaysShow keeps the escape hatch reachable when filtering the list.
	items.push({ label: '$(folder-opened) Browse…', detail: FOLDER_PICKER_DETAIL, alwaysShow: true });
	return items;
}

async function selectFolders(title: string, defaultUri?: vscode.Uri): Promise<string[] | undefined> {
	const result = await vscode.window.showOpenDialog({
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: true,
		title,
		openLabel: 'Select folder(s)',
		defaultUri
	});

	return result?.length ? result.map(uri => uri.fsPath) : undefined;
}
