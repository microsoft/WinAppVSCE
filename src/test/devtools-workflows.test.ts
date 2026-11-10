import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { parseApps, parseSavedComments } from '../devtools/devtools-cli';
import { matchSourceRoot } from '../devtools/source-resolver';
import { inspectorPreference } from '../devtools/launch-options';
import { findTreeNode, replaceSubtree, subtreeRoot } from '../devtools/tree-model';
import { createDevToolsWorkspace } from './e2e/devtools-fixture';
import { readFileSync, rmSync } from 'node:fs';

test('the live fixture asks the owning CLI to unregister on exit', () => {
    const workspace = createDevToolsWorkspace(process.cwd());
    try {
        const launch = JSON.parse(readFileSync(path.join(workspace, '.vscode', 'launch.json'), 'utf8'));
        assert.equal(launch.configurations[0].unregisterOnExit, true);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test('inspector preference respects launch override, setting, and VS Code default', () => {
    assert.equal(inspectorPreference(undefined), 'vscode');
    assert.equal(inspectorPreference({}, 'native'), 'native');
    assert.equal(inspectorPreference({ devToolsInspector: 'vscode' }, 'native'), 'vscode');
    assert.equal(inspectorPreference({ devToolsInspector: 'native' }), 'native');
});

test('app discovery accepts attached and available apps but rejects malformed output', () => {
    assert.deepEqual(parseApps({ apps: [
        { processId: 12, processName: 'Gallery', attached: false },
        { processId: 13, processName: 'Fixture', attached: true, windowTitle: 'Fixture App' },
    ] }).map(app => app.processId), [12, 13]);
    assert.throws(() => parseApps({}), /app list/);
    assert.throws(() => parseApps({ apps: [{ processId: '12' }] }), /invalid app/);
    assert.throws(() => parseApps({ apps: [{ processId: -1, processName: 'Bad', attached: false }] }), /invalid app/);
});

test('saved comments use repository-relative anchors and never invent live handles', () => {
    const root = path.resolve('repo');
    const comments = parseSavedComments({
        app: { storePath: path.join(root, '.winapp', 'ui-comments.json') },
        comments: [{
            id: 'cmt_1', text: '<b>literal</b>', status: 'open', requiresConfirmation: true,
            anchor: { sourceFile: path.join('App', 'MainPage.xaml'), line: 21, identity: { name: 'Heading' } },
        }],
    }, path.join(root, 'App'));
    assert.deepEqual(comments, [{
        id: 'cmt_1', text: '<b>literal</b>', status: 'open', requiresConfirmation: true,
        file: path.join(root, 'App', 'MainPage.xaml'), line: 21, element: 'Heading',
    }]);
    assert.throws(() => parseSavedComments({}, root), /did not return comments/);
    assert.throws(() => parseSavedComments({ comments: [{ id: 'cmt_1', text: 'x' }] }, root), /invalid object/);
});

test('source roots are inferred only for unique project matches', () => {
    const gallery = path.resolve('repo', 'Gallery', 'Gallery.csproj');
    const fixture = path.resolve('repo', 'Fixture', 'Fixture.vcxproj');
    assert.equal(matchSourceRoot([gallery, fixture], 'gallery'), path.dirname(gallery));
    assert.equal(matchSourceRoot([gallery]), path.dirname(gallery));
    assert.equal(matchSourceRoot([gallery, fixture], 'Unknown'), undefined);
    assert.equal(matchSourceRoot([]), undefined);
    assert.equal(matchSourceRoot([gallery, path.resolve('other', 'Gallery.csproj')], 'Gallery'), undefined);
});

test('subtree loading accepts both protocol envelopes and validates the requested root', () => {
    const leaf = { handle: 'deep', type: 'Button', name: '', children: [], childCount: 0 };
    const root = { handle: 'root', type: 'Grid', name: '', children: [leaf], childCount: 1 };
    assert.equal(findTreeNode([root], 'deep'), leaf);
    assert.equal(subtreeRoot({ nodes: [root] }, 'deep'), leaf);
    assert.equal(subtreeRoot([root], 'root'), root);
    assert.throws(() => subtreeRoot([root], 'stale'), /requested element stale/);
});

test('expanding an ancestor removes a picked extra root once it is reachable normally', () => {
    const leaf = { handle: 'picked', name: '', type: 'Button', childCount: 0, children: [] };
    const root = { handle: 'root', name: '', type: 'Grid', childCount: 1, children: [] };
    const tree = replaceSubtree([root, { ...leaf }], { ...root, children: [leaf] });
    assert.equal(tree.length, 1);
    assert.equal(findTreeNode(tree, 'picked'), leaf);
    assert.throws(() => replaceSubtree([], leaf), /no longer in the tree/);
});
