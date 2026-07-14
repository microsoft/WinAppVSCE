import * as vscode from 'vscode';
import * as path from 'path';
import { spawn } from 'child_process';
import { getWinappCliPath, WINAPP_CLI_CALLER_VALUE, escapePowerShellArg } from './winapp-cli-utils';
import { detectProjects } from './project-detection';
import { resolveProjectDirectory as resolveProjectDirectoryCore } from './project-resolver';
import { glob } from 'glob';
import { ManifestEditorProvider } from './manifest-editor/manifest-editor-provider';
import {
	DEBUGGER_CHOICE_LABELS,
	chooseInstalledDebuggerType,
	getDebuggerExtensionRequirement,
	getDebuggerTypeFromChoice,
	inferDebuggerTypeFromProject
} from './debugger-resolver';

const WINAPP_DEBUG_TYPE = 'winapp';

/**
 * Output channel for debugger-related activity (e.g. auto-installed extensions),
 * so the user has a durable record of why WinApp added an extension. Created lazily.
 */
let debuggerLogChannel: vscode.OutputChannel | undefined;

function logDebuggerActivity(message: string): void {
	if (!debuggerLogChannel) {
		debuggerLogChannel = vscode.window.createOutputChannel('WinApp Debugger');
	}
	debuggerLogChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
	console.log(`[WinApp] ${message}`);
}

/**
 * Install a VS Code extension and activate it in this session so debugging can
 * continue without a full window reload. If VS Code hasn't surfaced it to this
 * extension host yet, fall back to prompting the user to reload.
 * `reason` explains why the extension is being added and is written to the
 * "WinApp Debugger" output channel so the change isn't a surprise to the user.
 * Returns true if the extension is installed and usable now, false otherwise.
 */
async function installAndActivateExtension(
	requirement: { id: string; name: string },
	reason: string
): Promise<boolean> {
	logDebuggerActivity(`Installing ${requirement.name} (${requirement.id}) because ${reason}.`);
	try {
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `Installing ${requirement.name}…` },
			async () => {
				await vscode.commands.executeCommand('workbench.extensions.installExtension', requirement.id);
			}
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(
			`Failed to install ${requirement.name}: ${message}. Please install it manually and retry.`
		);
		return false;
	}

	const installed = vscode.extensions.getExtension(requirement.id);
	if (!installed) {
		vscode.window.showInformationMessage(
			`${requirement.name} was installed. Reload VS Code to finish enabling it, then start debugging again.`,
			'Reload Window'
		).then((selection) => {
			if (selection === 'Reload Window') {
				vscode.commands.executeCommand('workbench.action.reloadWindow');
			}
		});
		return false;
	}

	if (!installed.isActive) {
		try {
			await installed.activate();
		} catch {
			// Non-fatal: the debugger contribution is registered on install, so
			// proceed and let the attach step surface any remaining issue.
		}
	}

	logDebuggerActivity(`${requirement.name} installed and ready.`);
	vscode.window.showInformationMessage(
		`WinApp installed ${requirement.name} to debug your app. See the "WinApp Debugger" output channel for details.`
	);
	return true;
}

/**
 * Show a modal letting the user pick and install the debugger extension that
 * matches their project (C#/.NET, C/C++, or Node/Electron). Used both on first run (no debuggerType)
 * and when an attach fails because the installed debugger doesn't match the
 * project. Returns the resolved debugger type, or undefined if cancelled.
 */
async function promptAndInstallDebuggerChoice(message: string, reason: string): Promise<string | undefined> {
	const choice = await vscode.window.showErrorMessage(
		message,
		{ modal: true },
		DEBUGGER_CHOICE_LABELS.installCsharp,
		DEBUGGER_CHOICE_LABELS.installCpp,
		DEBUGGER_CHOICE_LABELS.useNode
	);

	const selected = getDebuggerTypeFromChoice(choice);
	if (!selected) {
		return undefined;
	}

	const requirement = getDebuggerExtensionRequirement(selected);
	if (!requirement) {
		return selected;
	}
	return (await installAndActivateExtension(requirement, reason)) ? selected : undefined;
}

/**
 * Check that the VS Code extension required for the given debugger type is installed.
 * If it is not installed, show an actionable modal offering to install it.
 * Returns true if the extension is present (or the debugger type has no known requirement),
 * false if the extension is missing and wasn't installed.
 */
