import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, execFile } from 'child_process';
import {
	getWinappCliPath,
	WINAPP_CLI_CALLER_VALUE,
	escapePowerShellArg,
	formatPowerShellArgs,
	resolveWindowsPowerShellPath,
	isUsableElevatedCliPath,
	decideElevatedWinappCommand,
	extractJsonObject,
	resolveWorkingDirectory
} from './winapp-cli-utils';
import {
	detectProjects,
	BUILD_OUTPUT_EXCLUDE_GLOB,
	BUILD_OUTPUT_SKIP_DIRS
} from './project-detection';
import { walkDirectoryTree } from './directory-walk';
import {
	buildRunArgs,
	resolveDebugInput,
	resolveRunProject,
	runOptionsFromDebugConfig,
	shouldPromptForProject,
	validateDebugRunOptions,
	type WinAppRunOptions
} from './run-options';
import {
	FOLDER_PICKER_DETAIL,
	pickBuildOutputFolder
} from './folder-picker';
import {
	pickRunTarget,
	pickSolutionProject,
	resolveRunOptions
} from './run-utils';
import { getWorkspaceRoots, NO_WORKSPACE_MESSAGE } from './workspace';
import { launchRunProcess } from './run-launch';
import { DebugLaunchCancelled, WinAppRunFailure } from './run-exit';
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
	isSparseManifestXml,
	decodeManifestXml,
	planSparseInitCommand,
	buildSparsePackArgs,
	planEmbedIdentityCommand,
	embedRewritesBinary,
	defaultSparseOutputDir,
	getSparseManifestPath,
	hasExistingSparseOutput,
	findProjectRootIn,
	findOwningWorkspacePath,
	chooseSparseManifest,
} from './sparse-flow';
import {
	findWorkspaceArtifacts,
	buildSignCommand,
	CERTIFICATE_TIERS,
	MAX_QUICKPICK_RESULTS,
	SIGNABLE_ARTIFACT_TIERS,
	executeSignFlow,
	type SignFlowAdapter
} from './sign-utils';
import { ARTIFACT_DIALOG_FILTER } from './artifact-types';
import {
	buildCertGenerateArgs,
	decideCertGenerateOutcome,
	executeCertGenerateFlow,
	resolveCertPublisherSourceDecision,
	selectCanonicalManifest,
	type CertGenerateFlowAdapter,
	type CertIfExists,
	type CertPublisherSource
} from './cert-utils';
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
	resolveDebuggerTypeForRun,
	validateRunInput
} from './debugger-resolver';
import { NoOpDebugAdapter } from './noop-debug-adapter';
import { registerWinappNewCommand } from './new-command';
import {
	disposeWinappOutputChannel,
	getWinappOutputChannel,
	runWinappCapture,
	selectFolder
} from './winapp-host';
import {
	createWinappToolTaskSpec,
	executeWinappToolTask,
	parseToolArguments,
	resolveWinappToolInvocation,
	type WinappToolTaskSpec
} from './tool-command-utils';
import {
	createDefaultLaunchConfiguration,
	WINAPP_DEBUG_TYPE,
	WINAPP_LAUNCH_CONFIG_NAME
} from './launch-config';
import { offerLaunchConfiguration } from './launch-assets';

const WINDOWS_POWERSHELL_PATH = resolveWindowsPowerShellPath(process.env.SystemRoot);
const FILE_PICKER_DETAIL = 'Open a file picker';

/**
 * A file offered in a sign QuickPick. No `detail` — that second line would
 * double row height and only repeat the workspace root already implied by
 * `description`. `filePath` is a non-rendered payload; "Browse…" omits it.
 */
type SignableFileItem = vscode.QuickPickItem & { filePath?: string };

/**
 * Build the trailing "Browse…" QuickPick entry, which reaches anything the
 * capped discovery list omits. `alwaysShow` keeps it past the typed filter —
 * it matches no filename, so without it the escape hatch disappears exactly
 * when a user types the name of a file that was capped out.
 */
function createBrowseItem(): SignableFileItem {
	return {
		label: '$(folder-opened) Browse…',
		description: FILE_PICKER_DETAIL,
		alwaysShow: true
	};
}

/**
 * Append a truncation hint to `placeholder` when discovery filled every slot.
 * The hint rides the placeholder rather than a list row so it costs no entry.
 */
function withTruncationHint(placeholder: string, resultCount: number): string {
	return resultCount >= MAX_QUICKPICK_RESULTS
		? `${placeholder} (showing ${MAX_QUICKPICK_RESULTS} most recent — use Browse… for others)`
		: placeholder;
}

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
 * Search the workspace for signable packages, executables, and libraries and
 * let the user pick one via
 * a QuickPick. Discovery is tiered and capped: MSIX packages are searched
 * first, then remaining package types, then executables and libraries, stopping
 * as soon as the QuickPick result cap is reached. When no artifacts are
 * found the function falls back directly to a native file dialog; a "Browse…"
 * entry is always appended so the user can reach anything the capped list omits.
 *
 * @returns The selected file path, or `undefined` if cancelled.
 */
