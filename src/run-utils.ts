import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
	scanBuildOutputFolders,
	selectFolder
} from './folder-picker';
import { walkDirectoryTree, scanRoots, type ScanCancellationToken } from './directory-walk';
import { PROJECT_SCAN_SKIP_DIRS } from './project-detection';
import {
	classifyRunTarget,
	classifyRunTargetFile,
	collapseSolutionMigrationPairs,
	dedupeSolutionMembers,
	DISCOVERABLE_TARGET_EXTENSIONS,
	filterOfferableCandidates,
	filterSolutionsWithoutMembers,
	classifyOfferableProjects,
	findOwningRoot,
	isDirectory,
	isDiscoverableTargetExtension,
	isProjectMode,
	PROJECT_FILE_MAX_RESULTS,
	readSolutionProjectPaths,
	readTargetProjects,
	sortRunTargets,
	type RunTargetCandidate,
	type RunTargetKind
} from './run-target';
import { getWorkspaceRoots, NO_WORKSPACE_MESSAGE, type WorkspaceRoot } from './workspace';
import {
	availableRunToggles,
	COMMON_CONFIGURATIONS,
	expandRequiredToggles,
	resolveRunToggles,
	runToggleDetail,
	SUPPORTED_ARCHITECTURES,
	type RunToggle,
	type RunOptionKey,
	type WinAppRunOptions
} from './run-options';

/** VS Code layer for `winapp run`, shared by commands and the debug adapter. */

/** Marks the run-target picker entry that opens the browse sub-prompt. */
const BROWSE_DETAIL = 'Pick a project, solution, or build output folder yourself';

/** Marks the browse sub-prompt entry that opens a file dialog for projects. */
const PROJECT_PICKER_DETAIL = 'Open a file picker for .csproj, .sln, or .slnx';

/** Marks the browse sub-prompt entry that opens a folder dialog. */
const FOLDER_BROWSE_DETAIL = 'Open a folder picker for a project directory or a build output folder';

/** Progress message shown when discovery falls back to a build-output scan. */
const BUILD_OUTPUT_FALLBACK_MESSAGE = 'Searching for build output folders...';

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
	token: ScanCancellationToken
): Promise<RunTargetCandidate[]> {
	const candidates: RunTargetCandidate[] = [];

	const completed = await scanRoots(roots, token, async (root, signal) => {
		if (candidates.length >= PROJECT_FILE_MAX_RESULTS) {
			return 'stop';
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
			{ skipDirs: PROJECT_SCAN_SKIP_DIRS, signal }
		);
	});

	return completed ? candidates : [];
}

