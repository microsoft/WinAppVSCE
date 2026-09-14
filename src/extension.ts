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
	decideElevatedWinappCommand,
	resolveWorkingDirectory
} from './winapp-cli-utils';
import { detectProjects, deduplicateBuildOutputFolders, BUILD_OUTPUT_EXCLUDE_GLOB, BUILD_OUTPUT_MAX_RESULTS } from './project-detection';
import {
	classifyRunTarget,
	classifyRunTargetFile,
	dedupeSolutionMembers,
	findOwningRoot,
	isProjectMode,
	PROJECT_FILE_EXCLUDE_GLOB,
	PROJECT_FILE_GLOB,
	PROJECT_FILE_MAX_RESULTS,
	readSolutionProjectPaths,
	sortRunTargets,
	type RunTargetCandidate,
	type RunTargetKind,
	type WorkspaceRoot
} from './run-target';
import {
	buildRunArgs,
	COMMON_CONFIGURATIONS,
	getRunOptionErrors,
	SUPPORTED_ARCHITECTURES,
	validateRunOptions,
	type WinAppRunOptions
} from './run-options';
import { resolveProjectDirectory as resolveProjectDirectoryCore } from './project-resolver';
import { ManifestEditorProvider } from './manifest-editor/manifest-editor-provider';
import { registerManifestIntelliSense } from './manifest-intellisense/manifest-intellisense';
import { SchemaModel } from './manifest-schema/schema-model';
import { loadSchemaModel } from './manifest-schema/xsd-parser';
import { isManifestPath, MANIFEST_SELECTOR } from './manifest-schema/manifest-path';
import {
	PACK_ACTIONS,
	getPackNotificationAction,
	isArtifactWithinRoot,
	planPackCompletion
} from './pack-result';
import {
	findWorkspaceArtifacts,
	buildSignCommand,
	CERTIFICATE_GLOBS,
	EXECUTABLE_GLOBS,
	executeSignFlow,
	type SignFlowAdapter
} from './sign-utils';
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
	validateRunInput
} from './debugger-resolver';
import { NoOpDebugAdapter } from './noop-debug-adapter';
import {
	createWinappToolTaskSpec,
	executeWinappToolTask,
	parseToolArguments,
	resolveWinappToolInvocation,
	type WinappToolTaskSpec
} from './tool-command-utils';

const WINAPP_DEBUG_TYPE = 'winapp';
const WINDOWS_POWERSHELL_PATH = resolveWindowsPowerShellPath(process.env.SystemRoot);
const MAX_SIGNABLE_FILES = 10;

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
 * Run a Windows SDK tool through winapp without a command shell. ProcessExecution
 * keeps the output visible in a VS Code terminal while preserving argument
 * boundaries all the way to winapp.exe.
 */
