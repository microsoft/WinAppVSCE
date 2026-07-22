import * as path from 'path';
import * as os from 'os';

/**
 * Pure helpers for detecting the target architecture from a build-output folder
 * path and warning about architecture mismatches during packaging. These are
 * free of the VS Code API so they can be unit-tested directly (see
 * `src/test/arch-detection.test.ts`); the VS Code-facing wiring lives in
 * `extension.ts`.
 */

/** Architectures the WinApp CLI can package for. */
export type PackageArch = 'x64' | 'arm64' | 'x86';

const KNOWN_ARCHS: PackageArch[] = ['arm64', 'x64', 'x86'];

/**
 * Patterns that indicate an architecture in a path segment.
 * Ordered most-specific first so `win-arm64` matches before a bare `arm64`
 * segment that might appear elsewhere.
 */
const RID_PATTERNS: { pattern: RegExp; arch: PackageArch }[] = [
	{ pattern: /^win-arm64$/i, arch: 'arm64' },
	{ pattern: /^win-x64$/i, arch: 'x64' },
	{ pattern: /^win-x86$/i, arch: 'x86' },
	{ pattern: /^arm64$/i, arch: 'arm64' },
	{ pattern: /^x64$/i, arch: 'x64' },
	{ pattern: /^x86$/i, arch: 'x86' },
];

/**
 * Detect the target architecture from a build-output folder path by looking
 * for RID-style segments (e.g. `win-x64`, `arm64`, `x64`).
 *
 * Scans path segments from right to left (the deepest segments are the most
 * specific) and returns the first match. Returns `undefined` when no
 * architecture can be inferred.
 *
 * @param folderPath Absolute or relative path to the build-output folder.
 * @returns The detected architecture, or `undefined`.
 */
export function detectArchFromPath(folderPath: string): PackageArch | undefined {
	// Normalise the path and split into segments. Use both separators so this
	// works on any OS and with paths that mix forward/back slashes.
	const segments = folderPath.replace(/\\/g, '/').split('/').filter(Boolean);

	// Walk right-to-left — the most specific (deepest) segment wins.
	for (let i = segments.length - 1; i >= 0; i--) {
		for (const { pattern, arch } of RID_PATTERNS) {
			if (pattern.test(segments[i])) {
				return arch;
			}
		}
	}
	return undefined;
}

/**
 * Map `os.arch()` values to the corresponding {@link PackageArch}.
 * Returns `undefined` for architectures the WinApp CLI does not support.
 */
export function getMachineArch(): PackageArch | undefined {
	const nodeArch = os.arch();
	switch (nodeArch) {
		case 'x64':
			return 'x64';
		case 'arm64':
			return 'arm64';
		case 'ia32':
			return 'x86';
		default:
			return undefined;
	}
}

export type ArchMismatchResult =
	| { mismatch: false }
	| { mismatch: true; buildArch: PackageArch; machineArch: PackageArch };

/**
 * Check whether a self-contained package would bundle a runtime whose
 * architecture differs from the build output in the selected input folder.
 *
 * When `--self-contained` is used the CLI bundles the Windows App SDK runtime
 * that matches the **machine's** architecture, not the build output's
 * architecture. Packaging x64 binaries on an ARM64 host with self-contained
 * silently produces an arm64 runtime alongside x64 app binaries — a real
 * footgun.
 *
 * @param buildArch Architecture detected from the build-output folder.
 * @param machineArch Architecture of the current machine (from `os.arch()`).
 * @returns A result indicating whether a mismatch exists, and if so, the details.
 */
export function checkSelfContainedArchMismatch(
	buildArch: PackageArch | undefined,
	machineArch: PackageArch | undefined
): ArchMismatchResult {
	if (!buildArch || !machineArch) {
		return { mismatch: false };
	}
	if (buildArch === machineArch) {
		return { mismatch: false };
	}
	return { mismatch: true, buildArch, machineArch };
}

/**
 * Build a human-readable warning message for an architecture mismatch.
 */
export function buildArchMismatchWarning(buildArch: PackageArch, machineArch: PackageArch): string {
	return (
		`Architecture mismatch: the selected build output appears to target ${buildArch}, ` +
		`but this machine is ${machineArch}. A self-contained package will bundle the ` +
		`${machineArch} Windows App SDK runtime alongside ${buildArch} app binaries, ` +
		`which may not work correctly.`
	);
}

/**
 * Return an ordered list of architecture choices for the QuickPick, with the
 * detected architecture (if any) presented first and marked as default.
 */
export function buildArchChoices(detectedArch: PackageArch | undefined): string[] {
	if (!detectedArch) {
		return KNOWN_ARCHS.map((a) => a);
	}
	const rest = KNOWN_ARCHS.filter((a) => a !== detectedArch);
	return [`${detectedArch} (detected)`, ...rest];
}

/**
 * Parse a QuickPick selection back to a {@link PackageArch}.
 * Handles both plain labels (`x64`) and annotated labels (`x64 (detected)`).
 */
export function parseArchChoice(choice: string): PackageArch | undefined {
	const stripped = choice.replace(/\s*\(detected\)\s*$/i, '').trim().toLowerCase();
	if (KNOWN_ARCHS.includes(stripped as PackageArch)) {
		return stripped as PackageArch;
	}
	return undefined;
}
