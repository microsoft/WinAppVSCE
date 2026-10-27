import * as path from 'path';
import { parseXml } from './xml-read';

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

function startsWithBomlessUtf16Xml(buffer: Buffer, bigEndian: boolean): boolean {
	for (let index = 0; index + 1 < buffer.length; index += 2) {
		const codeUnit = bigEndian
			? (buffer[index] << 8) | buffer[index + 1]
			: buffer[index] | (buffer[index + 1] << 8);
		if (codeUnit === 0x3C) {
			return true;
		}
		if (codeUnit !== 0x20 && codeUnit !== 0x09 && codeUnit !== 0x0A && codeUnit !== 0x0D) {
			return false;
		}
	}
	return false;
}

/** Decode manifest bytes using the BOM-aware encodings accepted by Windows XML tools. */
export function decodeManifestXml(bytes: Uint8Array): string {
	const buffer = Buffer.from(bytes);
	if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
		return buffer.subarray(2).toString('utf16le');
	}
	if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
		const content = Buffer.from(buffer.subarray(2));
		if (content.length % 2 !== 0) {
			return '';
		}
		content.swap16();
		return content.toString('utf16le');
	}
	if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
		return buffer.subarray(3).toString('utf8');
	}
	if (startsWithBomlessUtf16Xml(buffer, false)) {
		return buffer.toString('utf16le');
	}
	if (startsWithBomlessUtf16Xml(buffer, true)) {
		if (buffer.length % 2 !== 0) {
			return '';
		}
		const content = Buffer.from(buffer);
		content.swap16();
		return content.toString('utf16le');
	}
	return buffer.toString('utf8');
}

/**
 * Determine whether manifest XML declares `AllowExternalContent`, i.e. whether
 * it is a sparse identity-only manifest.
 *
 * Content-based rather than path-based on purpose: a `sparse/` directory is a
 * convention (the CLI's default `--output-dir`), not a guarantee, and a sparse
 * manifest may legitimately live anywhere.
 */
