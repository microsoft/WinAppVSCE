import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';

export interface DebuggerExtensionRequirement {
	id: string;
	name: string;
}

export type RunInputValidation = {
	valid: true;
} | {
	valid: false;
	reason: 'not-found' | 'not-directory' | 'no-exe';
	message: string;
};

/** Only folder-mode input must already contain an executable. */
export async function validateRunInput(
	input: string,
	cwd: string,
	kind: 'project' | 'solution' | 'folder' | 'unknown',
	propertyName: string = 'input'
): Promise<RunInputValidation> {
	const resolved = path.isAbsolute(input) ? input : path.resolve(cwd, input);
	const stat = await fs.promises.stat(resolved).catch(() => undefined);

	if (kind === 'project' || kind === 'solution') {
		if (!stat) {
			const noun = kind === 'solution' ? 'solution' : 'project';
			return {
				valid: false,
				reason: 'not-found',
				message: `The configured "${propertyName}" ${noun} does not exist: ${input}. `
					+ `Update "${propertyName}" in launch.json to point to your ${noun} file.`
			};
		}
		// A project/solution input may be the file itself or a directory
		// containing one; both are valid and the CLI resolves the difference.
		return { valid: true };
	}

	if (!stat) {
		return {
			valid: false,
			reason: 'not-found',
			message: `The configured "${propertyName}" path does not exist: ${input}. `
				+ `Build your project first, or update "${propertyName}" in launch.json to point to your build output directory.`
		};
	}

	if (!stat.isDirectory()) {
		return {
			valid: false,
			reason: 'not-directory',
			message: `The configured "${propertyName}" is not a directory or a project file: ${input}. `
				+ `Update "${propertyName}" in launch.json to point to a project, a solution, or the folder containing your built application.`
		};
	}

	const exesInFolder = await glob('*.exe', { cwd: resolved, absolute: true, nocase: true });
	if (exesInFolder.length === 0) {
		return {
			valid: false,
			reason: 'no-exe',
			message: `The configured "${propertyName}" does not contain any .exe files: ${input}. `
				+ `Build your project first, or update "${propertyName}" in launch.json to point to a project file or the folder containing your built application.`
		};
	}

	return { valid: true };
}

/**
 * Maps debugger types to the VS Code extensions that provide them.
 */
export const DEBUGGER_EXTENSION_REQUIREMENTS: Record<string, DebuggerExtensionRequirement> = {
	'coreclr': { id: 'ms-dotnettools.csharp', name: 'C# (ms-dotnettools.csharp)' },
	'cppvsdbg': { id: 'ms-vscode.cpptools', name: 'C/C++ (ms-vscode.cpptools)' },
};

/**
 * Debugger types to consider (in preference order) when a launch configuration
 * doesn't specify one, and we need to reuse an already-installed extension.
 */
export const DEFAULT_DEBUGGER_CANDIDATES: string[] = ['coreclr', 'cppvsdbg'];

export const DEBUGGER_CHOICE_LABELS = {
	installCsharp: 'Install C# (.NET)',
	installCpp: 'Install C/C++',
	useNode: 'Use Node.js / Electron (built-in)'
} as const;

export function getDebuggerExtensionRequirement(debuggerType: string): DebuggerExtensionRequirement | undefined {
	return DEBUGGER_EXTENSION_REQUIREMENTS[debuggerType];
}

export function chooseInstalledDebuggerType(
	installedExtensionIds: Iterable<string>,
	candidates: readonly string[] = DEFAULT_DEBUGGER_CANDIDATES
): string | undefined {
	const installed = new Set([...installedExtensionIds].map(id => id.toLowerCase()));
	for (const candidate of candidates) {
		const requirement = getDebuggerExtensionRequirement(candidate);
		if (requirement && installed.has(requirement.id.toLowerCase())) {
			return candidate;
		}
	}
	return undefined;
}

export function getDebuggerTypeFromChoice(choice: string | undefined): string | undefined {
	if (choice === DEBUGGER_CHOICE_LABELS.installCsharp) {
		return 'coreclr';
	}
	if (choice === DEBUGGER_CHOICE_LABELS.installCpp) {
		return 'cppvsdbg';
	}
	if (choice === DEBUGGER_CHOICE_LABELS.useNode) {
		return 'node';
	}
	return undefined;
}
