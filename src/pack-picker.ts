import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { pickBuildOutputFolders } from './folder-picker';
import {
	type PackArchitecture,
	type PackInput,
	type PackOptions,
	type PackSigningMode,
	isBundleInput
} from './pack-args';
import { SUPPORTED_ARCHITECTURES } from './run-options';
import {
	discoverProjectTargets,
	pickConfiguration
} from './run-utils';
import {
	classifyOfferableProjects,
	findOwningRoot,
	readSolutionProjectPaths,
	sortRunTargets,
	type RunTargetCandidate
} from './run-target';
import {
	getWorkspaceRoots,
	NO_WORKSPACE_MESSAGE,
	type WorkspaceRoot
} from './workspace';

const PROJECT_SOURCE = 'Build and package a .NET project';
const FOLDER_SOURCE = 'Package existing build output';
const BROWSE_PROJECT_DETAIL = 'Open a file picker for .csproj, .sln, or .slnx';

interface ProjectQuickPickItem extends vscode.QuickPickItem {
	candidate?: RunTargetCandidate;
}

interface PackProjectSelection {
	projectFile: string;
	workspaceRoot: string;
}

interface PackSigningQuickPickItem extends vscode.QuickPickItem {
	mode: PackSigningMode;
}

/** Pick the source and all source-specific input needed by `winapp pack`. */
export async function pickPackInput(): Promise<PackInput | undefined> {
	const roots = getWorkspaceRoots();
	if (roots.length === 0) {
		vscode.window.showErrorMessage(NO_WORKSPACE_MESSAGE);
		return undefined;
	}

	const source = await vscode.window.showQuickPick(
		[
			{
				label: `$(project) ${PROJECT_SOURCE}`,
				detail: 'Build a .csproj and package one or more target architectures',
				sourceKind: 'project' as const
			},
			{
				label: `$(folder) ${FOLDER_SOURCE}`,
				detail: 'Package one or more folders that already contain built application files',
				sourceKind: 'folders' as const
			}
		],
		{ placeHolder: 'What would you like to package?' }
	);
	if (!source) {
		return undefined;
	}

	if (source.sourceKind === 'folders') {
		const folders = await pickBuildOutputFolders(roots);
		if (!folders || folders.length === 0) {
			return undefined;
		}
		const workspaceRoot = findOwningRoot(roots, folders[0])?.path ?? roots[0].path;
		return { kind: 'folders', folders, workspaceRoot };
	}

	const project = await pickPackProject(roots);
	if (!project) {
		return undefined;
	}
	const architectures = await pickPackArchitectures();
	if (!architectures) {
		return undefined;
	}
	return {
		kind: 'project',
		projectFile: project.projectFile,
		workspaceRoot: project.workspaceRoot,
		architectures
	};
}

/** Collect pack options, showing project-only configuration and signing choices. */
export async function pickPackOptions(input: PackInput): Promise<PackOptions | undefined> {
	let configuration: string | undefined;
	if (input.kind === 'project') {
		const selected = await pickConfiguration('Release', false);
		if (!selected) {
			return undefined;
		}
		configuration = selected.value;
	}

	const signing = await pickPackSigning(input.kind);
	if (!signing) {
		return undefined;
	}

	const selfContained = await vscode.window.showQuickPick(
		[
			{ label: 'No', value: false },
			{ label: 'Yes', value: true }
		],
		{
			placeHolder: isBundleInput(input)
				? 'Bundle Windows App SDK runtime into each package (self-contained)?'
				: 'Bundle Windows App SDK runtime (self-contained)?'
		}
	);
	if (!selfContained) {
		return undefined;
	}

	return {
		signing,
		selfContained: selfContained.value,
		configuration
	};
}

async function pickPackProject(
	roots: readonly WorkspaceRoot[]
): Promise<PackProjectSelection | undefined> {
	const discovery = await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'Searching for projects...',
			cancellable: true
		},
		async (_progress, token) => discoverProjectTargets(roots, token)
	);
	if (!discovery) {
		return undefined;
	}

	const { candidates, solutionMembers, onlyUnrunnableProjects, unsupportedSolutionsFound } = discovery;
	if (candidates.length === 0) {
		vscode.window.showWarningMessage(
			unsupportedSolutionsFound
				? 'Solutions were found, but none contained .NET projects supported by the bundled WinApp CLI. Browse to the project or solution you want to package.'
				: onlyUnrunnableProjects
				? 'Only library and test projects were found. Browse to the application project or solution you want to package.'
				: 'No projects or solutions were found. Browse to the project or solution you want to package.'
		);
		return browseForPackProject(roots);
	}

	const sorted = sortRunTargets(candidates);
	let candidate: RunTargetCandidate | undefined;
	if (sorted.length === 1) {
		candidate = sorted[0];
	} else {
		const items: ProjectQuickPickItem[] = sorted.map(item => {
			const relative = path.relative(item.root.path, item.path);
			return {
				label: `${item.kind === 'solution' ? '$(file-submodule)' : '$(file-code)'} ${path.basename(item.path)}`,
				description: roots.length > 1 ? `${item.root.name} — ${relative}` : relative,
				detail: item.path,
				candidate: item
			};
		});
		items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
		items.push({
			label: '$(folder-opened) Browse…',
			detail: BROWSE_PROJECT_DETAIL,
			alwaysShow: true
		});

		const picked = await vscode.window.showQuickPick(items, {
			placeHolder: 'Select the project or solution to package',
			matchOnDescription: true
		});
		if (!picked) {
			return undefined;
		}
		if (picked.detail === BROWSE_PROJECT_DETAIL) {
			return browseForPackProject(roots);
		}
		candidate = picked.candidate;
	}

	return candidate
		? resolvePackProject(candidate, solutionMembers.get(candidate.path))
		: undefined;
}

