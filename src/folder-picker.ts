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

/** Shown by both the single-root and multi-root build-output scans. */
const BUILD_OUTPUT_PROGRESS_TITLE = 'Searching for build output folders...';

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

/** Scans one root; the caller owns the progress UI and the cancellation token. */
export async function scanBuildOutputFolders(
	workspacePath: string,
	token: vscode.CancellationToken
): Promise<string[] | undefined> {
	// The token must reach findFiles itself: cancelling only a flag we
	// read afterwards leaves the (expensive) scan running to completion,
	// so the Cancel button appears to do nothing.
	const exeMatches = await vscode.workspace.findFiles(
		new vscode.RelativePattern(workspacePath, '**/*.exe'),
		BUILD_OUTPUT_EXCLUDE_GLOB,
		BUILD_OUTPUT_MAX_RESULTS,
		token
	);

	if (token.isCancellationRequested) {
		return undefined;
	}

	return deduplicateBuildOutputFolders(exeMatches.map(m => m.fsPath), workspacePath);
}

/** Scan a single root with cancellable VS Code progress. */
export async function findBuildOutputFolders(workspacePath: string): Promise<string[] | undefined> {
	return vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: BUILD_OUTPUT_PROGRESS_TITLE, cancellable: true },
		(_progress, token) => scanBuildOutputFolders(workspacePath, token)
	);
}

/** Open a progress-reporting multi-root scan; the caller fans out over roots. */
export async function withBuildOutputProgress<T>(
	scan: (token: vscode.CancellationToken) => Promise<T>
): Promise<T> {
	return vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: BUILD_OUTPUT_PROGRESS_TITLE, cancellable: true },
		(_progress, token) => scan(token)
	);
}

/** Pick build output, always leaving Browse available. */
export async function pickBuildOutputFolder(workspacePath: string): Promise<string | undefined> {
	const outputFolders = await findBuildOutputFolders(workspacePath);
	if (!outputFolders) {
		return undefined;
	}

	if (outputFolders.length === 0) {
		vscode.window.showWarningMessage(NO_BUILD_OUTPUT_MESSAGE);
		return selectFolder(SELECT_BUILD_OUTPUT_TITLE, vscode.Uri.file(workspacePath));
	}

	const items: Array<vscode.QuickPickItem & { directory?: string }> = outputFolders.map((folderPath) => ({
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