async function runWinappTool(spec: WinappToolTaskSpec): Promise<vscode.TaskExecution> {
	return executeWinappToolTask(spec, {
		createProcessExecution: (executable, args, options) =>
			new vscode.ProcessExecution(executable, args, options),
		createTask: (definition, _scope, name, source, execution) =>
			new vscode.Task(definition, vscode.TaskScope.Workspace, name, source, execution),
		setPresentation: (task, presentation) => {
			task.presentationOptions = {
				reveal: vscode.TaskRevealKind.Always,
				panel: vscode.TaskPanelKind.Dedicated,
				clear: presentation.clear
			};
		},
		executeTask: task => vscode.tasks.executeTask(task)
	});
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
 * Search the workspace for signable packages, executables, and libraries and
 * let the user pick one via
 * a QuickPick. When no artifacts are found the function falls back directly to
 * a native file dialog; a "Browse…" entry is always appended so the user can
 * opt into the dialog even when artifacts *are* discovered.
 *
 * @returns The selected file path, or `undefined` if cancelled.
 */
async function pickSignableFile(workspacePath: string): Promise<string | undefined> {
	const artifactPaths = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Searching for signable artifacts...', cancellable: true },
		async (_progress, token) => {
			const packagePaths = await findWorkspaceArtifactsWithCancellation(workspacePath, ARTIFACT_GLOBS, token);
			if (!packagePaths) {
				return undefined;
			}
			const executablePaths = await findWorkspaceArtifactsWithCancellation(workspacePath, EXECUTABLE_GLOBS, token);
			if (!executablePaths) {
				return undefined;
			}
			return [...packagePaths, ...executablePaths].slice(0, MAX_SIGNABLE_FILES);
		}
	);

	if (!artifactPaths) {
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
		placeHolder: 'Select a file to sign'
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
	const certPaths = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Searching for certificates...', cancellable: true },
		(_progress, token) => findWorkspaceArtifactsWithCancellation(workspacePath, CERTIFICATE_GLOBS, token)
	);

	if (!certPaths) {
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

async function findWorkspaceArtifactsWithCancellation(
	workspacePath: string,
	patterns: string[],
	token: vscode.CancellationToken
): Promise<string[] | undefined> {
	const abortController = new AbortController();
	const cancellation = token.onCancellationRequested(() => abortController.abort());
	if (token.isCancellationRequested) {
		abortController.abort();
	}

	try {
		const paths = await findWorkspaceArtifacts(
			workspacePath,
			async includePattern => {
				const matches = await vscode.workspace.findFiles(
					new vscode.RelativePattern(workspacePath, includePattern),
					null,
					undefined,
					token
				);
				return matches.map(uri => uri.fsPath);
			},
			patterns,
			abortController.signal
		);
		return token.isCancellationRequested ? undefined : paths;
	} finally {
		cancellation.dispose();
	}
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
 * The workspace folders, reduced to what run-target discovery needs.
 *
 * Unlike {@link getWorkspacePath}, this does not collapse a multi-root
 * workspace to its first folder. These helpers are written against the whole
 * root set so they can later back the other project-context commands too.
 */
function getWorkspaceRoots(): WorkspaceRoot[] {
	return (vscode.workspace.workspaceFolders ?? []).map(folder => ({
		name: folder.name,
		path: folder.uri.fsPath
	}));
}

/**
 * The root owning the active editor, used to sort its targets first. This only
 * affects ordering — every root's targets remain listed.
 */
function getPreferredRootPath(roots: readonly WorkspaceRoot[]): string | undefined {
	const activeUri = vscode.window.activeTextEditor?.document.uri;
	if (!activeUri || activeUri.scheme !== 'file') {
		return undefined;
	}
	return findOwningRoot(roots, activeUri.fsPath)?.path;
}

/**
 * Find project and solution files across every workspace root.
 *
 * This is the primary discovery mechanism for run targets: globbing for
 * project files is far cheaper and more precise than scanning for `**\/*.exe`,
 * so the executable scan is reserved for workspaces where no project is found
 * (or when the user explicitly asks for it).
 */
async function findProjectTargets(roots: readonly WorkspaceRoot[]): Promise<RunTargetCandidate[]> {
	const candidates: RunTargetCandidate[] = [];

	for (const root of roots) {
		const matches = await vscode.workspace.findFiles(
			new vscode.RelativePattern(root.path, PROJECT_FILE_GLOB),
			PROJECT_FILE_EXCLUDE_GLOB,
			PROJECT_FILE_MAX_RESULTS
		);

		for (const match of matches) {
			const kind = classifyRunTargetFile(match.fsPath);
			if (kind) {
				candidates.push({ kind, path: match.fsPath, root });
			}
		}
	}

	return candidates;
}

/**
 * Find build-output folders (directories containing `.exe` files) across every
 * workspace root.
 *
 * @returns The discovered folders, or `undefined` if the user cancelled the scan.
 */
async function findBuildOutputTargets(roots: readonly WorkspaceRoot[]): Promise<RunTargetCandidate[] | undefined> {
	const candidates: RunTargetCandidate[] = [];

	for (const root of roots) {
		const folders = await findBuildOutputFolders(root.path);
		if (!folders) {
			return undefined;
		}
		for (const folder of folders) {
			candidates.push({ kind: 'folder', path: folder, root });
		}
	}

	return candidates;
}

/**
 * Resolve the projects belonging to each discovered solution, so members can be
 * folded into their solution rather than listed alongside it.
 */
async function mapSolutionMembers(
	candidates: readonly RunTargetCandidate[]
): Promise<Map<string, string[]>> {
	const members = new Map<string, string[]>();

	await Promise.all(
		candidates
			.filter(candidate => candidate.kind === 'solution')
			.map(async candidate => {
				members.set(candidate.path, await readSolutionProjectPaths(candidate.path));
			})
	);

	return members;
}

const BUILD_OUTPUT_SEARCH_DETAIL = 'Scan the workspace for folders containing .exe files';

/** Marks the run-target picker entry that opens a file dialog for projects. */
const PROJECT_PICKER_DETAIL = 'Open a file picker for .csproj, .sln, or .slnx';

interface RunTargetQuickPickItem extends vscode.QuickPickItem {
	candidate?: RunTargetCandidate;
}

/**
 * Build the QuickPick items for a set of run targets, grouped by kind.
 *
 * Root names are only shown when the workspace actually has more than one
 * root, so single-folder users see no extra noise.
 */
function buildRunTargetItems(
	candidates: readonly RunTargetCandidate[],
	showRootNames: boolean
): RunTargetQuickPickItem[] {
	const items: RunTargetQuickPickItem[] = [];
	let lastGroup: string | undefined;

	for (const candidate of candidates) {
		const group = candidate.kind === 'folder' ? 'Build output folders' : 'Projects';
		if (group !== lastGroup) {
			items.push({ label: group, kind: vscode.QuickPickItemKind.Separator });
			lastGroup = group;
		}

		const relative = path.relative(candidate.root.path, candidate.path) || '.';
		const icon = candidate.kind === 'solution'
			? '$(file-submodule)'
			: candidate.kind === 'project' ? '$(file-code)' : '$(folder)';
		const name = candidate.kind === 'folder' ? relative : path.basename(candidate.path);

		items.push({
			label: `${icon} ${name}`,
			description: showRootNames ? `${candidate.root.name} — ${relative}` : relative,
			detail: candidate.path,
			candidate
		});
	}

	return items;
}

/**
 * Pick the target for `winapp run`.
 *
 * Presents projects, solutions and build-output folders from every workspace
 * root in a single prompt, and auto-selects when there is only one candidate.
 * The user chooses *what to run*, never which CLI mode to use — the mode is
 * derived from the selection.
 *
 * @param alwaysPrompt Show the picker even when there is a single obvious
 *   candidate. Used by the advanced command, where the user has explicitly
 *   asked to make choices.
 * @param scope Restrict discovery to a single workspace folder. The debug
 *   adapter passes the session's folder so F5 stays within the root that owns
 *   the launch configuration.
 * @returns The selected target, or `undefined` if cancelled.
 */
async function pickRunTarget(
	alwaysPrompt: boolean = false,
	scope?: vscode.WorkspaceFolder
): Promise<RunTargetCandidate | undefined> {
	const roots = scope
		? [{ name: scope.name, path: scope.uri.fsPath }]
		: getWorkspaceRoots();
	if (roots.length === 0) {
		vscode.window.showErrorMessage('No workspace folder open');
		return undefined;
	}

	let cancelled = false;
	const projects = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Searching for projects...', cancellable: true },
		async (_progress, token) => {
			token.onCancellationRequested(() => { cancelled = true; });
			return findProjectTargets(roots);
		}
	);

	if (cancelled) {
		return undefined;
	}

	// No project or solution anywhere — fall back to the (more expensive)
	// build-output scan, which is the only way to run in folder mode.
	let candidates = projects;
	let buildOutputScanned = false;
	if (candidates.length === 0) {
		const folders = await findBuildOutputTargets(roots);
		if (!folders) {
			return undefined;
		}
		candidates = folders;
		buildOutputScanned = true;
	} else {
		candidates = dedupeSolutionMembers(candidates, await mapSolutionMembers(candidates));
	}

	if (candidates.length === 0) {
		// Nothing discoverable at all — go straight to the folder dialog rather
		// than showing an empty picker.
		return browseForRunTarget(roots, 'folder');
	}

	const preferredRootPath = getPreferredRootPath(roots);
	const sorted = sortRunTargets(candidates, preferredRootPath);

	// A single unambiguous target needs no prompt at all.
	if (sorted.length === 1 && !alwaysPrompt) {
		return sorted[0];
	}

	const items = buildRunTargetItems(sorted, roots.length > 1);

	items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
	if (!buildOutputScanned) {
		items.push({
			label: '$(search) Search for build output folders…',
			detail: BUILD_OUTPUT_SEARCH_DETAIL
		});
	}
	items.push({ label: '$(file-code) Browse for a project or solution…', detail: PROJECT_PICKER_DETAIL });
	items.push({ label: '$(folder-opened) Browse for a folder…', detail: FOLDER_PICKER_DETAIL });

	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: 'Select the project, solution, or build output folder to run',
		matchOnDescription: true
	});

	if (!picked) {
		return undefined;
	}

	if (picked.detail === PROJECT_PICKER_DETAIL) {
		return browseForRunTarget(roots, 'file');
	}

	if (picked.detail === FOLDER_PICKER_DETAIL) {
		return browseForRunTarget(roots, 'folder');
	}

	if (picked.detail === BUILD_OUTPUT_SEARCH_DETAIL) {
		const folders = await findBuildOutputTargets(roots);
		if (!folders) {
			return undefined;
		}
		if (folders.length === 0) {
			vscode.window.showWarningMessage(
				'No folders containing .exe files were found. Build your project first, or browse to a folder.'
			);
			return browseForRunTarget(roots, 'folder');
		}
		const folderItems = buildRunTargetItems(
			sortRunTargets(folders, preferredRootPath),
			roots.length > 1
		);
		const pickedFolder = await vscode.window.showQuickPick(folderItems, {
			placeHolder: 'Select the build output folder containing your app',
			matchOnDescription: true
		});
		return pickedFolder?.candidate;
	}

	return picked.candidate;
}

