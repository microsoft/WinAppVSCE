import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, execFile } from 'child_process';
import {
	getWinappCliPath,
	WINAPP_CLI_CALLER_VALUE,
	escapePowerShellArg,
	resolveWindowsPowerShellPath,
	isUsableElevatedCliPath,
	decideElevatedWinappCommand
} from './winapp-cli-utils';
import { detectProjects, deduplicateBuildOutputFolders, BUILD_OUTPUT_EXCLUDE_GLOB, BUILD_OUTPUT_MAX_RESULTS } from './project-detection';
import { resolveProjectDirectory as resolveProjectDirectoryCore } from './project-resolver';
import { ManifestEditorProvider } from './manifest-editor/manifest-editor-provider';
import {
	PACK_ACTIONS,
	getPackNotificationAction,
	isArtifactWithinRoot,
	planPackCompletion
} from './pack-result';
import { findWorkspaceArtifacts, buildSignCommand, CERTIFICATE_GLOBS, executeSignFlow, type SignFlowAdapter } from './sign-utils';
import { ARTIFACT_DIALOG_FILTER, ARTIFACT_GLOBS } from './artifact-types';
import {
	detectArchFromPath,
	getMachineArch,
	checkSelfContainedArchMismatch,
	buildArchMismatchWarning
} from './arch-detection';
import {
	DEBUGGER_CHOICE_LABELS,
	chooseInstalledDebuggerType,
	getDebuggerExtensionRequirement,
	getDebuggerTypeFromChoice,
	validateInputFolder
} from './debugger-resolver';
import { NoOpDebugAdapter } from './noop-debug-adapter';

const WINAPP_DEBUG_TYPE = 'winapp';
const WINDOWS_POWERSHELL_PATH = resolveWindowsPowerShellPath(process.env.SystemRoot);

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
		await vscode.commands.executeCommand('workbench.extensions.installExtension', requirement.id);
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
async function resolveDebuggerType(explicitType: string | undefined): Promise<string | undefined> {
	if (explicitType) {
		return (await ensureDebuggerExtensionInstalled(explicitType)) ? explicitType : undefined;
	}

	// No debuggerType specified: reuse an already-installed debugger extension.
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
 * Shared output channel for capture-based winapp commands (e.g. pack). Created
 * lazily and reused so repeated runs don't leak channels.
 */
let winappOutputChannel: vscode.OutputChannel | undefined;

function getWinappOutputChannel(): vscode.OutputChannel {
	if (!winappOutputChannel) {
		winappOutputChannel = vscode.window.createOutputChannel('WinApp');
	}
	return winappOutputChannel;
}

/**
 * Run a winapp CLI command via `spawn` (shell: false) while capturing its
 * combined stdout/stderr, streaming it to the WinApp output channel and a
 * progress notification. Unlike {@link runWinappCommand}, this waits for the
 * command to finish so callers can inspect the output (e.g. the produced
 * package path).
 *
 * @returns The process exit code and the full captured output.
 */
async function runWinappCapture(
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
					outputChannel.appendLine('\nPackaging cancelled.');
					if (child.pid) {
						// On Windows, winapp pack may spawn helper processes; taskkill /t
						// terminates the whole tree instead of only the direct child.
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

/**
 * Search the workspace for MSIX/APPX artifacts and let the user pick one via
 * a QuickPick. When no artifacts are found the function falls back directly to
 * a native file dialog; a "Browse…" entry is always appended so the user can
 * opt into the dialog even when artifacts *are* discovered.
 *
 * @returns The selected file path, or `undefined` if cancelled.
 */
async function pickSignableFile(workspacePath: string): Promise<string | undefined> {
	let cancelled = false;
	const artifactPaths = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Searching for signable artifacts...', cancellable: true },
		async (_progress, token) => {
			token.onCancellationRequested(() => { cancelled = true; });
			return findWorkspaceArtifacts(workspacePath, ARTIFACT_GLOBS);
		}
	);

	if (cancelled) {
		return undefined;
	}

	if (artifactPaths.length === 0) {
		return selectFile('Select file to sign', {
			...ARTIFACT_DIALOG_FILTER,
			'Executables': ['exe', 'dll'],
			'All files': ['*']
		});
	}

	const items: vscode.QuickPickItem[] = artifactPaths.map((p) => {
		const relDir = path.dirname(path.relative(workspacePath, p));
		return {
			label: path.basename(p),
			description: relDir === '.' ? '' : relDir,
			detail: p
		};
	});

	items.push({ label: '$(folder-opened) Browse…', detail: 'Open a file picker' });

	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: 'Select a package to sign'
	});

	if (!picked) {
		return undefined;
	}

	if (picked.detail === 'Open a file picker') {
		return selectFile('Select file to sign', {
			...ARTIFACT_DIALOG_FILTER,
			'Executables': ['exe', 'dll'],
			'All files': ['*']
		});
	}

	return picked.detail;
}

