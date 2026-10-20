/**
 * Pure helpers for turning project or build-output selections into a
 * `winapp pack` invocation.
 *
 * These are kept free of the VS Code API so they can be unit-tested directly
 * (see `src/test/pack-args.test.ts`); the VS Code-facing picker lives in
 * `folder-picker.ts` and command orchestration lives in `extension.ts`.
 */

import * as path from 'path';

/**
 * The winapp CLI accepts a variadic `<input-folder>...` argument and switches
 * from a single `.msix` to a multi-architecture `.msixbundle` when it receives
 * more than one folder:
 *
 * ```
 * winapp pack ./publish/x64 ./publish/arm64
 * ```
 *
 * @returns `true` when the selection will produce a bundle.
 */
export function isBundleSelection(inputFolders: readonly string[]): boolean {
	return inputFolders.length > 1;
}

export type PackArchitecture = 'x64' | 'arm64' | 'x86';

export type PackInput =
	| {
		kind: 'folders';
		folders: string[];
		workspaceRoot: string;
	}
	| {
		kind: 'project';
		projectFile: string;
		workspaceRoot: string;
		architectures: readonly [PackArchitecture, ...PackArchitecture[]];
	};

export type PackSigningMode =
	/** Use the source's default: unsigned folders or project signing settings. */
	| 'default'
	/** Generate and install a development certificate before signing. */
	| 'generateDev'
	/** Explicitly override project signing and produce an unsigned artifact. */
	| 'unsigned';

/** True when the selected input will produce an MSIX bundle. */
export function isBundleInput(input: PackInput): boolean {
	return input.kind === 'folders'
		? isBundleSelection(input.folders)
		: input.architectures.length > 1;
}

/** Outcome of interpreting a multi-select build-output QuickPick. */
export type FolderSelection =
	/** The user ticked "Browse…"; append native-dialog choices to these folders. */
	| { kind: 'browse'; folders: string[] }
	/** The user ticked one or more discovered folders. */
	| { kind: 'folders'; folders: string[] }
	/** Nothing usable was selected (dismissed, or an empty selection). */
	| { kind: 'none' };

/**
 * Interpret the items returned by the multi-select build-output QuickPick.
 *
 * "Browse…" is rendered as an ordinary row so it keeps the same appearance as
 * every other picker in the extension. Under multi-select that means it can be
 * ticked *alongside* real folders. Browse augments those checked folders rather
 * than replacing them, so a user can combine discovered and manually selected
 * outputs in one bundle.
 *
 * @param picked Items selected by the user, or `undefined` when dismissed.
 * @param browseDetail The `detail` value that marks the "Browse…" entry.
 */
export function resolveFolderSelection(
	picked: readonly { detail?: string; directory?: string }[] | undefined,
	browseDetail: string
): FolderSelection {
	if (!picked || picked.length === 0) {
		return { kind: 'none' };
	}

	const folders = picked
		.map((item) => item.directory)
		.filter((directory): directory is string => directory !== undefined);

	if (picked.some((item) => item.detail === browseDetail)) {
		return { kind: 'browse', folders };
	}

	if (folders.length === 0) {
		return { kind: 'none' };
	}

	return { kind: 'folders', folders };
}

/** Append manually browsed folders without passing duplicates to the CLI. */
export function mergeFolderSelections(
	discovered: readonly string[],
	browsed: readonly string[]
): string[] {
	const unique = new Map<string, string>();
	for (const folder of [...discovered, ...browsed]) {
		const key = path.resolve(folder).toLowerCase();
		if (!unique.has(key)) {
			unique.set(key, folder);
		}
	}
	return [...unique.values()];
}

/** Options collected from the pack prompts. */
export interface PackOptions {
	signing: PackSigningMode;
	/** Bundle the Windows App SDK runtime into the package(s). */
	selfContained: boolean;
	/** Project-mode MSBuild configuration. Omitted to use the CLI's Release default. */
	configuration?: string;
}

/**
 * Build the argument array for `winapp pack`.
 *
 * Returned as an array (rather than a command string) because pack is spawned
 * with `shell: false`, so paths containing spaces need no quoting or escaping.
 *
 * Every selected folder is passed positionally; the CLI decides between `.msix`
 * and `.msixbundle` from how many it receives.
 */
export function buildPackArgs(input: PackInput, options: PackOptions): string[] {
	const args = input.kind === 'folders'
		? ['pack', ...input.folders]
		: ['pack', input.projectFile];

	if (input.kind === 'project') {
		for (const architecture of input.architectures) {
			args.push('--arch', architecture);
		}
		if (options.configuration) {
			args.push('--configuration', options.configuration);
		}
	}

	if (options.signing === 'generateDev') {
		args.push('--generate-cert', '--install-cert');
	} else if (options.signing === 'unsigned') {
		args.push('--no-sign');
	}

	if (options.selfContained) {
		args.push('--self-contained');
	}

	return args;
}

/**
 * Decide whether to run the self-contained architecture mismatch check.
 *
 * The check is only meaningful for a **single** package. There the CLI resolves
 * the Windows App SDK runtime from the *machine's* architecture, so packaging
 * x64 output on an arm64 host silently mixes architectures.
 *
 * For a bundle the CLI packs each slice with an explicit per-slice architecture
 * override, so every package receives the runtime matching its own
 * architecture and the warning would be actively misleading.
 */
export function shouldCheckSelfContainedArch(
	input: PackInput,
	selfContained: boolean
): boolean {
	return selfContained && input.kind === 'folders' && !isBundleSelection(input.folders);
}

/** Progress notification title for a pack run. */
export function packProgressTitle(input: PackInput): string {
	return isBundleInput(input) ? 'Creating MSIX bundle...' : 'Packaging app...';
}

/** Roots under which the CLI is allowed to report the produced artifact. */
export function getPackContainmentRoots(input: PackInput): string[] {
	const roots = input.kind === 'folders'
		? [input.workspaceRoot, ...input.folders]
		: [input.workspaceRoot, path.dirname(input.projectFile)];

	const unique = new Map<string, string>();
	for (const root of roots) {
		unique.set(root.toLowerCase(), root);
	}
	return [...unique.values()];
}
