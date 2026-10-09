/**
 * VS Code-facing helpers shared by the command modules: the WinApp output
 * channel, the capture-based CLI runner, and the folder picker. Split out so
 * command modules can use them without importing `extension.ts` (a cycle).
 */

import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { getWinappCliPath, WINAPP_CLI_CALLER_VALUE } from './winapp-cli-utils';

/** Where to send users whose .NET SDK is missing. */
export const DOTNET_DOWNLOAD_URL = 'https://dotnet.microsoft.com/download';

/**
 * Shared output channel for capture-based winapp commands (e.g. pack). Created
 * lazily and reused so repeated runs don't leak channels.
 */
let winappOutputChannel: vscode.OutputChannel | undefined;

export function getWinappOutputChannel(): vscode.OutputChannel {
	if (!winappOutputChannel) {
		winappOutputChannel = vscode.window.createOutputChannel('WinApp');
	}
	return winappOutputChannel;
}

/** Dispose the shared channel; called from the extension's subscriptions. */
export function disposeWinappOutputChannel(): void {
	winappOutputChannel?.dispose();
	winappOutputChannel = undefined;
}

/**
 * Run a winapp CLI command via `spawn` (shell: false) while capturing its
 * combined stdout/stderr, streaming it to the WinApp output channel and a
 * progress notification. Unlike `runWinappCommand`, this waits for the
 * command to finish so callers can inspect the output (e.g. the produced
 * package path).
 *
 * @returns The process exit code and the full captured output.
 */
export async function runWinappCapture(
	extensionPath: string,
	args: string[],
	cwd: string,
	progressTitle: string
): Promise<{ code: number | null; output: string; cancelled?: boolean }> {
	const cliPath = getWinappCliPath(extensionPath);
	const outputChannel = getWinappOutputChannel();
	outputChannel.appendLine(`> winapp ${args.join(' ')}`);

	return vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: progressTitle,
			cancellable: true
		},
		(_progress, token) =>
			new Promise<{ code: number | null; output: string; cancelled?: boolean }>((resolve) => {
				const child = spawn(cliPath, args, {
					cwd,
					env: { ...process.env, WINAPP_CLI_CALLER: WINAPP_CLI_CALLER_VALUE },
					shell: false
				});

				let output = '';
				let settled = false;
				let cancelled = false;
				const finish = (result: { code: number | null; output: string; cancelled?: boolean }) => {
					if (!settled) {
						settled = true;
						resolve(result);
					}
				};

				const cancellation = token.onCancellationRequested(() => {
					if (cancelled || settled) {
						return;
					}
					cancelled = true;
					outputChannel.appendLine('\nCancelled.');
					if (child.pid) {
						// On Windows, winapp commands may spawn helper processes (pack's
						// SDK tools, new's `dotnet new`); taskkill /t terminates the whole
						// tree instead of only the direct child.
						const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
							windowsHide: true
						});
						killer.on('error', () => child.kill());
						killer.on('close', (code) => {
							if (code !== 0) {
								child.kill();
							}
						});
					} else {
						child.kill();
					}
				});

				child.stdout!.on('data', (data: Buffer) => {
					const text = data.toString();
					output += text;
					outputChannel.append(text);
				});

				child.stderr!.on('data', (data: Buffer) => {
					const text = data.toString();
					output += text;
					outputChannel.append(text);
				});

				child.on('error', (err) => {
					cancellation.dispose();
					if (cancelled) {
						finish({ code: null, output, cancelled: true });
						return;
					}
					outputChannel.appendLine(`\nFailed to run winapp: ${err.message}`);
					finish({ code: null, output });
				});

				child.on('close', (code) => {
					cancellation.dispose();
					finish({ code, output, cancelled });
				});
			})
	);
}

/** Prompt for a single folder. */
export async function selectFolder(title: string, defaultUri?: vscode.Uri): Promise<string | undefined> {
	const result = await vscode.window.showOpenDialog({
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: false,
		title: title,
		defaultUri: defaultUri
	});

	return result?.[0]?.fsPath;
}
