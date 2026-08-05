/**
 * Shared manifest file-path matching helpers.
 * No VS Code dependency — usable from any module.
 */

import type * as vscode from 'vscode';

/** Regex that matches AppxManifest.xml or *.appxmanifest paths (case-insensitive). */
const MANIFEST_PATH_RE = /(?:^|[\\/])appxmanifest\.xml$|\.appxmanifest$/i;

function caseInsensitiveGlob(value: string): string {
    return [...value].map(character =>
        /[a-z]/i.test(character)
            ? `[${character.toUpperCase()}${character.toLowerCase()}]`
            : character
    ).join('');
}

/** Case-insensitive filename glob for the conventional AppxManifest.xml manifest. */
export const APPX_MANIFEST_XML_GLOB = caseInsensitiveGlob('AppxManifest.xml');

/** Case-insensitive extension glob for alternate .appxmanifest manifests. */
export const APPX_MANIFEST_EXTENSION_GLOB = caseInsensitiveGlob('appxmanifest');

/** Case-insensitive glob for the conventional AppxManifest.xml manifest. */
export const APPX_MANIFEST_XML_PATTERN = `**/${APPX_MANIFEST_XML_GLOB}`;

/** Case-insensitive glob for alternate .appxmanifest manifests. */
export const APPX_MANIFEST_EXTENSION_PATTERN = `**/*.${APPX_MANIFEST_EXTENSION_GLOB}`;

/** Glob used to discover manifest files in every workspace folder. */
export const WORKSPACE_MANIFEST_GLOB =
    `{${APPX_MANIFEST_XML_PATTERN},${APPX_MANIFEST_EXTENSION_PATTERN}}`;

/** Excludes dependency and source-control folders from workspace manifest discovery. */
export const WORKSPACE_MANIFEST_EXCLUDE_GLOB = '**/{node_modules,.git}/**';

/**
 * VS Code cannot filter for one XML filename, so this filter explicitly tells
 * users that XML selections must be named AppxManifest.xml.
 */
export const MANIFEST_DIALOG_FILTER: Record<string, string[]> = {
    'Manifest files (.appxmanifest or AppxManifest.xml)': ['appxmanifest', 'xml']
};

/** Check whether an fs path points to a manifest file. */
export function isManifestPath(fsPath: string): boolean {
    return MANIFEST_PATH_RE.test(fsPath);
}

/** VS Code document selector for manifest XML files. */
export const MANIFEST_SELECTOR: vscode.DocumentSelector = [
    { language: 'xml', pattern: APPX_MANIFEST_XML_PATTERN },
    { language: 'xml', pattern: APPX_MANIFEST_EXTENSION_PATTERN },
];