async function pickSignableFile(workspacePath: string): Promise<string | undefined> {
	const artifactPaths = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Searching for signable artifacts...', cancellable: true },
		(_progress, token) => findWorkspaceArtifactsWithCancellation(workspacePath, SIGNABLE_ARTIFACT_TIERS, token)
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

	const items: SignableFileItem[] = artifactPaths.map((p) => {
		const relDir = path.dirname(path.relative(workspacePath, p));
		return {
			label: path.basename(p),
			description: relDir === '.' ? '' : relDir,
			filePath: p
		};
	});

	items.push(createBrowseItem());

	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: withTruncationHint('Select a file to sign', artifactPaths.length)
	});

	if (!picked) {
		return undefined;
	}

	if (!picked.filePath) {
		return selectFile('Select file to sign', {
			...ARTIFACT_DIALOG_FILTER,
			'Executables': ['exe', 'dll'],
			'All files': ['*']
		});
	}

	return picked.filePath;
}

/**
 * Search the workspace for executables and let the user pick one via a
 * QuickPick, with a "Browse…" escape and a direct file-dialog fallback when
 * none are found.
 *
 * Shared by the sparse-identity and embed-identity commands, which both act on
 * an existing built executable rather than on a project directory.
 *
 * @param title Title for both the QuickPick and the fallback dialog.
 * @param extraExtensions Additional file extensions to include (e.g. side-by-side manifests).
 * @param extraFilters Additional file-dialog filters matching `extraExtensions`.
 */
async function pickExecutableTarget(
	workspacePaths: readonly string[],
	title: string,
	extraExtensions: string[] = [],
	extraFilters: { [name: string]: string[] } = {}
): Promise<string | undefined> {
	const defaultWorkspacePath = workspacePaths[0];
	const dialogFilters = { 'Executables': ['exe'], ...extraFilters, 'All files': ['*'] };

	const candidatePaths = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Searching for executables...', cancellable: true },
		(_progress, token) =>
			findWorkspaceArtifactsWithCancellation(workspacePaths, [['exe', ...extraExtensions]], token)
	);

	if (!candidatePaths) {
		return undefined;
	}

	if (candidatePaths.length === 0) {
		return selectFile(title, dialogFilters);
	}

	const items: SignableFileItem[] = candidatePaths.map((p) => {
		const owner = findOwningWorkspacePath(p, workspacePaths) ?? defaultWorkspacePath;
		const relDir = path.dirname(path.relative(owner, p));
		const rootPrefix = workspacePaths.length > 1 ? `${path.basename(owner)}\\` : '';
		return {
			label: path.basename(p),
			description: relDir === '.' ? rootPrefix.slice(0, -1) : `${rootPrefix}${relDir}`,
			filePath: p
		};
	});

	items.push(createBrowseItem());

	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: withTruncationHint(title, candidatePaths.length)
	});

	if (!picked) {
		return undefined;
	}

	if (!picked.filePath) {
		return selectFile(title, dialogFilters);
	}

	return picked.filePath;
}

/**
 * Search the workspace for PFX certificate files and let the user pick one
 * via a QuickPick. Discovery is capped to the newest certificates. Falls back
 * to a native file dialog when none are found;
 * a "Browse…" entry is always appended.
 *
 * @returns The selected certificate path, or `undefined` if cancelled.
 */
async function pickCertificateFile(workspacePath: string): Promise<string | undefined> {
	const certPaths = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Searching for certificates...', cancellable: true },
		(_progress, token) => findWorkspaceArtifactsWithCancellation(workspacePath, CERTIFICATE_TIERS, token)
	);

	if (!certPaths) {
		return undefined;
	}

	if (certPaths.length === 0) {
		return selectFile('Select signing certificate', {
			'Certificates': ['pfx']
		});
	}

	const items: SignableFileItem[] = certPaths.map((p) => {
		const relDir = path.dirname(path.relative(workspacePath, p));
		return {
			label: path.basename(p),
			description: relDir === '.' ? '' : relDir,
			filePath: p
		};
	});

	items.push(createBrowseItem());

	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: withTruncationHint('Select a signing certificate', certPaths.length)
	});

	if (!picked) {
		return undefined;
	}

	if (!picked.filePath) {
		return selectFile('Select signing certificate', {
			'Certificates': ['pfx']
		});
	}

	return picked.filePath;
}

