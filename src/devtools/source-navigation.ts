/**
 * Opens a DevTools-reported declaration site in the editor.
 *
 * Split from the panel because none of it needs panel state: the pure
 * reference-to-candidate mapping lives in source-resolver, and this is the
 * thin workspace lookup layered on top of it.
 */

import * as vscode from 'vscode';
import { isAbsoluteLocalPath, sourceCandidates, toZeroBasedPosition } from './source-resolver';

/**
 * Reveals a reported declaration site, warning the user when it cannot be
 * found rather than failing silently.
 */
export async function openSourceLocation(
    reference: string,
    line?: number,
    column?: number,
): Promise<void> {
    const target = await findSourceFile(reference);
    if (!target) {
        void vscode.window.showWarningMessage(`Could not find "${reference}" in this workspace.`);
        return;
    }

    const position = toZeroBasedPosition(line, column);
    const selection = new vscode.Range(position.line, position.column, position.line, position.column);
    await vscode.window.showTextDocument(target, { selection, preview: true });
}

/**
 * Maps a reference onto a file in the workspace.
 *
 * Packaged URIs are matched by name because the engine reports where the file
 * lived at package time, not where it lives now.
 */
export async function findSourceFile(reference: string): Promise<vscode.Uri | undefined> {
    if (isAbsoluteLocalPath(reference)) {
        const direct = vscode.Uri.file(reference);
        try {
            await vscode.workspace.fs.stat(direct);
            return direct;
        } catch {
            // Recorded at build time and no longer present; fall through to
            // searching the workspace by name.
        }
    }

    for (const candidate of sourceCandidates(reference)) {
        const pattern = `**/${candidate.replace(/\\/g, '/')}`;
        const matches = await vscode.workspace.findFiles(pattern, '**/{bin,obj,node_modules}/**', 2);
        if (matches.length > 0) {
            return matches[0];
        }
    }
    return undefined;
}