async function ensureDebuggerExtensionInstalled(debuggerType: string): Promise<boolean> {
	const requirement = getDebuggerExtensionRequirement(debuggerType);
	if (!requirement) {
		return true;
	}

	if (vscode.extensions.getExtension(requirement.id)) {
		return true;
	}

	// Use a modal so the user makes a deliberate choice before the session starts,
	// rather than a passive notification they can miss (see issue #32).
	const choice = await vscode.window.showErrorMessage(
		`The WinApp debugger needs the ${requirement.name} extension to debug "${debuggerType}" apps, but it isn't installed.`,
		{ modal: true },
		'Install and Retry'
	);

	if (choice !== 'Install and Retry') {
		return false;
	}

	return installAndActivateExtension(
		requirement,
		`the "${debuggerType}" debugger configured for this launch requires it`
	);
}

/**
 * Resolve the debugger type for a session and make sure its backing extension is
 * installed. When the configuration specifies a debuggerType, ensure that one.
 * When it doesn't (e.g. first F5 with no launch.json), reuse an already-installed
 * debugger extension if there is one, otherwise let the user pick the extension
 * that matches their project type (C#/.NET, C/C++, or Node/Electron) instead of guessing.
 * Returns the resolved debugger type, or undefined if the user cancelled.
 */
async function resolveDebuggerType(
	explicitType: string | undefined,
	folder: vscode.WorkspaceFolder | undefined
): Promise<string | undefined> {
	if (explicitType) {
		return (await ensureDebuggerExtensionInstalled(explicitType)) ? explicitType : undefined;
	}

	// No debuggerType specified: infer from project files before falling back to
	// installed extension reuse so Node/Electron projects are not misclassified
	// just because a C# or C++ debugger extension is already installed.
	if (folder) {
		const projectFiles = await glob(['**/*.csproj', '**/*.fsproj', '**/*.vbproj', '**/*.vcxproj', '**/package.json'], {
			cwd: folder.uri.fsPath,
			absolute: false,
			nocase: true,
			ignore: ['**/node_modules/**', '**/.git/**', '**/obj/**', '**/bin/**', '**/dist/**', '**/out/**', '**/.vs/**', '**/AppX/**', '**/.winapp/**', '**/packages/**']
		});
		const inferredType = inferDebuggerTypeFromProject(projectFiles);
		if (inferredType) {
			return (await ensureDebuggerExtensionInstalled(inferredType)) ? inferredType : undefined;
		}
	}

	// Reuse an already-installed debugger extension only when project inference
	// is unavailable or ambiguous.
	const installedCandidate = chooseInstalledDebuggerType(vscode.extensions.all.map(extension => extension.id));
	if (installedCandidate) {
		return installedCandidate;
	}

	// First run with nothing installed and no debuggerType configured: let the
	// user choose the debugger that matches their project rather than assuming C#.
	return promptAndInstallDebuggerChoice(
		'Since no "debuggerType" is set, choose the debugger that matches your project type. ' +
		'C#/.NET and C/C++ projects require an extension; Node.js/Electron uses the built-in debugger:',
		'you selected it to debug this project'
	);
}

/**
 * Execute a winapp CLI command and show output in the terminal
 */
async function runWinappCommand(extensionPath: string, command: string, cwd: string, showTerminal: boolean = true): Promise<string> {
	const cliPath = getWinappCliPath(extensionPath);
	const terminal = vscode.window.createTerminal({
		name: 'WinApp CLI',
		cwd: cwd,
		shellPath: 'powershell.exe',
		env: { WINAPP_CLI_CALLER: WINAPP_CLI_CALLER_VALUE }
	});

	if (showTerminal) {
		terminal.show();
	}

	terminal.sendText(`& ${escapePowerShellArg(cliPath)} ${command}`);
	return '';
}

/**
 * Resolves the project directory for commands that need a winapp project context.
 * Priority: 1) winapp.appDirectories setting, 2) project at workspace root, 3) scan workspace.
 * Returns the absolute path to the selected project directory, or undefined if cancelled.
 *
 * The resolution logic lives in `project-resolver.ts`; this wrapper supplies the
 * VS Code-backed dependencies (settings, QuickPick, progress UI).
 */
async function resolveProjectDirectory(workspacePath: string): Promise<string | undefined> {
	return resolveProjectDirectoryCore(workspacePath, {
		getAppDirectories: () =>
			vscode.workspace.getConfiguration('winapp').get<string[]>('appDirectories', []),
		showWarning: (message) => {
			vscode.window.showWarningMessage(message);
		},
		pickDirectory: async (items, placeHolder) => {
			const picked = await vscode.window.showQuickPick(items, { placeHolder });
			return picked?.directory;
		},
		scanProjects: async (root) =>
			vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: 'Searching for app projects...' },
				async () => detectProjects(root)
			)
	});
}

/**
 * Get the current workspace folder path
 */
