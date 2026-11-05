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
    sourceRoot?: string,
    panelColumn?: vscode.ViewColumn,
): Promise<void> {
    const target = await findSourceFile(reference, sourceRoot);
    if (!target) {
        await offerSourceRecovery(reference, `Could not find "${reference}" in this workspace.`);
        return;
    }

    const position = toZeroBasedPosition(line, column);
    const selection = new vscode.Range(position.line, position.column, position.line, position.column);
    const adjacent = panelColumn && panelColumn > 0
        ? (panelColumn === 1 ? 2 : panelColumn - 1)
        : vscode.ViewColumn.Beside;
    await vscode.window.showTextDocument(target, { selection, preview: true, viewColumn: adjacent });
}

/**
 * A failed open still leaves the user a way forward: copy the reported path,
 * or reveal it when it exists on disk.
 */
async function offerSourceRecovery(reference: string, message: string): Promise<void> {
    const copy = 'Copy path';
    const picked = await vscode.window.showWarningMessage(message, copy);
    if (picked === copy) { await vscode.env.clipboard.writeText(reference); }
}

/** Shows the source file in the OS file manager. */
export async function revealSourceLocation(reference: string, sourceRoot?: string): Promise<void> {
    const target = await findSourceFile(reference, sourceRoot);
    if (!target) {
        await offerSourceRecovery(reference, `Could not find "${reference}" to reveal.`);
        return;
    }
    await vscode.commands.executeCommand('revealFileInOS', target);
}

/** Copies the resolved path when the file is found, else the reported one. */
export async function copySourcePath(reference: string, sourceRoot?: string): Promise<void> {
    const target = await findSourceFile(reference, sourceRoot);
    const text = target?.fsPath ?? reference;
    await vscode.env.clipboard.writeText(text);
    void vscode.window.setStatusBarMessage(`Copied ${text}`, 3000);
}

/**
 * Maps a reference onto a file in the workspace.
 *
 * Packaged URIs are matched by name because the engine reports where the file
 * lived at package time, not where it lives now.
 */
export async function findSourceFile(reference: string, sourceRoot?: string): Promise<vscode.Uri | undefined> {
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
        if (sourceRoot) {
            const scoped = await vscode.workspace.findFiles(
                new vscode.RelativePattern(sourceRoot, pattern), '**/{bin,obj,node_modules}/**', 2);
            if (scoped.length === 1) { return scoped[0]; }
            if (scoped.length > 1) {
                return vscode.window.showQuickPick(scoped.map(uri => ({
                    label: vscode.workspace.asRelativePath(uri), uri,
                })), { placeHolder: 'Select the control source file' }).then(picked => picked?.uri);
            }
        }
        const matches = await vscode.workspace.findFiles(pattern, '**/{bin,obj,node_modules}/**', 2);
        if (matches.length === 1) { return matches[0]; }
        if (matches.length > 1) {
            return vscode.window.showQuickPick(matches.map(uri => ({
                label: vscode.workspace.asRelativePath(uri), uri,
            })), { placeHolder: 'Select the control source file' }).then(picked => picked?.uri);
        }
    }
    return undefined;
}
