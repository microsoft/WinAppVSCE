/**
 * Pure helpers for turning a build-output folder selection into a
 * `winapp pack` invocation.
 *
 * These are kept free of the VS Code API so they can be unit-tested directly
 * (see `src/test/pack-args.test.ts`); the VS Code-facing wiring (QuickPick,
 * folder dialog, progress) lives in `extension.ts`.
 */

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

/** Outcome of interpreting a multi-select build-output QuickPick. */
export type FolderSelection =
	/** The user ticked "Browse…"; fall back to the native folder dialog. */
	| { kind: 'browse' }
	/** The user ticked one or more discovered folders. */
	| { kind: 'folders'; folders: string[] }
	/** Nothing usable was selected (dismissed, or an empty selection). */
	| { kind: 'none' };

/**
 * Interpret the items returned by the multi-select build-output QuickPick.
 *
 * "Browse…" is rendered as an ordinary row so it keeps the same appearance as
 * every other picker in the extension. Under multi-select that means it can be
 * ticked *alongside* real folders, which is ambiguous — we resolve it in favour
 * of the dialog, since asking to browse is an explicit request that the
 * discovered list is insufficient.
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

	if (picked.some((item) => item.detail === browseDetail)) {
		return { kind: 'browse' };
	}

	const folders = picked
		.map((item) => item.directory)
		.filter((directory): directory is string => directory !== undefined);

	if (folders.length === 0) {
		return { kind: 'none' };
	}

	return { kind: 'folders', folders };
}

/** Options collected from the pack prompts. */
export interface PackOptions {
	/** Generate and install a throwaway development certificate. */
	generateCert: boolean;
	/** Bundle the Windows App SDK runtime into the package(s). */
	selfContained: boolean;
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
export function buildPackArgs(inputFolders: readonly string[], options: PackOptions): string[] {
	const args = ['pack', ...inputFolders];

	if (options.generateCert) {
		args.push('--generate-cert', '--install-cert');
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
	inputFolders: readonly string[],
	selfContained: boolean
): boolean {
	return selfContained && !isBundleSelection(inputFolders);
}

/** Progress notification title for a pack run. */
export function packProgressTitle(inputFolders: readonly string[]): string {
	return isBundleSelection(inputFolders) ? 'Creating MSIX bundle...' : 'Packaging app...';
}