/**
 * Fall back to a native dialog, classifying whatever the user selects so the
 * caller still knows which options apply.
 *
 * File and folder selection are separate entry points because a Windows open
 * dialog cannot offer both at once.
 */
async function browseForRunTarget(
	roots: readonly WorkspaceRoot[],
	mode: 'file' | 'folder'
): Promise<RunTargetCandidate | undefined> {
	const defaultUri = vscode.Uri.file(roots[0].path);
	let selected: string | undefined;

	if (mode === 'file') {
		const result = await vscode.window.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			title: 'Select a project or solution to run',
			defaultUri,
			filters: { 'Projects and solutions': ['csproj', 'sln', 'slnx'] }
		});
		selected = result?.[0]?.fsPath;
	} else {
		selected = await selectFolder('Select project or build output folder', defaultUri);
	}

	if (!selected) {
		return undefined;
	}

	return {
		kind: await classifyRunTarget(selected),
		path: selected,
		root: findOwningRoot(roots, selected) ?? roots[0]
	};
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
 * Read the `winapp.run.*` defaults for a workspace root.
 *
 * These settings are resource-scoped, so each folder of a multi-root workspace
 * can carry its own configuration/architecture/properties in its
 * `.vscode/settings.json`.
 */
function getRunSettings(rootPath: string): Partial<WinAppRunOptions> {
	const config = vscode.workspace.getConfiguration('winapp', vscode.Uri.file(rootPath));
	const configuration = config.get<string>('run.configuration');
	const arch = config.get<string>('run.arch');
	const properties = config.get<Record<string, string>>('run.properties');

	return {
		configuration: configuration || undefined,
		arch: arch || undefined,
		properties: properties && Object.keys(properties).length > 0 ? properties : undefined,
		unregisterOnExit: config.get<boolean>('run.unregisterOnExit') || undefined
	};
}

