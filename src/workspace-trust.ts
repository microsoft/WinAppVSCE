import * as vscode from 'vscode';

export const WORKSPACE_TRUST_REQUIRED = 'Trust this workspace to run WinApp commands or debug applications.';

export function requireTrustedWorkspace(): boolean {
	if (vscode.workspace.isTrusted) {
		return true;
	}
	void vscode.window.showWarningMessage(WORKSPACE_TRUST_REQUIRED);
	return false;
}

export function registerTrustedCommand(
	command: string,
	callback: Parameters<typeof vscode.commands.registerCommand>[1]
): vscode.Disposable {
	return vscode.commands.registerCommand(command, (...args: unknown[]) => {
		if (!requireTrustedWorkspace()) {
			return undefined;
		}
		return callback(...args);
	});
}
