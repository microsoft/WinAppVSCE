import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    type ManifestQuickPickItem,
    openManifestEditor,
    type OpenManifestEditorAdapter
} from '../manifest-editor/open-manifest-editor';
import {
    MANIFEST_DIALOG_FILTER,
    WORKSPACE_MANIFEST_EXCLUDE_GLOB,
    WORKSPACE_MANIFEST_GLOB
} from '../manifest-schema/manifest-path';

interface TestUri {
    fsPath: string;
    relativePath: string;
    workspaceRelativePath?: string;
}

function createAdapter(
    manifests: TestUri[],
    pick: (items: ManifestQuickPickItem<TestUri>[]) => ManifestQuickPickItem<TestUri> | undefined,
    browseResult?: TestUri[],
    workspaceFolderCount = 1
): {
    adapter: OpenManifestEditorAdapter<TestUri>;
    calls: {
        findFiles: Array<[string, string]>;
        pickItems: ManifestQuickPickItem<TestUri>[][];
        dialogOptions: object[];
        relativePathIncludesWorkspaceFolder: boolean[];
        warnings: string[];
        opened: TestUri[];
    };
} {
    const calls = {
        findFiles: [] as Array<[string, string]>,
        pickItems: [] as ManifestQuickPickItem<TestUri>[][],
        dialogOptions: [] as object[],
        relativePathIncludesWorkspaceFolder: [] as boolean[],
        warnings: [] as string[],
        opened: [] as TestUri[]
    };

    return {
        calls,
        adapter: {
            findFiles: async (include, exclude) => {
                calls.findFiles.push([include, exclude]);
                return manifests;
            },
            workspaceFolderCount: () => workspaceFolderCount,
            asRelativePath: (uri, includeWorkspaceFolder) => {
                calls.relativePathIncludesWorkspaceFolder.push(includeWorkspaceFolder);
                return includeWorkspaceFolder
                    ? uri.workspaceRelativePath ?? uri.relativePath
                    : uri.relativePath;
            },
            showQuickPick: async items => {
                calls.pickItems.push(items);
                return pick(items);
            },
            showOpenDialog: async options => {
                calls.dialogOptions.push(options);
                return browseResult;
            },
            showWarningMessage: message => {
                calls.warnings.push(message);
            },
            openManifestEditor: async uri => {
                calls.opened.push(uri);
            }
        }
    };
}

describe('openManifestEditor', () => {
    it('discovers manifests, sorts them, and opens the workspace selection', async () => {
        const first = { fsPath: 'C:\\workspace\\Alpha\\AppxManifest.xml', relativePath: 'Alpha/AppxManifest.xml' };
        const second = { fsPath: 'C:\\workspace\\zeta.APPXMANIFEST', relativePath: 'zeta.APPXMANIFEST' };
        const { adapter, calls } = createAdapter([second, first], items => items[0]);

        await openManifestEditor(adapter);

        assert.deepEqual(calls.findFiles, [[WORKSPACE_MANIFEST_GLOB, WORKSPACE_MANIFEST_EXCLUDE_GLOB]]);
        assert.deepEqual(calls.pickItems[0].map(item => item.label), [
            '$(file-code) AppxManifest.xml',
            '$(file-code) zeta.APPXMANIFEST',
            '$(folder-opened) Browse…'
        ]);
        assert.deepEqual(calls.opened, [first]);
        assert.deepEqual(calls.relativePathIncludesWorkspaceFolder, [false, false]);
        assert.equal(calls.dialogOptions.length, 0);
    });

    it('includes workspace folder names for unambiguous multi-root selections', async () => {
        const client = {
            fsPath: 'C:\\workspace\\Client\\AppxManifest.xml',
            relativePath: 'AppxManifest.xml',
            workspaceRelativePath: 'Client/AppxManifest.xml'
        };
        const server = {
            fsPath: 'C:\\workspace\\Server\\AppxManifest.xml',
            relativePath: 'AppxManifest.xml',
            workspaceRelativePath: 'Server/AppxManifest.xml'
        };
        const { adapter, calls } = createAdapter([server, client], items => items[0], undefined, 2);

        await openManifestEditor(adapter);

        assert.deepEqual(calls.pickItems[0].map(item => ({
            label: item.label,
            description: item.description
        })), [
            { label: '$(file-code) AppxManifest.xml', description: 'Client' },
            { label: '$(file-code) AppxManifest.xml', description: 'Server' },
            { label: '$(folder-opened) Browse…', description: 'Select a manifest file' }
        ]);
        assert.deepEqual(calls.relativePathIncludesWorkspaceFolder, [true, true]);
        assert.deepEqual(calls.opened, [client]);
    });

    it('browses with a transparent XML filter and opens a valid selected manifest', async () => {
        const selected = { fsPath: 'C:\\outside\\AppXManifest.XML', relativePath: 'outside/AppXManifest.XML' };
        const { adapter, calls } = createAdapter([], items => items[0], [selected]);

        await openManifestEditor(adapter);

        assert.deepEqual(calls.dialogOptions, [{
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            title: 'Select an app manifest',
            filters: MANIFEST_DIALOG_FILTER
        }]);
        assert.deepEqual(calls.opened, [selected]);
        assert.deepEqual(calls.warnings, []);
    });

    it('warns without opening a non-manifest selected through Browse', async () => {
        const invalid = { fsPath: 'C:\\outside\\settings.xml', relativePath: 'outside/settings.xml' };
        const { adapter, calls } = createAdapter([], items => items[0], [invalid]);

        await openManifestEditor(adapter);

        assert.deepEqual(calls.opened, []);
        assert.deepEqual(calls.warnings, ['Select an .appxmanifest or AppxManifest.xml file.']);
    });

    it('does nothing when selection is cancelled or Browse is cancelled', async () => {
        const cancelledPick = createAdapter([], () => undefined);
        await openManifestEditor(cancelledPick.adapter);
        assert.equal(cancelledPick.calls.dialogOptions.length, 0);
        assert.deepEqual(cancelledPick.calls.opened, []);

        const cancelledBrowse = createAdapter([], items => items[0]);
        await openManifestEditor(cancelledBrowse.adapter);
        assert.equal(cancelledBrowse.calls.dialogOptions.length, 1);
        assert.deepEqual(cancelledBrowse.calls.opened, []);
        assert.deepEqual(cancelledBrowse.calls.warnings, []);
    });
});
