export interface WinappToolPrompts {
	selectTool: () => PromiseLike<string | undefined>;
	promptForToolName: () => PromiseLike<string | undefined>;
	promptForArguments: (toolName: string) => PromiseLike<string | undefined>;
}

export interface WinappToolInvocation {
	cliPath: string;
	cwd: string;
	args: string[];
}

export interface WinappToolTaskSpec {
	process: {
		executable: string;
		args: string[];
		options: {
			cwd: string;
			env: Record<string, string>;
		};
	};
	task: {
		definition: { type: string };
		scope: 'workspace';
		name: string;
		source: string;
		presentation: {
			reveal: 'always';
			panel: 'dedicated';
			clear: boolean;
		};
	};
}

export interface WinappToolTaskRuntime<TExecution, TTask, TResult> {
	createProcessExecution: (
		executable: string,
		args: string[],
		options: { cwd: string; env: Record<string, string> }
	) => TExecution;
	createTask: (
		definition: { type: string },
		scope: 'workspace',
		name: string,
		source: string,
		execution: TExecution
	) => TTask;
	setPresentation: (
		task: TTask,
		presentation: { reveal: 'always'; panel: 'dedicated'; clear: boolean }
	) => void;
	executeTask: (task: TTask) => PromiseLike<TResult>;
}

/**
 * Split user-entered tool arguments without invoking a command shell.
 * Whitespace separates arguments and double quotes group values. Runs of backslashes
 * follow the Windows CommandLineToArgvW convention when immediately followed
 * by a double quote; otherwise backslashes are preserved.
 */
export function parseToolArguments(input: string): string[] {
	const args: string[] = [];
	let current = '';
	let quoted = false;
	let argumentStarted = false;

	for (let index = 0; index < input.length; index++) {
		const character = input[index];

		if (character === '\\') {
			let backslashCount = 1;
			while (input[index + backslashCount] === '\\') {
				backslashCount++;
			}

			const next = input[index + backslashCount];
			if (next === '"') {
				current += '\\'.repeat(Math.floor(backslashCount / 2));
				index += backslashCount;
				if (backslashCount % 2 === 0) {
					quoted = !quoted;
				} else {
					current += '"';
				}
			} else {
				current += '\\'.repeat(backslashCount);
				index += backslashCount - 1;
			}
			argumentStarted = true;
			continue;
		}

		if (character === '"') {
			quoted = !quoted;
			argumentStarted = true;
			continue;
		}

		if (/\s/.test(character)) {
			if (!quoted && argumentStarted) {
				args.push(current);
				current = '';
				argumentStarted = false;
			}
			if (!quoted) {
				continue;
			} else {
				current += character;
				argumentStarted = true;
			}
			continue;
		}

		current += character;
		argumentStarted = true;
	}

	if (quoted) {
		throw new Error('Unterminated double quote.');
	}

	if (argumentStarted) {
		args.push(current);
	}

	return args;
}

export function buildWinappToolArgs(toolName: string, argumentText?: string): string[] {
	return ['tool', toolName, ...parseToolArguments(argumentText || '')];
}

export async function resolveWinappToolInvocation(
	cliPath: string,
	cwd: string,
	prompts: WinappToolPrompts
): Promise<WinappToolInvocation | undefined> {
	const toolSelection = await prompts.selectTool();
	if (!toolSelection) {
		return undefined;
	}

	const toolName = toolSelection === 'other'
		? await prompts.promptForToolName()
		: toolSelection;
	if (!toolName) {
		return undefined;
	}

	const argumentText = await prompts.promptForArguments(toolName);
	if (argumentText === undefined) {
		return undefined;
	}

	return {
		cliPath,
		cwd,
		args: buildWinappToolArgs(toolName, argumentText)
	};
}

export function createWinappToolTaskSpec(
	invocation: WinappToolInvocation,
	callerValue: string
): WinappToolTaskSpec {
	return {
		process: {
			executable: invocation.cliPath,
			args: invocation.args,
			options: {
				cwd: invocation.cwd,
				env: {
					WINAPP_CLI_CALLER: callerValue
				}
			}
		},
		task: {
			definition: { type: 'winapp-tool' },
			scope: 'workspace',
			name: 'Run SDK Tool',
			source: 'WinApp',
			presentation: {
				reveal: 'always',
				panel: 'dedicated',
				clear: true
			}
		}
	};
}

export async function executeWinappToolTask<TExecution, TTask, TResult>(
	spec: WinappToolTaskSpec,
	runtime: WinappToolTaskRuntime<TExecution, TTask, TResult>
): Promise<TResult> {
	const execution = runtime.createProcessExecution(
		spec.process.executable,
		spec.process.args,
		spec.process.options
	);
	const task = runtime.createTask(
		spec.task.definition,
		spec.task.scope,
		spec.task.name,
		spec.task.source,
		execution
	);
	runtime.setPresentation(task, spec.task.presentation);
	return runtime.executeTask(task);
}
