import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { parseProcessIdFromJson } from './run-options';
import { WINAPP_CLI_CALLER_VALUE } from './winapp-cli-utils';

/** Preserves failed run output so callers can offer the output channel. */
export class WinAppRunFailure extends Error { }

export interface LaunchedRunProcess {
	processId: number;
	runProcess: ReturnType<typeof spawn>;
}

export interface LaunchRunProcessOptions {
	cliPath: string;
	args: readonly string[];
	cwd: string;
	outputChannel: vscode.OutputChannel;
}

/**
 * Runs `winapp run` and resolves once it reports the process ID to attach to.
 *
 * In project mode this restores and builds before it launches, which can take
 * minutes, so everything streams to the output channel and the notification
 * stays cancellable — the wait is neither silent nor inescapable. The caller
 * owns the returned process and must kill it when the debug session ends.
 */
export async function launchRunProcess(
	{ cliPath, args, cwd, outputChannel }: LaunchRunProcessOptions
): Promise<LaunchedRunProcess> {
	outputChannel.appendLine(`> winapp ${args.join(' ')}`);

	return vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: 'Launching package...',
		cancellable: true
	}, async (progress, token) => {
		progress.report({ message: 'Starting winapp run...' });

		return new Promise<LaunchedRunProcess>((resolve, reject) => {
			const child = spawn(cliPath, [...args], {
				cwd,
				env: { ...process.env, WINAPP_CLI_CALLER: WINAPP_CLI_CALLER_VALUE },
				shell: false
			});

			let stdout = '';
			let resolved = false;
			let cancelled = false;

			const cancellation = token.onCancellationRequested(() => {
				cancelled = true;
				child.kill();
			});

			const settle = (fn: () => void) => {
				resolved = true;
				cancellation.dispose();
				fn();
			};

			// The CLI's human-readable progress goes to stderr; surfacing it as
			// the notification message turns a multi-minute blank wait into a
			// live view of restore/build/deploy.
			const reportProgress = (text: string) => {
				const lastLine = text.split(/\r?\n/).filter(line => line.trim()).pop();
				if (lastLine) {
					progress.report({ message: lastLine.trim().slice(0, 120) });
				}
			};

			child.stdout!.on('data', (data: Buffer) => {
				const text = data.toString();
				stdout += text;
				outputChannel.append(text);
				if (resolved) { return; }

				const pid = parseProcessIdFromJson(stdout);
				if (pid) {
					settle(() => resolve({ processId: pid, runProcess: child }));
				}
			});

			child.stderr!.on('data', (data: Buffer) => {
				const text = data.toString();
				outputChannel.append(text);
				if (!resolved) {
					reportProgress(text);
				}
			});

			child.on('error', (err) => {
				if (!resolved) {
					settle(() => reject(new Error(`Failed to start winapp run: ${err.message}`)));
				}
			});

			child.on('close', (code) => {
				if (resolved) { return; }

				if (cancelled) {
					settle(() => reject(new Error('Launch cancelled.')));
				} else if (code !== 0) {
					// The full output is already in the channel; a toast is the
					// wrong place for a build log.
					settle(() => reject(new WinAppRunFailure(
						`winapp run failed with exit code ${code}.`
					)));
				} else {
					settle(() => reject(new WinAppRunFailure(
						'winapp run exited before reporting a process ID to attach to.'
					)));
				}
			});
		});
	});
}
