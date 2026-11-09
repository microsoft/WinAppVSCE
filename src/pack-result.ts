import * as path from 'path';
import { isArtifactPath, stripArtifactExtension } from './artifact-types';
import { parseWinappErrorMessage } from './winapp-cli-utils';

/**
 * Pure helpers for interpreting the output of `winapp package` and building the
 * post-pack completion notification. These are kept free of the VS Code API so
 * they can be unit-tested directly (see `src/test/pack-result.test.ts`); the
 * VS Code-facing wiring lives in `extension.ts`.
 */

/** Labels for the action buttons shown on the pack completion notification. */
export const PACK_ACTIONS = {
	reveal: 'Reveal in Explorer',
	sign: 'Sign',
	install: 'Install'
} as const;

export type PackActionLabel = (typeof PACK_ACTIONS)[keyof typeof PACK_ACTIONS];
export type PackNotificationAction = 'reveal' | 'sign' | 'install' | 'none';
export type PackCompletionPlan =
	| { kind: 'cancelled' }
	| { kind: 'error'; message: string }
	| { kind: 'success'; artifactPath: string; appName: string | undefined; message: string };

/**
 * Markers the CLI prints immediately before the produced artifact path.
 *
 * A single-package run prints `📦 Package:` while a multi-folder bundle run
 * prints `📦 Bundle:` instead (see `PackageCommand.cs` in microsoft/winappcli:
 * `$"{UiSymbols.Package} Package: {result.MsixPath}"` vs
 * `$"{UiSymbols.Package} Bundle: {result.BundlePath}"`). Both must be accepted,
 * otherwise a successful bundle is misreported as a packaging failure.
 *
 * The bundle branch prints no per-slice `📦 Package:` line — individual slices
 * are reported as `[1/2] Packing x64...` — so there is never more than one
 * artifact marker to choose between.
 *
 * The path may follow on the same line or wrap onto subsequent lines, so the
 * parser tolerates both layouts.
 */
const PACKAGE_MARKERS = ['📦 Package:', '📦 Bundle:'] as const;

/**
 * Locate the first artifact marker in a line.
 *
 * @returns The index just past the marker, or `-1` when the line has none.
 */
function findMarkerEnd(line: string): number {
	for (const marker of PACKAGE_MARKERS) {
		const markerIndex = line.indexOf(marker);
		if (markerIndex >= 0) {
			return markerIndex + marker.length;
		}
	}
	return -1;
}

function stripMarkers(line: string): string {
	// Remove the leading artifact marker if present, plus surrounding
	// whitespace, so what remains is the (possibly empty) path fragment.
	const markerEnd = findMarkerEnd(line);
	if (markerEnd >= 0) {
		return line.slice(markerEnd).trim();
	}
	return line.trim();
}

function looksLikeArtifactPath(candidate: string): boolean {
	return isArtifactPath(candidate);
}

/**
 * Extract the absolute path of the artifact produced by `winapp package` from
 * its captured stdout.
 *
 * The CLI prints the path after a `📦 Package:` marker (or `📦 Bundle:` for a
 * multi-folder bundle run), but Spectre.Console wrapping frequently pushes the
 * path onto the line *after* the marker, e.g.:
 *
 * ```
 *   📦 Package:
 * C:\path\to\CounterApp_1.0.0.0_x64.msix
 * ✅ MSIX package creation completed.
 * ```
 *
 * Strategy:
 * Prefer the text attached to (or following) the artifact marker,
 * concatenating consecutive lines to handle Spectre.Console wrapping.
 *
 * @param output Combined stdout (and optionally stderr) captured from the CLI.
 * @returns The trimmed artifact path, or `undefined` if none was found.
 */