/**
 * Ask which project to launch when the target is a solution containing more
 * than one runnable app.
 *
 * Returns `{ cancelled: true }` when the user dismissed the prompt, which is
 * distinct from "no selection needed" — the caller must not run in that case.
 * When the solution can't be parsed we return no project at all and let the
 * CLI produce its own, better-informed error.
 */
async function pickSolutionProject(
	target: RunTargetCandidate
): Promise<{ cancelled: boolean; project?: string }> {
	if (target.kind !== 'solution') {
		return { cancelled: false };
	}

	const projects = await readSolutionProjectPaths(target.path);
	if (projects.length <= 1) {
		return { cancelled: false };
	}

	const solutionDir = path.dirname(target.path);
	const items = projects.map(projectPath => ({
		label: `$(file-code) ${path.basename(projectPath)}`,
		description: path.relative(solutionDir, projectPath),
		projectPath
	}));

	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: `Which project in ${path.basename(target.path)} would you like to run?`,
		matchOnDescription: true
	});

	if (!picked) {
		return { cancelled: true };
	}

	return { cancelled: false, project: picked.projectPath };
}

/** A toggle offered by the advanced run command. */
interface RunToggle {
	key: keyof WinAppRunOptions;
	label: string;
	detail: string;
	/** Only offered when the target is a project or solution. */
	projectOnly?: boolean;
}

