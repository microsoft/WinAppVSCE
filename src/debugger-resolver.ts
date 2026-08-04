import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';

export interface DebuggerExtensionRequirement {
	id: string;
	name: string;
}

export type InputFolderValidation = {
	valid: true;
} | {
	valid: false;
	reason: 'not-found' | 'not-directory' | 'no-exe';
	message: string;
};

/**
 * Validates that an inputFolder path is suitable for a debug launch:
 * - The path must exist
 * - It must be a directory
 * - It must contain at least one .exe file
 *
 * Relative paths are resolved against the provided cwd.
 */
export async function validateInputFolder(inputFolder: string, cwd: string): Promise<InputFolderValidation> {
	const resolvedFolder = path.isAbsolute(inputFolder) ? inputFolder : path.resolve(cwd, inputFolder);
	const folderStat = await fs.promises.stat(resolvedFolder).catch(() => undefined);
	if (!folderStat) {
		return {
			valid: false,
			reason: 'not-found',
			message: `The configured "inputFolder" path does not exist: ${inputFolder}. `
				+ 'Build your project first, or update "inputFolder" in the debug configuration to point to your build output directory.'
		};
	}

	if (!folderStat.isDirectory()) {
		return {
			valid: false,
			reason: 'not-directory',
			message: `The configured "inputFolder" is not a directory: ${inputFolder}. `
				+ 'Update "inputFolder" in the debug configuration to point to the folder containing your built application.'
		};
	}

	const exesInFolder = await glob('*.exe', { cwd: resolvedFolder, absolute: true, nocase: true });
	if (exesInFolder.length === 0) {
		return {
			valid: false,
			reason: 'no-exe',
			message: `The configured "inputFolder" does not contain any .exe files: ${inputFolder}. `
				+ 'Build your project first, or update "inputFolder" in the debug configuration to point to the folder containing your built application.'
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
