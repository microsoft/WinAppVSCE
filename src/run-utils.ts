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
	isDirectory,
	isProjectMode,
	PROJECT_FILE_EXCLUDE_GLOB,
	PROJECT_FILE_GLOB,
	PROJECT_FILE_MAX_RESULTS,
	readSolutionProjectPaths,
	readTargetProjects,
	RUN_TARGET_DISPLAY_LIMIT,
	sortRunTargets,
	type RunTargetCandidate,
	type RunTargetKind,
	type WorkspaceRoot
} from './run-target';
import {
	COMMON_CONFIGURATIONS,
	SUPPORTED_ARCHITECTURES,
	type WinAppRunOptions
} from './run-options';

/** VS Code layer for `winapp run`, shared by commands and the debug adapter. */

export const FOLDER_PICKER_DETAIL = 'Open a folder picker';

/** Marks the run-target picker entry that opens a file dialog for projects. */
const PROJECT_PICKER_DETAIL = 'Open a file picker for .csproj, .sln, or .slnx';

const BUILD_OUTPUT_SEARCH_DETAIL = 'Scan the workspace for folders containing .exe files';

/** Shown whenever an executable scan comes up empty, in either picker. */
const NO_BUILD_OUTPUT_MESSAGE =
	'No folders containing .exe files were found. Build your project first, or browse to a folder.';

/** Title of the native folder dialog used as the build-output fallback. */
const SELECT_BUILD_OUTPUT_TITLE = 'Select build output folder';

/** Placeholder for every build-output QuickPick. */
const SELECT_BUILD_OUTPUT_PLACEHOLDER = 'Select the build output folder containing your app';

/** Every run entry point reports a missing workspace identically. */
export const NO_WORKSPACE_MESSAGE = 'No workspace folder open';

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

/** Shown by both the single-root and multi-root build-output scans. */
const BUILD_OUTPUT_PROGRESS_TITLE = 'Searching for build output folders...';

/** Scans one root; the caller owns the progress UI and the cancellation token. */
async function scanBuildOutputFolders(
	workspacePath: string,
	token: vscode.CancellationToken
): Promise<string[] | undefined> {
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

/** Find build-output folders with cancellable VS Code progress. */
export async function findBuildOutputFolders(workspacePath: string): Promise<string[] | undefined> {
	return vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: BUILD_OUTPUT_PROGRESS_TITLE, cancellable: true },
		(_progress, token) => scanBuildOutputFolders(workspacePath, token)
	);
}

/** Pick build output, always leaving Browse available. */
export async function pickBuildOutputFolder(workspacePath: string): Promise<string | undefined> {
	const outputFolders = await findBuildOutputFolders(workspacePath);
	if (!outputFolders) {
		return undefined;
	}

	if (outputFolders.length === 0) {
		vscode.window.showWarningMessage(NO_BUILD_OUTPUT_MESSAGE);
		return selectFolder(SELECT_BUILD_OUTPUT_TITLE, vscode.Uri.file(workspacePath));
	}

	const items: Array<vscode.QuickPickItem & { directory?: string }> = outputFolders.map((folderPath) => ({
		label: path.relative(workspacePath, folderPath) || '.',
		detail: folderPath,
		directory: folderPath
	}));

	items.push({ label: '$(folder-opened) Browse…', detail: FOLDER_PICKER_DETAIL });

	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: SELECT_BUILD_OUTPUT_PLACEHOLDER
	});

	if (!picked) {
		return undefined;
	}

	if (picked.detail === FOLDER_PICKER_DETAIL) {
		return selectFolder(SELECT_BUILD_OUTPUT_TITLE, vscode.Uri.file(workspacePath));
	}

	return picked.directory;
}

/** Returns all workspace roots; never collapses multi-root workspaces. */
export function getWorkspaceRoots(): WorkspaceRoot[] {
	return (vscode.workspace.workspaceFolders ?? []).map(folder => ({
		name: folder.name,
		path: folder.uri.fsPath
	}));
}