const RUN_TOGGLES: RunToggle[] = [
	{ key: 'clean', label: 'Clean application data', detail: 'Remove the existing package\'s LocalState and settings before deploying (--clean)' },
	{ key: 'noBuild', label: 'Skip build', detail: 'Run the existing build output without rebuilding (--no-build)', projectOnly: true },
	{ key: 'noRestore', label: 'Skip restore', detail: 'Do not restore the project before building (--no-restore)', projectOnly: true },
	{ key: 'noLaunch', label: 'Register only, do not launch', detail: 'Create the debug identity and register the package without starting the app (--no-launch)' },
	{ key: 'withAlias', label: 'Launch via execution alias', detail: 'Run in the terminal with stdin/stdout inherited; requires an execution alias in the manifest (--with-alias)' },
	{ key: 'unregisterOnExit', label: 'Unregister on exit', detail: 'Remove the development package after the app exits (--unregister-on-exit)' }
];

/**
 * Prompt for the advanced run options in a single multi-select, rather than a
 * chain of yes/no prompts.
 *
 * Options that the CLI ignores for the chosen target are omitted entirely
 * rather than shown disabled, so the list never offers a no-op.
 *
 * @returns The selected options, or `undefined` if cancelled.
 */
async function pickRunToggles(
	kind: RunTargetKind,
	defaults: Partial<WinAppRunOptions>
): Promise<Partial<WinAppRunOptions> | undefined> {
	const available = RUN_TOGGLES.filter(toggle => !toggle.projectOnly || isProjectMode(kind));
	const items = available.map(toggle => ({
		label: toggle.label,
		detail: toggle.detail,
		toggle,
		picked: defaults[toggle.key] === true
	}));

	const picked = await vscode.window.showQuickPick(items, {
		canPickMany: true,
		placeHolder: 'Select run options (press Enter to continue)'
	});

	if (!picked) {
		return undefined;
	}

	const selected: Partial<WinAppRunOptions> = {};
	for (const toggle of available) {
		(selected as Record<string, unknown>)[toggle.key] = picked.some(item => item.toggle.key === toggle.key);
	}
	return selected;
}

/**
 * Prompt for build configuration and architecture in project mode.
 *
 * @returns The selections, or `undefined` if cancelled.
 */
async function pickBuildSettings(
	defaults: Partial<WinAppRunOptions>
): Promise<Partial<WinAppRunOptions> | undefined> {
	const configurationItems = [...COMMON_CONFIGURATIONS].map(name => ({
		label: name,
		description: name === (defaults.configuration ?? 'Debug') ? 'current default' : undefined
	}));

	const configuration = await vscode.window.showQuickPick(configurationItems, {
		placeHolder: 'Build configuration'
	});
	if (!configuration) {
		return undefined;
	}

	const archItems = [
		{ label: 'Default', description: 'Use the current process architecture', arch: undefined as string | undefined },
		...[...SUPPORTED_ARCHITECTURES].map(name => ({ label: name, description: undefined, arch: name }))
	];

	const arch = await vscode.window.showQuickPick(archItems, {
		placeHolder: 'Target architecture'
	});
	if (!arch) {
		return undefined;
	}

	return { configuration: configuration.label, arch: arch.arch };
}

