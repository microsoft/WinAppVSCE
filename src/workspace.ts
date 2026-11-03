import * as vscode from 'vscode';

/** The open workspace, reduced to what the extension's commands need. */

/** A workspace folder, reduced to a display name and a path. */
export interface WorkspaceRoot {
	/** The folder's display name (`vscode.WorkspaceFolder.name`). */
	name: string;
	/** Absolute filesystem path of the folder. */
	path: string;
}

/** Every entry point reports a missing workspace identically. */
export const NO_WORKSPACE_MESSAGE = 'No workspace folder open';

/** Returns all workspace roots; never collapses multi-root workspaces. */
export function getWorkspaceRoots(): WorkspaceRoot[] {
	return (vscode.workspace.workspaceFolders ?? []).map(folder => ({
		name: folder.name,
		path: folder.uri.fsPath
	}));
}
