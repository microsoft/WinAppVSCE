import * as vscode from 'vscode';

export const WORKSPACE_TRUST_REQUIRED = 'WinApp debugging requires a trusted workspace.';

// VS Code's Restricted Mode UI already explains trust; blocked commands stay silent.
export function requireTrustedWorkspace(): boolean {
	return vscode.workspace.isTrusted;
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
