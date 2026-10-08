import * as fs from 'fs';
import * as path from 'path';
import { classifyRunTargetEntries } from './run-target';

export interface DebuggerExtensionRequirement {
	id: string;
	name: string;
}

export type RunInputValidation = {
	valid: true;
} | {
	valid: false;
	reason: 'not-found' | 'nothing-runnable';
	message: string;
};

/** One phrase for every "point launch.json somewhere valid" hint. */
const RUNNABLE_TARGET = 'a project, a solution, or the folder containing your built application';

const BUILD_FIRST = 'Build your project first, or ';

function pointAt(propertyName: string, target: string): string {
	return `update "${propertyName}" in launch.json to point to ${target}.`;
}

/**
 * The CLI decides project vs folder mode, so this only catches the one
 * launch.json mistake it cannot report well: a path that exists but holds
 * nothing runnable, which is almost always a stale or unbuilt directory.
 */
export async function validateRunInput(
	input: string,
	cwd: string,
	propertyName: string = 'input'
): Promise<RunInputValidation> {
	const resolved = path.isAbsolute(input) ? input : path.resolve(cwd, input);
	const stat = await fs.promises.stat(resolved).catch(() => undefined);

	if (!stat) {
		return {
			valid: false,
			reason: 'not-found',
			message: `The configured "${propertyName}" path does not exist: ${input}. `
				+ BUILD_FIRST + pointAt(propertyName, RUNNABLE_TARGET)
		};
	}

	// A file input names a project or an executable; the CLI reports anything
	// else it cannot build far better than a guess here would.
	if (!stat.isDirectory()) {
		return { valid: true };
	}

	const entries = await fs.promises.readdir(resolved).catch(() => undefined);
	if (!entries) {
		return { valid: true };
	}

	if (classifyRunTargetEntries(entries) === 'unknown') {
		return {
			valid: false,
			reason: 'nothing-runnable',
			message: `The configured "${propertyName}" contains no project or .exe files: ${input}. `
				+ BUILD_FIRST + pointAt(propertyName, RUNNABLE_TARGET)
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