/** Root owning the active editor, used only as a sort hint. */
function getPreferredRootPath(roots: readonly WorkspaceRoot[]): string | undefined {
	const activeUri = vscode.window.activeTextEditor?.document.uri;
	if (!activeUri || activeUri.scheme !== 'file') {
		return undefined;
	}
	return findOwningRoot(roots, activeUri.fsPath)?.path;
}

/** Prefer project globbing; reserve executable scans for fallback or explicit use. */
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

/** Find `.exe` output folders across every workspace root. */
async function findBuildOutputTargets(roots: readonly WorkspaceRoot[]): Promise<RunTargetCandidate[] | undefined> {
	// One progress notification for the whole sweep. Calling the single-root
	// helper per root would stack a separate popup, and a separate Cancel
	// button, on every folder in a multi-root workspace.
	return vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: BUILD_OUTPUT_PROGRESS_TITLE, cancellable: true },
		async (_progress, token) => {
			const candidates: RunTargetCandidate[] = [];

			for (const root of roots) {
				const folders = await scanBuildOutputFolders(root.path, token);
				if (!folders) {
					return undefined;
				}
				for (const folder of folders) {
					candidates.push({ kind: 'folder', path: folder, root });
				}
			}

			return candidates;
		}
	);
}

/** Map each discovered solution to its member projects. */
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

/** Selected run target plus discovery data already parsed for it. */
export interface RunTargetSelection {
	target: RunTargetCandidate;
	/** Absolute project paths belonging to `target`, when already known. */
	members?: readonly string[];
}

/** Build grouped items; show root names only for multi-root workspaces. */
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

/** Pick what to run; the selection derives the CLI mode. */
export async function pickRunTarget(
	alwaysPrompt: boolean = false,
	scope?: vscode.WorkspaceFolder
): Promise<RunTargetSelection | undefined> {
	const roots = scope
		? [{ name: scope.name, path: scope.uri.fsPath }]
		: getWorkspaceRoots();
	if (roots.length === 0) {
		vscode.window.showErrorMessage(NO_WORKSPACE_MESSAGE);
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
			vscode.window.showWarningMessage(NO_BUILD_OUTPUT_MESSAGE);
			return browseForRunTarget(roots, 'folder');
		}
		const folderItems = buildRunTargetItems(
			sortRunTargets(folders, preferredRootPath).slice(0, RUN_TARGET_DISPLAY_LIMIT),
			roots.length > 1
		);
		const pickedFolder = await vscode.window.showQuickPick(folderItems, {
			placeHolder: SELECT_BUILD_OUTPUT_PLACEHOLDER,
			matchOnDescription: true
		});
		return pickedFolder?.candidate ? { target: pickedFolder.candidate } : undefined;
	}

	return picked.candidate
		? { target: picked.candidate, members: solutionMembers.get(picked.candidate.path) }
		: undefined;
}

/** Native fallback; Windows cannot select files and folders in one dialog. */
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

/** `winapp.run.*` defaults are resource-scoped per workspace root. */
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


/** Prompt only for multiple plausible apps; otherwise the CLI is authoritative. */
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
		// The CLI makes the final app classification and reports failures more
		// precisely than a doomed QuickPick would.
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

/** A toggle offered by the With Options run command. */
interface RunToggle {
	key: keyof WinAppRunOptions;
	label: string;
	detail: string;
	/** Only offered when the target is a project or solution. */
	projectOnly?: boolean;
}

/** With Options toggles; omit `--without-alias` to avoid conflicting aliases. */
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

/** Omit target-inapplicable toggles; configured defaults start checked. */
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

/** Seed build prompts from settings so custom defaults remain selectable. */
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

/** Resolve run options shared by palette commands and debug fallback. */
export async function resolveRunOptions(
	withOptions: boolean,
	scope?: vscode.WorkspaceFolder
): Promise<{ options: WinAppRunOptions; target: RunTargetCandidate } | undefined> {
	const selection = await pickRunTarget(withOptions, scope);
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

	if (withOptions) {
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

	return { options, target };}