/** Find `.exe` output folders across every workspace root. */
async function findBuildOutputTargets(
	roots: readonly WorkspaceRoot[],
	token: ScanCancellationToken
): Promise<RunTargetCandidate[] | undefined> {
	// Attribute each folder back to the root it came from; the run picker
	// labels candidates by root in a multi-root workspace.
	const rootsByPath = new Map(roots.map(root => [root.path, root]));

	const found = await scanBuildOutputFolders(roots.map(root => root.path), token);
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

/** Everything discovery learned about a workspace, under one progress popup. */
interface RunTargetDiscovery {
	candidates: RunTargetCandidate[];
	solutionMembers: Map<string, string[]>;
	/** Projects were found, but every one was a library or a test project. */
	onlyUnrunnableProjects: boolean;
}

/**
 * Project discovery, with a build-output scan as the fallback.
 *
 * Both scans share the caller's token and progress reporter so the whole
 * search is one cancellable notification rather than two in sequence.
 */
async function discoverRunTargets(
	roots: readonly WorkspaceRoot[],
	progress: vscode.Progress<{ message?: string }>,
	token: ScanCancellationToken
): Promise<RunTargetDiscovery | undefined> {
	const projects = await findProjectTargets(roots, token);
	if (token.isCancellationRequested) {
		return undefined;
	}

	let candidates = projects;
	let solutionMembers = new Map<string, string[]>();

	if (candidates.length > 0) {
		// A workspace mid-.slnx-migration ships both files for one solution;
		// keeping both would turn an unambiguous workspace into a prompt.
		candidates = collapseSolutionMigrationPairs(candidates);
		solutionMembers = await mapSolutionMembers(candidates);
		if (token.isCancellationRequested) {
			return undefined;
		}
		candidates = filterSolutionsWithoutMembers(candidates, solutionMembers);
		candidates = dedupeSolutionMembers(candidates, solutionMembers);
		// Drop projects the project file itself identifies as a library or a
		// test project. Solutions are left alone — the CLI resolves the
		// runnable project inside one far more accurately than we can.
		candidates = await filterOfferableCandidates(candidates);
		if (token.isCancellationRequested) {
			return undefined;
		}
	}

	// Discovery either found nothing, or found only libraries and test
	// projects. Both leave a build output folder as the one remaining way to
	// run, so look for one before giving up on the workspace.
	const onlyUnrunnableProjects = projects.some(candidate => candidate.kind === 'project')
		&& candidates.length === 0;
	if (candidates.length === 0) {
		progress.report({ message: BUILD_OUTPUT_FALLBACK_MESSAGE });
		const folders = await findBuildOutputTargets(roots, token);
		if (!folders) {
			return undefined;
		}
		candidates = folders;
	}

	return { candidates, solutionMembers, onlyUnrunnableProjects };
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

	const discovery = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Searching for projects...', cancellable: true },
		async (progress, token) => discoverRunTargets(roots, progress, token)
	);

	if (!discovery) {
		return undefined;
	}

	const { candidates, solutionMembers, onlyUnrunnableProjects } = discovery;

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

	// Every discovered target is listed: a QuickPick filters only over the items
	// it was given, so truncating here would make the rest unreachable by
	// typing. The scan is already bounded by PROJECT_FILE_MAX_RESULTS.
	const items = buildRunTargetItems(sorted, roots.length > 1);

	items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });

	// alwaysShow keeps the escape hatch reachable: without it, typing a filter
	// that matches no discovered target also filters away Browse…, leaving an
	// empty picker and no way forward.
	items.push({ label: '$(folder-opened) Browse…', detail: BROWSE_DETAIL, alwaysShow: true });

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

	const targetKind = await classifyRunTarget(selected);

	return {
		target: {
			kind: targetKind,
			path: selected,
			root: resolveBrowsedRoot(roots, selected, targetKind)
		}
	};
}

/**
 * The working directory and display anchor for a browsed target.
 *
 * Attributing a target outside the workspace to `roots[0]` would mislabel it
 * and run the CLI from an unrelated directory, so a target no workspace folder
 * owns becomes its own root.
 */