async function browseForPackProject(
	roots: readonly WorkspaceRoot[]
): Promise<PackProjectSelection | undefined> {
	const selected = await vscode.window.showOpenDialog({
		canSelectFiles: true,
		canSelectFolders: false,
		canSelectMany: false,
		title: 'Select a project or solution to package',
		defaultUri: vscode.Uri.file(roots[0].path),
		filters: {
			'Projects and solutions': ['csproj', 'sln', 'slnx']
		}
	});
	const selectedPath = selected?.[0]?.fsPath;
	if (!selectedPath) {
		return undefined;
	}

	const extension = path.extname(selectedPath).toLowerCase();
	const root = findOwningRoot(roots, selectedPath)
		?? { name: path.basename(path.dirname(selectedPath)), path: path.dirname(selectedPath) };
	const candidate: RunTargetCandidate = {
		kind: extension === '.csproj' ? 'project' : 'solution',
		path: selectedPath,
		root
	};
	return resolvePackProject(candidate);
}

async function resolvePackProject(
	candidate: RunTargetCandidate,
	discoveredMembers?: readonly string[]
): Promise<PackProjectSelection | undefined> {
	if (candidate.kind === 'project') {
		return { projectFile: candidate.path, workspaceRoot: candidate.root.path };
	}

	const members = discoveredMembers
		? [...discoveredMembers]
		: await readSolutionProjectPaths(candidate.path);
	const offerable = await classifyOfferableProjects(members);
	if (offerable.length === 0) {
		vscode.window.showWarningMessage(
			`No packageable application projects were found in ${path.basename(candidate.path)}.`
		);
		return undefined;
	}

	let projectFile: string;
	if (offerable.length === 1) {
		projectFile = offerable[0].path;
	} else {
		const container = path.dirname(candidate.path);
		const picked = await vscode.window.showQuickPick(
			offerable.map(project => ({
				label: `$(file-code) ${path.basename(project.path)}`,
				description: path.relative(container, project.path),
				projectFile: project.path
			})),
			{
				placeHolder: `Which project in ${path.basename(candidate.path)} would you like to package?`,
				matchOnDescription: true
			}
		);
		if (!picked) {
			return undefined;
		}
		projectFile = picked.projectFile;
	}

	return { projectFile, workspaceRoot: candidate.root.path };
}

async function pickPackArchitectures(
): Promise<readonly [PackArchitecture, ...PackArchitecture[]] | undefined> {
	const processArchitecture = os.arch() === 'arm64'
		? 'arm64'
		: os.arch() === 'ia32' ? 'x86' : 'x64';

	while (true) {
		const picked = await vscode.window.showQuickPick(
			SUPPORTED_ARCHITECTURES.map(architecture => ({
				label: architecture,
				description: architecture === processArchitecture ? 'Current process architecture' : undefined,
				picked: architecture === processArchitecture,
				architecture
			})),
			{
				placeHolder: 'Select target architecture(s) — pick two or more to create an MSIX bundle',
				canPickMany: true
			}
		);
		if (!picked) {
			return undefined;
		}
		if (picked.length > 0) {
			return picked.map(item => item.architecture) as [PackArchitecture, ...PackArchitecture[]];
		}
		vscode.window.showWarningMessage('Select at least one target architecture.');
	}
}

async function pickPackSigning(inputKind: PackInput['kind']): Promise<PackSigningMode | undefined> {
	const generateDevItem: PackSigningQuickPickItem = {
		label: 'Generate and install a development certificate',
		detail: 'Create and trust a new local development certificate, then sign the package',
		mode: 'generateDev'
	};
	const unsignedItem: PackSigningQuickPickItem = {
		label: 'Create an unsigned package',
		detail: 'Leave the package unsigned for Store submission or an external signing pipeline',
		mode: 'unsigned'
	};
	const folderItems: PackSigningQuickPickItem[] = [
		{
			...unsignedItem,
			description: 'Recommended'
		},
		generateDevItem
	];
	const projectItems: PackSigningQuickPickItem[] = [
		{
			label: 'Use project signing settings',
			description: 'Recommended',
			detail: 'Honor the certificate and signing properties configured by the project',
			mode: 'default'
		},
		generateDevItem,
		unsignedItem
	];
	const picked = await vscode.window.showQuickPick(
		inputKind === 'project' ? projectItems : folderItems,
		{ placeHolder: 'How should the package be signed?' }
	);
	return picked?.mode;
}
