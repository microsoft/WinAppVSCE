export interface DebuggerExtensionRequirement {
	id: string;
	name: string;
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
