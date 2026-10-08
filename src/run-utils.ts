import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
	findBuildOutputFolders,
	selectFolder
} from './folder-picker';
import { walkDirectoryTree } from './directory-walk';
import { PROJECT_SCAN_SKIP_DIRS } from './project-detection';
import {
	classifyRunTarget,
	classifyRunTargetFile,
	dedupeSolutionMembers,
	DISCOVERABLE_TARGET_EXTENSIONS,
	filterOfferableCandidates,
	filterOfferableProjects,
	findOwningRoot,
	isDirectory,
	isDiscoverableTargetExtension,
	isProjectMode,
	PROJECT_FILE_MAX_RESULTS,
	readSolutionProjectPaths,
	readTargetProjects,
	RUN_TARGET_DISPLAY_LIMIT,
	sortRunTargets,
	type RunTargetCandidate,
	type RunTargetKind
} from './run-target';
import { getWorkspaceRoots, NO_WORKSPACE_MESSAGE, type WorkspaceRoot } from './workspace';
import {
	COMMON_CONFIGURATIONS,
	SUPPORTED_ARCHITECTURES,
	type WinAppRunOptions
} from './run-options';

/** VS Code layer for `winapp run`, shared by commands and the debug adapter. */

/** Marks the run-target picker entry that opens the browse sub-prompt. */
const BROWSE_DETAIL = 'Pick a project, solution, or build output folder yourself';

/** Marks the browse sub-prompt entry that opens a file dialog for projects. */
const PROJECT_PICKER_DETAIL = 'Open a file picker for .csproj, .sln, or .slnx';

/** Marks the browse sub-prompt entry that opens a folder dialog. */
const FOLDER_BROWSE_DETAIL = 'Open a folder picker for a project directory or a build output folder';

/**
 * Prefer project discovery; reserve executable scans for fallback or explicit use.
 *
 * Walks the tree directly rather than using `vscode.workspace.findFiles`,
 * which silently honours the user's `files.exclude` and `search.exclude`
 * settings — a workspace that hides `src/**` would hide its own app project
 * from the run picker.
 */
async function findProjectTargets(
	roots: readonly WorkspaceRoot[],
	token: vscode.CancellationToken
): Promise<RunTargetCandidate[]> {
	const candidates: RunTargetCandidate[] = [];
	const controller = new AbortController();
	const subscription = token.onCancellationRequested(() => controller.abort());

	try {
		for (const root of roots) {
			if (token.isCancellationRequested || candidates.length >= PROJECT_FILE_MAX_RESULTS) {
				break;
			}

			await walkDirectoryTree(
				root.path,
				(directory, entries) => {
					for (const entry of entries) {
						if (!entry.isFile()) { continue; }

						const kind = isDiscoverableTargetExtension(entry.name)
							? classifyRunTargetFile(entry.name)
							: undefined;
						if (!kind) { continue; }

						candidates.push({ kind, path: path.join(directory, entry.name), root });
						if (candidates.length >= PROJECT_FILE_MAX_RESULTS) { return 'stop'; }
					}
					return 'descend';
				},
				{ skipDirs: PROJECT_SCAN_SKIP_DIRS, signal: controller.signal }
			);
		}
	} finally {
		subscription.dispose();
	}

	return token.isCancellationRequested ? [] : candidates;
}

