/**
 * Shared manifest file-path matching helpers.
 * No VS Code dependency — usable from any module.
 */

import type * as vscode from 'vscode';

/** Regex that matches AppxManifest.xml or *.appxmanifest paths (case-insensitive). */
const MANIFEST_PATH_RE = /(?:^|[\\/])appxmanifest\.xml$|\.appxmanifest$/i;

/** Check whether an fs path points to a manifest file. */
export function isManifestPath(fsPath: string): boolean {
    return MANIFEST_PATH_RE.test(fsPath);
}

/** VS Code document selector for manifest XML files. */
export const MANIFEST_SELECTOR: vscode.DocumentSelector = [
    { language: 'xml', pattern: '**/[Aa]ppx[Mm]anifest.xml' },
    { language: 'xml', pattern: '**/*.appxmanifest' },
];
