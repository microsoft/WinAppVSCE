import * as path from 'path';
import {
    isManifestPath,
    MANIFEST_DIALOG_FILTER,
    WORKSPACE_MANIFEST_EXCLUDE_GLOB,
    WORKSPACE_MANIFEST_GLOB
} from '../manifest-schema/manifest-path';

export interface ManifestUri {
    fsPath: string;
}

export interface ManifestQuickPickItem<TUri extends ManifestUri> {
    label: string;
    description: string;
    uri?: TUri;
}

export interface OpenManifestEditorAdapter<TUri extends ManifestUri> {
    findFiles(include: string, exclude: string): PromiseLike<TUri[]>;
    workspaceFolderCount(): number;
    asRelativePath(uri: TUri, includeWorkspaceFolder: boolean): string;
    showQuickPick(
        items: ManifestQuickPickItem<TUri>[],
        options: { placeHolder: string }
    ): PromiseLike<ManifestQuickPickItem<TUri> | undefined>;
    showOpenDialog(options: {
        canSelectFiles: boolean;
        canSelectFolders: boolean;
        canSelectMany: boolean;
        title: string;
        filters: Record<string, string[]>;
    }): PromiseLike<TUri[] | undefined>;
    showWarningMessage(message: string): void | PromiseLike<unknown>;
    openManifestEditor(uri: TUri): PromiseLike<unknown>;
}

const BROWSE_ITEM_LABEL = '$(folder-opened) Browse…';
const MANIFEST_PICKER_PLACEHOLDER = 'Select an app manifest to open';
const INVALID_MANIFEST_MESSAGE = 'Select an .appxmanifest or AppxManifest.xml file.';

/** Discover, select, validate, and open a manifest in the visual editor. */
export async function openManifestEditor<TUri extends ManifestUri>(
    adapter: OpenManifestEditorAdapter<TUri>
): Promise<void> {
    const manifests = await adapter.findFiles(
        WORKSPACE_MANIFEST_GLOB,
        WORKSPACE_MANIFEST_EXCLUDE_GLOB
    );
    const browseItem: ManifestQuickPickItem<TUri> = {
        label: BROWSE_ITEM_LABEL,
        description: 'Select a manifest file'
    };
    const includeWorkspaceFolder = adapter.workspaceFolderCount() > 1;
    const items = manifests
        .map(uri => ({
            uri,
            relativePath: adapter.asRelativePath(uri, includeWorkspaceFolder)
        }))
        .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
        .map(({ uri, relativePath }) => {
            return {
                label: `$(file-code) ${path.basename(uri.fsPath)}`,
                description: path.dirname(relativePath),
                uri
            };
        });
    const picked = await adapter.showQuickPick([...items, browseItem], {
        placeHolder: MANIFEST_PICKER_PLACEHOLDER
    });
    if (!picked) {
        return;
    }

    let manifestUri = picked.uri;
    if (!manifestUri) {
        const selected = await adapter.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            title: 'Select an app manifest',
            filters: MANIFEST_DIALOG_FILTER
        });
        manifestUri = selected?.[0];
    }
    if (!manifestUri) {
        return;
    }

    if (!isManifestPath(manifestUri.fsPath)) {
        await adapter.showWarningMessage(INVALID_MANIFEST_MESSAGE);
        return;
    }

    await adapter.openManifestEditor(manifestUri);
}
