/**
 * Resolves DevTools source references to files on disk.
 *
 * The engine reports declaration sites as packaged URIs
 * (`ms-appx:///MainWindow.xaml`) or as paths that were recorded on the build
 * machine. Neither is guaranteed to be openable, so references are mapped back
 * onto the workspace before the panel offers a go-to-source link.
 */

import * as path from 'path';

/** Prefer the project that built the running exe, then the project matching the app name, then a single project. */
export function matchSourceRoot(projects: string[], processName?: string, exePath?: string): string | undefined {
    if (exePath) {
        const exe = path.resolve(exePath).toLowerCase();
        const owners = projects
            .map(project => path.dirname(path.resolve(project)))
            .filter(folder => exe.startsWith(folder.toLowerCase() + path.sep));
        if (owners.length > 0) {
            const deepest = Math.max(...owners.map(folder => folder.length));
            const best = [...new Set(owners.filter(folder => folder.length === deepest).map(f => f.toLowerCase()))];
            if (best.length === 1) { return owners.find(folder => folder.toLowerCase() === best[0]); }
        }
    }
    const matching = processName
        ? projects.filter(project => path.basename(project, path.extname(project)).toLowerCase()
            === processName.toLowerCase())
        : [];
    if (matching.length === 1) { return path.dirname(matching[0]); }
    if (projects.length === 1) { return path.dirname(projects[0]); }
    return undefined;
}

/** The folder the engine already reports for an app, from its "already uses the project folder" refusal. */
export function existingSourceRoot(message: string): string | undefined {
    const match = /already uses the project folder (.+?)\.?\s*$/i.exec(message.trim());
    return match?.[1]?.trim() || undefined;
}

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