export function parsePackagedArtifactPath(output: string): string | undefined {
	const lines = output.split(/\r?\n/).map((line) => line.replace(/\r$/, ''));

	// 1. Anchor on the artifact marker ("📦 Package:" or "📦 Bundle:").
	for (let i = 0; i < lines.length; i++) {
		if (findMarkerEnd(lines[i]) < 0) {
			continue;
		}

		const sameLine = stripMarkers(lines[i]);
		if (looksLikeArtifactPath(sameLine)) {
			return sameLine;
		}

		// Path printed on following row(s). Spectre.Console may wrap a long
		// path across multiple lines, so we concatenate non-empty lines after
		// the marker until the accumulated text ends in a known extension.
		let accumulated = sameLine;
		for (let j = i + 1; j < lines.length; j++) {
			const fragment = lines[j].trim();
			if (fragment.length === 0) {
				if (accumulated.length > 0) {
					// A blank line after content means the path block ended
					// without matching — stop accumulating.
					break;
				}
				continue;
			}
			accumulated += fragment;
			if (looksLikeArtifactPath(accumulated)) {
				return accumulated;
			}
		}
	}

	return undefined;
}

/**
 * Build the message shown in the pack completion notification.
 *
 * Uses the artifact's file name (not the full path) so the toast stays short,
 * and includes the app name inferred from the workspace/input folder when
 * available.
 *
 * @param artifactPath Absolute path to the produced .msix/.msixbundle.
 * @param appName Optional friendly app name to prefix the message with.
 */
export function buildPackSuccessMessage(artifactPath: string, appName?: string): string {
	const fileName = path.basename(artifactPath);
	if (appName && appName.trim().length > 0) {
		return `${appName.trim()} packaged → ${fileName}`;
	}
	return `Package created → ${fileName}`;
}

export function getPackNotificationAction(choice: string | undefined): PackNotificationAction {
	if (choice === PACK_ACTIONS.reveal) {
		return 'reveal';
	}
	if (choice === PACK_ACTIONS.sign) {
		return 'sign';
	}
	if (choice === PACK_ACTIONS.install) {
		return 'install';
	}
	return 'none';
}

export function isArtifactWithinRoot(artifactPath: string, root: string): boolean {
	const resolvedArtifact = path.resolve(artifactPath).toLowerCase();
	const resolvedRoot = path.resolve(root).toLowerCase();
	const relativePath = path.relative(resolvedRoot, resolvedArtifact);
	return relativePath.length > 0 && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

export function planPackCompletion(result: {
	code: number | null;
	output: string;
	cancelled?: boolean;
}): PackCompletionPlan {
	if (result.cancelled) {
		return { kind: 'cancelled' };
	}

	const artifactPath = parsePackagedArtifactPath(result.output);
	if (result.code !== 0 || !artifactPath) {
		const explicitError = result.output
			.split(/\r?\n/)
			.find(line => /^\s*(?:\[ERROR\]\s*-\s*|[❌✖✗]\s*)/u.test(line));
		const detail = explicitError ? parseWinappErrorMessage(explicitError) : undefined;
		return {
			kind: 'error',
			message: detail
				? `Packaging failed: ${detail}`
				: 'Packaging failed. See the WinApp output channel for details.'
		};
	}

	const appName = deriveAppNameFromArtifact(artifactPath);
	return {
		kind: 'success',
		artifactPath,
		appName,
		message: buildPackSuccessMessage(artifactPath, appName)
	};
}

/**
 * Derive a friendly app name from a packaged artifact's file name.
 *
 * The CLI names artifacts `<name>_<version>_<arch>.msix`, where the version
 * segment always begins with a digit. We take everything up to the first
 * `_<digit>` boundary so an app name that itself contains underscores is
 * preserved (e.g. `My_Cool_App_1.0.0_x64.msix` → `My_Cool_App`).
 *
 * @param artifactPath Absolute path or file name of the produced artifact.
 * @returns The inferred app name, or `undefined` if it cannot be determined.
 */
export function deriveAppNameFromArtifact(artifactPath: string): string | undefined {
	const base = stripArtifactExtension(path.basename(artifactPath));
	const match = base.match(/^(.*?)_\d/);
	if (match && match[1].length > 0) {
		return match[1];
	}
	return undefined;
}
