/**
 * Single source of truth for artifact type definitions.
 *
 * Every module that needs to know "what counts as a packaged artifact" should
 * import from here instead of maintaining its own list. This prevents drift
 * when a new artifact type (e.g. `.appinstaller`) is added.
 */

/** Supported artifact file extensions (without leading dot). */
export const ARTIFACT_EXTENSIONS = ['msix', 'msixbundle', 'appx', 'appxbundle'] as const;

/** Extensions with leading dot (internal — used by helpers below). */
const DOTTED_EXTENSIONS = ARTIFACT_EXTENSIONS.map((ext) => `.${ext}`);

/** Glob patterns that match packaged artifacts anywhere in a directory tree. */
export const ARTIFACT_GLOBS: string[] = ARTIFACT_EXTENSIONS.map((ext) => `**/*.${ext}`);

/** File-dialog filter for MSIX/APPX packages (VS Code `showOpenDialog` format). */
export const ARTIFACT_DIALOG_FILTER: Record<string, string[]> = {
	'MSIX Packages': [...ARTIFACT_EXTENSIONS]
};

/**
 * Test whether a file path ends with a known artifact extension
 * (case-insensitive).
 */
export function isArtifactPath(filePath: string): boolean {
	const lower = filePath.toLowerCase();
	return DOTTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Remove a trailing artifact extension from a file name / path.
 *
 * Returns the input unchanged when it does not end with a recognised
 * extension. The match is case-insensitive.
 */
export function stripArtifactExtension(name: string): string {
	return name.replace(ARTIFACT_EXTENSION_RE, '');
}

/**
 * RegExp that matches any artifact extension at the end of a string
 * (case-insensitive). The alternation is ordered longest-first so that
 * `.msixbundle` is matched before `.msix`.
 */
const ARTIFACT_EXTENSION_RE = new RegExp(
	`\\.(${[...ARTIFACT_EXTENSIONS].sort((a, b) => b.length - a.length).join('|')})$`,
	'i'
);