/**
 * Search the workspace for PFX certificate files and let the user pick one
 * via a QuickPick. Falls back to a native file dialog when none are found;
 * a "Browse…" entry is always appended.
 *
 * @returns The selected certificate path, or `undefined` if cancelled.
 */
async function pickCertificateFile(workspacePath: string): Promise<string | undefined> {
	let cancelled = false;
	const certPaths = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Searching for certificates...', cancellable: true },
		async (_progress, token) => {
			token.onCancellationRequested(() => { cancelled = true; });
			return findWorkspaceArtifacts(workspacePath, CERTIFICATE_GLOBS);
		}
	);

	if (cancelled) {
		return undefined;
	}

	if (certPaths.length === 0) {
		return selectFile('Select signing certificate', {
			'Certificates': ['pfx']
		});
	}

	const items: vscode.QuickPickItem[] = certPaths.map((p) => {
		const relDir = path.dirname(path.relative(workspacePath, p));
		return {
			label: path.basename(p),
			description: relDir === '.' ? '' : relDir,
			detail: p
		};
	});

	items.push({ label: '$(folder-opened) Browse…', detail: 'Open a file picker' });

	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: 'Select a signing certificate'
	});

	if (!picked) {
		return undefined;
	}

	if (picked.detail === 'Open a file picker') {
		return selectFile('Select signing certificate', {
			'Certificates': ['pfx']
		});
	}

	return picked.detail;
}

const FOLDER_PICKER_DETAIL = 'Open a folder picker';

/**
 * Scan the workspace for build output folders (directories containing .exe
 * files). Shows a progress notification with cancel support.
 *
 * @returns The discovered folder paths sorted by relative path, or undefined if cancelled.
 */
async function findBuildOutputFolders(workspacePath: string): Promise<string[] | undefined> {
	let cancelled = false;
	const outputFolders = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Searching for build output folders...', cancellable: true },
		async (_progress, token) => {
			token.onCancellationRequested(() => { cancelled = true; });
			const exeMatches = await vscode.workspace.findFiles(
				new vscode.RelativePattern(workspacePath, '**/*.exe'),
				BUILD_OUTPUT_EXCLUDE_GLOB,
				BUILD_OUTPUT_MAX_RESULTS
			);

			return deduplicateBuildOutputFolders(
				exeMatches.map(m => m.fsPath),
				workspacePath
			);
		}
	);

	if (cancelled) {
		return undefined;
	}

	return outputFolders;
}

/**
 * Search the workspace for build output folders and let the user pick one via
 * a QuickPick. Falls back to a native folder dialog when none are found; a
 * "Browse…" entry is always appended.
 *
 * @returns The selected folder path, or `undefined` if cancelled.
 */