/**
 * Surface option diagnostics. Errors block the run; warnings are shown but do
 * not stop it, because the CLI's behavior for inapplicable options (ignore
 * them) is well defined.
 *
 * @returns True when the run should proceed.
 */
function reportRunDiagnostics(options: WinAppRunOptions, kind: RunTargetKind): boolean {
	const diagnostics = validateRunOptions(options, kind, 'palette');
	const errors = getRunOptionErrors(diagnostics);

	if (errors.length > 0) {
		vscode.window.showErrorMessage(errors.map(d => d.message).join(' '));
		return false;
	}

	for (const warning of diagnostics) {
		vscode.window.showWarningMessage(warning.message);
	}

	return true;
}

/**
 * Run a resolved option set in a terminal.
 *
 * Each argument is escaped individually rather than concatenated into a
 * pre-built command string, so values containing spaces or quotes — most
 * notably `--property Name=Value` — survive PowerShell parsing intact.
 */
async function runWinappRun(extensionPath: string, options: WinAppRunOptions, cwd: string): Promise<void> {
	const command = buildRunArgs(options).map(escapePowerShellArg).join(' ');
	await runWinappCommand(extensionPath, command, cwd);
}

/**
 * Shared flow for both run commands: pick a target, resolve options, validate,
 * and launch.
 */
async function executeRunCommand(extensionPath: string, advanced: boolean): Promise<void> {
	const target = await pickRunTarget(advanced);
	if (!target) {
		return;
	}

	const settings = getRunSettings(target.root.path);
	const projectMode = isProjectMode(target.kind);

	// Only apply the project-mode settings to a project-mode target. Carrying
	// them into folder mode would make every plain folder run report warnings
	// about options the CLI silently ignores.
	let options: WinAppRunOptions = {
		input: target.path,
		unregisterOnExit: settings.unregisterOnExit,
		...(projectMode
			? {
				configuration: settings.configuration,
				arch: settings.arch,
				properties: settings.properties
			}
			: {})
	};

	const projectSelection = await pickSolutionProject(target);
	if (projectSelection.cancelled) {
		return;
	}
	options.project = projectSelection.project;

	if (advanced) {
		if (projectMode) {
			const buildSettings = await pickBuildSettings(settings);
			if (!buildSettings) {
				return;
			}
			options = { ...options, ...buildSettings };
		}

		const toggles = await pickRunToggles(target.kind, settings);
		if (!toggles) {
			return;
		}
		options = { ...options, ...toggles };
	}

	if (!reportRunDiagnostics(options, target.kind)) {
		return;
	}

	await runWinappRun(extensionPath, options, target.root.path);
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

		// Validate a user-specified input early so we can cleanly
		// cancel the session (return undefined) before the adapter factory
		// runs — this avoids showing the debugger toolbar on failure.
		const input = resolveDebugInput(config);
		let cwd: string;
		try {
			cwd = resolveWorkingDirectory(folder.uri.fsPath, config.workingDirectory);
		} catch (error) {
			// An unusable workingDirectory is a launch.json authoring problem, so
			// surface it here and cancel the session rather than letting the
			// adapter factory fail later with the debugger toolbar already shown.
			vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
			return undefined;
		}

		const kind = input ? await classifyRunTarget(input) : 'unknown';

		// Reject option combinations the adapter cannot honour (for example
		// --detach or --no-launch, which leave nothing for the debugger to
		// attach to) before the session starts.
		const optionErrors = getRunOptionErrors(
			validateRunOptions(runOptionsFromDebugConfig(config, input ?? ''), kind, 'debug')
		);
		if (optionErrors.length > 0) {
			vscode.window.showErrorMessage(optionErrors.map(d => d.message).join(' '));
			return undefined;
		}

		if (input) {
			const result = await validateRunInput(input, cwd, kind, config.input ? 'input' : 'inputFolder');
			if (!result.valid) {
				const openDebugConfigurationAction = 'Open debug configuration';
				void vscode.window.showErrorMessage(result.message, openDebugConfigurationAction).then(
					action => {
						if (action === openDebugConfigurationAction) {
							void vscode.commands.executeCommand('workbench.action.debug.configure').then(
								undefined,
								error => {
									void vscode.window.showErrorMessage(
										`Failed to open debug configuration: ${error instanceof Error ? error.message : String(error)}`
									).then(undefined, () => {});
								}
							);
						}
					},
					error => {
						void vscode.window.showErrorMessage(
							`Failed to show input validation error: ${error instanceof Error ? error.message : String(error)}`
						).then(undefined, () => {});
					}
				);
				return undefined;
			}
		}

		return config;
	}
}