function getWorkspacePath(): string | undefined {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || workspaceFolders.length === 0) {
		vscode.window.showErrorMessage('No workspace folder open');
		return undefined;
	}
	return workspaceFolders[0].uri.fsPath;
}

/**
 * Prompt user to select a file
 */
async function selectFile(title: string, filters?: { [name: string]: string[] }): Promise<string | undefined> {
	const result = await vscode.window.showOpenDialog({
		canSelectFiles: true,
		canSelectFolders: false,
		canSelectMany: false,
		title: title,
		filters: filters
	});

	return result?.[0]?.fsPath;
}

/**
 * Prompt user to select a folder
 */
async function selectFolder(title: string): Promise<string | undefined> {
	const result = await vscode.window.showOpenDialog({
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: false,
		title: title
	});

	return result?.[0]?.fsPath;
}

class WinAppDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
	private extensionPath: string;

	constructor(extensionPath: string) {
		this.extensionPath = extensionPath;
	}

	async resolveDebugConfiguration(
		folder: vscode.WorkspaceFolder | undefined,
		config: vscode.DebugConfiguration,
		_token?: vscode.CancellationToken
	): Promise<vscode.DebugConfiguration | undefined> {
		// If no configuration, create a default one
		if (!config.type && !config.request && !config.name) {
			config.type = WINAPP_DEBUG_TYPE;
			config.name = 'WinApp: Launch and Attach';
			config.request = 'launch';
		}

		// Ensure the extension backing the underlying debugger is installed before
		// the session starts, so a first-run user isn't dropped into a half-started
		// session (issue #32). When no debuggerType is configured, let the user
		// choose the extension matching their project instead of assuming coreclr.
		const debuggerType = await resolveDebuggerType(config.debuggerType, folder);
		if (!debuggerType) {
			return undefined;
		}
		// Persist the resolved type so the attach step uses the matching debugger.
		config.debuggerType = debuggerType;

		return config;
	}

	async resolveDebugConfigurationWithSubstitutedVariables(
		folder: vscode.WorkspaceFolder | undefined,
		config: vscode.DebugConfiguration,
		_token?: vscode.CancellationToken
	): Promise<vscode.DebugConfiguration | undefined> {
		if (!folder) {
			vscode.window.showErrorMessage('No workspace folder open');
			return undefined;
		}

		return config;
	}
}

class WinAppDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
	private extensionPath: string;

	constructor(extensionPath: string) {
		this.extensionPath = extensionPath;
	}

	async createDebugAdapterDescriptor(
		session: vscode.DebugSession,
		_executable: vscode.DebugAdapterExecutable | undefined
	): Promise<vscode.DebugAdapterDescriptor> {
		const config = session.configuration;
		const folder = session.workspaceFolder;

		if (!folder) {
			throw new Error('No workspace folder open');
		}

		try {
			// The run command requires an input-folder positional argument.
			// If not set in launch.json, search for folders containing .exe
			// files and let the user pick one.
			let inputFolder: string | undefined = config.inputFolder;
			if (!inputFolder) {
				const exeMatches = await glob('**/*.exe', {
					cwd: folder.uri.fsPath,
					absolute: true,
					nocase: true,
					ignore: ['**/node_modules/**', '**/.git/**', '**/AppX/**', '**/.winapp/**', '**/obj/**', '**/.vs/**', '**/packages/**']
				});

				// Collect unique parent directories that contain .exe files
				const dirSet = new Set<string>();
				for (const exe of exeMatches) {
					dirSet.add(path.dirname(exe));
				}

				if (dirSet.size === 0) {
					throw new Error('No folders containing .exe files found in the workspace. Build your project first, or set "inputFolder" in launch.json.');
				}

				const dirs = [...dirSet].sort();
				if (dirs.length === 1) {
					inputFolder = dirs[0];
				} else {
					const items = dirs.map(d => ({
						label: path.relative(folder.uri.fsPath, d),
						description: d,
						fsPath: d
					}));
					const picked = await vscode.window.showQuickPick(items, {
						placeHolder: 'Select the build output folder containing your app'
					});
					if (!picked) {
						throw new Error('No build output folder selected, cancelling debug session.');
					}
					inputFolder = picked.fsPath;
				}
			}

			const cliPath = getWinappCliPath(this.extensionPath);
			const baseSpawnArgs = ['run', inputFolder];

			// Optional explicit manifest path; when omitted the CLI
			// auto-detects from the input folder or current directory.
			if (config.manifest) {
				baseSpawnArgs.push('--manifest', config.manifest);
			}

			if (config.outputAppxDirectory) {
				baseSpawnArgs.push('--output-appx-directory', config.outputAppxDirectory);
			}

			// Determine the debugger type based on config or default to coreclr
			const debuggerType = config.debuggerType || 'coreclr';

			// Safety net: resolveDebugConfiguration already verifies the required
			// extension before the session starts, but re-check here so we never
			// launch the process only to fail on attach if resolution was bypassed.
			if (!await ensureDebuggerExtensionInstalled(debuggerType)) {
				return new vscode.DebugAdapterInlineImplementation(new NoOpDebugAdapter());
			}

			const buildAttachDebugConfiguration = (currentDebuggerType: string, processId: number): vscode.DebugConfiguration => {
				const debugConfiguration: vscode.DebugConfiguration = {
					type: currentDebuggerType,
					name: config.name || 'Attach to WinApp Package',
					request: 'attach'
				};

				if (currentDebuggerType === 'node') {
					debugConfiguration.port = config.port || 9229;
				} else {
					debugConfiguration.processId = processId;
				}

				return debugConfiguration;
			};

			const launchAndAttach = async (currentDebuggerType: string): Promise<ReturnType<typeof spawn> | undefined> => {
				const spawnArgs = [...baseSpawnArgs];
				let args = config.args || '';
				if (currentDebuggerType === 'node') {
					args = '--inspect' + (config.port ? `=${config.port}` : '') + ' ' + args;
				}

				if (args.trim()) {
					spawnArgs.push('--args', args.trim());
				}

				spawnArgs.push('--json');

				// Spawn winapp run --json. The process stays alive while the app runs,
				// so we stream stdout to parse the JSON with the PID before waiting for exit.
				const { processId, runProcess } = await vscode.window.withProgress({
					location: vscode.ProgressLocation.Notification,
					title: 'Launching package...',
					cancellable: false
				}, async (progress) => {
					progress.report({ message: 'Running winapp run...' });

					let cwd = folder.uri.fsPath;
					if (config.workingDirectory) {
						cwd = config.workingDirectory;
					}

					return new Promise<{ processId: number; runProcess: ReturnType<typeof spawn> }>((resolve, reject) => {
						const child = spawn(cliPath, spawnArgs, {
							cwd,
							env: { ...process.env, WINAPP_CLI_CALLER: WINAPP_CLI_CALLER_VALUE },
							shell: false
						});

						let stdout = '';
						let stderr = '';
						let resolved = false;

						child.stdout!.on('data', (data: Buffer) => {
							stdout += data.toString();
							if (resolved) { return; }

							const pid = parseProcessIdFromJson(stdout);
							if (pid) {
								resolved = true;
								resolve({ processId: pid, runProcess: child });
							}
						});

						child.stderr!.on('data', (data: Buffer) => {
							stderr += data.toString();
							console.warn('winapp run stderr:', data.toString());
						});

						child.on('error', (err) => {
							if (!resolved) {
								reject(new Error(`Failed to start winapp run: ${err.message}`));
							}
						});

						child.on('close', (code) => {
							if (!resolved) {
								if (code !== 0) {
									reject(new Error(`winapp run exited with code ${code}. stderr: ${stderr}\nstdout: ${stdout}`));
								} else {
									reject(new Error(`winapp run exited before returning a process ID. stdout: ${stdout}`));
								}
							}
						});
					});
				});

				let runProcessExited = false;
				let earlyWatchSettled = false;
				let earlyWatchTimeout: ReturnType<typeof setTimeout> | undefined;
				let resolveEarlyAttachFailure: (failed: boolean) => void = () => { };
				let terminateDisposable: vscode.Disposable | undefined;
				const finishEarlyAttachWatch = (failed: boolean): void => {
					if (earlyWatchSettled) {
						return;
					}
					earlyWatchSettled = true;
					if (earlyWatchTimeout) {
						clearTimeout(earlyWatchTimeout);
					}
					terminateDisposable?.dispose();
					resolveEarlyAttachFailure(failed);
				};

				const earlyAttachFailure = new Promise<boolean>((resolve) => {
					resolveEarlyAttachFailure = resolve;
					earlyWatchTimeout = setTimeout(() => finishEarlyAttachWatch(false), 1500);
				});

				runProcess.once('close', () => {
					runProcessExited = true;
					finishEarlyAttachWatch(false);
				});

				terminateDisposable = vscode.debug.onDidTerminateDebugSession((ended) => {
					if (ended.parentSession === session && !runProcessExited) {
						finishEarlyAttachWatch(true);
					}
				});

				const debugConfiguration = buildAttachDebugConfiguration(currentDebuggerType, processId);
				try {
					const started = await vscode.debug.startDebugging(folder, debugConfiguration, { parentSession: session });
					if (!started) {
						finishEarlyAttachWatch(false);
						runProcess.kill();
						return undefined;
					}
				} catch (error) {
					finishEarlyAttachWatch(false);
					runProcess.kill();
					throw error;
				}

				if (await earlyAttachFailure) {
					runProcess.kill();
					return undefined;
				}

				return runProcess;
			};

			// Start the real debug session as a child of the winapp session.
			// startDebugging resolves false when the child debugger can't attach —
			// most commonly because the installed debugger extension doesn't match
			// the project type (e.g. a C# extension was reused for a C/C++ app).
			let runProcess = await launchAndAttach(debuggerType);
			if (!runProcess) {
				const debuggerName = getDebuggerExtensionRequirement(debuggerType)?.name ?? `"${debuggerType}"`;
				const retryDebuggerType = await promptAndInstallDebuggerChoice(
					`The ${debuggerName} debugger couldn't attach to your app. ` +
					`This usually means the installed debugger extension doesn't match your project type. ` +
					`Choose the debugger that matches your project so WinApp can retry:`,
					'you selected it after the previous debugger failed to attach'
				);
				if (retryDebuggerType) {
					runProcess = await launchAndAttach(retryDebuggerType);
					if (!runProcess) {
						const retryDebuggerName = getDebuggerExtensionRequirement(retryDebuggerType)?.name ?? `"${retryDebuggerType}"`;
						vscode.window.showErrorMessage(
							`The ${retryDebuggerName} debugger still couldn't attach to your app. Check your project type and debugger configuration, then try again.`
						);
					}
				}

				if (!runProcess) {
					return new vscode.DebugAdapterInlineImplementation(new NoOpDebugAdapter());
				}
			}

			// When the child debug session ends, kill the winapp run process and stop the parent session
			const parentSession = session;
			const disposable = vscode.debug.onDidTerminateDebugSession((ended) => {
				if (ended.parentSession === parentSession) {
					disposable.dispose();
					runProcess.kill();
					vscode.debug.stopDebugging(parentSession);
				}
			});

			// When the winapp run process exits (app closed), stop the debug session
			runProcess.on('close', () => {
				vscode.debug.stopDebugging(parentSession);
			});

			// Return an inline no-op adapter — the real debugging happens in the child session above
			return new vscode.DebugAdapterInlineImplementation(new NoOpDebugAdapter());
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`Failed to launch and attach: ${message}`);
			throw error;
		}
	}
}

