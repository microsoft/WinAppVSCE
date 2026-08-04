import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	buildWinappToolArgs,
	createWinappToolTaskSpec,
	executeWinappToolTask,
	parseToolArguments,
	resolveWinappToolInvocation
} from '../tool-command-utils';
import { WINAPP_CLI_CALLER_VALUE } from '../winapp-cli-utils';

describe('parseToolArguments', () => {
	it('splits ordinary arguments', () => {
		assert.deepEqual(parseToolArguments('/? --verbose value'), ['/?', '--verbose', 'value']);
	});

	it('preserves quoted values and empty arguments', () => {
		assert.deepEqual(
			parseToolArguments('--name "My Package" --empty ""'),
			['--name', 'My Package', '--empty', '']
		);
	});

	it('preserves Windows path separators', () => {
		assert.deepEqual(
			parseToolArguments('/f "C:\\Program Files\\App\\manifest.xml"'),
			['/f', 'C:\\Program Files\\App\\manifest.xml']
		);
	});

	it('preserves an unquoted UNC path', () => {
		assert.deepEqual(parseToolArguments('\\\\server\\share\\folder'), ['\\\\server\\share\\folder']);
	});

	it('preserves a quoted UNC path', () => {
		assert.deepEqual(
			parseToolArguments('"\\\\server\\share\\folder name"'),
			['\\\\server\\share\\folder name']
		);
	});

	it('parses a quoted path ending in a backslash', () => {
		assert.deepEqual(parseToolArguments('"C:\\folder with spaces\\\\"'), ['C:\\folder with spaces\\']);
	});

	it('treats PowerShell metacharacters as argument text', () => {
		assert.deepEqual(
			parseToolArguments('/?; Set-Content injected.txt owned'),
			['/?;', 'Set-Content', 'injected.txt', 'owned']
		);
	});

	it('requires quotes to group whitespace while supporting escaped quotes', () => {
		assert.deepEqual(
			parseToolArguments('one\\ two "say \\"hello\\""'),
			['one\\', 'two', 'say "hello"']
		);
	});

	it('separates an option after an unquoted path ending in a backslash', () => {
		assert.deepEqual(
			parseToolArguments('C:\\output\\ /p app.msix'),
			['C:\\output\\', '/p', 'app.msix']
		);
	});

	it('preserves apostrophes in unquoted Windows paths', () => {
		assert.deepEqual(
			parseToolArguments("C:\\Users\\O'Brien\\file.xml /nologo"),
			["C:\\Users\\O'Brien\\file.xml", '/nologo']
		);
	});

	it('applies Windows backslash runs before double quotes', () => {
		assert.deepEqual(
			parseToolArguments('"two\\\\\\\\slashes" three\\\\\\\\"parts" one\\\\\\"quote'),
			['two\\\\\\\\slashes', 'three\\\\parts', 'one\\"quote']
		);
	});

	it('rejects unterminated quotes', () => {
		assert.throws(() => parseToolArguments('--name "unfinished'), /Unterminated double quote/);
	});
});

describe('buildWinappToolArgs', () => {
	it('keeps the tool name as one argument and appends parsed arguments', () => {
		assert.deepEqual(
			buildWinappToolArgs('custom tool', '--input "C:\\my app"'),
			['tool', 'custom tool', '--input', 'C:\\my app']
		);
	});
	it('maps a tool and argument text to exact argv', () => {
		assert.deepEqual(
			buildWinappToolArgs('mt', '-manifest "\\\\server\\share\\app.manifest"'),
			['tool', 'mt', '-manifest', '\\\\server\\share\\app.manifest']
		);
	});
});

