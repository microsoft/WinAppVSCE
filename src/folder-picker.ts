import * as vscode from 'vscode';
import * as path from 'path';
import {
	BUILD_OUTPUT_EXCLUDE_GLOB,
	BUILD_OUTPUT_MAX_RESULTS,
	deduplicateBuildOutputFolders
} from './project-detection';

/**
 * Folder selection shared by the run, pack, and project commands.
 *
 * `winapp package` only ever accepts a build output folder, so it uses the
 * build-output picker directly. The run picker lives in `run-utils` because it
 * also offers projects and solutions, and borrows the scan from here.
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

/**
 * Prompt the user to select a folder.
 */
export async function selectFolder(title: string, defaultUri?: vscode.Uri): Promise<string | undefined> {
	const result = await vscode.window.showOpenDialog({
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: false,
		title,
		defaultUri
	});

	return result?.[0]?.fsPath;
}

/**
 * Scan every root for folders containing `.exe` files, under one cancellable
 * progress notification. Returns undefined if the user cancelled.
 *
 * A single root is just the one-element case, so both the pack picker and the
 * multi-root run picker share this; a per-root wrapper would stack a separate
 * popup, and a separate Cancel button, on every folder in a multi-root
 * workspace.
 */
export async function findBuildOutputFolders(
	rootPaths: readonly string[]
): Promise<BuildOutputFolder[] | undefined> {
	return vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: BUILD_OUTPUT_PROGRESS_TITLE, cancellable: true },
		async (_progress, token) => {
			const found: BuildOutputFolder[] = [];

			for (const rootPath of rootPaths) {
				// The token must reach findFiles itself: cancelling only a flag
				// we read afterwards leaves the (expensive) scan running to
				// completion, so the Cancel button appears to do nothing.
				const exeMatches = await vscode.workspace.findFiles(
					new vscode.RelativePattern(rootPath, '**/*.exe'),
					BUILD_OUTPUT_EXCLUDE_GLOB,
					BUILD_OUTPUT_MAX_RESULTS,
					token
				);

				if (token.isCancellationRequested) {
					return undefined;
				}

				const folders = deduplicateBuildOutputFolders(exeMatches.map(m => m.fsPath), rootPath);
				for (const folder of folders) {
					found.push({ rootPath, path: folder });
				}
			}

			return found;
		}
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

	const items: Array<vscode.QuickPickItem & { directory?: string }> = outputFolders.map(({ path: folderPath }) => ({
		label: path.relative(workspacePath, folderPath) || '.',
		detail: folderPath,
		directory: folderPath
	}));

	items.push({ label: '$(folder-opened) Browse…', detail: FOLDER_PICKER_DETAIL });

	const picked = await vscode.window.showQuickPick(items, {
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
