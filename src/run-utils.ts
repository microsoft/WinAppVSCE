import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
	BUILD_OUTPUT_EXCLUDE_GLOB,
	BUILD_OUTPUT_MAX_RESULTS,
	deduplicateBuildOutputFolders
} from './project-detection';
import {
	classifyRunTarget,
	classifyRunTargetFile,
	dedupeSolutionMembers,
	filterOfferableCandidates,
	filterOfferableProjects,
	findOwningRoot,
	isProjectMode,
	PROJECT_FILE_EXCLUDE_GLOB,
	PROJECT_FILE_GLOB,
	PROJECT_FILE_MAX_RESULTS,
	readDirectoryProjectPaths,
	readSolutionProjectPaths,
	RUN_TARGET_DISPLAY_LIMIT,
	sortRunTargets,
	type RunTargetCandidate,
	type RunTargetKind,
	type WorkspaceRoot
} from './run-target';
import {
	COMMON_CONFIGURATIONS,
	getRunOptionErrors,
	SUPPORTED_ARCHITECTURES,
	validateRunOptions,
	type WinAppRunOptions
} from './run-options';

/**
 * The run flow for `winapp run`: discovering targets, resolving options, and
 * prompting only where the CLI genuinely cannot decide for itself.
 *
 * Extracted from `extension.ts`, which had grown past 76 KB. The pure pieces
 * live in `run-target.ts` and `run-options.ts`; this module is the VS Code
 * layer that sits on top of them and is shared by the palette commands and the
 * debug adapter.
 */

export const FOLDER_PICKER_DETAIL = 'Open a folder picker';

/** Marks the run-target picker entry that opens a file dialog for projects. */
const PROJECT_PICKER_DETAIL = 'Open a file picker for .csproj, .sln, or .slnx';

const BUILD_OUTPUT_SEARCH_DETAIL = 'Scan the workspace for folders containing .exe files';

/**
 * Prompt the user to select a folder.
 */
export async function selectFolder(title: string, defaultUri?: vscode.Uri): Promise<string | undefined> {
	const result = await vscode.window.showOpenDialog({
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: false,
		title,
		defaultUri
	});

	return result?.[0]?.fsPath;
}

/**
 * Scan a workspace root for build output folders (directories containing .exe
 * files). Shows a progress notification with cancel support.
 *
 * @returns The discovered folder paths sorted by relative path, or `undefined`
 *   if cancelled.
 */
export async function findBuildOutputFolders(workspacePath: string): Promise<string[] | undefined> {
	const outputFolders = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Searching for build output folders...', cancellable: true },
		async (_progress, token) => {
			// The token must reach findFiles itself: cancelling only a flag we
			// read afterwards leaves the (expensive) scan running to completion,
			// so the Cancel button appears to do nothing.
			const exeMatches = await vscode.workspace.findFiles(
				new vscode.RelativePattern(workspacePath, '**/*.exe'),
				BUILD_OUTPUT_EXCLUDE_GLOB,
				BUILD_OUTPUT_MAX_RESULTS,
				token
			);

			if (token.isCancellationRequested) {
				return undefined;
			}

			return deduplicateBuildOutputFolders(exeMatches.map(m => m.fsPath), workspacePath);
		}
	);

	return outputFolders;
}

/**
 * Search the workspace for build output folders and let the user pick one via
 * a QuickPick. Falls back to a native folder dialog when none are found; a
 * "Browse…" entry is always appended.
 *
 * Used by the commands that genuinely require built output (for example
 * `winapp pack`). The run flow uses {@link pickRunTarget} instead, which can
 * also offer projects and solutions.
 *
 * @returns The selected folder path, or `undefined` if cancelled.
 */
