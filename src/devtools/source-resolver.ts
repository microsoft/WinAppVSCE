/**
 * Resolves DevTools source references to files on disk.
 *
 * The engine reports declaration sites as packaged URIs
 * (`ms-appx:///MainWindow.xaml`) or as paths that were recorded on the build
 * machine. Neither is guaranteed to be openable, so references are mapped back
 * onto the workspace before the panel offers a go-to-source link.
 */

import * as path from 'path';

/** Strips the packaging scheme from a DevTools source reference. */
export function stripSourceScheme(reference: string): string {
    const trimmed = reference.trim();
    const match = /^ms-appx(?:-web)?:\/\/\/?(.*)$/i.exec(trimmed);
    if (match) {
        return match[1];
    }
    return trimmed;
}

/** True when the reference is already an absolute local path. */
export function isAbsoluteLocalPath(reference: string): boolean {
    return /^[a-zA-Z]:[\\/]/.test(reference) || reference.startsWith('\\\\');
}

/**
 * Produces candidate workspace-relative paths for a source reference, most
 * specific first.
 *
 * A packaged URI keeps whatever folder structure the package used, which
 * usually mirrors the project layout — but XAML in a subfolder is sometimes
 * flattened at package time, so the bare file name is included as a fallback.
 */
export function sourceCandidates(reference: string): string[] {
    const stripped = stripSourceScheme(reference).replace(/\//g, path.sep);
    if (!stripped) { return []; }

    const candidates: string[] = [stripped];
    const baseName = path.basename(stripped);
    if (baseName && baseName !== stripped) {
        candidates.push(baseName);
    }
    return candidates;
}

/**
 * Converts a 1-based protocol line number to the 0-based position VS Code uses.
 *
 * The engine omits the line when it could not resolve one, and some paths
 * report 0 to mean "file but no position"; both collapse to the file start.
 */
export function toZeroBasedPosition(line: number | undefined, column: number | undefined): { line: number; column: number } {
    const resolvedLine = typeof line === 'number' && line > 0 ? line - 1 : 0;
    const resolvedColumn = typeof column === 'number' && column > 0 ? column - 1 : 0;
    return { line: resolvedLine, column: resolvedColumn };
}