async function findWorkspaceArtifactsWithCancellation(
	workspacePath: string | readonly string[],
	tiers: readonly (readonly string[])[],
	token: vscode.CancellationToken
): Promise<string[] | undefined> {
	const workspacePaths = typeof workspacePath === 'string' ? [workspacePath] : workspacePath;
	const abortController = new AbortController();
	const cancellation = token.onCancellationRequested(() => abortController.abort());
	if (token.isCancellationRequested) {
		abortController.abort();
	}

	try {
		const pathGroups = await Promise.all(
			workspacePaths.map(root =>
				findWorkspaceArtifacts(root, {
					tiers,
					signal: abortController.signal
				})
			)
		);
		if (token.isCancellationRequested) {
			return undefined;
		}

		const seen = new Set<string>();
		return pathGroups.flat().filter(candidate => {
			const key = candidate.toLowerCase();
			if (seen.has(key)) {
				return false;
			}
			seen.add(key);
			return true;
		});
	} finally {
		cancellation.dispose();
	}
}

/**
 * Resolve the publisher source, supplying VS Code UI to the decision logic in
 * `resolveCertPublisherSourceDecision`.
 *
 * @returns The resolved source, or `undefined` if the user cancelled.
 */
async function resolveCertPublisherSource(
	projectDir: string
): Promise<CertPublisherSource | undefined> {
	return resolveCertPublisherSourceDecision({
		findCanonicalManifest: async () => {
			// A plain directory read, not a workspace glob: the CLI only ever looks
			// for its manifest beside the project file, so recursing would surface
			// templates and sibling projects it would never have used.
			let entries: fs.Dirent[];
			try {
				entries = await fs.promises.readdir(projectDir, { withFileTypes: true });
			} catch {
				return undefined;
			}

			return selectCanonicalManifest(
				entries
					.filter(entry => entry.isFile())
					.map(entry => path.join(projectDir, entry.name)),
				projectDir
			);
		},

		promptPublisher: async () => {
			// The value is passed to the CLI as typed; it owns what a valid
			// publisher is.
			const publisher = await vscode.window.showInputBox({
				title: 'Certificate publisher',
				prompt: `Enter the publisher for the certificate in ${path.basename(projectDir)} — it must match your package's Identity/@Publisher.`,
				placeHolder: 'Contoso or CN=Contoso, O=Contoso Ltd, C=US',
				ignoreFocusOut: true
			});

			return publisher?.trim();
		}
	});
}

/** Build the `cert generate` arguments for a resolved publisher source. */
function certGenerateArgsFor(source: CertPublisherSource, ifExists: CertIfExists): string[] {
	return buildCertGenerateArgs(
		source.kind === 'manifest'
			? { manifestPath: source.manifestPath, ifExists }
			: { publisher: source.publisher, ifExists }
	);
}

/**
 * Report the outcome, offering to reveal the certificate.
 *
 * @param created `false` when an existing certificate was reused rather than
 *   generated, so the message does not claim work that did not happen.
 * @param installing `true` when an elevated `cert install` was handed off; the
 *   install runs in a separate window, so its own result is reported there.
 */
async function showCertGenerateSuccess(
	certificatePath: string,
	{ created, installing }: { created: boolean; installing: boolean }
): Promise<void> {
	const lead = created
		? `Certificate created at ${certificatePath}.`
		: `Using the existing certificate at ${certificatePath}.`;
	const message = installing
		? `${lead} Approve the UAC prompt in the elevated window to finish installing it.`
		: lead;

	const action = await vscode.window.showInformationMessage(message, 'Reveal in Explorer');
	if (action === 'Reveal in Explorer') {
		await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(certificatePath));
	}
}

/**
 * Where `cert generate` writes by default.
 *
 * The extension does not pass `--output`, so the CLI writes `devcert.pfx` into
 * the working directory it is spawned in. Knowing the path up front means the
 * result does not have to be parsed back out of the CLI's output.
 */
function defaultCertificatePath(projectDir: string): string {
	return path.join(projectDir, 'devcert.pfx');
}

/**
 * Build the VS Code adapter for the certificate-generation flow.
 *
 * The decision logic lives in `executeCertGenerateFlow` (cert-utils); this only
 * supplies the UI and process operations it delegates to.
 */