export function isSparseManifestXml(xml: string): boolean {
	const normalizedXml = xml.charCodeAt(0) === 0xFEFF ? xml.slice(1) : xml;
	const { doc, errors } = parseXml(normalizedXml);
	if (errors.length > 0) {
		return false;
	}

	const elements = doc.getElementsByTagName('*');
	for (let index = 0; index < elements.length; index++) {
		const element = elements.item(index);
		if (
			element?.localName === 'AllowExternalContent' &&
			element.textContent?.trim().toLowerCase() === 'true'
		) {
			return true;
		}
	}

	return false;
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

/** Build the argument list for an identity-only `winapp pack` run. */
export function buildSparsePackArgs(options: {
	manifestPath: string;
	generateCertificate?: boolean;
}): string[] {
	const args = ['pack', options.manifestPath];
	if (options.generateCertificate) {
		args.push('--generate-cert');
	}
	return args;
}

export interface SparseCommandPlan {
	args: string[];
	cwd: string;
}

/** Build the complete sparse-init dispatch plan used by the command handler. */
export function planSparseInitCommand(options: {
	exePath: string;
	outputDir: string;
	workspacePath?: string;
	force?: boolean;
}): SparseCommandPlan {
	return {
		args: buildSparseInitArgs(options),
		cwd: options.workspacePath ?? path.dirname(options.exePath)
	};
}

/**
 * Build the argument list for `winapp embed-identity`.
 *
 * `--manifest` should normally be supplied. When it is omitted the CLI
 * searches a `sparse/` folder beside the target and then the current
 * directory — neither of which holds the manifest for a typical project, where
 * {@link buildSparseInitArgs} anchors output on the project root while the exe
 * sits under `bin/`. Omitting it is only correct for a flat layout where the
 * exe really does sit beside `sparse/`.
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
 * Build the complete embed-identity dispatch plan.
 *
 * The manifest is required at this boundary so the extension cannot
 * accidentally fall back to the CLI's location guessing.
 */
export function planEmbedIdentityCommand(options: {
	target: string;
	manifestPath: string;
	workspacePath?: string;
}): SparseCommandPlan {
	return {
		args: buildEmbedIdentityArgs({
			target: options.target,
			manifestPath: options.manifestPath
		}),
		cwd: options.workspacePath ?? path.dirname(options.target)
	};
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

/** Whether sparse init would overwrite a generated manifest or asset folder. */
export function hasExistingSparseOutput(
	outputDir: string,
	exists: (candidate: string) => boolean
): boolean {
	return exists(getSparseManifestPath(outputDir)) || exists(path.join(outputDir, 'Assets'));
}

/**
 * Whether a directory entry marks its directory as a project root.
 *
 * Intentionally a shallow name check rather than real project detection —
 * this only picks a *default* output location.
 */
export function isProjectMarker(entry: string): boolean {
	const lower = entry.toLowerCase();
	return (
		lower.endsWith('.csproj') ||
		lower.endsWith('.vcxproj') ||
		lower === 'cargo.toml' ||
		lower === 'package.json' ||
		lower === 'cmakelists.txt' ||
		lower === 'pubspec.yaml'
	);
}

/**
 * Whether `candidate` is strictly inside `root`.
 *
 * Uses `path.relative` rather than a string prefix test so that a sibling
 * directory sharing a textual prefix (`C:\repo-other` against `C:\repo`) is
 * not treated as contained.
 */
function isStrictlyInside(candidate: string, root: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(candidate));
	return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Find the workspace root that owns `target`.
 *
 * The longest containing path wins so nested workspace folders behave like
 * VS Code's `getWorkspaceFolder`: a file belongs to the most specific root.
 */
export function findOwningWorkspacePath(
	target: string,
	workspacePaths: readonly string[]
): string | undefined {
	const resolvedTarget = path.resolve(target);
	return workspacePaths
		.filter(workspacePath => {
			const relative = path.relative(path.resolve(workspacePath), resolvedTarget);
			return relative.length === 0 || (!relative.startsWith('..') && !path.isAbsolute(relative));
		})
		.sort((left, right) => path.resolve(right).length - path.resolve(left).length)[0];
}

/**
 * Walk up from `filePath` to the nearest enclosing project root, stopping at
 * (and never escaping) `workspacePath`.
 *
 * Anchors sparse init's output directory so that in a monorepo the generated
 * `sparse/` folder lands beside the project owning the executable rather than
 * at the workspace root.
 *
 * @param readDir Lists a directory's entry names. Injected so the walk can be
 * unit-tested without touching disk; throwing for an unreadable directory is
 * expected and simply continues the walk upward.
 * @returns The project directory, or `undefined` to fall back to the workspace root.
 */
export function findProjectRootIn(
	workspacePath: string,
	filePath: string,
	readDir: (dir: string) => string[]
): string | undefined {
	let dir = path.dirname(path.resolve(filePath));

	while (isStrictlyInside(dir, workspacePath)) {
		try {
			if (readDir(dir).some(isProjectMarker)) {
				return dir;
			}
		} catch {
			// Unreadable directory — keep walking up.
		}

		const parent = path.dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}

	return undefined;
}

/**
 * The outcome of resolving which sparse manifest to embed.
 *
 * `ask` carries the manifests found elsewhere in the workspace so the caller
 * can offer them, but it never picks one: see {@link chooseSparseManifest}.
 */
export type SparseManifestChoice =
	| { kind: 'resolved'; path: string }
	| { kind: 'ask'; candidates: string[] };

/**
 * Pick which sparse manifest `winapp embed-identity` should be pointed at.
 *
 * Passing `--manifest` explicitly is required in the general case: the CLI's
 * own fallback searches a `sparse/` folder beside the *executable* and then
 * the current directory, while {@link defaultSparseOutputDir} anchors output
 * on the *project root*. For any project whose exe builds into `bin/`, those
 * locations never coincide.
 *
 * Only the location this extension would have written is treated as
 * authoritative. Anything else is returned as `ask`, including the case of a
 * single workspace-wide match: embedding rewrites the executable in place, so
 * adopting a manifest that merely happens to be the only one in the workspace
 * would silently stamp an unrelated identity onto the user's binary.
 */
export function chooseSparseManifest(options: {
	expectedPath: string;
	expectedExists: boolean;
	discovered?: string[];
}): SparseManifestChoice {
	if (options.expectedExists) {
		return { kind: 'resolved', path: options.expectedPath };
	}

	return { kind: 'ask', candidates: options.discovered ?? [] };
}