/**
 * Resolve the run input from a debug configuration.
 *
 * `input` supersedes the original `inputFolder`, which is retained as a
 * deprecated alias so existing launch.json files keep working. When both are
 * present the new name wins.
 */
function resolveDebugInput(config: vscode.DebugConfiguration): string | undefined {
	return config.input || config.inputFolder || undefined;
}

/**
 * Map a launch.json configuration onto the shared run options.
 *
 * `json` is always set: the adapter depends on parsing the process ID out of
 * the CLI's JSON output in order to attach.
 */
function runOptionsFromDebugConfig(config: vscode.DebugConfiguration, input: string): WinAppRunOptions {
	return {
		input,
		project: config.project,
		configuration: config.configuration,
		arch: config.arch,
		framework: config.framework,
		runtime: config.runtime,
		properties: config.properties,
		noBuild: config.noBuild,
		noRestore: config.noRestore,
		clean: config.clean,
		detach: config.detach,
		noLaunch: config.noLaunch,
		unregisterOnExit: config.unregisterOnExit,
		withAlias: config.withAlias,
		executable: config.executable,
		manifest: config.manifest,
		outputAppxDirectory: config.outputAppxDirectory,
		json: true
	};
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
			// The run command requires an input positional argument. If not set
			// in launch.json, discover projects and build output folders in the
			// workspace and let the user pick one.
			let input = resolveDebugInput(config);
			const cwd = resolveWorkingDirectory(folder.uri.fsPath, config.workingDirectory);

			if (!input) {
				const target = await pickRunTarget(false, folder);
				if (!target) {
					throw new Error('No run target selected, cancelling debug session.');
				}
				input = target.path;
			}

			const cliPath = getWinappCliPath(this.extensionPath);

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

			const runOptions = runOptionsFromDebugConfig(config, input);
			runOptions.args = args.trim() || undefined;

			const baseSpawnArgs = buildRunArgs(runOptions);

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

	// Shared schema model — loaded lazily, shared by both editor and IntelliSense.
	// Schemas are bundled at build time (vscode:prepublish runs sync-schemas + verify-schemas),
	// so loadSchemaModel will always succeed in a properly packaged extension.
	const schemasDir = path.join(extensionPath, 'schemas');
	let sharedSchema: SchemaModel | undefined;
	const getSharedSchema = (): SchemaModel => {
		if (sharedSchema) { return sharedSchema; }
		sharedSchema = loadSchemaModel(schemasDir);
		return sharedSchema;
	};

	// Register the Manifest Editor (with schema support)
	context.subscriptions.push(ManifestEditorProvider.register(context, getSharedSchema));

	// Register AppxManifest IntelliSense (completion, hover, diagnostics) — shares the same schema
	registerManifestIntelliSense(context, getSharedSchema);

	// When an appxmanifest file is opened in the default text editor,
	// suggest switching to the Manifest Editor.
	const dismissedKey = 'winapp.manifestEditorNotificationDismissed';

	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(editor => {
			if (!editor || editor.document.uri.scheme !== 'file') { return; }
			if (!isManifestPath(editor.document.uri.fsPath)) { return; }
			if (context.globalState.get<boolean>(dismissedKey)) { return; }

			vscode.window.showInformationMessage(
				'This file can be opened with the Manifest Editor for a richer editing experience.',
				'Open Manifest Editor',
				"Don't Show Again",
			).then(choice => {
				if (choice === 'Open Manifest Editor') {
					vscode.commands.executeCommand('vscode.openWith', editor.document.uri, ManifestEditorProvider.viewType);
				} else if (choice === "Don't Show Again") {
					context.globalState.update(dismissedKey, true);
				}
			});
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('winapp.openManifestEditor', async (resource?: vscode.Uri) => {
			// Invoked from the editor title bar: open that manifest directly, no quick pick.
			if (resource instanceof vscode.Uri && isManifestPath(resource.fsPath)) {
				await vscode.commands.executeCommand('vscode.openWith', resource, ManifestEditorProvider.viewType);
				return;
			}

			const manifests = (await Promise.all(
				MANIFEST_SELECTOR.map(selector =>
					vscode.workspace.findFiles(selector.pattern as string, BUILD_OUTPUT_EXCLUDE_GLOB)
				)
			)).flat();
			const browseItem = {
				label: '$(folder-opened) Browse…',
				description: 'Select a manifest file',
				uri: undefined as vscode.Uri | undefined
			};
			const includeWorkspaceFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
			const items = manifests
				.map(uri => ({
					uri,
					relativePath: vscode.workspace.asRelativePath(uri, includeWorkspaceFolder)
				}))
				.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
				.map(({ uri, relativePath }) => ({
					label: `$(file-code) ${path.basename(uri.fsPath)}`,
					description: path.dirname(relativePath),
					uri
				}));
			const picked = await vscode.window.showQuickPick([...items, browseItem], {
				placeHolder: 'Select an app manifest to open'
			});
			if (!picked) { return; }

			let manifestUri = picked.uri;
			if (!manifestUri) {
				const selected = await vscode.window.showOpenDialog({
					canSelectFiles: true,
					canSelectFolders: false,
					canSelectMany: false,
					title: 'Select an app manifest',
					filters: { 'App manifests': ['appxmanifest', 'xml'] }
				});
				manifestUri = selected?.[0];
			}
			if (!manifestUri) { return; }
			if (!isManifestPath(manifestUri.fsPath)) {
				vscode.window.showWarningMessage('Select an .appxmanifest or AppxManifest.xml file.');
				return;
			}

			await vscode.commands.executeCommand('vscode.openWith', manifestUri, ManifestEditorProvider.viewType);
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
			await executeRunCommand(extensionPath, false);
		})
	);

	// Register winapp.runAdvanced command
	context.subscriptions.push(
		vscode.commands.registerCommand('winapp.runAdvanced', async () => {
			await executeRunCommand(extensionPath, true);
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
			const invocation = await resolveWinappToolInvocation(
				getWinappCliPath(extensionPath),
				workspacePath,
				{
					selectTool: () => vscode.window.showQuickPick(
						['makeappx', 'signtool', 'mt', 'makepri', 'other'],
						{ placeHolder: 'Select Windows SDK tool' }
					),
					promptForToolName: () => vscode.window.showInputBox({
						prompt: 'Enter the Windows SDK tool name',
						placeHolder: 'e.g., custom-tool'
					}),
					promptForArguments: (toolName) => vscode.window.showInputBox({
						prompt: `Enter arguments for ${toolName}. Arguments are passed without shell interpretation; ` +
							'double-quote values that contain spaces.',
						placeHolder: 'e.g., /?',
						validateInput: (value) => {
							try {
								parseToolArguments(value);
								return undefined;
							} catch (error) {
								return error instanceof Error ? error.message : String(error);
							}
						}
					})
				}
			);
			if (!invocation) {
				return;
			}

			return runWinappTool(createWinappToolTaskSpec(
				invocation,
				WINAPP_CLI_CALLER_VALUE
			));
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