function createCertGenerateFlowAdapter(
	extensionPath: string,
	projectDir: string,
	source: CertPublisherSource
): CertGenerateFlowAdapter {
	const certificatePath = defaultCertificatePath(projectDir);

	return {
		runGenerate: async (ifExists: CertIfExists) => {
			const { code, output, cancelled } = await runWinappCapture(
				extensionPath,
				certGenerateArgsFor(source, ifExists),
				projectDir,
				'Generating certificate...'
			);
			return decideCertGenerateOutcome(code, output, certificatePath, cancelled);
		},

		confirmOverwrite: async (existingPath) => {
			const choice = await vscode.window.showWarningMessage(
				`A certificate already exists at ${existingPath}. Overwriting it invalidates packages already signed with it, and the new certificate must be trusted again.`,
				'Overwrite Existing Cert',
				'Use Existing Cert'
			);

			if (choice === 'Overwrite Existing Cert') {
				return 'overwrite';
			}
			if (choice === 'Use Existing Cert') {
				return 'reuse';
			}
			return 'dismiss';
		},

		installCertificate: async (certificatePath: string) => {
			// Installing trusts the certificate in the machine store, which needs
			// administrator rights. VS Code cannot elevate the integrated terminal,
			// so this runs in a separate UAC-elevated window.
			await runWinappCommandElevated(
				extensionPath,
				`cert install ${escapePowerShellArg(certificatePath)}`,
				projectDir
			);
		},

		reportSuccess: async (certPath, context) => {
			await showCertGenerateSuccess(certPath, context);
		},

		reportFailure: (message?: string) => {
			const outputChannel = getWinappOutputChannel();
			outputChannel.show(true);
			vscode.window.showErrorMessage(
				message
					? `Certificate generation failed: ${message}`
					: 'Certificate generation failed. See the WinApp output channel for details.'
			);
		},

		reportKeptExisting: (existingPath: string) => {
			vscode.window.showInformationMessage(
				`Kept the existing certificate at ${existingPath}. No certificate was generated or installed.`
			);
		}
	};
}

/** Upper bound on sparse manifests offered before the user can choose Browse. */
const MAX_DISCOVERED_SPARSE_MANIFESTS = 20;

/** App manifests are small text files; skip hostile or accidental huge inputs. */
const MAX_SPARSE_MANIFEST_BYTES = 1024 * 1024;

function sparseManifestPickerPlaceholder(label: string, resultCount: number): string {
	return resultCount >= MAX_DISCOVERED_SPARSE_MANIFESTS
		? `${label} (discovery limited to ${MAX_DISCOVERED_SPARSE_MANIFESTS} per workspace — use Browse… for others)`
		: label;
}

/**
 * Search the workspace for sparse (identity-only) manifests.
 *
 * Candidates are located with the same patterns the manifest editor uses, then
 * each is *read* and tested for `AllowExternalContent`. Detection is
 * content-based rather than path-based because a `sparse/` directory is only
 * the CLI's default output location, not a guarantee — and a sparse manifest
 * may legitimately live anywhere.
 *
 * @returns Paths of discovered sparse manifests, or `undefined` if cancelled.
 */
async function findSparseManifests(
	workspacePath: string,
	token: vscode.CancellationToken
): Promise<string[] | undefined> {
	const sparsePaths: string[] = [];
	await walkDirectoryTree(
		workspacePath,
		async (directory, entries) => {
			for (const entry of entries) {
				if (token.isCancellationRequested) {
					return 'stop';
				}
				if (!entry.isFile()) {
					continue;
				}

				const manifestPath = path.join(directory, entry.name);
				if (!isManifestPath(manifestPath)) {
					continue;
				}

				try {
					const stat = await fs.promises.stat(manifestPath);
					if (stat.size > MAX_SPARSE_MANIFEST_BYTES) {
						continue;
					}
					const bytes = await fs.promises.readFile(manifestPath);
					if (isSparseManifestXml(decodeManifestXml(bytes))) {
						sparsePaths.push(manifestPath);
						if (sparsePaths.length >= MAX_DISCOVERED_SPARSE_MANIFESTS) {
							return 'stop';
						}
					}
				} catch {
					// Unreadable or deleted between enumeration and read — skip it
					// rather than failing the whole picker.
				}
			}
			return 'descend';
		},
		{ skipDirs: BUILD_OUTPUT_SKIP_DIRS }
	);

	if (token.isCancellationRequested) {
		return undefined;
	}

	return sparsePaths.sort((a, b) => a.localeCompare(b));
}

/**
 * Locate the sparse manifest that `winapp embed-identity` should read identity
 * from for `target`.
 *
 * When `--manifest` is omitted the CLI searches a `sparse/` folder beside the
 * target and then the current directory. Neither location holds the manifest in
 * the common case: {@link winapp.initSparse} anchors its output on the
 * executable's *project root*, while a built exe usually sits several levels
 * deeper under `bin/`. Resolving the path here keeps the two commands in step
 * instead of relying on a search that only succeeds for a flat layout.
 *
 * Only the path this extension would have written is adopted automatically.
 * Embedding rewrites the executable in place, so a manifest found anywhere
 * else is confirmed by the user rather than guessed at — even when it is the
 * only one in the workspace, since it may belong to an unrelated project.
 *
 * @returns The manifest to pass explicitly, or `undefined` if the user
 * cancelled, in which case the caller must abort.
 */
