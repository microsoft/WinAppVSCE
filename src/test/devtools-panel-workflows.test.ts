import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import type * as vscode from 'vscode';
import { FakeDevToolsEngine } from './helpers/fake-devtools-engine';
import { USED_METHODS } from '../devtools/protocol';
import { DevToolsCli } from '../devtools/devtools-cli';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../devtools/devtools-types';

const disposable = { dispose() {} };
class Panel {
    viewColumn = 1;
    visible = false;
    messages: ExtensionToWebviewMessage[] = [];
    reveals: unknown[][] = [];
    receive: (message: WebviewToExtensionMessage) => void = () => { throw new Error('No message handler'); };
    onDispose: (() => void) | undefined;
    webview = {
        html: '', cspSource: 'vscode-webview://test',
        onDidReceiveMessage: (handler: typeof this.receive) => { this.receive = handler; return disposable; },
        postMessage: (message: ExtensionToWebviewMessage) => { this.messages.push(message); return Promise.resolve(true); },
    };
    onDidDispose(handler: () => void) { this.onDispose = handler; return disposable; }
    reveal(...args: unknown[]) { this.reveals.push(args); }
    dispose() { const handler = this.onDispose; this.onDispose = undefined; handler?.(); }
}

const panels: Panel[] = [];
const shownDocuments: Record<string, unknown>[] = [];
const uri = (fsPath: string) => ({ fsPath, toString: () => fsPath });
const registered = new Map<string, () => Promise<void>>();
let projects: ReturnType<typeof uri>[] = [];
let inspector = 'vscode';
const stub = {
    ViewColumn: { Active: -1, Beside: -2 },
    Uri: { file: uri, joinPath: (base: { fsPath: string }, ...parts: string[]) => uri(path.join(base.fsPath, ...parts)) },
    Range: class { constructor(readonly startLine: number, readonly startColumn: number, readonly endLine: number, readonly endColumn: number) {} },
    workspace: {
        workspaceFolders: [], fs: { stat: async () => ({}) },
        findFiles: async () => projects,
        getConfiguration: () => ({ get: () => inspector }),
    },
    commands: {
        registerCommand: (name: string, handler: () => Promise<void>) => { registered.set(name, handler); return disposable; },
    },
    window: {
        createWebviewPanel: () => { const panel = new Panel(); panels.push(panel); return panel; },
        createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
        showTextDocument: async (_target: unknown, options: Record<string, unknown>) => { shownDocuments.push(options); },
        showWarningMessage: async () => undefined,
        showErrorMessage: async () => undefined,
        showQuickPick: async (items: unknown[]) => items[0],
    },
};

// Only the VS Code boundary is replaced. The panel and its JSON-RPC client run
// unchanged, against the real named-pipe fake engine.
const loader = require('node:module') as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const originalLoad = loader._load;
let panelModule: typeof import('../devtools/devtools-panel');
let sourceModule: typeof import('../devtools/source-navigation');
let commandsModule: typeof import('../devtools/commands');
try {
    loader._load = (request, parent, isMain) => request === 'vscode'
        ? stub : originalLoad(request, parent, isMain);
    panelModule = require('../devtools/devtools-panel');
    sourceModule = require('../devtools/source-navigation');
    commandsModule = require('../devtools/commands');
} finally {
    loader._load = originalLoad;
}
const { DevToolsPanel } = panelModule;
const extensionUri = uri(process.cwd()) as vscode.Uri;