function resolveBrowsedRoot(
	roots: readonly WorkspaceRoot[],
	selected: string,
	kind: RunTargetKind
): WorkspaceRoot {
	// Honours a scoped root list, and prefers the deepest match when roots nest.
	const owning = findOwningRoot(roots, selected);
	if (owning) {
		return owning;
	}

	// `roots` may have been scoped to a single folder by the caller, while the
	// browsed path belongs to another folder of the same workspace.
	const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(selected));
	if (folder) {
		return { name: folder.name, path: folder.uri.fsPath };
	}

	const base = kind === 'folder' ? selected : path.dirname(selected);
	return { name: path.basename(base) || base, path: base };
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

	const offerable = await classifyOfferableProjects(projects);
	if (offerable.length <= 1) {
		// The CLI makes the final app classification and reports failures more
		// precisely than a doomed QuickPick would.
		return { cancelled: false };
	}

	// Only genuine ambiguity deserves a prompt. When at most one member is a
	// confident app, `winapp run <solution>` picks it without `--project` —
	// asking would make the user arbitrate a question the CLI already answers
	// with full MSBuild evaluation. The list still offers every `unknown`
	// member once we do ask, so nothing undecidable is hidden from a choice.
	const apps = offerable.filter(entry => entry.runnability === 'app');
	if (apps.length <= 1) {
		return { cancelled: false };
	}

	const items = offerable.map(({ path: projectPath }) => ({
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

/** A toggle row, carrying the toggle it stands for. */
interface RunToggleQuickPickItem extends vscode.QuickPickItem {
	toggle: RunToggle;
}

/**
 * Omit target-inapplicable toggles; everything starts unchecked.
 *
 * Built by hand rather than with `showQuickPick` so checking a dependent
 * toggle can tick its prerequisite in place. Silently adding the flag later
 * would leave the list showing something other than what runs, and warning
 * about it would be noise for a choice the user already made.
 */
export async function pickRunToggles(
	kind: RunTargetKind
): Promise<Partial<WinAppRunOptions> | undefined> {
	const available = availableRunToggles(isProjectMode(kind));
	const picker = vscode.window.createQuickPick<RunToggleQuickPickItem>();
	picker.canSelectMany = true;
	picker.placeholder = 'Select run options (press Enter to continue)';
	picker.items = available.map(toggle => ({
		label: toggle.label,
		detail: runToggleDetail(toggle),
		toggle
	}));

	try {
		const checkedKeys = await new Promise<RunOptionKey[] | undefined>(resolve => {
			// Assigning selectedItems re-enters this handler, so the implied
			// update must not try to imply anything further.
			let syncing = false;

			picker.onDidChangeSelection(selection => {
				if (syncing) { return; }

				const expanded = expandRequiredToggles(available, selection.map(item => item.toggle.key));
				if (expanded.length === selection.length) { return; }

				syncing = true;
				picker.selectedItems = picker.items.filter(item => expanded.includes(item.toggle.key));
				syncing = false;
			});

			picker.onDidAccept(() => resolve(picker.selectedItems.map(item => item.toggle.key)));
			picker.onDidHide(() => resolve(undefined));
			picker.show();
		});

		return checkedKeys && resolveRunToggles(available, checkedKeys);
	} finally {
		picker.dispose();
	}
}

/** Build prompts for the With Options flow; the CLI owns the defaults. */
export async function pickBuildSettings(): Promise<Partial<WinAppRunOptions> | undefined> {
	const configuration = await pickConfiguration();
	if (configuration === undefined) {
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

	return { configuration: configuration.value, arch: arch.arch };
}

/**
 * The configuration prompt, which accepts a name that is not Debug or Release.
 *
 * `--configuration` is an open string — a project is free to define `Staging`
 * or `Debug-Internal`, and `launch.json` already declares the field as a plain
 * string — so the two common names are offered as rows while anything typed is
 * taken as-is. Returns `undefined` when dismissed, or a wrapper whose `value`
 * is `undefined` for "let the CLI choose", which the two cases cannot otherwise
 * be told apart.
 */
async function pickConfiguration(): Promise<{ value: string | undefined } | undefined> {
	const picker = vscode.window.createQuickPick<vscode.QuickPickItem>();
	picker.placeholder = 'Build configuration, or type another name';
	picker.items = [
		{ label: 'Default', description: 'Debug' },
		...[...COMMON_CONFIGURATIONS].map(name => ({ label: name }))
	];

	try {
		const picked = await new Promise<vscode.QuickPickItem | string | undefined>(resolve => {
			picker.onDidAccept(() => resolve(picker.selectedItems[0] ?? picker.value.trim()));
			picker.onDidHide(() => resolve(undefined));
			picker.show();
		});

		if (picked === undefined) {
			return undefined;
		}

		// A typed name only reaches here when it matched no row, and an empty
		// one means the user accepted without choosing anything.
		const label = typeof picked === 'string' ? picked : picked.label;
		if (!label || label === 'Default') {
			return { value: undefined };
		}
		return { value: label };
	} finally {
		picker.dispose();
	}
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