async function resolveSparseManifestForTarget(
	workspacePath: string,
	target: string
): Promise<string | undefined> {
	// Mirror of the output directory winapp.initSparse passes to --output-dir,
	// so the manifest it just wrote is found without a workspace scan.
	const expected = getSparseManifestPath(
		defaultSparseOutputDir(workspacePath, findProjectRootForFile(workspacePath, target))
	);
	if (fs.existsSync(expected)) {
		const choice = chooseSparseManifest({ expectedPath: expected, expectedExists: true });
		return choice.kind === 'resolved' ? choice.path : undefined;
	}

	const discovered = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Window, title: 'Looking for sparse manifests…' },
		(_progress, token) => findSparseManifests(workspacePath, token)
	);

	const choice = chooseSparseManifest({
		expectedPath: expected,
		expectedExists: false,
		discovered
	});
	if (choice.kind === 'resolved') {
		return choice.path;
	}

	return pickSparseManifestForEmbed(workspacePath, target, choice.candidates);
}

/**
 * Ask which identity to embed when the expected manifest is missing.
 *
 * Candidates found elsewhere in the workspace are offered, but always behind
 * an explicit choice: the identity that gets stamped into the binary should
 * never be decided by which manifest happened to turn up in a scan.
 *
 * @returns The chosen manifest, or `undefined` if the user cancelled.
 */
async function pickSparseManifestForEmbed(
	workspacePath: string,
	target: string,
	candidates: string[]
): Promise<string | undefined> {
	const browseLabel = '$(file-code) Browse for sparse manifest…';
	const items: vscode.QuickPickItem[] = candidates.map(manifestPath => ({
		label: `$(file-code) ${path.basename(manifestPath)}`,
		description: path.relative(workspacePath, manifestPath),
		detail: manifestPath
	}));
	items.push({ label: browseLabel, alwaysShow: true });

	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: sparseManifestPickerPlaceholder(
			candidates.length > 0
				? `Select the sparse manifest whose identity to embed into ${path.basename(target)}`
				: `No sparse manifest found for ${path.basename(target)} — browse for one`,
			candidates.length
		),
		ignoreFocusOut: true
	});
	if (!picked) {
		return undefined;
	}
	if (picked.label !== browseLabel) {
		return picked.detail;
	}

	return selectFile('Select sparse manifest', { 'App manifests': ['xml', 'appxmanifest'] });
}

/** Select a sparse manifest for the identity-only pack command. */
async function pickSparseManifestToPack(workspacePaths: readonly string[]): Promise<string | undefined> {
	const defaultWorkspacePath = workspacePaths[0];
	let cancelled = false;
	const rootResults = await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'Searching for sparse identity manifests...',
			cancellable: true
		},
		async (_progress, token) => {
			token.onCancellationRequested(() => { cancelled = true; });
			const results = await Promise.all(
				workspacePaths.map(workspacePath => findSparseManifests(workspacePath, token))
			);
			return token.isCancellationRequested || results.some(result => !result)
				? undefined
				: [...new Set(results.flatMap(result => result ?? []))];
		}
	);
	if (cancelled || !rootResults) {
		return undefined;
	}

	if (rootResults.length === 0) {
		return selectFile('Select sparse identity manifest', {
			'App manifests': ['xml', 'appxmanifest']
		});
	}

	const browseLabel = '$(file-code) Browse…';
	const items: Array<vscode.QuickPickItem & { manifestPath?: string }> = rootResults.map(manifestPath => {
		const owner = findOwningWorkspacePath(manifestPath, workspacePaths) ?? defaultWorkspacePath;
		return {
			label: `$(file-code) ${path.basename(manifestPath)}`,
			description: workspacePaths.length > 1 ? path.basename(owner) : undefined,
			detail: manifestPath,
			manifestPath
		};
	});
	items.push({ label: browseLabel, alwaysShow: true });

	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: sparseManifestPickerPlaceholder(
			'Select the sparse identity manifest to package',
			rootResults.length
		)
	});
	if (!picked) {
		return undefined;
	}
	if (picked.label === browseLabel) {
		return selectFile('Select sparse identity manifest', {
			'App manifests': ['xml', 'appxmanifest']
		});
	}
	return picked.manifestPath;
}

/**
 * Walk up from `filePath` to find the nearest enclosing directory that looks
 * like a project root, stopping at the workspace root.
 *
 * Used to anchor sparse init's output directory so that in a monorepo the
 * generated `sparse/` folder lands beside the project owning the executable
 * rather than at the workspace root. Returns `undefined` when no project
 * marker is found, in which case the caller falls back to the workspace root.
 *
 * This is a cheap synchronous lookup for a *default* — it deliberately does
 * not run the full project detection scan, since these commands act on an
 * explicit executable rather than on a resolved project.
 */