export async function pickBuildOutputFolder(workspacePath: string): Promise<string | undefined> {
	const outputFolders = await findBuildOutputFolders(workspacePath);
	if (!outputFolders) {
		return undefined;
	}

	if (outputFolders.length === 0) {
		vscode.window.showWarningMessage(
			'No folders containing .exe files were found. Build your project first, or browse to a folder.'
		);
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
 * Unlike `getWorkspacePath`, this does not collapse a multi-root workspace to
 * its first folder.
 */
export function getWorkspaceRoots(): WorkspaceRoot[] {
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
async function findProjectTargets(
	roots: readonly WorkspaceRoot[],
	token: vscode.CancellationToken
): Promise<RunTargetCandidate[]> {
	const candidates: RunTargetCandidate[] = [];

	for (const root of roots) {
		const matches = await vscode.workspace.findFiles(
			new vscode.RelativePattern(root.path, PROJECT_FILE_GLOB),
			PROJECT_FILE_EXCLUDE_GLOB,
			PROJECT_FILE_MAX_RESULTS,
			token
		);

		if (token.isCancellationRequested) {
			return [];
		}

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

interface RunTargetQuickPickItem extends vscode.QuickPickItem {
	candidate?: RunTargetCandidate;
}

/**
 * A chosen run target, plus anything discovery already learned about it.
 *
 * Carrying the solution's members avoids re-reading and re-parsing a solution
 * file that discovery has already parsed in order to fold its members away.
 */
export interface RunTargetSelection {
	target: RunTargetCandidate;
	/** Absolute project paths belonging to `target`, when already known. */
	members?: readonly string[];
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
export async function pickRunTarget(
	alwaysPrompt: boolean = false,
	scope?: vscode.WorkspaceFolder
): Promise<RunTargetSelection | undefined> {
	const roots = scope
		? [{ name: scope.name, path: scope.uri.fsPath }]
		: getWorkspaceRoots();
	if (roots.length === 0) {
		vscode.window.showErrorMessage('No workspace folder open');
		return undefined;
	}

	const projects = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Searching for projects...', cancellable: true },
		async (_progress, token) => {
			const found = await findProjectTargets(roots, token);
			return token.isCancellationRequested ? undefined : found;
		}
	);

	if (!projects) {
		return undefined;
	}

	// No project or solution anywhere — fall back to the (more expensive)
	// build-output scan, which is the only way to run in folder mode.
	let candidates = projects;
	let solutionMembers = new Map<string, string[]>();
	let buildOutputScanned = false;

	if (candidates.length > 0) {
		solutionMembers = await mapSolutionMembers(candidates);
		candidates = dedupeSolutionMembers(candidates, solutionMembers);
		// Drop projects the project file itself identifies as a library or a
		// test project. Solutions are left alone — the CLI resolves the
		// runnable project inside one far more accurately than we can.
		candidates = await filterOfferableCandidates(candidates);
	}

	// Discovery either found nothing, or found only libraries and test
	// projects. Both leave a build output folder as the one remaining way to
	// run, so look for one before giving up on the workspace.
	const onlyUnrunnableProjects = projects.length > 0 && candidates.length === 0;
	if (candidates.length === 0) {
		const folders = await findBuildOutputTargets(roots);
		if (!folders) {
			return undefined;
		}
		candidates = folders;
		buildOutputScanned = true;
	}

	if (candidates.length === 0) {
		// Nothing runnable at all. Say so before a file dialog appears
		// unbidden — the user asked to run, not to browse.
		vscode.window.showWarningMessage(
			onlyUnrunnableProjects
				? 'Only library and test projects were found in this workspace, and winapp run needs an executable app project. Browse to the project or folder you want to run.'
				: 'No projects, solutions, or build output folders were found in this workspace. Browse to the project or folder you want to run.'
		);
		return browseForRunTarget(roots, 'folder');
	}

	const preferredRootPath = getPreferredRootPath(roots);
	const sorted = sortRunTargets(candidates, preferredRootPath);

	// A single unambiguous target needs no prompt at all.
	if (sorted.length === 1 && !alwaysPrompt) {
		return { target: sorted[0], members: solutionMembers.get(sorted[0].path) };
	}

	const shown = sorted.slice(0, RUN_TARGET_DISPLAY_LIMIT);
	const items = buildRunTargetItems(shown, roots.length > 1);

	// A separator immediately followed by another is collapsed by VS Code, so
	// the cap notice doubles as the divider before the browse entries.
	const capped = sorted.length > shown.length;
	items.push({
		label: capped ? `Showing ${shown.length} of ${sorted.length} — browse to reach the rest` : '',
		kind: vscode.QuickPickItemKind.Separator
	});

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
			sortRunTargets(folders, preferredRootPath).slice(0, RUN_TARGET_DISPLAY_LIMIT),
			roots.length > 1
		);
		const pickedFolder = await vscode.window.showQuickPick(folderItems, {
			placeHolder: 'Select the build output folder containing your app',
			matchOnDescription: true
		});
		return pickedFolder?.candidate ? { target: pickedFolder.candidate } : undefined;
	}

	return picked.candidate
		? { target: picked.candidate, members: solutionMembers.get(picked.candidate.path) }
		: undefined;
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
): Promise<RunTargetSelection | undefined> {
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
		target: {
			kind: await classifyRunTarget(selected),
			path: selected,
			root: findOwningRoot(roots, selected) ?? roots[0]
		}
	};
}

/**
 * Read the `winapp.run.*` defaults for a workspace root.
 *
 * These settings are resource-scoped, so each folder of a multi-root workspace
 * can carry its own configuration/architecture/properties in its
 * `.vscode/settings.json`.
 */
export function getRunSettings(rootPath: string): Partial<WinAppRunOptions> {
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

/** True when `targetPath` exists and is a directory. */
async function isDirectory(targetPath: string): Promise<boolean> {
	try {
		return (await fs.promises.stat(targetPath)).isDirectory();
	} catch {
		return false;
	}
}

/**
 * The projects a target contains, or an empty array when the target already
 * names a single project.
 *
 * Branches on what the path *is* rather than on its classified kind: a
 * directory holding a `.sln` classifies as `solution`, but must be read as a
 * directory. Reading it as a solution file fails with `EISDIR`, and because
 * that failure is swallowed the caller would silently skip the prompt.
 */
async function readTargetProjects(
	target: RunTargetCandidate
): Promise<{ projects: string[]; containerPath: string }> {
	if (!isProjectMode(target.kind)) {
		return { projects: [], containerPath: target.path };
	}

	if (await isDirectory(target.path)) {
		// A directory input is resolved by the CLI from the projects and
		// solutions at its top level.
		const directoryProjects = await readDirectoryProjectPaths(target.path);
		if (directoryProjects.length > 0) {
			return { projects: directoryProjects, containerPath: target.path };
		}
		return { projects: [], containerPath: target.path };
	}

	if (target.kind === 'solution') {
		return {
			projects: await readSolutionProjectPaths(target.path),
			containerPath: path.dirname(target.path)
		};
	}

	// A path to a single .csproj already names the project.
	return { projects: [], containerPath: path.dirname(target.path) };
}

/**
 * Ask which project to launch, but only when the CLI genuinely cannot work it
 * out for itself.
 *
 * `winapp run` already auto-selects the single runnable app project in a
 * solution or directory, using full MSBuild evaluation — it only fails when
 * there are several. So this prompts only when more than one candidate
 * survives filtering, and otherwise emits no `--project` at all. Guessing on
 * the CLI's behalf with a weaker heuristic risks pinning the *wrong* project,
 * which is worse than letting the CLI decide or report a precise error.
 *
 * Returns `{ cancelled: true }` when the user dismissed the prompt, which is
 * distinct from "no selection needed" — the caller must not run in that case.
 */
export async function pickSolutionProject(
	selection: RunTargetSelection
): Promise<{ cancelled: boolean; project?: string }> {
	const target = selection.target;

	let projects: string[];
	let containerPath: string;

	// Discovery may already have parsed this solution in order to fold its
	// members away; reuse that rather than reading the file a second time.
	if (selection.members && selection.members.length > 0 && !await isDirectory(target.path)) {
		projects = [...selection.members];
		containerPath = path.dirname(target.path);
	} else {
		({ projects, containerPath } = await readTargetProjects(target));
	}

	if (projects.length <= 1) {
		return { cancelled: false };
	}

	const offerable = await filterOfferableProjects(projects);
	if (offerable.length <= 1) {
		// Exactly one plausible app, or none at all. Either way there is
		// nothing worth asking about: the CLI makes the final call with its
		// own, better-informed classification, and when nothing is runnable it
		// reports that far more precisely than a doomed QuickPick would.
		return { cancelled: false };
	}

	const items = offerable.map(projectPath => ({
		label: `$(file-code) ${path.basename(projectPath)}`,
		// Show the path relative to the container, not just the file name, so
		// two same-named projects are distinguishable.
		description: path.relative(containerPath, projectPath),
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

/**
 * The toggles offered by the advanced run command.
 *
 * `--without-alias` is deliberately absent: it is the inverse of
 * `--with-alias`, and two mutually exclusive checkboxes in one multi-select
 * invite a selection that `validateRunOptions` then has to reject. It stays
 * available in launch.json, where the two are separate properties.
 */
const RUN_TOGGLES: RunToggle[] = [
	{ key: 'clean', label: 'Clean application data', detail: 'Remove the existing package\'s LocalState and settings before deploying (--clean)' },
	{ key: 'noBuild', label: 'Skip build', detail: 'Run the existing build output without rebuilding (--no-build)', projectOnly: true },
	{ key: 'noRestore', label: 'Skip restore', detail: 'Do not restore the project before building (--no-restore)', projectOnly: true },
	{ key: 'aot', label: 'Native AOT publish', detail: 'Run the project\'s configured Native AOT publish; requires PublishAot=true (--aot)', projectOnly: true },
	{ key: 'detach', label: 'Launch and return immediately', detail: 'Do not wait for the app to exit (--detach)' },
	{ key: 'noLaunch', label: 'Register only, do not launch', detail: 'Create the debug identity and register the package without starting the app (--no-launch)' },
	{ key: 'withAlias', label: 'Launch via execution alias', detail: 'Run in the terminal with stdin/stdout inherited; requires an execution alias in the manifest (--with-alias)' },
	{ key: 'unregisterOnExit', label: 'Unregister on exit', detail: 'Remove the development package after the app exits (--unregister-on-exit)' }
];

/**
 * Prompt for the advanced run options in a single multi-select, rather than a
 * chain of yes/no prompts.
 *
 * Options that the CLI ignores for the chosen target are omitted entirely
 * rather than shown disabled, so the list never offers a no-op. Options
 * already enabled by settings start checked, so leaving the prompt untouched
 * preserves the configured behaviour.
 *
 * @returns The selected options, or `undefined` if cancelled.
 */
export async function pickRunToggles(
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
 * Both prompts are seeded from the current settings and mark the active value,
 * so a configured non-default (for example a custom configuration name) is
 * offered rather than silently replaced.
 *
 * @returns The selections, or `undefined` if cancelled.
 */
export async function pickBuildSettings(
	defaults: Partial<WinAppRunOptions>
): Promise<Partial<WinAppRunOptions> | undefined> {
	const currentConfiguration = defaults.configuration ?? 'Debug';
	const configurationNames = [...COMMON_CONFIGURATIONS] as string[];
	if (!configurationNames.includes(currentConfiguration)) {
		// A custom configuration from settings must remain selectable, or the
		// prompt would quietly replace it with Debug.
		configurationNames.unshift(currentConfiguration);
	}

	const configurationItems = configurationNames.map(name => ({
		label: name,
		description: name === currentConfiguration ? 'current default' : undefined
	}));

	const configuration = await vscode.window.showQuickPick(configurationItems, {
		placeHolder: 'Build configuration'
	});
	if (!configuration) {
		return undefined;
	}

	const archItems = [
		{
			label: 'Default',
			description: defaults.arch ? undefined : 'current default',
			arch: undefined as string | undefined
		},
		...[...SUPPORTED_ARCHITECTURES].map(name => ({
			label: name,
			description: name === defaults.arch ? 'current default' : undefined,
			arch: name as string | undefined
		}))
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
export function reportRunDiagnostics(options: WinAppRunOptions, kind: RunTargetKind): boolean {
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
 * Resolve the full option set for a run, from target selection through to
 * validation. Shared by the palette commands and the debug adapter's
 * no-configuration fallback.
 *
 * @returns The resolved options and the selected target, or `undefined` when
 *   the user cancelled or validation failed.
 */
export async function resolveRunOptions(
	advanced: boolean,
	scope?: vscode.WorkspaceFolder
): Promise<{ options: WinAppRunOptions; target: RunTargetCandidate } | undefined> {
	const selection = await pickRunTarget(advanced, scope);
	if (!selection) {
		return undefined;
	}

	const target = selection.target;
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

	const projectSelection = await pickSolutionProject(selection);
	if (projectSelection.cancelled) {
		return undefined;
	}
	options.project = projectSelection.project;

	if (advanced) {
		if (projectMode) {
			const buildSettings = await pickBuildSettings(settings);
			if (!buildSettings) {
				return undefined;
			}
			options = { ...options, ...buildSettings };
		}

		const toggles = await pickRunToggles(target.kind, settings);
		if (!toggles) {
			return undefined;
		}
		options = { ...options, ...toggles };
	}

	if (!reportRunDiagnostics(options, target.kind)) {
		return undefined;
	}

	return { options, target };
}