async function pickBuildOutputFolder(workspacePath: string): Promise<string | undefined> {
	const outputFolders = await findBuildOutputFolders(workspacePath);
	if (!outputFolders) {
		return undefined;
	}

	if (outputFolders.length === 0) {
		return selectFolder('Select build output folder', vscode.Uri.file(workspacePath));
	}

	const items: Array<vscode.QuickPickItem & { directory?: string }> = outputFolders.map((folderPath) => ({
		label: path.relative(workspacePath, folderPath) || '.',
		detail: folderPath,
		directory: folderPath
	}));

	items.push({ label: '$(folder-opened) Browse…', detail: FOLDER_PICKER_DETAIL });

	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: 'Select the build output folder containing your app'
	});

	if (!picked) {
		return undefined;
	}

	if (picked.detail === FOLDER_PICKER_DETAIL) {
		return selectFolder('Select build output folder', vscode.Uri.file(workspacePath));
	}

	return picked.directory;
}

/**
 * Run the code-signing flow for an MSIX/executable. Prompts for the file to
 * sign (unless one is supplied) and the signing certificate, then invokes
 * `winapp sign`. Reused by both the `winapp.sign` command and the post-pack
 * completion notification.
 *
 * When invoked without a prefilled path (i.e. from the `winapp.sign` command),
 * the function searches the workspace for MSIX/APPX artifacts and presents
 * them in a QuickPick. A "Browse…" option is always available to fall back to
 * a native file dialog, and the dialog is shown directly when no artifacts are
 * found in the workspace.
 *
 * @param prefilledFilePath When provided, skips the file picker and signs this
 *   path directly (e.g. the MSIX just produced by pack).
 */
async function signPackage(
	extensionPath: string,
	workspacePath: string,
	prefilledFilePath?: string
): Promise<void> {
	const adapter: SignFlowAdapter = {
		pickSignableFile: (wp) => pickSignableFile(wp),
		pickCertificateFile: (wp) => pickCertificateFile(wp),
		runSignCommand: async (ep, cmd, wp) => { await runWinappCommand(ep, cmd, wp); }
	};
	await executeSignFlow(adapter, extensionPath, workspacePath, prefilledFilePath);
}

/**
 * Install (sideload) a packaged MSIX by running `Add-AppxPackage` in a
 * PowerShell terminal. The package must be signed with a trusted certificate
 * for installation to succeed; the terminal surfaces any errors to the user.
 */
function installPackage(artifactPath: string, cwd: string): void {
	const terminal = vscode.window.createTerminal({
		name: 'WinApp Install',
		cwd,
		shellPath: 'powershell.exe'
	});
	terminal.show();
	terminal.sendText(`Add-AppxPackage -Path ${escapePowerShellArg(artifactPath)}`);
}

/**
 * Surface the result of a pack run. On success, show a completion notification
 * naming the produced artifact with Reveal / Sign / Install actions. On
 * failure, direct the user to the WinApp output channel.
 */
async function handlePackCompletion(
	extensionPath: string,
	workspacePath: string,
	inputFolder: string,
	result: { code: number | null; output: string; cancelled?: boolean }
): Promise<void> {
	const plan = planPackCompletion(result);
	switch (plan.kind) {
		case 'cancelled':
			return;
		case 'error':
			getWinappOutputChannel().show();
			vscode.window.showErrorMessage(plan.message);
			return;
	}

	if (
		!fs.existsSync(plan.artifactPath) ||
		(!isArtifactWithinRoot(plan.artifactPath, workspacePath) &&
			!isArtifactWithinRoot(plan.artifactPath, inputFolder))
	) {
		getWinappOutputChannel().show();
		vscode.window.showErrorMessage('Packaging failed. See the WinApp output channel for details.');
		return;
	}

	const choice = await vscode.window.showInformationMessage(
		plan.message,
		PACK_ACTIONS.reveal,
		PACK_ACTIONS.sign,
		PACK_ACTIONS.install
	);

	switch (getPackNotificationAction(choice)) {
		case 'reveal':
			await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(plan.artifactPath));
			break;
		case 'sign':
			await signPackage(extensionPath, workspacePath, plan.artifactPath);
			break;
		case 'install':
			installPackage(plan.artifactPath, path.dirname(plan.artifactPath));
			break;
	}
}