async function until(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
        if (Date.now() >= deadline) { throw new Error('Timed out waiting for panel result'); }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

test('relaunching the same project replaces the previous run\'s disconnected panel', async t => {
    const first = 830500 + process.pid;
    const second = first + 1;
    const engine = await FakeDevToolsEngine.start(second, { methods: [...USED_METHODS] });
    t.after(async () => { DevToolsPanel.disposeAll(); await engine.stop(); });
    await DevToolsPanel.show(first, extensionUri, 1, process.cwd());
    const stale = panels.at(-1)!;
    let staleDisposed = false;
    const onDispose = stale.onDispose;
    stale.onDispose = () => { staleDisposed = true; onDispose?.(); };
    DevToolsPanel.disconnectFor(first);
    await DevToolsPanel.show(second, extensionUri, 1, process.cwd());
    assert.ok(staleDisposed, 'the stale panel for the old PID is closed');
    assert.notEqual(panels.at(-1), stale);
});

test('tree selection updates the engine selection and highlight', async t => {
    const pid = 810000 + process.pid;
    const engine = await FakeDevToolsEngine.start(pid, { methods: [...USED_METHODS] });
    t.after(async () => { DevToolsPanel.disposeAll(); await engine.stop(); });
    await DevToolsPanel.show(pid, extensionUri);
    const panel = panels.at(-1)!;
    panel.receive({ type: 'ready' });
    await until(() => panel.messages.some(m => m.type === 'comments'));
    panel.receive({ type: 'selectNode', handle: 'h-title' });
    await until(() => engine.received.some(m => m.method === 'Selection.select'));
    await until(() => panel.messages.some(m => m.type === 'properties'));
    assert.deepEqual(engine.received.find(m => m.method === 'Selection.select')?.params,
        { handle: 'h-title', owner: 'fake-owner-token' });
    assert.equal(engine.received.find(m => m.method === 'Overlay.highlight')?.params.handle, 'h-title');
    assert.ok(!panel.messages.some(m => m.type === 'status' && m.status.state === 'error'));
});

test('a refused engine selection does not prevent properties or highlighting', async t => {
    const pid = 850000 + process.pid;
    const engine = await FakeDevToolsEngine.start(pid, {
        methods: [...USED_METHODS],
        handlers: { 'Selection.select': () => { throw new Error('Selection unavailable'); } },
    });
    t.after(async () => { DevToolsPanel.disposeAll(); await engine.stop(); });
    await DevToolsPanel.show(pid, extensionUri);
    const panel = panels.at(-1)!;
    panel.receive({ type: 'ready' });
    await until(() => panel.messages.some(m => m.type === 'comments'));
    panel.receive({ type: 'selectNode', handle: 'h-title' });
    await until(() => panel.messages.some(m => m.type === 'status' && m.status.message?.includes('could not be synchronized') === true));
    assert.ok(panel.messages.some(m => m.type === 'properties' && m.properties.handle === 'h-title'));
    assert.ok(engine.received.some(m => m.method === 'Overlay.highlight'));
});

test('expanding a truncated node fetches its children and surfaces subtree failures', async t => {
    const pid = 820000 + process.pid;
    let fail = false;
    const leaf = { handle: 'deep', type: 'Button', name: 'DeepButton', children: [], childCount: 0 };
    const engine = await FakeDevToolsEngine.start(pid, {
        methods: [...USED_METHODS],
        handlers: {
            'VisualTree.enumerate': params => {
                if (params.rootHandle && fail) { throw new Error('Element went stale'); }
                return { nodes: [{
                    handle: 'root', type: 'Grid', name: '', childCount: 1,
                    children: params.rootHandle ? [leaf] : [],
                }] };
            },
        },
    });
    t.after(async () => { DevToolsPanel.disposeAll(); await engine.stop(); });
    await DevToolsPanel.show(pid, extensionUri);
    const panel = panels.at(-1)!;
    panel.receive({ type: 'ready' });
    await until(() => panel.messages.some(m => m.type === 'comments'));
    panel.receive({ type: 'expandNode', handle: 'root' });
    await until(() => panel.messages.some(m => m.type === 'tree' && m.tree.nodes[0].children?.length === 1));
    assert.deepEqual(engine.received.find(m => m.method === 'VisualTree.enumerate' && m.params.rootHandle)?.params,
        { rootHandle: 'root', authored: true, depth: 12 });
    fail = true;
    panel.receive({ type: 'expandNode', handle: 'root' });
    await until(() => panel.messages.some(m => m.type === 'status' && m.status.message === 'Element went stale'));
});

test('a filter request loads the whole tree, and later refreshes keep every level', async t => {
    const pid = 825000 + process.pid;
    const engine = await FakeDevToolsEngine.start(pid, {
        methods: [...USED_METHODS],
        handlers: {
            'VisualTree.enumerate': () => ({ nodes: [{ handle: 'root', type: 'Grid', name: '', childCount: 0, children: [] }] }),
        },
    });
    t.after(async () => { DevToolsPanel.disposeAll(); await engine.stop(); });
    await DevToolsPanel.show(pid, extensionUri);
    const panel = panels.at(-1)!;
    panel.receive({ type: 'ready' });
    await until(() => panel.messages.some(m => m.type === 'comments'));
    const depths = () => engine.received
        .filter(m => m.method === 'VisualTree.enumerate' && !m.params.rootHandle)
        .map(m => m.params.depth);
    assert.deepEqual(depths(), [12]);

    panel.receive({ type: 'loadFullTree' });
    await until(() => depths().length === 2);
    panel.receive({ type: 'refreshTree', authored: false });
    await until(() => depths().length === 3);

    assert.deepEqual(depths(), [12, -1, -1]);
});

test('a picked element outside the loaded tree is fetched and the panel revealed', async t => {
    const pid = 830000 + process.pid;
    const engine = await FakeDevToolsEngine.start(pid, {
        methods: [...USED_METHODS],
        handlers: {
            'VisualTree.enumerate': params => ({ nodes: [{
                handle: params.rootHandle ?? 'root', type: 'Button', name: '', childCount: 0, children: [],
            }] }),
        },
    });
    t.after(async () => { DevToolsPanel.disposeAll(); await engine.stop(); });
    await DevToolsPanel.show(pid, extensionUri);
    const panel = panels.at(-1)!;
    panel.receive({ type: 'ready' });
    await until(() => panel.messages.some(m => m.type === 'comments'));
    engine.emit('Selection.picked', { handle: 'outside' });
    await until(() => panel.messages.some(m => m.type === 'properties' && m.properties.handle === 'outside'));
    assert.ok(panel.reveals.some(args => args[1] === false));
    assert.ok(panel.messages.some(m => m.type === 'selectHandle' && m.handle === 'outside'));
    assert.ok(engine.received.some(m => m.method === 'VisualTree.enumerate'
        && m.params.rootHandle === 'outside' && m.params.authored === false));
});

test('external inspector registration routes inspect and comments requests to the panel', async t => {
    const pid = 835000 + process.pid;
    const engine = await FakeDevToolsEngine.start(pid, {
        methods: [...USED_METHODS],
        handlers: {
            'VisualTree.enumerate': params => ({ nodes: [{
                handle: params.rootHandle ?? 'root', type: 'Button', name: '', childCount: 0, children: [],
            }] }),
        },
    });
    t.after(async () => { DevToolsPanel.disposeAll(); await engine.stop(); });
    await DevToolsPanel.show(pid, extensionUri);
    const panel = panels.at(-1)!;
    panel.receive({ type: 'ready' });
    await until(() => engine.received.some(m => m.method === 'Inspector.registerExternal'));
    assert.deepEqual(engine.received.find(m => m.method === 'Inspector.registerExternal')?.params, {
        owner: 'fake-owner-token',
        displayName: 'Visual Studio Code',
    });
    assert.ok(!engine.received.some(m => m.method === 'Window.close'));

    engine.emit('Inspector.openRequested', { view: 'inspect', origin: null });
    await until(() => panel.messages.some(m => m.type === 'showInspect'));
    assert.ok(panel.reveals.some(args => args[1] === false));

    engine.emit('Inspector.openRequested', { view: 'comments', origin: null });
    await until(() => panel.messages.some(m => m.type === 'showComments'));

    engine.emit('Inspector.openRequested', { view: 'inspect', handle: 'external', origin: null });
    await until(() => panel.messages.some(m => m.type === 'selectHandle' && m.handle === 'external'));

    DevToolsPanel.closeFor(pid);
    await until(() => engine.received.some(m => m.method === 'Inspector.unregisterExternal'));
    assert.deepEqual(engine.received.find(m => m.method === 'Inspector.unregisterExternal')?.params, {
        owner: 'fake-owner-token',
    });
});

test('comments remain usable after debug teardown and can be opened without a process', async t => {
    const pid = 840000 + process.pid;
    const engine = await FakeDevToolsEngine.start(pid, { methods: [...USED_METHODS] });
    const comments = [{ id: 'cmt_1', text: 'Saved note', status: 'open' }];
    const reads = t.mock.method(DevToolsCli.prototype, 'comments', async () => comments);
    const writes = t.mock.method(DevToolsCli.prototype, 'changeComment', async () => {});
    t.after(async () => { DevToolsPanel.disposeAll(); await engine.stop(); });
    await DevToolsPanel.show(pid, extensionUri, 1, process.cwd());
    const live = panels.at(-1)!;
    live.receive({ type: 'ready' });
    await until(() => live.messages.some(m => m.type === 'comments'));
    DevToolsPanel.disconnectFor(pid);
    assert.ok(live.messages.some(m => m.type === 'status' && m.status.state === 'disconnected'));
    live.receive({ type: 'loadComments' });
    await until(() => reads.mock.callCount() > 0);
    live.receive({ type: 'resolveComment', id: 'cmt_1' });
    await until(() => writes.mock.callCount() === 1);
    assert.deepEqual(writes.mock.calls[0].arguments, [process.cwd(), 'cmt_1', 'resolve']);

    await DevToolsPanel.showComments(extensionUri, process.cwd());
    const offline = panels.at(-1)!;
    offline.receive({ type: 'ready' });
    await until(() => offline.messages.some(m => m.type === 'comments'));
    assert.ok(offline.messages.some(m => m.type === 'showComments'));
    offline.receive({ type: 'deleteComment', id: 'cmt_1' });
    await until(() => writes.mock.callCount() === 2);
    assert.deepEqual(writes.mock.calls[1].arguments, [process.cwd(), 'cmt_1', 'delete']);
});

test('source navigation opens a stable adjacent group, not another group on each click', async () => {
    shownDocuments.length = 0;
    await sourceModule.openSourceLocation('C:\\src\\MainPage.xaml', 10, 5, undefined, 1);
    await sourceModule.openSourceLocation('C:\\src\\MainPage.xaml', 10, 5, undefined, 1);
    await sourceModule.openSourceLocation('C:\\src\\MainPage.xaml', 10, 5, undefined, 3);
    assert.deepEqual(shownDocuments.map(options => options.viewColumn), [2, 2, 2]);
    assert.deepEqual(shownDocuments[0].selection,
        new stub.Range(9, 4, 9, 4));
});

test('attach discovers apps and passes the matching workspace project as source root', async t => {
    const root = path.resolve('workspace', 'Gallery');
    projects = [uri(path.join(root, 'Gallery.csproj')), uri(path.resolve('workspace', 'Other', 'Other.csproj'))];
    inspector = 'native';
    const run = t.mock.method(DevToolsCli.prototype, 'run', async (args: string[]) =>
        args[1] === 'list' ? { apps: [{ processId: 123, processName: 'Gallery', attached: false }] } : { ok: true });
    commandsModule.registerDevToolsCommands({
        extensionPath: process.cwd(), extensionUri, subscriptions: [],
    } as never);
    await registered.get('winapp.attachDevTools')!();
    assert.deepEqual(run.mock.calls[1].arguments, [[
        'devtools', 'attach', '--pid', '123', '--source-root', root, '--show-window',
    ], root]);
    inspector = 'vscode';
});

test('the engine echoing the panel\'s own selection does not steal keyboard focus', async t => {
    const pid = 830700 + process.pid;
    const engine = await FakeDevToolsEngine.start(pid, { methods: [...USED_METHODS] });
    t.after(async () => { DevToolsPanel.disposeAll(); await engine.stop(); });
    await DevToolsPanel.show(pid, extensionUri);
    const panel = panels.at(-1)!;
    panel.receive({ type: 'ready' });
    await until(() => panel.messages.some(m => m.type === 'comments'));
    panel.receive({ type: 'selectNode', handle: 'h-title' });
    await until(() => panel.messages.some(m => m.type === 'properties'));
    const reveals = panel.reveals.length;
    engine.emit('Selection.picked', { handle: 'h-title' });
    await until(() => panel.messages.some(m => m.type === 'pickStateChanged'));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(panel.reveals.length, reveals, 'revealing would move focus out of the tree');
});

test('a picked element disarms pick mode in the panel', async t => {
    const pid = 860000 + process.pid;
    const engine = await FakeDevToolsEngine.start(pid, { methods: [...USED_METHODS] });
    t.after(async () => { DevToolsPanel.disposeAll(); await engine.stop(); });
    await DevToolsPanel.show(pid, extensionUri);
    const panel = panels.at(-1)!;
    panel.receive({ type: 'ready' });
    await until(() => panel.messages.some(m => m.type === 'comments'));
    engine.emit('Selection.picked', { handle: 'h-title' });
    await until(() => panel.messages.some(m => m.type === 'pickStateChanged' && m.armed === false));
});

test('hovering a row only highlights and never arms selection', async t => {
    const pid = 861000 + process.pid;
    const engine = await FakeDevToolsEngine.start(pid, { methods: [...USED_METHODS] });
    t.after(async () => { DevToolsPanel.disposeAll(); await engine.stop(); });
    await DevToolsPanel.show(pid, extensionUri);
    const panel = panels.at(-1)!;
    panel.receive({ type: 'ready' });
    await until(() => panel.messages.some(m => m.type === 'comments'));
    panel.receive({ type: 'hoverNode', handle: 'h-title' });
    await until(() => engine.received.some(m => m.method === 'Overlay.highlight'));
    assert.ok(!engine.received.some(m => m.method === 'Selection.arm' || m.method === 'Selection.select'));
});

function duplicateNameEngine(pid: number, names: string[]) {
    return FakeDevToolsEngine.start(pid, {
        methods: [...USED_METHODS],
        handlers: {
            'VisualTree.enumerate': () => ({ nodes: [{
                handle: 'root', type: 'Grid', name: '', childCount: names.length,
                children: names.map((name, i) => ({ handle: `n${i}`, type: 'Button', name, childCount: 0, children: [] })),
            }] }),
            'Comment.add': params => {
                if (params.handle) { throw new Error('Element is stale'); }
                return { id: 'c1' };
            },
        },
    });
}

test('a stale comment anchor is not re-resolved by an ambiguous name', async t => {
    const pid = 862000 + process.pid;
    const engine = await duplicateNameEngine(pid, ['Dup', 'Dup']);
    t.after(async () => { DevToolsPanel.disposeAll(); await engine.stop(); });
    await DevToolsPanel.show(pid, extensionUri);
    const panel = panels.at(-1)!;
    panel.receive({ type: 'ready' });
    await until(() => panel.messages.some(m => m.type === 'tree'));
    panel.receive({ type: 'addComment', handle: 'n1', text: 'too tight' });
    await until(() => panel.messages.some(m => m.type === 'commentError'));
    const error = panel.messages.find(m => m.type === 'commentError');
    assert.match(error?.type === 'commentError' ? error.message : '', /not unique/);
    assert.ok(!engine.received.some(m => m.method === 'Comment.add' && m.params.name));
    assert.ok(!panel.messages.some(m => m.type === 'commentAdded'));
});

test('a stale comment anchor falls back to a unique name and confirms the add', async t => {
    const pid = 863000 + process.pid;
    const engine = await duplicateNameEngine(pid, ['Only', 'Other']);
    t.after(async () => { DevToolsPanel.disposeAll(); await engine.stop(); });
    await DevToolsPanel.show(pid, extensionUri);
    const panel = panels.at(-1)!;
    panel.receive({ type: 'ready' });
    await until(() => panel.messages.some(m => m.type === 'tree'));
    panel.receive({ type: 'addComment', handle: 'n0', text: 'too tight' });
    await until(() => panel.messages.some(m => m.type === 'commentAdded'));
    assert.deepEqual(engine.received.filter(m => m.method === 'Comment.add').at(-1)?.params,
        { name: 'Only', text: 'too tight' });
});

test('app-driven value changes reach the selected element, unchanged polls post nothing', async t => {
    const pid = 866000 + process.pid;
    let text = 'Count: 0';
    const engine = await FakeDevToolsEngine.start(pid, {
        methods: [...USED_METHODS],
        handlers: { 'Property.get': () => ({ props: [{ name: 'Text', value: text, type: 'String' }] }) },
    });
    t.after(async () => { DevToolsPanel.disposeAll(); await engine.stop(); });
    await DevToolsPanel.show(pid, extensionUri);
    const panel = panels.at(-1)!;
    panel.visible = true;
    panel.receive({ type: 'ready' });
    await until(() => panel.messages.some(m => m.type === 'comments'));
    panel.receive({ type: 'selectNode', handle: 'counter' });
    const posted = () => panel.messages.filter(m => m.type === 'properties');
    await until(() => posted().length === 1);
    const gets = () => engine.received.filter(m => m.method === 'Property.get').length;
    const start = gets();
    await until(() => gets() > start);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(posted().length, 1);

    text = 'Count: 2';
    await until(() => posted().length === 2);
    const last = posted().at(-1);
    assert.ok(last?.type === 'properties' && last.properties.props[0].value === 'Count: 2');
});

test('a rejected property write tells the webview so it can drop the edit marker', async t => {
    const pid = 868000 + process.pid;
    const engine = await FakeDevToolsEngine.start(pid, {
        methods: [...USED_METHODS],
        handlers: { 'HotReload.setProperty': () => { throw new Error('conversion failed'); } },
    });
    t.after(async () => { DevToolsPanel.disposeAll(); await engine.stop(); });
    await DevToolsPanel.show(pid, extensionUri);
    const panel = panels.at(-1)!;
    panel.receive({ type: 'ready' });
    await until(() => panel.messages.some(m => m.type === 'comments'));
    panel.receive({ type: 'setProperty', handle: 'border', name: 'Width', value: 'abc', writeType: 'Double' });
    await until(() => panel.messages.some(m => m.type === 'setPropertyFailed'));
    assert.deepEqual(panel.messages.find(m => m.type === 'setPropertyFailed'),
        { type: 'setPropertyFailed', handle: 'border', name: 'Width' });
});

test('a selected element removed by the app gets a clear message and polling stops', async t => {
    const pid = 867000 + process.pid;
    let gone = false;
    const engine = await FakeDevToolsEngine.start(pid, {
        methods: [...USED_METHODS],
        handlers: {
            'Property.get': () => {
                if (gone) { throw Object.assign(new Error('handle or name not found'), { code: -32009 }); }
                return { props: [{ name: 'Text', value: 'Dynamic 0', type: 'String' }] };
            },
        },
    });
    t.after(async () => { DevToolsPanel.disposeAll(); await engine.stop(); });
    await DevToolsPanel.show(pid, extensionUri);
    const panel = panels.at(-1)!;
    panel.visible = true;
    panel.receive({ type: 'ready' });
    await until(() => panel.messages.some(m => m.type === 'comments'));
    panel.receive({ type: 'selectNode', handle: 'dynamic0' });
    await until(() => panel.messages.some(m => m.type === 'properties'));

    gone = true;
    await until(() => panel.messages.some(m => m.type === 'propertiesError'));
    const error = panel.messages.find(m => m.type === 'propertiesError');
    assert.ok(error?.type === 'propertiesError' && error.message.includes('no longer in the app'));
    const gets = engine.received.filter(m => m.method === 'Property.get').length;
    await new Promise(resolve => setTimeout(resolve, 1300));
    assert.equal(engine.received.filter(m => m.method === 'Property.get').length, gets, 'the removed handle is not re-polled');
});

test('an edit saved to an element the user has left does not pull the panel back', async t => {
    const pid = 864000 + process.pid;
    const engine = await FakeDevToolsEngine.start(pid, { methods: [...USED_METHODS] });
    t.after(async () => { DevToolsPanel.disposeAll(); await engine.stop(); });
    await DevToolsPanel.show(pid, extensionUri);
    const panel = panels.at(-1)!;
    panel.receive({ type: 'ready' });
    await until(() => panel.messages.some(m => m.type === 'comments'));
    panel.receive({ type: 'selectNode', handle: 'first' });
    panel.receive({ type: 'selectNode', handle: 'second' });
    await until(() => engine.received.filter(m => m.method === 'Property.get').length >= 2);
    const before = engine.received.length;
    panel.receive({ type: 'setProperty', handle: 'first', name: 'Width', value: '10', writeType: 'Double' });
    await until(() => engine.received.some(m => m.method === 'HotReload.setProperty'));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(!engine.received.slice(before).some(m => m.method === 'Property.get' && m.params.handle === 'first'));

    panel.receive({ type: 'setProperty', handle: 'second', name: 'Width', value: '10', writeType: 'Double' });
    await until(() => engine.received.slice(before).some(m => m.method === 'Property.get' && m.params.handle === 'second'));
});
