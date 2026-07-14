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

/**
 * Infers the debugger from project files only when exactly one supported project
 * family is present. Precedence is deliberately conservative: .NET and C++
 * project files map directly to their debuggers, while package.json maps to
 * Node only when there are no competing native signals such as Cargo.toml or
 * tauri.conf.json. Mixed families return undefined so the installed debugger
 * reuse/picker path can decide instead of guessing.
 */
export function inferDebuggerTypeFromProject(fileNames: readonly string[]): string | undefined {
	let hasDotNet = false;
	let hasCpp = false;
	let hasNode = false;
	let hasOtherNative = false;

	for (const fileName of fileNames) {
		const normalized = fileName.replace(/\\/g, '/').toLowerCase();
		const baseName = normalized.substring(normalized.lastIndexOf('/') + 1);

		if (baseName.endsWith('.csproj') || baseName.endsWith('.fsproj') || baseName.endsWith('.vbproj')) {
			hasDotNet = true;
		} else if (baseName.endsWith('.vcxproj')) {
			hasCpp = true;
		} else if (baseName === 'package.json') {
			hasNode = true;
		} else if (baseName === 'cargo.toml' || baseName === 'tauri.conf.json') {
			hasOtherNative = true;
		}
	}

	if (hasNode && hasOtherNative) {
		return undefined;
	}

	const matches = [
		hasDotNet ? 'coreclr' : undefined,
		hasCpp ? 'cppvsdbg' : undefined,
		hasNode ? 'node' : undefined
	].filter((debuggerType): debuggerType is string => debuggerType !== undefined);

	return matches.length === 1 ? matches[0] : undefined;
}
