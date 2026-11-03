import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { createProgressLineReader, parseProcessIdFromJson } from './run-options';
import { classifyRunExit } from './run-exit';
import { killProcessTree } from './process-tree';
import { WINAPP_CLI_CALLER_VALUE } from './winapp-cli-utils';

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
				// Project mode spawns restore and MSBuild beneath the CLI, so
				// the whole tree has to go — not just the direct child.
				killProcessTree(child);
			});

			const settle = (fn: () => void) => {
				resolved = true;
				cancellation.dispose();
				fn();
			};

			// Under `--json` the CLI reserves stdout for the payload and sends
			// its human-readable output to stderr, so this is where restore and
			// build progress shows up. Surfacing it turns a multi-minute blank
			// wait into a live view.
			const nextProgressMessage = createProgressLineReader();

			child.stdout!.on('data', (data: Buffer) => {
				const text = data.toString();
				outputChannel.append(text);
				if (resolved) { return; }

				// Only accumulate while still looking for the PID. The app can
				// run for hours after that, and every byte it writes would
				// otherwise be retained for the life of the debug session.
				stdout += text;
				const pid = parseProcessIdFromJson(stdout);
				if (pid) {
					settle(() => resolve({ processId: pid, runProcess: child }));
				}
			});

			child.stderr!.on('data', (data: Buffer) => {
				const text = data.toString();
				outputChannel.append(text);
				if (resolved) { return; }

				const message = nextProgressMessage(text);
				if (message) {
					progress.report({ message });
				}
			});

			child.on('error', (err) => {
				if (!resolved) {
					settle(() => reject(new Error(`Failed to start winapp run: ${err.message}`)));
				}
			});

			child.on('close', (code) => {
				if (resolved) { return; }
				settle(() => reject(classifyRunExit({ code, cancelled })));
			});
		});
	});
}
