/**
 * Single source of truth for artifact type definitions.
 *
 * Every module that needs to know "what counts as a packaged artifact" should
 * import from here instead of maintaining its own list. This prevents drift
 * when a new artifact type (e.g. `.appinstaller`) is added.
 */

/** Supported artifact file extensions (without leading dot). */
export const ARTIFACT_EXTENSIONS_NO_DOT = ['msix', 'msixbundle', 'appx', 'appxbundle'] as const;

/** Supported artifact file extensions (with leading dot, longest first for greedy matching). */
export const ARTIFACT_EXTENSIONS = ARTIFACT_EXTENSIONS_NO_DOT.map((ext) => `.${ext}`);

/** Glob patterns that match packaged artifacts anywhere in a directory tree. */
export const ARTIFACT_GLOBS: string[] = ARTIFACT_EXTENSIONS_NO_DOT.map((ext) => `**/*.${ext}`);

/** File-dialog filter for MSIX/APPX packages (VS Code `showOpenDialog` format). */
export const ARTIFACT_DIALOG_FILTER: Record<string, string[]> = {
	'MSIX Packages': [...ARTIFACT_EXTENSIONS_NO_DOT]
};

/**
 * Test whether a file path ends with a known artifact extension
 * (case-insensitive).
 */
export function isArtifactPath(filePath: string): boolean {
	const lower = filePath.toLowerCase();
	return ARTIFACT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Remove a trailing artifact extension from a file name / path.
 *
 * Returns the input unchanged when it does not end with a recognised
 * extension. The match is case-insensitive.
 */
export function stripArtifactExtension(name: string): string {
	return name.replace(artifactExtensionPattern(), '');
}

/**
 * RegExp that matches any artifact extension at the end of a string
 * (case-insensitive). The alternation is ordered longest-first so that
 * `.msixbundle` is matched before `.msix`.
 */
export function artifactExtensionPattern(): RegExp {
	const sorted = [...ARTIFACT_EXTENSIONS_NO_DOT].sort((a, b) => b.length - a.length);
	return new RegExp(`\\.(${sorted.join('|')})$`, 'i');
}