describe('winapp.tool flow', () => {
	it('resolves interactive tool selection and arguments', async () => {
		const invocation = await resolveWinappToolInvocation(
			'C:\\winapp.exe',
			'C:\\workspace',
			{
				selectTool: async () => 'makeappx',
				promptForToolName: async () => {
					throw new Error('known tools do not need a custom name');
				},
				promptForArguments: async toolName => {
					assert.equal(toolName, 'makeappx');
					return '/?';
				}
			}
		);

		assert.deepEqual(invocation?.args, ['tool', 'makeappx', '/?']);
	});

	it('accepts an empty interactive argument response', async () => {
		const invocation = await resolveWinappToolInvocation(
			'C:\\winapp.exe',
			'C:\\workspace',
			{
				selectTool: async () => 'makeappx',
				promptForToolName: async () => {
					throw new Error('known tools do not need a custom name');
				},
				promptForArguments: async toolName => {
					assert.equal(toolName, 'makeappx');
					return '';
				}
			}
		);

		assert.deepEqual(invocation, {
			cliPath: 'C:\\winapp.exe',
			cwd: 'C:\\workspace',
			args: ['tool', 'makeappx']
		});
	});

	it('resolves a custom tool selection and arguments', async () => {
		const invocation = await resolveWinappToolInvocation(
			'C:\\winapp.exe',
			'C:\\workspace',
			{
				selectTool: async () => 'other',
				promptForToolName: async () => 'custom-tool',
				promptForArguments: async toolName => {
					assert.equal(toolName, 'custom-tool');
					return '--input "C:\\my app"';
				}
			}
		);

		assert.deepEqual(invocation, {
			cliPath: 'C:\\winapp.exe',
			cwd: 'C:\\workspace',
			args: ['tool', 'custom-tool', '--input', 'C:\\my app']
		});
	});

	it('stops prompting when tool selection is cancelled', async () => {
		const failLaterPrompt = async () => {
			throw new Error('no later prompt should execute');
		};
		const invocation = await resolveWinappToolInvocation(
			'C:\\winapp.exe',
			'C:\\workspace',
			{
				selectTool: async () => undefined,
				promptForToolName: failLaterPrompt,
				promptForArguments: failLaterPrompt
			}
		);

		assert.equal(invocation, undefined);
	});

	it('stops prompting when the custom tool name is cancelled', async () => {
		const invocation = await resolveWinappToolInvocation(
			'C:\\winapp.exe',
			'C:\\workspace',
			{
				selectTool: async () => 'other',
				promptForToolName: async () => undefined,
				promptForArguments: async () => {
					throw new Error('argument prompt should not execute');
				}
			}
		);

		assert.equal(invocation, undefined);
	});

	it('returns no invocation when the argument prompt is cancelled', async () => {
		const invocation = await resolveWinappToolInvocation(
			'C:\\winapp.exe',
			'C:\\workspace',
			{
				selectTool: async () => 'makeappx',
				promptForToolName: async () => {
					throw new Error('known tools do not need a custom name');
				},
				promptForArguments: async toolName => {
					assert.equal(toolName, 'makeappx');
					return undefined;
				}
			}
		);

		assert.equal(invocation, undefined);
	});

	it('produces the complete process and task specification', () => {
		const spec = createWinappToolTaskSpec({
			cliPath: 'C:\\winapp.exe',
			cwd: 'C:\\workspace',
			args: ['tool', 'mt', '-manifest', 'input.manifest']
		}, WINAPP_CLI_CALLER_VALUE);

		assert.deepEqual(spec, {
			process: {
				executable: 'C:\\winapp.exe',
				args: ['tool', 'mt', '-manifest', 'input.manifest'],
				options: {
					cwd: 'C:\\workspace',
					env: {
						WINAPP_CLI_CALLER: 'vscode-extension'
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
		});
	});

	it('executes the task spec and returns the launched TaskExecution', async () => {
		const spec = createWinappToolTaskSpec({
			cliPath: 'C:\\winapp.exe',
			cwd: 'C:\\workspace',
			args: ['tool', 'mt', '-manifest', 'input.manifest']
		}, WINAPP_CLI_CALLER_VALUE);
		const calls: Array<[string, unknown]> = [];
		const processExecution = { kind: 'ProcessExecution' };
		const task = { kind: 'Task' };
		const taskExecution = { kind: 'TaskExecution' };

		const result = await executeWinappToolTask(spec, {
			createProcessExecution: (executable, args, options) => {
				calls.push(['process', { executable, args, options }]);
				return processExecution;
			},
			createTask: (definition, scope, name, source, execution) => {
				calls.push(['task', { definition, scope, name, source, execution }]);
				return task;
			},
			setPresentation: (createdTask, presentation) => {
				calls.push(['presentation', { task: createdTask, presentation }]);
			},
			executeTask: async createdTask => {
				calls.push(['execute', createdTask]);
				return taskExecution;
			}
		});

		assert.equal(result, taskExecution);
		assert.deepEqual(calls, [
			['process', {
				executable: 'C:\\winapp.exe',
				args: ['tool', 'mt', '-manifest', 'input.manifest'],
				options: {
					cwd: 'C:\\workspace',
					env: {
						WINAPP_CLI_CALLER: 'vscode-extension'
					}
				}
			}],
			['task', {
				definition: { type: 'winapp-tool' },
				scope: 'workspace',
				name: 'Run SDK Tool',
				source: 'WinApp',
				execution: processExecution
			}],
			['presentation', {
				task,
				presentation: { reveal: 'always', panel: 'dedicated', clear: true }
			}],
			['execute', task]
		]);
	});
});
