import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { cliErrorText, parseApps, parseSavedComments } from '../devtools/devtools-cli';
import { existingSourceRoot, matchSourceRoot } from '../devtools/source-resolver';
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
        diagnostic: 'Current source candidates need confirmation.',
    }]);
    assert.throws(() => parseSavedComments({}, root), /did not return comments/);
    assert.throws(() => parseSavedComments({ comments: [{ id: 'cmt_1', text: 'x' }] }, root), /invalid object/);
});

test('saved comments follow a confirmed anchor to its current line and explain unplaced ones', () => {
    const root = path.resolve('repo');
    const [moved, renamed, unlinked] = parseSavedComments({
        app: { storePath: path.join(root, '.winapp', 'ui-comments.json') },
        comments: [{
            id: 'moved', text: 'a', status: 'open', anchorConfirmed: true,
            hits: [{ file: path.join('App', 'MainPage.xaml'), line: 31, confidence: 'strong' }],
            anchor: { sourceFile: path.join('App', 'MainPage.xaml'), line: 26, identity: { name: 'SaveButton' } },
        }, {
            id: 'renamed', text: 'b', status: 'open', hits: [],
            anchor: { sourceFile: path.join('App', 'MainPage.xaml'), line: 27, identity: { name: 'Gone' } },
        }, {
            id: 'unlinked', text: 'c', status: 'open', hits: [], anchor: { identity: { name: 'Root' } },
        }],
    }, root);
    assert.equal(moved.line, 31, 'a confirmed anchor reports where the element is declared now');
    assert.equal(moved.diagnostic, undefined);
    assert.match(renamed.diagnostic!, /renamed or removed/);
    assert.equal(renamed.line, 27);
    assert.match(unlinked.diagnostic!, /Not linked to source/);
});

test('attach prefers the project that built the running exe over a same-named project', () => {
    const fixture = path.resolve('repo', 'BBFixture', 'BBFixture.csproj');
    const copy = path.resolve('repo', 'BBFixtureB', 'BBFixture.csproj');
    const exe = path.resolve('repo', 'BBFixtureB', 'bin', 'x64', 'Debug', 'AppX', 'BBFixture.exe');
    assert.equal(matchSourceRoot([fixture, copy], 'BBFixture', exe), path.dirname(copy));
    assert.equal(matchSourceRoot([fixture], 'BBFixture', path.resolve('elsewhere', 'BBFixture.exe')),
        path.dirname(fixture));
    assert.equal(existingSourceRoot('This app already uses the project folder C:\\src\\winui-app.'), 'C:\\src\\winui-app');
    assert.equal(existingSourceRoot('DevTools attached, but the project folder was not set: '
        + 'This app already uses the project folder C:\\src\\winui-app.'), 'C:\\src\\winui-app');
    assert.equal(existingSourceRoot('Target process exited.'), undefined);
});

test('CLI failures surface their own reason whatever the JSON casing', () => {
    assert.equal(cliErrorText({ Ok: false, Error: 'Read-only store.' }), 'Read-only store.');
    assert.equal(cliErrorText({ error: { message: 'Corrupt store.' } }), 'Corrupt store.');
    assert.equal(cliErrorText({ ok: true }), undefined);
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