/** Find `.exe` output folders across every workspace root. */
async function findBuildOutputTargets(roots: readonly WorkspaceRoot[]): Promise<RunTargetCandidate[] | undefined> {
	// Attribute each folder back to the root it came from; the run picker
	// labels candidates by root in a multi-root workspace.
	const rootsByPath = new Map(roots.map(root => [root.path, root]));

	const found = await findBuildOutputFolders(roots.map(root => root.path));
	if (!found) {
		return undefined;
	}

	const candidates: RunTargetCandidate[] = [];
	for (const { rootPath, path: folder } of found) {
		const root = rootsByPath.get(rootPath);
		if (root) {
			candidates.push({ kind: 'folder', path: folder, root });
		}
	}

	return candidates;
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
	}

	if (candidates.length === 0) {
		// Nothing runnable at all. Say so before a file dialog appears
		// unbidden — the user asked to run, not to browse.
		vscode.window.showWarningMessage(
			onlyUnrunnableProjects
				? 'Only library and test projects were found in this workspace, and winapp run needs an executable app project. Browse to the project or folder you want to run.'
				: 'No projects, solutions, or build output folders were found in this workspace. Browse to the project or folder you want to run.'
		);
		return browseForRunTarget(roots);
	}

	const sorted = sortRunTargets(candidates);

	// A single unambiguous target needs no prompt at all, in either run
	// command — With Options varies how a target is built, not which one.
	if (sorted.length === 1) {
		return { target: sorted[0], members: solutionMembers.get(sorted[0].path) };
	}

	const shown = sorted.slice(0, RUN_TARGET_DISPLAY_LIMIT);
	const items = buildRunTargetItems(shown, roots.length > 1);

	// A separator immediately followed by another is collapsed by VS Code, so
	// the cap notice doubles as the divider before the browse entry.
	const capped = sorted.length > shown.length;
	items.push({
		label: capped ? `Showing ${shown.length} of ${sorted.length} — browse to reach the rest` : '',
		kind: vscode.QuickPickItemKind.Separator
	});

	items.push({ label: '$(folder-opened) Browse…', detail: BROWSE_DETAIL });

	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: 'Select the project, solution, or build output folder to run',
		matchOnDescription: true
	});

	if (!picked) {
		return undefined;
	}

	if (picked.detail === BROWSE_DETAIL) {
		return browseForRunTarget(roots);
	}

	return picked.candidate
		? { target: picked.candidate, members: solutionMembers.get(picked.candidate.path) }
		: undefined;
}

/**
 * Ask what to browse for, then open that dialog.
 *
 * Windows cannot select files and folders in one native dialog, so the kind
 * has to be settled before one opens. Passing `kind` skips the question where
 * the caller already knows the answer.
 */
async function browseForRunTarget(
	roots: readonly WorkspaceRoot[],
	kind?: 'file' | 'folder'
): Promise<RunTargetSelection | undefined> {
	let mode = kind;

	if (!mode) {
		const picked = await vscode.window.showQuickPick(
			[
				{ label: '$(file-code) Project or solution file…', detail: PROJECT_PICKER_DETAIL, mode: 'file' as const },
				{ label: '$(folder) Project directory or build output folder…', detail: FOLDER_BROWSE_DETAIL, mode: 'folder' as const }
			],
			{ placeHolder: 'What would you like to browse for?' }
		);
		if (!picked) {
			return undefined;
		}
		mode = picked.mode;
	}

	const defaultUri = vscode.Uri.file(roots[0].path);
	let selected: string | undefined;

	if (mode === 'file') {
		const result = await vscode.window.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			title: 'Select a project or solution to run',
			defaultUri,
			filters: {
				'Projects and solutions': DISCOVERABLE_TARGET_EXTENSIONS.map(extension => extension.slice(1))
			}
		});
		selected = result?.[0]?.fsPath;
	} else {
		selected = await selectFolder('Select a project directory or build output folder', defaultUri);
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

/** Omit target-inapplicable toggles; everything starts unchecked. */
export async function pickRunToggles(
	kind: RunTargetKind
): Promise<Partial<WinAppRunOptions> | undefined> {
	const available = RUN_TOGGLES.filter(toggle => !toggle.projectOnly || isProjectMode(kind));
	const items = available.map(toggle => ({
		label: toggle.label,
		detail: toggle.detail,
		toggle
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

/** Build prompts for the With Options flow; the CLI owns the defaults. */
export async function pickBuildSettings(): Promise<Partial<WinAppRunOptions> | undefined> {
	const configurationItems = [...COMMON_CONFIGURATIONS].map(name => ({ label: name }));

	const configuration = await vscode.window.showQuickPick(configurationItems, {
		placeHolder: 'Build configuration'
	});
	if (!configuration) {
		return undefined;
	}

	const archItems = [
		{ label: 'Default', description: 'current process architecture', arch: undefined as string | undefined },
		...[...SUPPORTED_ARCHITECTURES].map(name => ({
			label: name,
			description: undefined as string | undefined,
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
	const selection = await pickRunTarget(scope);
	if (!selection) {
		return undefined;
	}

	const target = selection.target;
	const projectMode = isProjectMode(target.kind);

	let options: WinAppRunOptions = { input: target.path };

	const projectSelection = await pickSolutionProject(selection);
	if (projectSelection.cancelled) {
		return undefined;
	}
	options.project = projectSelection.project;

	if (withOptions) {
		if (projectMode) {
			const buildSettings = await pickBuildSettings();
			if (!buildSettings) {
				return undefined;
			}
			options = { ...options, ...buildSettings };
		}

		const toggles = await pickRunToggles(target.kind);
		if (!toggles) {
			return undefined;
		}
		options = { ...options, ...toggles };
	}

	return { options, target };}