/**
 * Report whether the current VS Code process is running elevated (as
 * administrator).
 *
 * VS Code cannot launch an elevated integrated terminal, so admin-only winapp
 * commands must be routed either through the normal terminal (when already
 * elevated) or through a separate UAC-elevated window (when not). We probe the
 * process token with PowerShell's WindowsPrincipal check. On any failure we
 * return `false`, which is the safe default: the command is then launched via
 * an elevated window (UAC), avoiding a silent "Access denied" failure.
 */
async function isProcessElevated(): Promise<boolean> {
	return new Promise((resolve) => {
		execFile(
			WINDOWS_POWERSHELL_PATH,
			[
				'-NoProfile',
				'-NonInteractive',
				'-Command',
				'[bool]([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'
			],
			{ timeout: 10000, windowsHide: true },
			(error, stdout) => {
				resolve(!error && stdout.trim().toLowerCase() === 'true');
			}
		);
	});
}

/**
 * Run a winapp command that requires administrator rights.
 *
 * If VS Code is already elevated, the command runs in the normal integrated
 * terminal. Otherwise it is launched in a separate UAC-elevated PowerShell
 * window (VS Code cannot elevate the integrated terminal), and an information
 * message explains that a Windows admin prompt will appear.
 */
async function runWinappCommandElevated(extensionPath: string, command: string, cwd: string): Promise<void> {
	const isElevated = await isProcessElevated();
	const cliPath = getWinappCliPath(extensionPath);
	const launcherPath = WINDOWS_POWERSHELL_PATH;
	const decision = decideElevatedWinappCommand(
		isElevated,
		isUsableElevatedCliPath(cliPath, fs.existsSync(cliPath)),
		cliPath,
		command,
		cwd,
		launcherPath
	);

	if (decision.kind === 'run-normally') {
		await runWinappCommand(extensionPath, command, cwd);
		return;
	}

	if (decision.kind === 'error-cli-missing') {
		vscode.window.showErrorMessage(
			'The bundled WinApp CLI executable could not be found, so the administrator command was not started. Rebuild or reinstall the extension, then try again.'
		);
		return;
	}

	const terminal = vscode.window.createTerminal({
		name: 'WinApp CLI (Admin launcher)',
		cwd: cwd,
		shellPath: WINDOWS_POWERSHELL_PATH,
		env: { WINAPP_CLI_CALLER: WINAPP_CLI_CALLER_VALUE }
	});
	terminal.show();
	terminal.sendText(decision.command);
	vscode.window.showInformationMessage(
		'Installing the certificate requires administrator rights. Approve the Windows User Account Control (UAC) prompt in the elevated window that just opened.'
	);
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
			const browseItem = { label: '$(folder-opened) Browse…', detail: FOLDER_PICKER_DETAIL, directory: '' };
			const picked = await vscode.window.showQuickPick([...items, browseItem], { placeHolder });
			if (!picked) { return undefined; }
			if (picked.directory === '') {
				const folder = await selectFolder('Select project folder', vscode.Uri.file(workspacePath));
				if (!folder) { return undefined; }
				const relative = path.relative(workspacePath, folder);
				if (relative.startsWith('..') || path.isAbsolute(relative)) {
					vscode.window.showWarningMessage('Selected folder is outside the workspace and was ignored.');
					return undefined;
				}
				try {
					const realWorkspace = await fs.promises.realpath(workspacePath);
					const realFolder = await fs.promises.realpath(folder);
					const realRelative = path.relative(realWorkspace, realFolder);
					if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
						vscode.window.showWarningMessage('Selected folder is outside the workspace and was ignored.');
						return undefined;
					}
				} catch {
					// Target doesn't exist on disk — lexical check above is authoritative
				}
				return folder;
			}
			return picked.directory || undefined;
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
async function selectFolder(title: string, defaultUri?: vscode.Uri): Promise<string | undefined> {
	const result = await vscode.window.showOpenDialog({
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: false,
		title: title,
		defaultUri: defaultUri
	});

	return result?.[0]?.fsPath;
}

class WinAppDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
	private extensionPath: string;

	constructor(extensionPath: string) {
		this.extensionPath = extensionPath;
	}

	async resolveDebugConfiguration(
		_folder: vscode.WorkspaceFolder | undefined,
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
		const debuggerType = await resolveDebuggerType(config.debuggerType);
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

		// Validate a user-specified inputFolder early so we can cleanly
		// cancel the session (return undefined) before the adapter factory
		// runs — this avoids showing the debugger toolbar on failure.
		const inputFolder: string | undefined = config.inputFolder;
		if (inputFolder) {
			let cwd = folder.uri.fsPath;
			if (config.workingDirectory) {
				cwd = config.workingDirectory;
			}
			const result = await validateInputFolder(inputFolder, cwd);
			if (!result.valid) {
				vscode.window.showErrorMessage(result.message);
				return undefined;
			}
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
			let cwd = folder.uri.fsPath;
			if (config.workingDirectory) {
				cwd = config.workingDirectory;
			}

			if (!inputFolder) {
				const dirs = await findBuildOutputFolders(folder.uri.fsPath);

				if (!dirs || dirs.length === 0) {
					throw new Error('No folders containing .exe files found in the workspace. Build your project first, or set "inputFolder" in launch.json.');
				}

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

			let args = config.args || '';
			if (debuggerType === 'node') {
				args = '--inspect' + (config.port ? `=${config.port}` : '') + ' ' + args;
			}

			if (args.trim()) {
				baseSpawnArgs.push('--args', args.trim());
			}

			baseSpawnArgs.push('--json');

			// Spawn winapp run --json. The process stays alive while the app runs,
			// so we stream stdout to parse the JSON with the PID before waiting for exit.
			const { processId, runProcess } = await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: 'Launching package...',
				cancellable: false
			}, async (progress) => {
				progress.report({ message: 'Running winapp run...' });

				return new Promise<{ processId: number; runProcess: ReturnType<typeof spawn> }>((resolve, reject) => {
					const child = spawn(cliPath, baseSpawnArgs, {
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

			// Build the attach debug configuration
			const debugConfiguration: vscode.DebugConfiguration = {
				type: debuggerType,
				name: config.name || 'Attach to WinApp Package',
				request: 'attach'
			};

			if (debuggerType === 'node') {
				debugConfiguration.port = config.port || 9229;
			} else {
				debugConfiguration.processId = processId;
			}

			const parentSession = session;

			// Tear down exactly once, whichever side finishes first: the child debug
			// session ending or the winapp run process exiting. Killing the run
			// process here prevents it from being orphaned in the background.
			let teardownRequested = false;
			const teardown = () => {
				if (teardownRequested) {
					return;
				}
				teardownRequested = true;
				disposable.dispose();
				runProcess.kill();
				vscode.debug.stopDebugging(parentSession);
			};

			// When the child debug session ends, tear down the run process and parent session
			const disposable = vscode.debug.onDidTerminateDebugSession((ended) => {
				if (ended.parentSession === parentSession) {
					teardown();
				}
			});

			// When the winapp run process exits (app closed), stop the debug session
			runProcess.on('close', () => {
				teardown();
			});

			// Start the real debug session as a child of the winapp session.
			// startDebugging resolves false when the child debugger can't attach —
			// most commonly because the installed debugger extension doesn't match
			// the project type (e.g. a C# extension was reused for a C/C++ app).
			// If it throws, tear down so the winapp run process is not left orphaned.
			try {
				const started = await vscode.debug.startDebugging(folder, debugConfiguration, { parentSession: session });
				if (!started) {
					teardown();
					const debuggerName = getDebuggerExtensionRequirement(debuggerType)?.name ?? `"${debuggerType}"`;
					await promptAndInstallDebuggerChoice(
						`The ${debuggerName} debugger couldn't attach to your app. ` +
						`This usually means the installed debugger extension doesn't match your project type. ` +
						`Install the debugger that matches your project, then start debugging again:`,
						'you selected it after the previous debugger failed to attach'
					);
					return new vscode.DebugAdapterInlineImplementation(new NoOpDebugAdapter());
				}
			} catch (startError) {
				teardown();
				throw startError;
			}

			// Return an inline no-op adapter — the real debugging happens in the child session above
			return new vscode.DebugAdapterInlineImplementation(new NoOpDebugAdapter());
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`Failed to launch and attach: ${message}`);
			throw error;
		}
	}
}

export function activate(context: vscode.ExtensionContext) {
	const extensionPath = context.extensionPath;
	const provider = new WinAppDebugConfigurationProvider(extensionPath);

	// Dispose the shared WinApp output channel when the extension unloads.
	context.subscriptions.push({ dispose: () => winappOutputChannel?.dispose() });

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

			const inputFolder = await pickBuildOutputFolder(workspacePath);
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

			// --- Architecture mismatch warning for self-contained packages ---
			if (selfContained === 'Yes') {
				const detectedArch = detectArchFromPath(inputFolder);
				const machineArch = getMachineArch();
				const mismatchResult = checkSelfContainedArchMismatch(detectedArch, machineArch);
				if (mismatchResult.mismatch) {
					const warning = buildArchMismatchWarning(mismatchResult.buildArch, mismatchResult.machineArch);
					const proceed = await vscode.window.showWarningMessage(
						warning,
						{ modal: true },
						'Continue anyway'
					);
					if (proceed !== 'Continue anyway') {
						return;
					}
				}
			}

			// Build the argument array for spawn (shell: false) so paths and flags
			// are passed literally — no PowerShell parsing/escaping required.
			const args = ['pack', inputFolder];
			if (generateCert === 'Yes') {
				args.push('--generate-cert', '--install-cert');
			}
			if (selfContained === 'Yes') {
				args.push('--self-contained');
			}

			const result = await runWinappCapture(
				extensionPath,
				args,
				workspacePath,
				'Packaging app...'
			);
			await handlePackCompletion(extensionPath, workspacePath, inputFolder, result);
		})
	);

	// Register winapp.run command
	context.subscriptions.push(
		vscode.commands.registerCommand('winapp.run', async () => {
			const workspacePath = getWorkspacePath();
			if (!workspacePath) {
				return;
			}

			const inputFolder = await pickBuildOutputFolder(workspacePath);
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
				['Generate only', 'Generate and install (requires admin)'],
				{ placeHolder: 'Generate a development certificate — install it in the machine store too?' }
			);

			if (!install) {
				return;
			}

			// Installing trusts the certificate in the machine store, which needs
			// administrator rights. When VS Code isn't elevated we can't install
			// from the integrated terminal, so run the whole generate+install in a
			// separate UAC-elevated window instead of failing with "Access denied".
			if (install === 'Generate and install (requires admin)') {
				await runWinappCommandElevated(extensionPath, 'cert generate --install', projectDir);
			} else {
				await runWinappCommand(extensionPath, 'cert generate', projectDir);
			}
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

			// Trusting a certificate in the machine store requires admin; route
			// through an elevated window when VS Code isn't already elevated.
			await runWinappCommandElevated(extensionPath, `cert install ${escapePowerShellArg(certPath)}`, workspacePath);
		})
	);

	// Register winapp.sign command
	context.subscriptions.push(
		vscode.commands.registerCommand('winapp.sign', async (prefilledPath?: string) => {
			const workspacePath = getWorkspacePath();
			if (!workspacePath) {
				return;
			}

			await signPackage(extensionPath, workspacePath, prefilledPath);
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
