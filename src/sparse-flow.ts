import * as path from 'path';

/**
 * Pure helpers for the sparse packaging workflow:
 *   1. `winapp init --exe <exe> --sparse`  → identity-only manifest + Assets
 *   2. `winapp pack <appxmanifest.xml>`    → identity-only .msix
 *   3. `winapp embed-identity <exe>`       → <msix> element in the fusion manifest
 *
 * Kept free of the VS Code API so the argument construction and input
 * classification can be unit-tested directly (see
 * `src/test/sparse-flow.test.ts`); the VS Code-facing wiring lives in
 * `extension.ts`. Mirrors the split already used by `project-resolver.ts` and
 * `sign-utils.ts`.
 */

/** Folder name the CLI uses by default for sparse output (`--output-dir`). */
export const SPARSE_OUTPUT_FOLDER = 'sparse';

/** File name the CLI writes inside the sparse output folder. */
export const SPARSE_MANIFEST_FILENAME = 'appxmanifest.xml';

/**
 * Matches `<uap10:AllowExternalContent>true</uap10:AllowExternalContent>`.
 *
 * The element is the defining marker of a sparse (identity-only) manifest:
 * `winapp pack` only accepts a manifest *file* when it declares this, and the
 * namespace prefix is not fixed, so any prefix (or none) is tolerated.
 *
 * The pattern is deliberately linear — a single bounded character class for
 * the optional prefix and simple `\s*` runs — so it cannot backtrack
 * catastrophically on hostile input (see `redos-prevention.test.ts`).
 */
const ALLOW_EXTERNAL_CONTENT_RE = /<(?:[\w.-]+:)?AllowExternalContent\s*>\s*true\s*</i;

/**
 * Determine whether manifest XML declares `AllowExternalContent`, i.e. whether
 * it is a sparse identity-only manifest.
 *
 * Content-based rather than path-based on purpose: a `sparse/` directory is a
 * convention (the CLI's default `--output-dir`), not a guarantee, and a sparse
 * manifest may legitimately live anywhere.
 */
export function isSparseManifestXml(xml: string): boolean {
	return ALLOW_EXTERNAL_CONTENT_RE.test(xml);
}

/**
 * An input accepted by `winapp pack`.
 *
 * The CLI takes either one or more build-output folders (a full package
 * layout) or a single sparse `appxmanifest.xml` file (identity-only). The two
 * behave differently enough — identity-only packages have no binaries, no
 * architecture, and no runtime to bundle — that the extension must keep them
 * apart rather than passing an untyped path around.
 */
export type PackInput =
	| { kind: 'folder'; path: string }
	| { kind: 'sparseManifest'; path: string };

/**
 * Whether a pack input produces an identity-only package, and therefore
 * whether the self-contained / architecture prompts apply.
 */
export function isIdentityOnlyInput(input: PackInput): boolean {
	return input.kind === 'sparseManifest';
}

/**
 * The directory used as the containment root when validating the artifact
 * produced from `input`.
 *
 * `handlePackCompletion` checks the produced artifact lives under the
 * workspace or the input; for a manifest file the meaningful root is its
 * containing folder.
 */
export function getPackInputRoot(input: PackInput): string {
	return input.kind === 'folder' ? input.path : path.dirname(input.path);
}

/**
 * Build the argument list for a sparse `winapp init` run.
 *
 * Deliberately omits `--name` and `--publisher`: the CLI infers the package
 * name, publisher, version, and description from the executable's file version
 * info. `--use-defaults` suppresses the CLI's interactive *prompts*, not its
 * inference, so the inferred values are still used. Users adjust them
 * afterwards in the manifest editor, where `Publisher` can be reconciled
 * against the signing certificate.
 *
 * @param exePath Absolute path to the existing application executable.
 * @param outputDir Directory to write `appxmanifest.xml` and `Assets/` into.
 * @param force Overwrite an existing manifest instead of failing.
 */
export function buildSparseInitArgs(options: {
	exePath: string;
	outputDir: string;
	force?: boolean;
}): string[] {
	const args = [
		'init',
		'--exe',
		options.exePath,
		'--sparse',
		'--use-defaults',
		'--output-dir',
		options.outputDir
	];

	if (options.force) {
		args.push('--force');
	}

	return args;
}

/**
 * Build the argument list for `winapp embed-identity`.
 *
 * `--manifest` is intentionally omitted when not supplied: the CLI already
 * searches a `sparse/` folder beside the target and then the current
 * directory, which is exactly where {@link buildSparseInitArgs} writes the
 * manifest. Passing it explicitly would only restate the default.
 *
 * @param target Path to the `.exe`, or to an `.xml`/`.manifest` side-by-side manifest.
 * @param manifestPath Optional explicit sparse manifest to read identity from.
 */
export function buildEmbedIdentityArgs(options: {
	target: string;
	manifestPath?: string;
}): string[] {
	const args = ['embed-identity', options.target];

	if (options.manifestPath) {
		args.push('--manifest', options.manifestPath);
	}

	return args;
}

/**
 * Whether embedding identity into `target` rewrites a binary in place.
 *
 * EXE targets are modified with `mt.exe`, which invalidates any existing
 * Authenticode signature; `.xml`/`.manifest` targets are edited as text and
 * are non-destructive. Callers use this to decide whether to ask the user to
 * confirm before running.
 */
export function embedRewritesBinary(target: string): boolean {
	return path.extname(target).toLowerCase() === '.exe';
}

/**
 * Default directory for sparse init output.
 *
 * The CLI defaults to a `sparse/` folder in the *current* directory; because
 * the extension always passes `--output-dir` explicitly it must pick that
 * location itself. It anchors on the executable's project root when one is
 * supplied, so that in a monorepo the manifest lands beside the project that
 * owns the exe rather than at the workspace root.
 *
 * A dedicated, source-controllable folder (rather than beside the exe) keeps
 * these build-time inputs out of a build-output directory that a clean or
 * rebuild would wipe.
 *
 * @param workspacePath Absolute path to the workspace root.
 * @param projectRoot Optional project directory owning the executable.
 */
export function defaultSparseOutputDir(workspacePath: string, projectRoot?: string): string {
	const base = projectRoot && projectRoot.length > 0 ? projectRoot : workspacePath;
	return path.join(base, SPARSE_OUTPUT_FOLDER);
}

/** Absolute path to the manifest that a sparse init run writes into `outputDir`. */
export function getSparseManifestPath(outputDir: string): string {
	return path.join(outputDir, SPARSE_MANIFEST_FILENAME);
}