function findProjectRootForFile(workspacePath: string, filePath: string): string | undefined {
	return findProjectRootIn(workspacePath, filePath, dir => fs.readdirSync(dir));
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
	inputRoot: string,
	result: { code: number | null; output: string; cancelled?: boolean; identityOnly?: boolean }
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
			!isArtifactWithinRoot(plan.artifactPath, inputRoot))
	) {
		getWinappOutputChannel().show();
		vscode.window.showErrorMessage('Packaging failed. See the WinApp output channel for details.');
		return;
	}

	const choice = await vscode.window.showInformationMessage(plan.message, ...plan.actions);

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
	return getWorkspacePaths()?.[0];
}

/** Get all open workspace folder paths, preserving VS Code's root order. */
function getWorkspacePaths(): string[] | undefined {
	const paths = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath);
	if (!paths || paths.length === 0) {
		vscode.window.showErrorMessage(NO_WORKSPACE_MESSAGE);
		return undefined;
	}
	return paths;
}

/**
 * Resolve the workspace root that owns a selected target.
 *
 * Sparse commands start discovery from the first workspace root, but Browse…
 * can select a file from another root or outside the workspace. All subsequent
 * path decisions must follow the selected file rather than root ordering.
 */
function getTargetWorkspacePath(target: string): string | undefined {
	return findOwningWorkspacePath(
		target,
		vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? []
	);
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

/** Escapes each argument separately so PowerShell preserves boundaries. */
async function runWinappRun(extensionPath: string, options: WinAppRunOptions, cwd: string): Promise<void> {
	const command = buildRunArgs(options).map(escapePowerShellArg).join(' ');
	await runWinappCommand(extensionPath, command, cwd);
}

async function executeRunCommand(extensionPath: string, withOptions: boolean): Promise<void> {
	const resolved = await resolveRunOptions(withOptions);
	if (!resolved) {
		return;
	}

	await runWinappRun(extensionPath, resolved.options, resolved.target.root.path);
}

class WinAppDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
	private extensionPath: string;

	constructor(extensionPath: string) {
		this.extensionPath = extensionPath;
	}

	/**
	 * Deliberately no `provideDebugConfigurations` here.
	 *
	 * For the initial trigger kind VS Code CONCATENATES package.json's
	 * `initialConfigurations` with whatever providers return
	 * (Debugger.getInitialConfigurationContent), so implementing it would
	 * write the WinApp entry to launch.json twice. package.json already
	 * declares the one configuration we want; the dynamic provider
	 * registered in activate() covers the Run and Debug dropdown, which VS
	 * Code queries through a separate path that does no concatenation.
	 */
	async resolveDebugConfiguration(
		_folder: vscode.WorkspaceFolder | undefined,
		config: vscode.DebugConfiguration,
		_token?: vscode.CancellationToken
	): Promise<vscode.DebugConfiguration | undefined> {
		// If no configuration, create a default one
		if (!config.type && !config.request && !config.name) {
			config.type = WINAPP_DEBUG_TYPE;
			config.name = WINAPP_LAUNCH_CONFIG_NAME;
			config.request = 'launch';
		}

		// Ensure the extension backing the underlying debugger is installed before
		// the session starts, so a first-run user isn't dropped into a half-started
		// session (issue #32). When no debuggerType is configured, let the user
		// choose the extension matching their project instead of assuming coreclr.
		const debuggerResolution = resolveDebuggerTypeForRun(config.debuggerType, config.aot);
		if (debuggerResolution.error) {
			vscode.window.showErrorMessage(debuggerResolution.error);
			return undefined;
		}

		const debuggerType = await resolveDebuggerType(debuggerResolution.debuggerType);
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
			vscode.window.showErrorMessage(NO_WORKSPACE_MESSAGE);
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

		// The CLI reports bad option values itself; these three are rejected
		// here because they break the debug session, so it never sees them.
		const optionErrors = validateDebugRunOptions(runOptionsFromDebugConfig(config, input ?? ''));
		if (optionErrors.length > 0) {
			vscode.window.showErrorMessage(optionErrors.join(' '));
			return undefined;
		}

		if (input) {
			const result = await validateRunInput(input, cwd, config.input ? 'input' : 'inputFolder');
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
 * The user dismissed a prompt. Not a failure, so it must not be reported as
 * one: an error toast for "I pressed Escape" is noise, and VS Code's own
 * convention is for a cancelled launch to end quietly.
 *
 * Shared with `run-launch.ts`, which raises the same class when the user
 * cancels the "Launching package..." progress notification.
 */
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
			throw new Error(NO_WORKSPACE_MESSAGE);
		}

		try {
			// The run command requires an input positional argument. If not set
			// in launch.json, discover projects and build output folders in the
			// workspace and let the user pick one.
			let input = resolveDebugInput(config);
			const cwd = resolveWorkingDirectory(folder.uri.fsPath, config.workingDirectory);
			// A target chosen interactively may still be ambiguous (a solution
			// or directory holding several runnable apps). The palette flow
			// disambiguates in the same way; without this, F5 would launch
			// `winapp run <sln>` with no --project and the CLI would refuse.
			let pickedProject: string | undefined;

			if (!input) {
				const selection = await pickRunTarget(folder);
				if (!selection) {
					throw new DebugLaunchCancelled();
				}
				input = selection.target.path;

				// An explicit launch.json "project" wins below, so prompting for
				// one here would only discard the answer.
				if (shouldPromptForProject(config.project)) {
					const projectSelection = await pickSolutionProject(selection);
					if (projectSelection.cancelled) {
						throw new DebugLaunchCancelled();
					}
					pickedProject = projectSelection.project;
				}
			}

			const cliPath = getWinappCliPath(this.extensionPath);

			// Resolution normally sets this before the adapter starts, but keep
			// the Native AOT constraint here too in case another caller bypasses
			// the configuration provider.
			const debuggerResolution = resolveDebuggerTypeForRun(config.debuggerType, config.aot);
			if (debuggerResolution.error) {
				throw new Error(debuggerResolution.error);
			}
			const debuggerType = debuggerResolution.debuggerType || 'coreclr';

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
			// An explicit launch.json "project" always wins; this only fills in
			// what the interactive picker resolved.
			runOptions.project = resolveRunProject(runOptions.project, pickedProject);

			const baseSpawnArgs = buildRunArgs(runOptions);

			const outputChannel = getWinappOutputChannel();
			const { processId, runProcess } = await launchRunProcess({
				cliPath,
				args: baseSpawnArgs,
				cwd,
				outputChannel
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
			// Dismissing a prompt is a decision, not a failure. VS Code ends
			// the session quietly; an error toast would just blame the user.
			if (error instanceof DebugLaunchCancelled) {
				throw error;
			}

			const message = error instanceof Error ? error.message : String(error);

			// A run failure has already written the full CLI output to the
			// channel; point the user at it instead of pasting a build log into
			// a toast that truncates it.
			if (error instanceof WinAppRunFailure) {
				const showOutput = 'Show Output';
				void vscode.window.showErrorMessage(`Failed to launch and attach: ${message}`, showOutput)
					.then(action => {
						if (action === showOutput) {
							getWinappOutputChannel().show(true);
						}
					}, () => { });
			} else {
				vscode.window.showErrorMessage(`Failed to launch and attach: ${message}`);
			}
			throw error;
		}
	}
}

export function activate(context: vscode.ExtensionContext) {
	const extensionPath = context.extensionPath;
	const provider = new WinAppDebugConfigurationProvider(extensionPath);

	// Dispose the shared WinApp output channel when the extension unloads.
	context.subscriptions.push({ dispose: () => disposeWinappOutputChannel() });

	context.subscriptions.push(
		vscode.debug.registerDebugConfigurationProvider(WINAPP_DEBUG_TYPE, provider)
	);

	// Offer WinApp in the Run and Debug view's automatic configuration list.
	// Unlike the F5 path, that list is queried independently of the active
	// editor, so it works whatever file the user happens to have open.
	//
	// A standalone provider rather than `provider` above: only the dynamic
	// trigger kind may supply configurations here, because VS Code appends
	// initial-kind results to package.json's `initialConfigurations` and
	// would duplicate the entry.
	context.subscriptions.push(
		vscode.debug.registerDebugConfigurationProvider(
			WINAPP_DEBUG_TYPE,
			{ provideDebugConfigurations: () => [createDefaultLaunchConfiguration()] },
			vscode.DebugConfigurationProviderTriggerKind.Dynamic
		)
	);

	// A missing launch.json is what strands users on VS Code's "install an
	// extension for <language>" prompt, so offer to create one up front.
	// Fire-and-forget: activation must not block on a notification, but a
	// rejection still has to land somewhere other than an unhandled one.
	offerLaunchConfiguration(context).catch(error => {
		console.error('WinApp: failed to offer a launch configuration', error);
	});

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

	registerWinappNewCommand(context, extensionPath);

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

	// Register winapp.initSparse command
	context.subscriptions.push(
		vscode.commands.registerCommand('winapp.initSparse', async () => {
			const workspacePaths = getWorkspacePaths();
			if (!workspacePaths) {
				return;
			}

			// Sparse init acts on an existing built executable and writes to an
			// explicit --output-dir, so it deliberately skips project detection.
			const exePath = await pickExecutableTarget(
				workspacePaths,
				'Select the executable to grant package identity'
			);
			if (!exePath) {
				return;
			}

			const targetWorkspacePath = getTargetWorkspacePath(exePath);
			let outputDir: string;
			if (targetWorkspacePath) {
				outputDir = defaultSparseOutputDir(
					targetWorkspacePath,
					findProjectRootForFile(targetWorkspacePath, exePath)
				);
			} else {
				outputDir = defaultSparseOutputDir(path.dirname(exePath));
			}

			// The CLI refuses to replace an existing manifest or generated
			// assets, so ask first rather than letting a partial rerun fail.
			let force = false;
			if (hasExistingSparseOutput(outputDir, fs.existsSync)) {
				const relative = targetWorkspacePath
					? path.relative(targetWorkspacePath, outputDir) || outputDir
					: outputDir;
				const proceed = await vscode.window.showWarningMessage(
					`Sparse identity output already exists in ${relative}. Overwrite the manifest and generated assets?`,
					{ modal: true },
					'Overwrite'
				);
				if (proceed !== 'Overwrite') {
					return;
				}
				force = true;
			}

			const plan = planSparseInitCommand({
				exePath,
				outputDir,
				workspacePath: targetWorkspacePath,
				force
			});
			await runWinappCommand(
				extensionPath,
				formatPowerShellArgs(plan.args),
				plan.cwd
			);
		})
	);

	// Register winapp.embedIdentity command
	context.subscriptions.push(
		vscode.commands.registerCommand('winapp.embedIdentity', async () => {
			const workspacePaths = getWorkspacePaths();
			if (!workspacePaths) {
				return;
			}

			// Side-by-side manifests are included, but a generic **/*.xml scan is
			// deliberately avoided — far too noisy in a real repo. An .xml target
			// stays reachable through Browse….
			const target = await pickExecutableTarget(
				workspacePaths,
				'Select the executable or side-by-side manifest',
				['manifest'],
				{ 'Side-by-side manifests': ['manifest', 'xml'] }
			);
			if (!target) {
				return;
			}
			const targetWorkspacePath = getTargetWorkspacePath(target);

			const manifestPath = targetWorkspacePath
				? await resolveSparseManifestForTarget(targetWorkspacePath, target)
				: await pickSparseManifestForEmbed(path.dirname(target), target, []);
			if (!manifestPath) {
				return;
			}

			if (embedRewritesBinary(target)) {
				void vscode.window.showInformationMessage(
					`Embedding identity into ${path.basename(target)}. Previously signed? Re-sign before distributing.`
				);
			}

			const plan = planEmbedIdentityCommand({
				target,
				manifestPath,
				workspacePath: targetWorkspacePath
			});
			await runWinappCommand(
				extensionPath,
				formatPowerShellArgs(plan.args),
				plan.cwd
			);
		})
	);
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
			if (generateCert === undefined) {
				return;
			}

			const selfContained = await vscode.window.showQuickPick(
				['Yes', 'No'],
				{ placeHolder: 'Bundle Windows App SDK runtime (self-contained)?' }
			);
			if (selfContained === undefined) {
				return;
			}

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
			await handlePackCompletion(
				extensionPath,
				workspacePath,
				inputFolder,
				result
			);
		})
	);

	// Register winapp.packSparse command
	context.subscriptions.push(
		vscode.commands.registerCommand('winapp.packSparse', async () => {
			const workspacePaths = getWorkspacePaths();
			if (!workspacePaths) {
				return;
			}

			const manifestPath = await pickSparseManifestToPack(workspacePaths);
			if (!manifestPath) {
				return;
			}
			const workspacePath =
				findOwningWorkspacePath(manifestPath, workspacePaths) ??
				path.dirname(manifestPath);

			const generateCert = await vscode.window.showQuickPick(
				['Yes', 'No'],
				{ placeHolder: 'Generate a development certificate?' }
			);
			if (generateCert === undefined) {
				return;
			}

			const args = buildSparsePackArgs({
				manifestPath,
				generateCertificate: generateCert === 'Yes'
			});

			const result = await runWinappCapture(
				extensionPath,
				args,
				workspacePath,
				'Creating sparse identity package...'
			);
			await handlePackCompletion(
				extensionPath,
				workspacePath,
				path.dirname(manifestPath),
				{ ...result, identityOnly: true }
			);
		})
	);

	// Register winapp.run command
	context.subscriptions.push(
		vscode.commands.registerCommand('winapp.run', async () => {
			await executeRunCommand(extensionPath, false);
		})
	);

	// Register winapp.runWithOptions command
	context.subscriptions.push(
		vscode.commands.registerCommand('winapp.runWithOptions', async () => {
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

			const source = await resolveCertPublisherSource(projectDir);
			if (!source) {
				return;
			}

			// Generation runs un-elevated so its exit code is visible here: a bad
			// publisher or an existing certificate can then be reported in VS Code
			// instead of scrolling past inside a UAC window. Only the install step
			// needs administrator rights, and it is elevated separately.
			await executeCertGenerateFlow(
				createCertGenerateFlowAdapter(extensionPath, projectDir, source),
				install === 'Generate and install (requires admin)'
			);
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

export function deactivate() {
	debuggerLogChannel?.dispose();
	debuggerLogChannel = undefined;
}