/**
 * A minimal no-op debug adapter. The winapp debug type doesn't need a real adapter
 * since we delegate to a child debug session (coreclr/node).
 */
class NoOpDebugAdapter implements vscode.DebugAdapter {
	private sendMessageEmitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
	readonly onDidSendMessage: vscode.Event<vscode.DebugProtocolMessage> = this.sendMessageEmitter.event;

	handleMessage(message: vscode.DebugProtocolMessage): void {
		// Respond to the initialize request so VS Code doesn't hang
		const msg = message as any;
		if (msg.type === 'request' && msg.command === 'initialize') {
			this.sendMessageEmitter.fire({
				type: 'response',
				request_seq: msg.seq,
				success: true,
				command: msg.command,
				seq: 0
			} as any);
		} else if (msg.type === 'request' && msg.command === 'disconnect') {
			this.sendMessageEmitter.fire({
				type: 'response',
				request_seq: msg.seq,
				success: true,
				command: msg.command,
				seq: 0
			} as any);
		}
	}

	dispose(): void {
		this.sendMessageEmitter.dispose();
	}
}

export function activate(context: vscode.ExtensionContext) {
	const extensionPath = context.extensionPath;
	const provider = new WinAppDebugConfigurationProvider(extensionPath);

	context.subscriptions.push(
		vscode.debug.registerDebugConfigurationProvider(WINAPP_DEBUG_TYPE, provider)
	);

	const factory = new WinAppDebugAdapterFactory(extensionPath);
	context.subscriptions.push(
		vscode.debug.registerDebugAdapterDescriptorFactory(WINAPP_DEBUG_TYPE, factory)
	);

	// Register the AppxManifest visual editor
	context.subscriptions.push(ManifestEditorProvider.register(context));

	// When an appxmanifest file is opened in the default text editor,
	// suggest switching to the visual editor.
	const MANIFEST_PATTERN = /(?:^|[\\/])appxmanifest\.xml$|\.appxmanifest$/i;
	const dismissedKey = 'winapp.manifestEditorNotificationDismissed';

	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(editor => {
			if (!editor || editor.document.uri.scheme !== 'file') { return; }
			if (!MANIFEST_PATTERN.test(editor.document.uri.fsPath)) { return; }
			if (context.globalState.get<boolean>(dismissedKey)) { return; }

			vscode.window.showInformationMessage(
				'This file can be opened with the WinApp visual manifest editor for a richer editing experience.',
				'Open with AppxManifest Editor',
				"Don't Show Again",
			).then(choice => {
				if (choice === 'Open with AppxManifest Editor') {
					vscode.commands.executeCommand('vscode.openWith', editor.document.uri, ManifestEditorProvider.viewType);
				} else if (choice === "Don't Show Again") {
					context.globalState.update(dismissedKey, true);
				}
			});
		})
	);

	// Register winapp.init command
	context.subscriptions.push(
		vscode.commands.registerCommand('winapp.init', async () => {
			const workspacePath = getWorkspacePath();
			if (!workspacePath) {
				return;
			}

			// Resolve project directory (honors appDirectories setting)
			const projectDir = await resolveProjectDirectory(workspacePath);
			if (!projectDir) {
				return;
			}

			const selectedPath = path.relative(workspacePath, projectDir) || '.';

			const sdkMode = await vscode.window.showQuickPick(
				['stable', 'preview', 'experimental', 'none'],
				{ placeHolder: 'Select SDK installation mode' }
			);

			let command = `init ${escapePowerShellArg(selectedPath)} --use-defaults`;
			if (sdkMode && sdkMode !== 'stable') {
				command += ` --setup-sdks ${sdkMode}`;
			}

			await runWinappCommand(extensionPath, command, workspacePath);
		})
	);

	// Register winapp.restore command
	context.subscriptions.push(
		vscode.commands.registerCommand('winapp.restore', async () => {
			const workspacePath = getWorkspacePath();
			if (!workspacePath) {
				return;
			}

			const projectDir = await resolveProjectDirectory(workspacePath);
			if (!projectDir) {
				return;
			}

			await runWinappCommand(extensionPath, 'restore', projectDir);
		})
	);

	// Register winapp.update command
	context.subscriptions.push(
		vscode.commands.registerCommand('winapp.update', async () => {
			const workspacePath = getWorkspacePath();
			if (!workspacePath) {
				return;
			}

			const projectDir = await resolveProjectDirectory(workspacePath);
			if (!projectDir) {
				return;
			}

			const sdkMode = await vscode.window.showQuickPick(
				['stable', 'preview', 'experimental'],
				{ placeHolder: 'Select SDK installation mode (optional)' }
			);

			let command = 'update';
			if (sdkMode && sdkMode !== 'stable') {
				command += ` --setup-sdks ${sdkMode}`;
			}

			await runWinappCommand(extensionPath, command, projectDir);
		})
	);

	// Register winapp.pack command
	context.subscriptions.push(
		vscode.commands.registerCommand('winapp.pack', async () => {
			const workspacePath = getWorkspacePath();
			if (!workspacePath) {
				return;
			}

			const inputFolder = await selectFolder('Select input folder to package');
			if (!inputFolder) {
				return;
			}

			const generateCert = await vscode.window.showQuickPick(
				['Yes', 'No'],
				{ placeHolder: 'Generate and install a development certificate?' }
			);

			const selfContained = await vscode.window.showQuickPick(
				['Yes', 'No'],
				{ placeHolder: 'Bundle Windows App SDK runtime (self-contained)?' }
			);

			let command = `pack ${escapePowerShellArg(inputFolder)}`;
			if (generateCert === 'Yes') {
				command += ' --generate-cert --install-cert';
			}
			if (selfContained === 'Yes') {
				command += ' --self-contained';
			}

			await runWinappCommand(extensionPath, command, workspacePath);
		})
	);

	// Register winapp.run command
	context.subscriptions.push(
		vscode.commands.registerCommand('winapp.run', async () => {
			const workspacePath = getWorkspacePath();
			if (!workspacePath) {
				return;
			}

			const inputFolder = await selectFolder('Select input folder containing the app to run');
			if (!inputFolder) {
				return;
			}

			await runWinappCommand(extensionPath, `run ${escapePowerShellArg(inputFolder)}`, workspacePath);
		})
	);

	// Register winapp.createDebugIdentity command
	context.subscriptions.push(
		vscode.commands.registerCommand('winapp.createDebugIdentity', async () => {
			const workspacePath = getWorkspacePath();
			if (!workspacePath) {
				return;
			}
			const entrypoint = await selectFile('Select executable', {
				'Executables': ['exe'],
				'All files': ['*']
			});

			let command = 'create-debug-identity';
			if (entrypoint) {
				command += ` ${escapePowerShellArg(entrypoint)}`;
			}

			await runWinappCommand(extensionPath, command, workspacePath);
		})
	);

	// Register winapp.manifestGenerate command
	context.subscriptions.push(
		vscode.commands.registerCommand('winapp.manifestGenerate', async () => {
			const workspacePath = getWorkspacePath();
			if (!workspacePath) {
				return;
			}

			const projectDir = await resolveProjectDirectory(workspacePath);
			if (!projectDir) {
				return;
			}

			const template = await vscode.window.showQuickPick(
				['packaged', 'sparse'],
				{ placeHolder: 'Select manifest template type' }
			);

			let command = 'manifest generate';
			if (template) {
				command += ` --template ${template}`;
			}

			await runWinappCommand(extensionPath, command, projectDir);
		})
	);

	// Register winapp.manifestUpdateAssets command
	context.subscriptions.push(
		vscode.commands.registerCommand('winapp.manifestUpdateAssets', async () => {
			const workspacePath = getWorkspacePath();
			if (!workspacePath) {
				return;
			}

			const projectDir = await resolveProjectDirectory(workspacePath);
			if (!projectDir) {
				return;
			}

			const imagePath = await selectFile('Select source image for assets', {
				'Images': ['png', 'jpg', 'jpeg', 'gif', 'bmp']
			});

			if (!imagePath) {
				vscode.window.showErrorMessage('An image file is required');
				return;
			}

			await runWinappCommand(extensionPath, `manifest update-assets ${escapePowerShellArg(imagePath)}`, projectDir);
		})
	);

	// Register winapp.certGenerate command
	context.subscriptions.push(
		vscode.commands.registerCommand('winapp.certGenerate', async () => {
			const workspacePath = getWorkspacePath();
			if (!workspacePath) {
				return;
			}

			const projectDir = await resolveProjectDirectory(workspacePath);
			if (!projectDir) {
				return;
			}

			const install = await vscode.window.showQuickPick(
				['Yes', 'No'],
				{ placeHolder: 'Install certificate after generation?' }
			);

			let command = 'cert generate';
			if (install === 'Yes') {
				command += ' --install';
			}

			await runWinappCommand(extensionPath, command, projectDir);
		})
	);

	// Register winapp.certInstall command
	context.subscriptions.push(
		vscode.commands.registerCommand('winapp.certInstall', async () => {
			const workspacePath = getWorkspacePath();
			if (!workspacePath) {
				return;
			}

			const certPath = await selectFile('Select certificate to install', {
				'Certificates': ['pfx', 'cer']
			});

			if (!certPath) {
				vscode.window.showErrorMessage('A certificate file is required');
				return;
			}

			await runWinappCommand(extensionPath, `cert install ${escapePowerShellArg(certPath)}`, workspacePath);
		})
	);

	// Register winapp.sign command
	context.subscriptions.push(
		vscode.commands.registerCommand('winapp.sign', async () => {
			const workspacePath = getWorkspacePath();
			if (!workspacePath) {
				return;
			}

			const filePath = await selectFile('Select file to sign', {
				'MSIX Packages': ['msix', 'appx'],
				'Executables': ['exe', 'dll'],
				'All files': ['*']
			});

			if (!filePath) {
				vscode.window.showErrorMessage('A file to sign is required');
				return;
			}

			const certPath = await selectFile('Select signing certificate', {
				'Certificates': ['pfx']
			});

			if (!certPath) {
				vscode.window.showErrorMessage('A certificate file is required');
				return;
			}

			await runWinappCommand(extensionPath, `sign ${escapePowerShellArg(filePath)} --cert ${escapePowerShellArg(certPath)}`, workspacePath);
		})
	);

	// Register winapp.tool command
	context.subscriptions.push(
		vscode.commands.registerCommand('winapp.tool', async () => {
			const workspacePath = getWorkspacePath();
			if (!workspacePath) {
				return;
			}

			const toolSelection = await vscode.window.showQuickPick(
				['makeappx', 'signtool', 'mt', 'makepri', 'other'],
				{ placeHolder: 'Select Windows SDK tool' }
			);

			if (!toolSelection) {
				return;
			}

			let toolName: string;
			if (toolSelection === 'other') {
				const customTool = await vscode.window.showInputBox({
					prompt: 'Enter the Windows SDK tool name',
					placeHolder: 'e.g., custom-tool'
				});

				if (!customTool) {
					return;
				}
				toolName = customTool;
			} else {
				toolName = toolSelection;
			}

			const args = await vscode.window.showInputBox({
				prompt: `Enter arguments for ${toolName}`,
				placeHolder: 'e.g., --help'
			});

			let command = `tool ${escapePowerShellArg(toolName)}`;
			if (args) {
				// args is a raw, multi-token passthrough for the selected tool
				// (e.g. "--foo bar /p:baz"), so it is intentionally not quoted as a
				// single literal. toolName is escaped above because it is a single value.
				command += ` ${args}`;
			}

			await runWinappCommand(extensionPath, command, workspacePath);
		})
	);

	// Register winapp.getWinappPath command
	context.subscriptions.push(
		vscode.commands.registerCommand('winapp.getWinappPath', async () => {
			const workspacePath = getWorkspacePath();
			if (!workspacePath) {
				return;
			}

			const projectDir = await resolveProjectDirectory(workspacePath);
			if (!projectDir) {
				return;
			}

			const global = await vscode.window.showQuickPick(
				['Local (.winapp in workspace)', 'Global (shared cache)'],
				{ placeHolder: 'Which path to retrieve?' }
			);

			let command = 'get-winapp-path';
			if (global === 'Global (shared cache)') {
				command += ' --global';
			}

			await runWinappCommand(extensionPath, command, projectDir);
		})
	);

	// Register winapp.manifestAddAlias command
	context.subscriptions.push(
		vscode.commands.registerCommand('winapp.manifestAddAlias', async () => {
			const workspacePath = getWorkspacePath();
			if (!workspacePath) {
				return;
			}

			const projectDir = await resolveProjectDirectory(workspacePath);
			if (!projectDir) {
				return;
			}

			await runWinappCommand(extensionPath, 'manifest add-alias', projectDir);
		})
	);

	// Register winapp.unregister command
	context.subscriptions.push(
		vscode.commands.registerCommand('winapp.unregister', async () => {
			const workspacePath = getWorkspacePath();
			if (!workspacePath) {
				return;
			}

			const projectDir = await resolveProjectDirectory(workspacePath);
			if (!projectDir) {
				return;
			}

			await runWinappCommand(extensionPath, 'unregister', projectDir);
		})
	);

	// Register winapp.certInfo command
	// This command only inspects a certificate file and does not require a workspace.
	context.subscriptions.push(
		vscode.commands.registerCommand('winapp.certInfo', async () => {
			const certPath = await selectFile('Select certificate file', {
				'Certificates': ['pfx', 'cer']
			});

			if (!certPath) {
				vscode.window.showErrorMessage('A certificate file is required');
				return;
			}

			const password = await vscode.window.showInputBox({
				prompt: 'Enter certificate password (leave empty for default)',
				password: true
			});

			// Use spawn with an args array (shell: false) to avoid exposing
			// the password in terminal history and to prevent argument injection.
			const cliPath = getWinappCliPath(extensionPath);
			const args = ['cert', 'info', certPath];
			if (password) {
				args.push('--password', password);
			}

			// Use the certificate's parent directory as cwd since no workspace is required.
			const cwd = path.dirname(certPath);

			const outputChannel = vscode.window.createOutputChannel('WinApp Cert Info');
			outputChannel.show();
			outputChannel.appendLine(`Running: winapp cert info "${certPath}"`);

			await new Promise<void>((resolve) => {
				const child = spawn(cliPath, args, {
					cwd,
					env: { ...process.env, WINAPP_CLI_CALLER: WINAPP_CLI_CALLER_VALUE },
					shell: false
				});

				child.stdout!.on('data', (data: Buffer) => {
					outputChannel.append(data.toString());
				});

				child.stderr!.on('data', (data: Buffer) => {
					outputChannel.append(data.toString());
				});

				child.on('error', (err) => {
					vscode.window.showErrorMessage(`Failed to run cert info: ${err.message}`);
					resolve();
				});

				child.on('close', (code) => {
					if (code !== 0) {
						outputChannel.appendLine(`\nCommand exited with code ${code}`);
						vscode.window.showErrorMessage('Certificate info command failed. See output for details.');
					}
					resolve();
				});
			});
		})
	);
}

/**
 * Parse the process ID from the winapp run --json output.
 * Expects a JSON object with a processId (or pid) field.
 */
function parseProcessIdFromJson(output: string): number | undefined {
	try {
		const json = JSON.parse(output.trim());
		const pid = json.processId ?? json.pid ?? json.ProcessId ?? json.PID;
		if (typeof pid === 'number' && pid > 0) {
			return pid;
		}
	} catch {
		// JSON not complete yet or invalid
	}
	return undefined;
}

export function deactivate() {
	debuggerLogChannel?.dispose();
	debuggerLogChannel = undefined;
}
