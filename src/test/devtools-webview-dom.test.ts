import { test } from 'node:test';
import * as assert from 'node:assert';
import { JSDOM } from 'jsdom';
import { getDevToolsWebviewContent } from '../devtools/webview-content';
import type { ExtensionToWebviewMessage } from '../devtools/devtools-types';

/**
 * Exercises the webview against a real DOM.
 *
 * The panel script runs inside a webview, so none of it is reachable from the
 * extension-host tests. Loading the generated page into jsdom covers the part
 * that would otherwise only be verified by hand: that a protocol payload
 * actually renders, and that user gestures post the intents the host expects.
 *
 * The tree and property payloads below were captured from a live WinUI app
 * running under `winapp run --devtools`, so the shapes are real rather than
 * assumed.
 */

const NONCE = 'dom-test-nonce';

test('expanding a truncated tree row requests its missing children', async t => {
    const h = loadPanel();
    t.after(() => h.dom.window.close());
    await h.sendAndFlush({ type: 'tree', tree: {
        authored: true,
        nodes: [{ handle: 'root', type: 'Grid', name: '', childCount: 1, children: [
            { handle: 'deep', type: 'Grid', name: 'Truncated', childCount: 2, children: [] },
        ] }],
    } });
    h.posted.length = 0;
    const twisty = h.doc.querySelector('[data-handle="deep"] .twisty');
    assert.ok(twisty);
    twisty.dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));
    assert.ok(h.posted.some(m => m.type === 'expandNode' && m.handle === 'deep'));
});

test('filtering a partly loaded tree asks once for every level, so deep matches are found', async t => {
    const h = loadPanel();
    t.after(() => h.dom.window.close());
    await h.sendAndFlush({ type: 'tree', tree: {
        authored: false,
        nodes: [{ handle: 'root', type: 'Grid', name: '', childCount: 1, children: [
            { handle: 'deep', type: 'Grid', name: 'Truncated', childCount: 2, children: [] },
        ] }],
    } });
    h.posted.length = 0;
    const filter = h.doc.getElementById('filter') as HTMLInputElement;
    for (const text of ['#Counter', '#CounterButton']) {
        filter.value = text;
        filter.dispatchEvent(new h.dom.window.Event('input'));
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.equal(h.posted.filter(m => m.type === 'loadFullTree').length, 1);
});

test('a picked handle clears the tree filter and leaves the comments tab', async t => {
    const h = loadPanel();
    t.after(() => h.dom.window.close());
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE });
    const filter = h.doc.getElementById('filter') as HTMLInputElement;
    filter.value = '#not-present';
    filter.dispatchEvent(new h.dom.window.Event('input'));
    await new Promise(resolve => setTimeout(resolve, 200));
    h.send({ type: 'showComments' });
    await h.sendAndFlush({ type: 'selectHandle', handle: '234881525' });
    assert.equal(filter.value, '');
    assert.equal(h.doc.getElementById('tab-tree')?.getAttribute('aria-selected'), 'true');
    assert.ok(h.doc.querySelector('[data-handle="234881525"][aria-selected="true"]'));
});

test('disconnect disables live controls but leaves saved comment actions available', async t => {
    const h = loadPanel();
    t.after(() => h.dom.window.close());
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE });
    h.send({ type: 'comments', comments: [{ id: 'saved', text: 'Keep this note', status: 'open', handle: '134218229' }] });
    h.send({ type: 'status', status: { state: 'disconnected' } });
    assert.equal((h.doc.getElementById('btn-pick') as HTMLButtonElement).disabled, true);
    assert.equal((h.doc.getElementById('btn-focus') as HTMLButtonElement).disabled, true);
    assert.equal((h.doc.getElementById('compose-text') as HTMLTextAreaElement).disabled, true);
    assert.ok(!h.doc.querySelector('#comments-host')?.textContent?.includes('Show in tree'));
    const resolve = [...h.doc.querySelectorAll('#comments-host button')].find(button => button.textContent === 'Resolve');
    assert.ok(resolve);
    h.posted.length = 0;
    resolve.dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));
    assert.ok(h.posted.some(m => m.type === 'resolveComment' && m.id === 'saved'));
});

/** A single-file-per-level tree, for exercising deep ancestor paths. */
function chain(types: string[]): Record<string, unknown> {
    let node: Record<string, unknown> | null = null;
    for (let i = types.length - 1; i >= 0; i--) {
        node = {
            handle: 'h' + i,
            name: '',
            type: 'Microsoft.UI.Xaml.Controls.' + types[i],
            file: 'ms-appx:///MainWindow.xaml',
            childCount: node ? 1 : 0,
            children: node ? [node] : [],
        };
    }
    return node as Record<string, unknown>;
}

const LIVE_TREE = {
    nodes: [
        {
            handle: '117441013',
            name: '',
            type: 'Microsoft.UI.Xaml.Controls.Grid',
            file: 'ms-appx:///MainWindow.xaml',
            childCount: 2,
            children: [
                {
                    handle: '134218229',
                    name: 'AppTitleBar',
                    type: 'Microsoft.UI.Xaml.Controls.TitleBar',
                    file: 'ms-appx:///MainWindow.xaml',
                    childCount: 0,
                    children: [],
                },
                {
                    handle: '150995445',
                    name: 'RootFrame',
                    type: 'Microsoft.UI.Xaml.Controls.Frame',
                    file: 'ms-appx:///MainWindow.xaml',
                    childCount: 1,
                    children: [
                        {
                            handle: '234881525',
                            name: '',
                            type: 'PocApp.MainPage',
                            file: 'ms-appx:///MainPage.xaml',
                            childCount: 0,
                            children: [],
                        },
                    ],
                },
            ],
        },
    ],
    authored: true,
};

const LIVE_PROPS = {
    handle: '234881525',
    canEdit: true,
    source: { file: 'MainPage.xaml', line: 17, column: 5 },
    props: [
        {
            name: 'Opacity',
            value: '0.5',
            valueType: 'Windows.Foundation.Double',
            valueSource: 'Local',
            editKind: 'number',
            writeType: 'Double',
            chain: [
                { source: 'Local', value: '0.5', winner: true, file: 'ms-appx:///MainPage.xaml', line: 9 },
                { source: 'Default', value: '1', winner: false },
            ],
        },
        {
            name: 'AutomationProperties.AccessibilityView',
            value: 'Content',
            valueType: 'Microsoft.UI.Xaml.Automation.Peers.AccessibilityView',
            valueSource: 'Default',
            editKind: 'enum',
            writeType: 'AccessibilityView',
            enumValues: ['Raw', 'Control', 'Content'],
        },
    ],
};

/**
 * Captured verbatim from a live app (winapp devtools call Property.get) so
 * the authored-markup fields match the engine rather than our guesses.
 */
const AUTHORED_PROPS = {
    handle: '301990376',
    canEdit: true,
    props: [
        {
            name: 'Text',
            value: 'bound title',
            valueType: 'Windows.Foundation.String',
            valueSource: 'Local',
            editKind: 'text',
            writeType: 'String',
            authored: '{x:Bind Vm.Title, Mode=OneWay}',
            authoredKind: 'xBind',
            authoredKey: 'Vm.Title',
            chain: [
                { source: 'Local', value: 'bound title', winner: true, file: 'ms-appx:///MainPage.xaml', line: 18 },
                { source: 'Default', value: '', winner: false },
            ],
        },
        {
            name: 'Background',
            value: '#FF3FBF6F',
            valueType: 'Microsoft.UI.Xaml.Media.SolidColorBrush',
            valueSource: 'Local',
            editKind: 'color',
            writeType: 'SolidColorBrush',
            authored: '{StaticResource ProbeBrush}',
            authoredKind: 'staticResource',
            authoredKey: 'ProbeBrush',
            chain: [
                { source: 'Local', value: '#FF3FBF6F', winner: true, file: 'ms-appx:///MainPage.xaml', line: 31 },
            ],
        },
    ],
};

interface Harness {
    dom: JSDOM;
    doc: Document;
    posted: Record<string, unknown>[];
    send: (message: ExtensionToWebviewMessage) => void;
    sendAndFlush: (message: ExtensionToWebviewMessage) => Promise<void>;
    flush: () => Promise<void>;
    rowTexts: () => string[];
    expandAllProps: () => void;
    revealAllProps: () => void;
    /** The custom dropdown root whose trigger carries this aria-label. */
    drop: (label: string) => HTMLElement | null;
    /** Labels of every option a custom dropdown offers. */
    dropOptions: (label: string) => string[];
    /** The value a custom dropdown currently shows as selected. */
    dropValue: (label: string) => string | undefined;
    /** Chooses an option by its visible label, as a user click would. */
    pickDrop: (label: string, option: string) => void;
}

/**
 * Builds the page with the VS Code API shim already present.
 *
 * The inline script calls `acquireVsCodeApi()` at load, so the shim has to be
 * installed before scripts run; jsdom's `beforeParse` hook is the only place
 * that happens early enough.
 */
function loadPanel(): Harness {
    const webview = { cspSource: 'vscode-webview://test' } as never;
    const html = getDevToolsWebviewContent(webview, NONCE);
    const posted: Record<string, unknown>[] = [];
    let stored: unknown;

    const dom = new JSDOM(html, {
        runScripts: 'dangerously',
        pretendToBeVisual: true,
        beforeParse(window) {
            (window as unknown as Record<string, unknown>).acquireVsCodeApi = () => ({
                postMessage: (m: Record<string, unknown>) => { posted.push(m); },
                setState: (s: unknown) => { stored = s; },
                getState: () => stored,
            });
        },
    });

    const doc = dom.window.document;

    const send = (message: ExtensionToWebviewMessage) => {
        const event = new dom.window.MessageEvent('message', { data: message });
        dom.window.dispatchEvent(event);
    };

    // Tree rendering is deferred to requestAnimationFrame, so assertions have
    // to wait for the frame to run.
    const flush = () => new Promise<void>((resolve) => {
        dom.window.requestAnimationFrame(() => setTimeout(resolve, 0));
    });

    const sendAndFlush = async (message: ExtensionToWebviewMessage) => {
        send(message);
        await flush();
    };

    const rowTexts = () =>
        Array.from(doc.querySelectorAll('#tree-viewport [role="treeitem"]'))
            .map((el) => (el.textContent ?? '').trim());

    const click = (target: Element | null | undefined) =>
        (target as HTMLElement | null | undefined)?.dispatchEvent(
            new dom.window.MouseEvent('click', { bubbles: true }),
        );

    // The pane shows a curated subset in collapsed groups, mirroring the
    // native window. Tests that assert on an arbitrary property have to turn
    // the curation off and open every group first.
    const revealAllProps = () => {
        click(doc.querySelector('#props-viewport .plink'));
        for (const head of Array.from(doc.querySelectorAll('#props-viewport .pgroup'))) {
            if (!head.className.includes('open')) {
                click(head);
            }
        }
    };

    // Editors and provenance now live in the per-property expansion card, so
    // most property assertions need the card opened first.
    const expandAllProps = () => {
        for (const button of Array.from(doc.querySelectorAll('#props-viewport .pvalue'))) {
            click(button);
        }
    };

    // Dropdowns are custom widgets rather than native selects, so tests drive
    // them through the same button/listbox the user sees.
    const drop = (label: string): HTMLElement | null => {
        const btn = doc.querySelector(`.pdrop-btn[aria-label="${label}"]`);
        return (btn?.parentElement as HTMLElement | undefined) ?? null;
    };

    const dropItems = (label: string) =>
        Array.from(drop(label)?.querySelectorAll('.custom-dropdown-item') ?? []);

    const dropOptions = (label: string) =>
        dropItems(label).map((el) => el.getAttribute('data-value') ?? '');

    const dropValue = (label: string) =>
        dropItems(label).find((el) => el.className.includes('selected'))
            ?.getAttribute('data-value') ?? undefined;

    const pickDrop = (label: string, option: string) => {
        const root = drop(label);
        assert.ok(root, `expected a dropdown labelled "${label}"`);
        click(root.querySelector('.pdrop-btn'));
        const match = dropItems(label).find((el) => el.getAttribute('data-value') === option);
        assert.ok(match, `dropdown "${label}" has no option "${option}" (has ${dropOptions(label).join(', ')})`);
        click(match);
    };

    // The host always reports capabilities right after connecting; without it
    // the panel stays read-only.
    send({ type: 'capabilities', canEdit: true, canPick: true, canHighlight: true });

    return {
        dom, doc, posted, send, sendAndFlush, flush, rowTexts,
        expandAllProps, revealAllProps, drop, dropOptions, dropValue, pickDrop,
    };
}

test('webview announces readiness to the host', async () => {
    const h = loadPanel();
    assert.ok(h.posted.some((m) => m.type === 'ready'), 'should post a ready message');
});

test('renders a live visual tree payload', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);

    const texts = h.rowTexts();
    assert.ok(texts.length > 0, 'expected tree rows to render');
    assert.ok(texts.some((t) => t.includes('Grid')), `expected a Grid row, got: ${texts.join(' | ')}`);
});

test('shows short type names rather than full namespaces', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);

    const texts = h.rowTexts().join(' | ');
    assert.ok(!texts.includes('Microsoft.UI.Xaml.Controls.Grid'), 'namespace should be trimmed');
});

test('renders property rows including the enum editor', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({ type: 'properties', properties: LIVE_PROPS } as ExtensionToWebviewMessage);

    const text = h.doc.getElementById('props-viewport')?.textContent ?? '';
    assert.ok(text.includes('Opacity'), `expected Opacity in: ${text.slice(0, 200)}`);

        h.revealAllProps();
        h.expandAllProps();

    const drop = h.drop('AutomationProperties.AccessibilityView');
    assert.ok(drop, 'enum property should render a dropdown editor');
    assert.strictEqual(h.dropOptions('AutomationProperties.AccessibilityView').length, 3);
});

test('property values from the app are never interpreted as markup', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({
        type: 'properties',
        properties: {
            ...LIVE_PROPS,
            props: [{
                name: 'Content',
                value: '<img src=x onerror="globalThis.__pwned=1">',
                valueType: 'System.String',
                editKind: 'none',
            }],
        },
    } as ExtensionToWebviewMessage);

    assert.strictEqual(h.doc.querySelectorAll('#props-viewport img').length, 0);
    assert.strictEqual((h.dom.window as unknown as Record<string, unknown>).__pwned, undefined);
    assert.ok((h.doc.getElementById('props-viewport')?.textContent ?? '').includes('onerror'));
});

test('element names from the app are never interpreted as markup', async () => {
    const h = loadPanel();
    h.send({
        type: 'tree',
        tree: {
            authored: true,
            nodes: [{
                handle: '1',
                name: '<img src=x onerror="globalThis.__pwned=1">',
                type: 'Grid',
                childCount: 0,
                children: [],
            }],
        },
    } as ExtensionToWebviewMessage);

    assert.strictEqual(h.doc.querySelectorAll('#tree-viewport img').length, 0);
    assert.strictEqual((h.dom.window as unknown as Record<string, unknown>).__pwned, undefined);
});

test('the Just my XAML toggle re-requests the tree with the new scope', async () => {
    const h = loadPanel();
    const toggle = h.doc.getElementById('btn-jmx') as HTMLElement;
    h.posted.length = 0;

    // Starts pressed, so one click asks for the full tree.
    toggle.dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));

    const refresh = h.posted.find((m) => m.type === 'refreshTree');
    assert.ok(refresh, 'expected a refreshTree message');
    assert.strictEqual(refresh?.authored, false);
    assert.strictEqual(toggle.getAttribute('aria-pressed'), 'false');
});

test('the comments tab switches views and asks the host for comments', async () => {
    const h = loadPanel();
    h.posted.length = 0;

    h.doc.getElementById('tab-comments')?.dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));

    assert.ok(h.posted.some((m) => m.type === 'loadComments'), 'expected loadComments');
    assert.strictEqual(h.doc.getElementById('tab-comments')?.getAttribute('aria-selected'), 'true');
    assert.ok(h.doc.getElementById('comments-viewport')?.className.includes('hidden') === false);
});

test('the comments badge stays hidden until something is open', async () => {
    const h = loadPanel();
    const badge = h.doc.getElementById('comments-badge') as HTMLElement;
    assert.ok(badge.className.includes('hidden'), 'badge should be hidden at zero');

    h.send({
        type: 'comments',
        comments: [
            { id: 'a', text: 'too tight', status: 'open', element: 'Button' },
            { id: 'b', text: 'done', status: 'resolved', element: 'Grid' },
        ],
    } as ExtensionToWebviewMessage);

    assert.ok(!badge.className.includes('hidden'), 'badge should appear once a comment is open');
    assert.strictEqual(badge.textContent, '1', 'badge counts only open comments');
});

test('clicking a row selects it and asks the host for properties', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.posted.length = 0;

    const row = h.doc.querySelector('#tree-viewport [role="treeitem"]') as HTMLElement;
    row.dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));

    const select = h.posted.find((m) => m.type === 'selectNode');
    assert.ok(select, `expected selectNode, got ${JSON.stringify(h.posted)}`);
    assert.strictEqual(select?.handle, '117441013');
});

test('editing an enum property posts the engine writeType, not the runtime type', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({ type: 'properties', properties: LIVE_PROPS } as ExtensionToWebviewMessage);
    h.revealAllProps();
    h.expandAllProps();
    h.posted.length = 0;

    h.pickDrop('AutomationProperties.AccessibilityView', 'Raw');

    const set = h.posted.find((m) => m.type === 'setProperty');
    assert.ok(set, `expected setProperty, got ${JSON.stringify(h.posted)}`);
    assert.strictEqual(set?.value, 'Raw');
    // The engine rejects the fully-qualified runtime type name here.
    assert.strictEqual(set?.writeType, 'AccessibilityView');
});

test('a read-only posture suppresses property editors', async () => {
    const h = loadPanel();
    // A read-only engine reports canEdit: false during negotiation.
    h.send({ type: 'capabilities', canEdit: false, canPick: true, canHighlight: true });
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({
        type: 'properties',
        properties: { ...LIVE_PROPS, canEdit: false },
    } as ExtensionToWebviewMessage);

    assert.ok(
        (h.doc.getElementById('props-viewport')?.textContent ?? '').includes('Opacity'),
        'properties should still be listed when read-only',
    );

    // Opening every card must not conjure an editor when the engine refuses
    // mutation; the expansion still shows provenance.
    h.expandAllProps();
    assert.strictEqual(h.doc.querySelectorAll('#props-viewport .pdrop').length, 0);
    assert.strictEqual(h.doc.querySelectorAll('#props-viewport input').length, 0);
});

test('choosing a different KIND stages the change rather than applying it', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({ type: 'properties', properties: AUTHORED_PROPS } as unknown as ExtensionToWebviewMessage);
    h.expandAllProps();
    h.posted.length = 0;

    assert.ok(h.drop('Kind of value for Text'), 'expected a KIND dropdown');
    h.pickDrop('Kind of value for Text', 'text');

    assert.ok(h.doc.querySelector('#props-viewport .pstaged'), 'expected a staged banner');
    // Switching representation can destroy a binding, so it must never happen
    // as a side effect of moving a dropdown.
    assert.ok(!h.posted.some((m) => m.type === 'setProperty'), 'staging must not write to the app');
});

test('an applied KIND survives a reload while nothing has been written yet', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({ type: 'capabilities', canEdit: true, canPick: true, canHighlight: true } as ExtensionToWebviewMessage);
    h.send({ type: 'properties', properties: AUTHORED_PROPS } as unknown as ExtensionToWebviewMessage);
    h.expandAllProps();
    h.pickDrop('Kind of value for Text', 'text');
    const apply = Array.from(h.doc.querySelectorAll('#props-viewport button')).find(b => b.textContent === 'Apply') as HTMLElement;
    apply.click();
    const input = h.doc.querySelector('#props-viewport input[aria-label="Text"]') as HTMLInputElement;
    input.focus();
    input.value = 'typing';
    input.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));

    // The bound value ticking in the app reloads the same element.
    const ticked = { ...AUTHORED_PROPS, props: [{ ...AUTHORED_PROPS.props[0], value: 'bound title 2' }, AUTHORED_PROPS.props[1]] };
    h.send({ type: 'properties', properties: ticked } as unknown as ExtensionToWebviewMessage);

    const after = h.doc.querySelector('#props-viewport input[aria-label="Text"]') as HTMLInputElement | null;
    assert.ok(after, 'the Text editor the user applied is still there');
    assert.strictEqual(after.value, 'typing', 'and so is what they typed');
});

test('a reload waits for an open menu to close instead of destroying it', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({ type: 'properties', properties: AUTHORED_PROPS } as unknown as ExtensionToWebviewMessage);
    h.expandAllProps();
    const root = h.drop('Kind of value for Text')!;
    (root.querySelector('.pdrop-btn') as HTMLElement).click();
    assert.ok(root.querySelector('.custom-dropdown-menu')?.classList.contains('open'));

    const ticked = { ...AUTHORED_PROPS, props: [{ ...AUTHORED_PROPS.props[0], value: 'bound title 2' }, AUTHORED_PROPS.props[1]] };
    h.send({ type: 'properties', properties: ticked } as unknown as ExtensionToWebviewMessage);
    assert.ok(root.isConnected, 'the open menu was not rebuilt under the pointer');
    assert.ok(root.querySelector('.custom-dropdown-menu')?.classList.contains('open'));

    h.doc.body.click();
    await h.flush();
    assert.ok(!root.isConnected, 'the held reload ran once the menu closed');
    assert.ok((h.doc.getElementById('props-viewport')?.textContent ?? '').includes('bound title 2'));
});

test('a pending Restore binding confirmation survives a change to another property', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    const text = {
        name: 'Text', value: 'literal', valueType: 'System.String', editKind: 'text',
        valueSource: 'DevTools', authoredKind: 'xBind', authoredKey: 'Title',
    };
    const opacity = { name: 'Opacity', value: '1', valueType: 'System.Double', editKind: 'number', valueSource: 'Default' };
    const props = (o: string) => ({ ...LIVE_PROPS, props: [text, { ...opacity, value: o }] });
    h.send({ type: 'properties', properties: props('1') } as unknown as ExtensionToWebviewMessage);
    h.expandAllProps();
    h.send({ type: 'bindingRestoreConfirm', name: 'Text', scope: 'MainPage' } as unknown as ExtensionToWebviewMessage);

    h.send({ type: 'properties', properties: props('0.5') } as unknown as ExtensionToWebviewMessage);
    const labels = Array.from(h.doc.querySelectorAll('#props-viewport button')).map(b => b.textContent);
    assert.ok(labels.includes('Restore binding (confirm)'), 'the second press still confirms');
});

test('writing a value through the staged kind applies it and drops the staged banner', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({ type: 'capabilities', canEdit: true, canPick: true, canHighlight: true } as ExtensionToWebviewMessage);
    h.send({ type: 'properties', properties: AUTHORED_PROPS } as unknown as ExtensionToWebviewMessage);
    h.expandAllProps();

    h.pickDrop('Kind of value for Text', 'text');
    assert.ok(h.doc.querySelector('#props-viewport .pstaged'), 'picking a kind stages it');
    const input = h.doc.querySelector('#props-viewport input[aria-label="Text"]') as HTMLInputElement;
    input.value = 'literal';
    input.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    assert.ok(h.posted.some((m) => m.type === 'setProperty' && m.value === 'literal'));
    assert.ok(!h.doc.querySelector('#props-viewport .pstaged'), 'the write was the apply');
});

test('an edit records the original value and says what it was', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({ type: 'properties', properties: LIVE_PROPS } as ExtensionToWebviewMessage);
    h.expandAllProps();

    const input = h.doc.querySelector('#props-viewport input[aria-label="Opacity"]') as HTMLInputElement;
    input.value = '0.25';
    input.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    const row = h.doc.querySelector('#props-viewport [data-prop="Opacity"]') as HTMLElement;
    assert.ok(!row.querySelector('.pdot')?.className.includes('hidden'), 'changed marker should show');
    assert.ok(
        (row.textContent ?? '').includes('was 0.5'),
        'the expansion should say what the value was',
    );
});

test('restore original puts back the pre-edit value, and clears one that was never set', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({ type: 'properties', properties: LIVE_PROPS } as ExtensionToWebviewMessage);
    h.revealAllProps();
    h.expandAllProps();

    const input = h.doc.querySelector('#props-viewport input[aria-label="Opacity"]') as HTMLInputElement;
    input.value = '0.25';
    input.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    h.pickDrop('AutomationProperties.AccessibilityView', 'Raw');
    h.posted.length = 0;

    const restore = (name: string) => h.doc.querySelector(
        `#props-viewport button[aria-label="Restore original value of ${name}"]`) as HTMLElement;
    restore('Opacity').dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));
    assert.deepEqual(h.posted.find(m => m.type === 'setProperty'), {
        type: 'setProperty', handle: '234881525', name: 'Opacity', value: '0.5', writeType: 'Double',
    });

    // AccessibilityView came from its default, so putting "Content" back
    // locally would pin it; clearing returns it to the default instead.
    h.posted.length = 0;
    restore('AutomationProperties.AccessibilityView')
        .dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));
    assert.deepEqual(h.posted, [{
        type: 'clearProperty', handle: '234881525', name: 'AutomationProperties.AccessibilityView',
    }]);
    assert.ok(!restore('Opacity') && !restore('AutomationProperties.AccessibilityView'),
        'restored rows stop offering restore');
});

test('clear value is offered only for a locally set value that is not a binding', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({ type: 'properties', properties: LIVE_PROPS } as ExtensionToWebviewMessage);
    h.revealAllProps();
    h.expandAllProps();
    const clear = (name: string) => h.doc.querySelector(`#props-viewport button[aria-label="Clear value of ${name}"]`);
    assert.ok(clear('Opacity'), 'a Local value can be cleared');
    assert.ok(!clear('AutomationProperties.AccessibilityView'), 'a default has nothing to clear');

    h.posted.length = 0;
    (clear('Opacity') as HTMLElement).dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));
    assert.deepEqual(h.posted, [{ type: 'clearProperty', handle: '234881525', name: 'Opacity' }]);

    h.send({ type: 'properties', properties: AUTHORED_PROPS } as ExtensionToWebviewMessage);
    h.revealAllProps();
    h.expandAllProps();
    assert.ok(!clear('Text'), 'clearing an x:Bind target would delete the binding');
    assert.ok(clear('Background'), 'a resource reference is a local value');
});

test('a half-typed value survives the element reloading', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({ type: 'properties', properties: LIVE_PROPS } as ExtensionToWebviewMessage);
    h.expandAllProps();
    const box = () => h.doc.querySelector('#props-viewport input[aria-label="Opacity"]') as HTMLInputElement;
    box().focus();
    box().value = '0.3';
    h.posted.length = 0;

    h.send({ type: 'properties', properties: LIVE_PROPS } as ExtensionToWebviewMessage);

    assert.equal(box().value, '0.3');
    assert.equal(h.doc.activeElement, box());
    assert.ok(!h.posted.some(m => m.type === 'setProperty'), 'a reload is not the user committing');
});

test('a draft is saved to the element it was typed on when the selection moves', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({ type: 'properties', properties: LIVE_PROPS } as ExtensionToWebviewMessage);
    h.expandAllProps();
    const box = h.doc.querySelector('#props-viewport input[aria-label="Opacity"]') as HTMLInputElement;
    box.focus();
    box.value = '0.3';
    h.posted.length = 0;

    h.send({ type: 'properties', properties: AUTHORED_PROPS } as ExtensionToWebviewMessage);

    const sets = h.posted.filter(m => m.type === 'setProperty');
    assert.deepEqual(sets, [{
        type: 'setProperty', handle: '234881525', name: 'Opacity', value: '0.3', writeType: 'Double',
    }]);

    // Restore must still be there when the user goes back.
    h.send({ type: 'properties', properties: LIVE_PROPS } as ExtensionToWebviewMessage);
    h.expandAllProps();
    assert.ok(h.doc.querySelector('#props-viewport button[aria-label="Restore original value of Opacity"]'));
});

test('an expanded value lists its precedence chain with the winner marked', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({ type: 'properties', properties: LIVE_PROPS } as ExtensionToWebviewMessage);
    h.expandAllProps();
    const lines = Array.from(h.doc.querySelectorAll('#props-viewport .pchain .pwit-text')).map(e => e.textContent);
    assert.deepEqual(lines, ['\u25B8 Local  0.5   MainPage.xaml:9', '   Default  1']);
    const editor = h.doc.querySelector('#props-viewport input[aria-label="Opacity"]');
    assert.ok(editor, 'the editor still renders beside the chain');
});

test('blurring after a committed edit does not write the stale value back', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({ type: 'properties', properties: LIVE_PROPS } as ExtensionToWebviewMessage);
    h.expandAllProps();
    const box = () => h.doc.querySelector('#props-viewport input[aria-label="Opacity"]') as HTMLInputElement;
    box().focus();
    box().value = '0.3';
    box().dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    // The host confirms with a fresh payload for the same element.
    const confirmed = {
        ...LIVE_PROPS,
        props: LIVE_PROPS.props.map(p => p.name === 'Opacity' ? { ...p, value: '0.3' } : p),
    };
    h.send({ type: 'properties', properties: confirmed } as ExtensionToWebviewMessage);
    assert.equal(box().value, '0.3', 'the box shows the confirmed value, not the pre-edit one');
    h.posted.length = 0;
    box().blur();
    assert.ok(!h.posted.some(m => m.type === 'setProperty'), 'blur must not revert the edit');
});

test('a committed value is not re-applied when the selection moves', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({ type: 'properties', properties: LIVE_PROPS } as ExtensionToWebviewMessage);
    h.expandAllProps();
    const box = h.doc.querySelector('#props-viewport input[aria-label="Opacity"]') as HTMLInputElement;
    box.focus();
    box.value = '0.3';
    box.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    h.posted.length = 0;
    h.send({ type: 'properties', properties: AUTHORED_PROPS } as ExtensionToWebviewMessage);
    assert.ok(!h.posted.some(m => m.type === 'setProperty'));
});

test('remembered originals are bounded', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    for (let i = 0; i < 520; i++) {
        h.send({ type: 'properties', properties: { ...LIVE_PROPS, handle: 'h' + i } } as ExtensionToWebviewMessage);
        h.expandAllProps();
        const clear = h.doc.querySelector('#props-viewport button[aria-label="Clear value of Opacity"]') as HTMLElement;
        clear.dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));
    }
    const restoreOffered = (handle: string) => {
        h.send({ type: 'properties', properties: { ...LIVE_PROPS, handle } } as ExtensionToWebviewMessage);
        h.expandAllProps();
        return !!h.doc.querySelector('#props-viewport button[aria-label="Restore original value of Opacity"]');
    };
    assert.ok(!restoreOffered('h0'), 'the oldest originals are dropped first');
    assert.ok(!restoreOffered('h19'));
    assert.ok(restoreOffered('h20'), 'the newest 500 are kept');
    assert.ok(restoreOffered('h519'));
});

test('the view tabs follow the ARIA tab pattern from the keyboard', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    const tree = h.doc.getElementById('tab-tree') as HTMLElement;
    const comments = h.doc.getElementById('tab-comments') as HTMLElement;
    assert.equal(comments.tabIndex, -1, 'only the selected tab is a tab stop');
    tree.focus();
    tree.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.equal(comments.getAttribute('aria-selected'), 'true');
    assert.equal(h.doc.activeElement, comments);
    assert.equal(tree.tabIndex, -1);
    assert.ok(h.doc.getElementById(comments.getAttribute('aria-controls')!), 'the tab names its panel');
});

test('a value dropdown is a combobox that tells assistive tech which option is highlighted', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({ type: 'properties', properties: AUTHORED_PROPS } as unknown as ExtensionToWebviewMessage);
    h.expandAllProps();
    const btn = h.drop('Kind of value for Text')!.querySelector('.pdrop-btn') as HTMLElement;
    assert.equal(btn.getAttribute('role'), 'combobox');
    const key = (k: string) => btn.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: k, bubbles: true }));
    key('Enter');
    const first = btn.getAttribute('aria-activedescendant');
    assert.ok(first && h.doc.getElementById(first)?.getAttribute('role') === 'option');
    key('ArrowDown');
    assert.notEqual(btn.getAttribute('aria-activedescendant'), first, 'moving the cursor is announced');
    key('Escape');
    assert.equal(btn.getAttribute('aria-activedescendant'), null);
});

test('the source link offers reveal and copy path as recovery', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({ type: 'properties', properties: LIVE_PROPS } as ExtensionToWebviewMessage);
    h.posted.length = 0;
    for (const label of ['Reveal source file in File Explorer', 'Copy path of source file']) {
        (h.doc.querySelector(`button[aria-label="${label}"]`) as HTMLElement)
            .dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));
    }
    assert.deepEqual(h.posted, [
        { type: 'revealSource', file: 'MainPage.xaml' },
        { type: 'copySourcePath', file: 'MainPage.xaml' },
    ]);
});

test('a property row announces its value and expands from anywhere on the line', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({ type: 'properties', properties: LIVE_PROPS } as ExtensionToWebviewMessage);
    const value = () => h.doc.querySelector('#props-viewport [data-prop="Opacity"] .pvalue') as HTMLElement;
    assert.equal(value().getAttribute('aria-label'), 'Opacity: 0.5');
    assert.equal(value().getAttribute('aria-expanded'), 'false');
    assert.equal(h.doc.querySelector('#props-viewport [data-prop="Opacity"] .pchevron')?.getAttribute('aria-hidden'), 'true');

    (h.doc.querySelector('#props-viewport [data-prop="Opacity"] .prow-line') as HTMLElement)
        .dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));
    assert.equal(value().getAttribute('aria-expanded'), 'true');
});

test('the tree is named for what it lists and its rows count their siblings', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    await h.sendAndFlush({ type: 'selectHandle', handle: '234881525' } as ExtensionToWebviewMessage);
    const tree = h.doc.getElementById('tree-viewport') as HTMLElement;
    assert.equal(tree.getAttribute('aria-label'), 'UI elements');
    assert.equal(h.doc.getElementById('tree-header')?.getAttribute('aria-hidden'), 'true');

    const row = (handle: string) => h.doc.querySelector(`[data-handle="${handle}"]`) as HTMLElement;
    const position = (handle: string) => [row(handle).getAttribute('aria-posinset'), row(handle).getAttribute('aria-setsize')];
    assert.deepEqual(position('117441013'), ['1', '1']);
    assert.deepEqual(position('134218229'), ['1', '2']);
    assert.deepEqual(position('150995445'), ['2', '2']);
    assert.deepEqual(position('234881525'), ['1', '1']);
    assert.equal(row('150995445').querySelector('.twisty')?.getAttribute('aria-hidden'), 'true');
});

test('the tree filter matches element captions and follows caption changes', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({ type: 'previews', previews: [{ handle: '134218229', preview: 'Settings Header' }] });
    const filter = h.doc.getElementById('filter') as HTMLInputElement;
    filter.value = 'settings header';
    filter.dispatchEvent(new h.dom.window.Event('input'));
    await new Promise(resolve => setTimeout(resolve, 250));
    await h.flush();
    assert.ok(h.rowTexts().some(text => text.includes('AppTitleBar')), 'the caption should match');

    await h.sendAndFlush({ type: 'previews', previews: [{ handle: '134218229', preview: 'Account' }] });
    assert.ok(!h.rowTexts().some(text => text.includes('AppTitleBar')), 'a stale caption must not keep matching');
    assert.ok((h.doc.getElementById('tree-viewport')?.textContent ?? '').includes('No elements match'));
});

test('reloading the same element refreshes its caption and open diagnostics', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    await h.sendAndFlush({ type: 'selectHandle', handle: '234881525' } as ExtensionToWebviewMessage);
    h.send({ type: 'properties', properties: LIVE_PROPS } as ExtensionToWebviewMessage);
    h.expandAllProps();
    h.posted.length = 0;

    h.send({ type: 'properties', properties: LIVE_PROPS } as ExtensionToWebviewMessage);

    assert.ok(h.posted.some(m => m.type === 'requestPreviews'
        && JSON.stringify(m.handles) === JSON.stringify(['234881525'])), 'the caption may show the new value');
    assert.ok(!h.posted.some(m => m.type === 'resolveResource' && m.name === 'Opacity'), 'a literal value is never resolved as a resource');

    h.posted.length = 0;
    h.send({ type: 'properties', properties: AUTHORED_PROPS } as ExtensionToWebviewMessage);
    assert.ok(!h.posted.some(m => m.type === 'requestPreviews'), 'a new element is not a reload');
});

test('high contrast mode keeps state visible without colour', () => {
    const h = loadPanel();
    const css = Array.from(h.doc.querySelectorAll('style')).map(style => style.textContent).join('\n');
    assert.match(css, /@media \(forced-colors: active\)/);
});

test('hovering a tree row only asks for a highlight', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.posted.length = 0;
    h.doc.querySelector('[data-handle="117441013"]')
        ?.dispatchEvent(new h.dom.window.MouseEvent('mouseover', { bubbles: true }));
    assert.deepEqual(h.posted, [{ type: 'hoverNode', handle: '117441013' }]);
});

test('a pick result turns the pick button off', async () => {
    const h = loadPanel();
    const pick = h.doc.getElementById('btn-pick') as HTMLElement;
    h.send({ type: 'pickStateChanged', armed: true });
    assert.equal(pick.getAttribute('aria-pressed'), 'true');
    h.send({ type: 'pickStateChanged', armed: false });
    assert.equal(pick.getAttribute('aria-pressed'), 'false');
});

test('expanding a bound property asks the host to diagnose the binding', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({
        type: 'properties',
        properties: {
            ...LIVE_PROPS,
            props: [{
                name: 'Text',
                value: 'hello',
                valueType: 'System.String',
                editKind: 'text',
                writeType: 'String',
                binding: '{x:Bind ViewModel.Title}',
            }],
        },
    } as ExtensionToWebviewMessage);
    h.posted.length = 0;
    h.expandAllProps();

    const diagnose = h.posted.find((m) => m.type === 'diagnoseBinding');
    assert.ok(diagnose, `expected diagnoseBinding, got ${JSON.stringify(h.posted)}`);
    assert.strictEqual(diagnose?.name, 'Text');

    h.send({
        type: 'binding',
        name: 'Text',
        binding: { status: 'broken', ok: false, source: 'MainViewModel', path: 'Title', mode: 'OneWay' },
    } as ExtensionToWebviewMessage);

    const text = h.doc.getElementById('props-viewport')?.textContent ?? '';
    assert.ok(text.includes('BINDING'), 'expected the BINDING block');
    assert.ok(text.includes('MainViewModel'), 'expected the binding source');
    assert.ok(h.doc.querySelector('#props-viewport .pbind-bad'), 'a failing binding should read as failing');
});

test('an unavailable binding agent is explained rather than left blank', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({
        type: 'properties',
        properties: {
            ...LIVE_PROPS,
            props: [{
                name: 'Text',
                value: 'hello',
                valueType: 'System.String',
                editKind: 'text',
                binding: '{Binding Title}',
            }],
        },
    } as ExtensionToWebviewMessage);
    h.expandAllProps();
    h.send({
        type: 'binding',
        name: 'Text',
        binding: { unavailable: true, message: 'Binding diagnosis needs a managed (.NET) app.' },
    } as ExtensionToWebviewMessage);

    assert.ok(
        (h.doc.getElementById('props-viewport')?.textContent ?? '').includes('managed (.NET) app'),
        'the reason should be shown, not an empty block',
    );
});

test('the window switcher only appears once there is a choice to make', async () => {
    const h = loadPanel();
    const surface = h.doc.getElementById('surface') as HTMLElement;

    h.send({ type: 'surfaces', surfaces: [{ id: 'main', title: 'MainWindow', active: true }] });
    assert.ok(surface.className.includes('hidden'), 'one window needs no switcher');

    h.send({
        type: 'surfaces',
        surfaces: [
            { id: 'main', title: 'MainWindow', active: true },
            { id: 'dialog', title: 'Settings' },
        ],
    });
    assert.ok(!surface.className.includes('hidden'), 'two windows should offer a switcher');
    assert.strictEqual(surface.querySelectorAll('.custom-dropdown-item').length, 2);
});

test('focus tracking is off until asked for, then follows the app', async () => {
    const h = loadPanel();
    h.posted.length = 0;

    h.send({ type: 'focusChanged', handle: '117441013', label: 'Button' });
    assert.ok(
        h.doc.getElementById('focus-notice')?.className.includes('hidden'),
        'focus should not be announced while tracking is off',
    );

    h.doc.getElementById('btn-focus')?.dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));
    const toggle = h.posted.find((m) => m.type === 'toggleFocusTracking');
    assert.strictEqual(toggle?.armed, true);

    h.send({ type: 'focusChanged', handle: '117441013', label: 'Button' });
    assert.ok(
        (h.doc.getElementById('focus-notice')?.textContent ?? '').includes('Button'),
        'focus should be announced once tracking is on',
    );
});

test('disconnect status is surfaced to the user', async () => {
    const h = loadPanel();    h.send({
        type: 'status',
        status: { state: 'disconnected', message: 'The app disconnected.' },
    } as ExtensionToWebviewMessage);

    const status = h.doc.getElementById('status');
    assert.ok(!status?.classList.contains('hidden'), 'status banner should be visible');
    assert.ok((status?.textContent ?? '').includes('disconnected'));
});

// ───────────────────────── failure-path UX ─────────────────────────
//
// Every one of these is a state a user reaches on a bad setup — an engine that
// never came up, an app that exited mid-session, an edit the engine refused.
// The panel's only way to explain itself is the status banner and the compose
// error, so what those say, and how loudly, is the whole user experience of a
// failure.

test('a connect failure is reported as an error, not a passing remark', async () => {
    const h = loadPanel();

    h.send({
        type: 'status',
        status: { state: 'error', message: 'Could not connect to the DevTools engine.' },
    } as ExtensionToWebviewMessage);

    const status = h.doc.getElementById('status');
    assert.ok(!status?.classList.contains('hidden'), 'status banner should be visible');
    assert.ok((status?.textContent ?? '').includes('Could not connect'));
    assert.ok(
        status?.classList.contains('error'),
        `a failed connect should read as an error, got class "${status?.className}"`,
    );
});

test('a disconnect reads as a warning rather than a fault', async () => {
    // An app that exited is usually the user closing their own window. Styling
    // that the same as a genuine engine failure trains people to ignore both.
    const h = loadPanel();

    h.send({
        type: 'status',
        status: { state: 'disconnected', message: 'The app disconnected.' },
    } as ExtensionToWebviewMessage);

    const status = h.doc.getElementById('status');
    assert.ok(
        status?.classList.contains('warn'),
        `a disconnect should read as a warning, got class "${status?.className}"`,
    );
    assert.ok(!status?.classList.contains('error'), 'a disconnect is not an engine fault');
});

test('a failure with no reason attached still explains itself', async () => {
    // DevToolsError carries a message, but a socket error or a rejected
    // promise from somewhere else may not. An empty banner is worse than a
    // generic one: it looks like the panel simply stopped.
    const h = loadPanel();

    h.send({ type: 'status', status: { state: 'error' } } as ExtensionToWebviewMessage);
    const afterError = h.doc.getElementById('status')?.textContent ?? '';
    assert.ok(afterError.trim().length > 0, 'an error with no message should still say something');

    h.send({ type: 'status', status: { state: 'disconnected' } } as ExtensionToWebviewMessage);
    const afterDisconnect = h.doc.getElementById('status')?.textContent ?? '';
    assert.ok(afterDisconnect.trim().length > 0, 'a disconnect with no message should still say something');
});

test('the panel says it is connecting rather than looking empty', async () => {
    // The engine creates its pipe a moment after the PID is known, and the
    // client retries for 20s. Without this the panel is a blank tree for what
    // looks like a hang.
    const h = loadPanel();

    h.send({ type: 'status', status: { state: 'connecting', processId: 4242 } } as ExtensionToWebviewMessage);

    const status = h.doc.getElementById('status');
    assert.ok(!status?.classList.contains('hidden'), 'status banner should be visible while connecting');
    assert.match(status?.textContent ?? '', /connect/i);
});

test('failure text from the engine is never interpreted as markup', async () => {
    // Engine error strings can carry a pipe path, an exception message, or
    // anything else the app put in a property name. They reach the banner
    // unmodified, so the banner has to be the thing that refuses to render it.
    const h = loadPanel();
    const hostile = '<img src=x onerror="globalThis.__pwned = true">';

    h.send({ type: 'status', status: { state: 'error', message: hostile } } as ExtensionToWebviewMessage);

    const status = h.doc.getElementById('status');
    assert.strictEqual(
        (h.dom.window as unknown as Record<string, unknown>).__pwned,
        undefined,
        'engine failure text must not execute',
    );
    assert.strictEqual(status?.querySelector('img'), null, 'engine failure text must not become elements');
    assert.ok((status?.textContent ?? '').includes('<img'), 'the raw text should still be shown');
});

test('a failure is announced to assistive technology', async () => {
    // The banner is the only indication the panel has stopped working, and a
    // screen-reader user never sees it change colour.
    const h = loadPanel();

    h.send({ type: 'status', status: { state: 'error', message: 'Engine gone.' } } as ExtensionToWebviewMessage);

    const status = h.doc.getElementById('status');
    assert.strictEqual(status?.getAttribute('role'), 'status');
    assert.strictEqual(status?.getAttribute('aria-live'), 'polite');
});

test('a refused comment with no reason still reports the failure', async () => {
    const h = loadPanel();

    h.send({ type: 'commentError' } as unknown as ExtensionToWebviewMessage);

    const composeError = h.doc.getElementById('compose-error');
    assert.ok(!composeError?.classList.contains('hidden'), 'the compose error should be visible');
    assert.ok((composeError?.textContent ?? '').trim().length > 0);
});

test('a later success clears a previous failure', async () => {
    // A banner that outlives the condition it describes is worse than none:
    // the user reconnects, the panel works, and it still says it is broken.
    const h = loadPanel();

    h.send({ type: 'status', status: { state: 'error', message: 'Engine gone.' } } as ExtensionToWebviewMessage);
    assert.ok(!h.doc.getElementById('status')?.classList.contains('hidden'));

    h.send({
        type: 'status',
        status: { state: 'connected', processId: 4242, protocolVersion: '1.0' },
    } as ExtensionToWebviewMessage);

    const status = h.doc.getElementById('status');
    assert.ok(!status?.classList.contains('error'), 'the error styling should be gone');
    assert.ok((status?.textContent ?? '').includes('4242'), 'the banner should describe the new connection');
});

test('filtering narrows the rendered rows', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    const before = h.rowTexts().length;

    const filter = h.doc.getElementById('filter') as HTMLInputElement;
    filter.value = 'TitleBar';
    filter.dispatchEvent(new h.dom.window.Event('input'));
    // The filter input is debounced before the tree is rebuilt.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await h.flush();

    const after = h.rowTexts();
    assert.ok(after.length < before, 'filter should reduce the row count');
    assert.ok(after.join(' | ').includes('TitleBar'));
});

test('a hash prefix searches names only, as the placeholder promises', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);

    const filter = h.doc.getElementById('filter') as HTMLInputElement;
    filter.value = '#Frame';
    filter.dispatchEvent(new h.dom.window.Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 250));
    await h.flush();

    const text = h.rowTexts().join(' | ');
    // RootFrame matches by name; the Frame *type* alone must not qualify, or
    // the hash would be decoration rather than a narrowing operator.
    assert.ok(text.includes('RootFrame'), 'expected the named match');
});

test('adding a comment requires a selected element to anchor it', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);

    h.doc.getElementById('tab-comments')?.dispatchEvent(new h.dom.window.Event('click', { bubbles: true }));
    h.send({ type: 'comments', comments: [] } as ExtensionToWebviewMessage);

    const add = h.doc.getElementById('compose-add') as HTMLButtonElement;
    const text = h.doc.getElementById('compose-text') as HTMLTextAreaElement;
    assert.ok(add.disabled, 'no selection means nothing to anchor a comment to');
    assert.ok(h.doc.getElementById('compose-target')?.textContent?.includes('Select an element'));

    h.send({ type: 'selectHandle', handle: '134218229' } as ExtensionToWebviewMessage);
    h.send({ type: 'comments', comments: [] } as ExtensionToWebviewMessage);
    assert.ok(h.doc.getElementById('compose-target')?.textContent?.includes('AppTitleBar'));

    // Still disabled: an anchor without words is not a comment.
    assert.ok(add.disabled, 'empty text should keep the button disabled');

    text.value = '  this needs more padding  ';
    text.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
    assert.ok(!add.disabled);

    h.posted.length = 0;
    add.dispatchEvent(new h.dom.window.Event('click', { bubbles: true }));

    const posted = h.posted.find((m) => m.type === 'addComment') as { handle: string; text: string } | undefined;
    assert.ok(posted, 'expected an addComment message');
    assert.strictEqual(posted?.handle, '134218229');
    assert.strictEqual(posted?.text, 'this needs more padding');
    assert.ok(add.disabled, 'the button waits for the host so the note is not sent twice');
    assert.strictEqual(text.value, '  this needs more padding  ', 'the draft is kept until the add succeeds');

    h.send({ type: 'commentError', message: 'Element is stale' } as ExtensionToWebviewMessage);
    assert.strictEqual(text.value, '  this needs more padding  ', 'a failure must not lose what was typed');
    assert.ok(!add.disabled, 'and the user can try again');

    h.send({ type: 'commentAdded' } as ExtensionToWebviewMessage);
    assert.strictEqual(text.value, '', 'a confirmed add clears the box');
});

test('selecting an element enables the compose box without waiting for a comment list', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.doc.getElementById('tab-comments')?.dispatchEvent(new h.dom.window.Event('click', { bubbles: true }));

    // Deliberately no 'comments' message: renderComments used to be the only
    // caller of updateCompose, which left the box permanently disabled for
    // anyone who selected an element and went straight to composing.
    h.send({ type: 'selectHandle', handle: '134218229' } as ExtensionToWebviewMessage);

    const text = h.doc.getElementById('compose-text') as HTMLTextAreaElement;
    assert.ok(!text.disabled, 'the selection alone must arm the compose box');
    assert.ok(h.doc.getElementById('compose-target')?.textContent?.includes('AppTitleBar'));
});

test('a comment draft stays on the element it was started on', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.doc.getElementById('tab-comments')?.dispatchEvent(new h.dom.window.Event('click', { bubbles: true }));
    h.send({ type: 'selectHandle', handle: '134218229' } as ExtensionToWebviewMessage);
    const text = h.doc.getElementById('compose-text') as HTMLTextAreaElement;
    const add = h.doc.getElementById('compose-add') as HTMLButtonElement;
    const target = () => h.doc.getElementById('compose-target')?.textContent ?? '';
    text.value = 'title bar note';
    text.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));

    h.send({ type: 'selectHandle', handle: '150995445' } as ExtensionToWebviewMessage);
    assert.ok(target().includes('AppTitleBar') && target().includes('Draft started here'), target());
    h.posted.length = 0;
    add.dispatchEvent(new h.dom.window.Event('click', { bubbles: true }));
    const posted = h.posted.find((m) => m.type === 'addComment') as { handle: string } | undefined;
    assert.strictEqual(posted?.handle, '134218229', 'the draft is not reassigned to the new selection');

    const withoutTitleBar = JSON.parse(JSON.stringify(LIVE_TREE));
    withoutTitleBar.nodes[0].children.shift();
    await h.sendAndFlush({ type: 'tree', tree: withoutTitleBar } as ExtensionToWebviewMessage);
    h.send({ type: 'commentError', message: 'Element is stale' } as ExtensionToWebviewMessage);
    assert.ok(target().includes('is gone'), target());
    assert.ok(add.disabled, 'a draft for a removed element cannot be saved elsewhere');
    assert.strictEqual(text.value, 'title bar note', 'the draft is kept');

    text.value = '';
    text.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
    assert.ok(target().includes('RootFrame'), 'clearing the draft follows the selection again');
});

test('leaving the comments tab tells the host to stop polling', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);

    h.doc.getElementById('tab-comments')?.dispatchEvent(new h.dom.window.Event('click', { bubbles: true }));
    assert.ok(h.posted.some((m) => m.type === 'loadComments'), 'opening the tab should request the list');

    h.posted.length = 0;
    h.doc.getElementById('tab-tree')?.dispatchEvent(new h.dom.window.Event('click', { bubbles: true }));
    assert.ok(h.posted.some((m) => m.type === 'commentsHidden'), 'closing the tab should stop the poll');
});

test('tree-scoped toolbar controls collapse with the tree', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);

    const controls = h.doc.getElementById('tree-controls') as HTMLElement;
    assert.ok(!controls.className.includes('hidden'), 'the toolbar belongs to the tree view');

    // Matches the native window's SetCommentsView: pick, focus tracking, the
    // filter and Just my XAML all act on the tree, so none of them mean
    // anything once the tree is off screen.
    h.doc.getElementById('tab-comments')?.dispatchEvent(new h.dom.window.Event('click', { bubbles: true }));
    assert.ok(controls.className.includes('hidden'), 'comments view must not leave them acting on nothing');

    h.doc.getElementById('tab-tree')?.dispatchEvent(new h.dom.window.Event('click', { bubbles: true }));
    assert.ok(!controls.className.includes('hidden'), 'and they come back with the tree');
});

test('a failed comment add is shown rather than silently dropped', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.doc.getElementById('tab-comments')?.dispatchEvent(new h.dom.window.Event('click', { bubbles: true }));

    const error = h.doc.getElementById('compose-error') as HTMLElement;
    assert.ok(error.className.includes('hidden'), 'no error before anything fails');

    h.send({ type: 'commentError', message: 'comments add failed' } as ExtensionToWebviewMessage);
    assert.ok(!error.className.includes('hidden'), 'a failure must become visible');
    assert.ok((error.textContent ?? '').includes('comments add failed'));
    assert.strictEqual(error.getAttribute('role'), 'alert', 'the failure must reach a screen reader too');
});

test('the properties header names the element and how you reached it', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({ type: 'selectHandle', handle: '234881525' } as ExtensionToWebviewMessage);
    h.send({ type: 'properties', properties: LIVE_PROPS } as ExtensionToWebviewMessage);

    const badge = h.doc.querySelector('#props-header .props-badge') as HTMLElement;
    assert.ok(badge, 'expected the identity badge');
    assert.strictEqual(
        badge.querySelector('.props-type')?.textContent,
        'MainPage',
        'the type is short, not namespaced',
    );

    const crumbs = h.doc.querySelector('#props-header .props-crumb-trail') as HTMLElement;
    // Root to parent, excluding the element itself.
    assert.strictEqual(crumbs.textContent, 'Grid \u203A Frame #RootFrame');
    assert.strictEqual(
        h.doc.querySelector('#props-header .props-crumb-toggle'),
        null,
        'a short path needs no expand link',
    );
});

test('a named element shows its name beside the type', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({ type: 'selectHandle', handle: '134218229' } as ExtensionToWebviewMessage);
    h.send({ type: 'properties', properties: LIVE_PROPS } as ExtensionToWebviewMessage);

    const badge = h.doc.querySelector('#props-header .props-badge') as HTMLElement;
    assert.strictEqual(badge.querySelector('.props-type')?.textContent, 'TitleBar');
    assert.strictEqual(badge.querySelector('.props-name')?.textContent, '#AppTitleBar');
});

test('a deep ancestor path is elided until the user asks for all of it', async () => {
    const h = loadPanel();
    // Six ancestors, which is past the four-segment threshold.
    const deep = {
        nodes: [chain(['Window', 'Grid', 'Border', 'StackPanel', 'ScrollViewer', 'Grid', 'Button'])],
        authored: true,
    };
    await h.sendAndFlush({ type: 'tree', tree: deep } as unknown as ExtensionToWebviewMessage);
    h.send({ type: 'selectHandle', handle: 'h6' } as ExtensionToWebviewMessage);
    h.send({ type: 'properties', properties: { handle: 'h6', canEdit: false, props: [] } } as unknown as ExtensionToWebviewMessage);

    const trail = () => h.doc.querySelector('#props-header .props-crumb-trail')?.textContent;
    const toggle = () => h.doc.querySelector('#props-header .props-crumb-toggle') as HTMLElement;

    assert.strictEqual(trail(), 'Window \u203A \u2026 \u203A ScrollViewer \u203A Grid');
    assert.strictEqual(toggle().textContent, 'Show all 6 ancestors');

    toggle().dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));
    assert.strictEqual(trail(), 'Window \u203A Grid \u203A Border \u203A StackPanel \u203A ScrollViewer \u203A Grid');
    assert.strictEqual(toggle().textContent, 'Show less');
});

test('the layout box model appears only while the adorner is armed', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({ type: 'capabilities', canEdit: true, canPick: true, canHighlight: true } as ExtensionToWebviewMessage);
    h.send({ type: 'selectHandle', handle: '134218229' } as ExtensionToWebviewMessage);
    h.send({ type: 'properties', properties: LIVE_PROPS } as ExtensionToWebviewMessage);

    const layout = {
        handle: '134218229',
        desired: { w: 800, h: 48 },
        render: { w: 800, h: 48 },
        actual: { w: 796, h: 44 },
        offset: { x: 0, y: 0 },
        inParent: { x: 2, y: 2 },
        parent: { type: 'Microsoft.UI.Xaml.Controls.Grid', w: 800, h: 600, childIndex: 0, childCount: 2 },
        grid: { row: '0', column: '0' },
    };

    // Numbers must not leak in before the user asks for them, or the pane
    // grows a block nobody requested.
    h.send({ type: 'layout', layout } as unknown as ExtensionToWebviewMessage);
    assert.strictEqual(h.doc.querySelector('#props-pane .lay-box'), null);

    h.doc.getElementById('btn-layout')?.dispatchEvent(new h.dom.window.Event('click', { bubbles: true }));
    h.send({ type: 'layout', layout } as unknown as ExtensionToWebviewMessage);

    // The box model is pinned in the header so it survives scrolling the
    // property list, exactly as the native window keeps it in view.
    const box = h.doc.querySelector('#props-header .lay-box');
    assert.ok(box, 'expected the box model once the adorner is on');
    const shown = box?.textContent ?? '';
    assert.ok(shown.includes('796'), 'actual size should be shown');
    assert.ok(shown.includes('800'), 'desired size should be shown');
    assert.ok(shown.includes('Grid'), 'the parent type should be named, not namespaced');
    assert.ok(!shown.includes('Microsoft.UI.Xaml'), 'the parent type should be short');
    assert.ok(shown.includes('1 of 2'), 'child position should read as 1-based');

    // Turning the adorner off has to take the numbers with it. It used to
    // leave them stranded until the user happened to select something else.
    h.doc.getElementById('btn-layout')?.dispatchEvent(new h.dom.window.Event('click', { bubbles: true }));
    assert.strictEqual(
        h.doc.querySelector('#props-header .lay-box'),
        null,
        'disarming the adorner clears the box model',
    );
});

test('the box model names margin, padding and content like the in-app adorner', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({ type: 'selectHandle', handle: '134218229' } as ExtensionToWebviewMessage);
    h.send({
        type: 'properties',
        properties: {
            handle: '134218229',
            canEdit: true,
            props: [
                { name: 'Margin', value: '4,8,16,2', valueType: 'Microsoft.UI.Xaml.Thickness' },
                { name: 'Padding', value: '6', valueType: 'Microsoft.UI.Xaml.Thickness' },
            ],
        },
    } as unknown as ExtensionToWebviewMessage);

    h.doc.getElementById('btn-layout')?.dispatchEvent(new h.dom.window.Event('click', { bubbles: true }));
    h.send({
        type: 'layout',
        layout: {
            handle: '134218229',
            desired: { w: 120, h: 40 },
            render: { w: 100, h: 32 },
            actual: { w: 100, h: 32 },
            offset: { x: 0, y: 0 },
            inParent: { x: 0, y: 0 },
        },
    } as unknown as ExtensionToWebviewMessage);

    const box = h.doc.querySelector('#props-header .lay-box') as HTMLElement;
    assert.ok(box, 'expected the box model');
    const tags = Array.from(box.querySelectorAll('.lay-tag')).map((el) => el.textContent);
    assert.deepStrictEqual(tags, ['margin', 'padding'], 'rings are named like the adorner');

    // Thickness is left, top, right, bottom; the edges carry those numbers.
    const edge = (ring: string, side: string) =>
        box.querySelector('.lay-ring.' + ring + ' > .lay-edge.' + side)?.textContent;
    assert.strictEqual(edge('margin', 'left'), '4');
    assert.strictEqual(edge('margin', 'top'), '8');
    assert.strictEqual(edge('margin', 'right'), '16');
    assert.strictEqual(edge('margin', 'bottom'), '2');
    // A single number expands to all four sides.
    assert.strictEqual(edge('padding', 'top'), '6');
    assert.strictEqual(edge('padding', 'left'), '6');

    // Content is the border box minus padding, not the border box itself.
    assert.ok(
        (box.querySelector('.lay-core')?.textContent ?? '').includes('88'),
        'content width is 100 less 6 and 6',
    );
    assert.ok(
        (box.querySelector('.lay-core')?.textContent ?? '').includes('20'),
        'content height is 32 less 6 and 6',
    );
});

test('an x:Bind property is recognised from the engine authoredKind', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({ type: 'capabilities', canEdit: true, canPick: true, canHighlight: true } as ExtensionToWebviewMessage);
    h.send({ type: 'properties', properties: AUTHORED_PROPS } as unknown as ExtensionToWebviewMessage);
    h.expandAllProps();

    assert.ok(h.drop('Kind of value for Text'), 'expected a KIND dropdown');
    const options = h.dropOptions('Kind of value for Text');
    // Guessing from the value type would never surface this; only the
    // engine's authoredKind can.
    assert.ok(options.includes('xbind'), 'x:Bind must be offered for an x:Bind property');
    assert.strictEqual(
        h.dropValue('Kind of value for Text'), 'xbind',
        'and it must be the default, so the editor is read-only',
    );
});

test('the per-row source line went with the witness block', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({ type: 'capabilities', canEdit: true, canPick: true, canHighlight: true } as ExtensionToWebviewMessage);
    h.send({ type: 'properties', properties: AUTHORED_PROPS } as unknown as ExtensionToWebviewMessage);
    h.expandAllProps();

    const viewport = h.doc.getElementById('props-viewport')!.cloneNode(true) as HTMLElement;
    // The precedence chain cites each entry's declaration, as the native window does.
    viewport.querySelectorAll('.pchain').forEach(c => c.remove());
    const shown = viewport.textContent ?? '';
    // The one source link that remains is the element-level one in the header.
    assert.ok(!shown.includes('MainPage.xaml:18'), 'no per-row source line remains');
});

test('the default KIND names what the value is now, as the native window does', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    const text = { valueType: 'System.String', editKind: 'text', writeType: 'String' };
    h.send({
        type: 'properties',
        properties: {
            ...LIVE_PROPS,
            props: [
                { ...text, name: 'Text', value: 'a', valueSource: 'Binding', authoredKind: 'binding', binding: '{Binding Title}' },
                { ...text, name: 'Tag', value: 'b', valueSource: 'Local', authoredKind: 'themeResource', authoredKey: 'K' },
                { ...text, name: 'Name', value: 'c', valueSource: 'DevTools', authoredKind: 'binding', authoredKey: 'Title' },
            ],
        },
    } as unknown as ExtensionToWebviewMessage);
    h.expandAllProps();

    assert.strictEqual(h.dropValue('Kind of value for Text'), 'binding', 'a {Binding} is not plain text');
    assert.strictEqual(h.dropValue('Kind of value for Tag'), 'resource', 'a resource key is not plain text');
    assert.strictEqual(h.dropValue('Kind of value for Name'), 'text', 'a live edit replaced the binding');
});

test('once Restore binding lands, the panel stops showing the replaced edit', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    const bound = {
        name: 'Text', value: 'Hello', valueType: 'System.String', editKind: 'text',
        valueSource: 'Binding', authoredKind: 'binding', binding: '{Binding Title}',
    };
    const props = (p: object) => ({
        type: 'properties', properties: { ...LIVE_PROPS, props: [p] },
    } as unknown as ExtensionToWebviewMessage);
    h.send(props(bound));
    h.expandAllProps();
    h.pickDrop('Kind of value for Text', 'text');
    const input = h.doc.querySelector('#props-viewport input[aria-label="Text"]') as HTMLInputElement;
    input.value = 'literal';
    input.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    h.send(props({ ...bound, value: 'literal', valueSource: 'DevTools', binding: undefined }));
    assert.ok((h.doc.getElementById('props-viewport')?.textContent ?? '').includes('was Hello'));

    h.send(props(bound));

    const shown = h.doc.getElementById('props-viewport')?.textContent ?? '';
    assert.ok(!shown.includes('was Hello'), 'the edit is gone from the app');
    assert.ok(!shown.includes('Restore original'));
    assert.strictEqual(h.dropValue('Kind of value for Text'), 'binding', 'KIND follows the binding again');
});

test('once an x:Bind restore lands, the panel stops showing the replaced edit', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    const bound = {
        name: 'Text', value: 'Hello', valueType: 'System.String', editKind: 'text',
        valueSource: 'Local', authoredKind: 'xBind', authored: '{x:Bind ViewModel.Title}',
    };
    const props = (p: object) => ({
        type: 'properties', properties: { ...LIVE_PROPS, props: [p] },
    } as unknown as ExtensionToWebviewMessage);
    h.send(props(bound));
    h.expandAllProps();
    h.pickDrop('Kind of value for Text', 'text');
    const input = h.doc.querySelector('#props-viewport input[aria-label="Text"]') as HTMLInputElement;
    input.value = 'literal';
    input.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    h.send(props({ ...bound, value: 'literal', valueSource: 'DevTools' }));
    assert.ok((h.doc.getElementById('props-viewport')?.textContent ?? '').includes('was Hello'));

    h.send(props(bound));

    const shown = h.doc.getElementById('props-viewport')?.textContent ?? '';
    assert.ok(!shown.includes('was Hello'), 'compiled bindings report Local once restored');
    assert.ok(!shown.includes('Restore original'));
});

test('only a resource-authored value offers the resource kind, labelled with its key', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    const props = (p: object) => ({
        type: 'properties', properties: { ...LIVE_PROPS, props: [p] },
    } as unknown as ExtensionToWebviewMessage);
    const options = (label: string) => [...(h.drop(label)?.querySelectorAll('[data-value]') ?? [])]
        .map(o => (o as HTMLElement).dataset.value);

    h.send(props({ name: 'Padding', value: '16,16,16,16', valueType: 'Thickness', editKind: 'thickness', writeType: 'Thickness', valueSource: 'Local' }));
    h.posted.length = 0;
    h.expandAllProps();
    assert.ok(!options('Kind of value for Padding').includes('resource'), 'the RPC cannot assign a resource');
    assert.ok(!h.posted.some(m => m.type === 'resolveResource'), 'a literal is never resolved as a resource');

    h.send(props({ name: 'Foreground', value: '#FF0078D4', valueType: 'Brush', editKind: 'text', writeType: 'Brush', valueSource: 'Local', authoredKind: 'staticResource', authoredKey: 'BrandBrush' }));
    h.expandAllProps();
    assert.strictEqual(h.dropValue('Kind of value for Foreground'), 'resource');
    h.send({ type: 'resource', name: 'Foreground', resource: { key: 'Foreground', resolved: '2587815578744' } } as ExtensionToWebviewMessage);
    assert.ok((h.doc.querySelector('#props-viewport .pexpand')?.textContent ?? '').includes('currently BrandBrush = #FF0078D4'), 'a bare handle is not a value');
});

test('staging a literal over a binding or resource warns what it replaces', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    const props = (p: object) => ({
        type: 'properties', properties: { ...LIVE_PROPS, props: [p] },
    } as unknown as ExtensionToWebviewMessage);
    const staged = () => h.doc.querySelector('#props-viewport .pstaged')?.textContent ?? '';
    const brush = {
        name: 'Foreground', value: '#FF8A2BE2', valueType: 'Brush', editKind: 'color', writeType: 'SolidColorBrush',
        valueSource: 'Local', authoredKind: 'staticResource', authoredKey: 'BrandBrush', authored: '{StaticResource BrandBrush}',
    };

    h.send(props({ name: 'Text', value: 'Hi', valueType: 'System.String', editKind: 'text', valueSource: 'Binding', authoredKind: 'binding', binding: '{Binding Title}' }));
    h.expandAllProps();
    h.pickDrop('Kind of value for Text', 'text');
    assert.ok(staged().includes('replaces the binding'));

    h.send(props(brush));
    h.expandAllProps();
    h.pickDrop('Kind of value for Foreground', 'color');
    assert.ok(staged().includes('replaces {StaticResource BrandBrush}'));

    h.send(props({ ...brush, valueSource: 'DevTools' }));
    assert.ok((h.doc.querySelector('#props-viewport .pexpand')?.textContent ?? '').includes('cannot reconnect the resource'));
});

test('a brush edits as a whole colour while its sub-properties stay read-only', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({
        type: 'properties',
        properties: {
            ...LIVE_PROPS,
            props: [
                {
                    name: 'Foreground', value: '#FF8A2BE2', valueType: 'Microsoft.UI.Xaml.Media.SolidColorBrush',
                    editKind: 'color', writeType: 'SolidColorBrush', valueSource: 'Local',
                    children: [
                        { name: 'Color', value: 'BlueViolet', valueType: 'Windows.UI.Color', editKind: 'color' },
                        { name: 'Opacity', value: '1', valueType: 'Windows.Foundation.Double', editKind: 'number' },
                    ],
                },
                { name: 'Opacity', value: '1', valueType: 'Double', editKind: 'number', writeType: 'Double', valueSource: 'Default' },
            ],
        },
    } as unknown as ExtensionToWebviewMessage);
    h.expandAllProps();

    const keys = [...h.doc.querySelectorAll('#props-viewport .prow')].map(r => (r as HTMLElement).dataset.prop);
    assert.deepStrictEqual(keys, ['Foreground', 'Foreground.Color', 'Foreground.Opacity', 'Opacity']);
    assert.ok(h.drop('Kind of value for Foreground'), 'the brush itself is editable');
    const child = h.doc.querySelector('#props-viewport .prow[data-prop="Foreground.Color"]') as HTMLElement;
    assert.ok(!child.querySelector('input, .pdrop'), 'the engine cannot write a sub-property');
    assert.ok(h.drop('Kind of value for Opacity'), 'the element Opacity is unaffected by the child of the same name');
});

test('a rejected write leaves no EDITED marker, but an earlier applied edit stays', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    const local = { name: 'Text', value: 'Hello', valueType: 'System.String', editKind: 'text', writeType: 'String', valueSource: 'Local' };
    const props = (p: object) => ({
        type: 'properties', properties: { ...LIVE_PROPS, props: [p] },
    } as unknown as ExtensionToWebviewMessage);
    const write = (value: string) => {
        const input = h.doc.querySelector('#props-viewport input[aria-label="Text"]') as HTMLInputElement;
        input.value = value;
        input.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    };
    const shown = () => h.doc.getElementById('props-viewport')?.textContent ?? '';
    h.send(props(local));
    h.expandAllProps();
    write('bad');
    h.send({ type: 'setPropertyFailed', handle: LIVE_PROPS.handle, name: 'Text' } as ExtensionToWebviewMessage);
    assert.ok(!shown().includes('was Hello'), 'nothing changed in the app');

    write('good');
    h.send(props({ ...local, value: 'good', valueSource: 'DevTools' }));
    write('bad again');
    h.send({ type: 'setPropertyFailed', handle: LIVE_PROPS.handle, name: 'Text' } as ExtensionToWebviewMessage);
    assert.ok(shown().includes('was Hello'), 'the successful edit can still be restored');
});

test('a healthy binding offers no Restore binding, as there is nothing to restore', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({
        type: 'properties',
        properties: {
            ...LIVE_PROPS,
            props: [{
                name: 'Text', value: 'a', valueType: 'System.String', editKind: 'text',
                valueSource: 'Binding', authoredKind: 'binding', binding: '{Binding Title}',
            }],
        },
    } as unknown as ExtensionToWebviewMessage);
    h.expandAllProps();
    h.send({
        type: 'binding',
        name: 'Text',
        binding: { status: 'evaluated', ok: true, source: 'Vm', path: 'Title', mode: 'OneWay' },
    } as ExtensionToWebviewMessage);

    const shown = h.doc.getElementById('props-viewport')?.textContent ?? '';
    assert.ok(shown.includes('evaluated'), 'the diagnosis is shown');
    assert.ok(!shown.includes('Restore binding'), 'restore only follows a live edit');
    assert.ok(!h.doc.querySelector('#props-viewport .pbind-bad'), 'a working binding is not shown as failing');
});

test('a binding replaced by a live edit offers Restore binding without re-diagnosing', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({
        type: 'properties',
        properties: {
            ...LIVE_PROPS,
            props: [{
                name: 'Text', value: 'literal', valueType: 'System.String', editKind: 'text',
                valueSource: 'DevTools', authoredKind: 'binding', authoredKey: 'Title',
            }],
        },
    } as unknown as ExtensionToWebviewMessage);
    h.posted.length = 0;
    h.expandAllProps();

    // Diagnosing captures the binding; doing it now would save the literal instead.
    assert.ok(!h.posted.some((m) => m.type === 'diagnoseBinding'));
    const shown = h.doc.getElementById('props-viewport')?.textContent ?? '';
    assert.ok(shown.includes('replaced this binding'), 'the state is explained');
    assert.ok(!shown.includes('x:Bind'), 'a runtime binding restores on its own');

    const restore = Array.from(h.doc.querySelectorAll('#props-viewport button'))
        .find((b) => b.textContent === 'Restore binding') as HTMLElement | undefined;
    assert.ok(restore, 'expected Restore binding');
    restore.click();
    const sent = h.posted.find((m) => m.type === 'restoreBinding');
    assert.strictEqual(sent?.name, 'Text');
});

test('a resource-backed property shows its authored key read-only', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({ type: 'capabilities', canEdit: true, canPick: true, canHighlight: true } as ExtensionToWebviewMessage);
    h.send({ type: 'properties', properties: AUTHORED_PROPS } as unknown as ExtensionToWebviewMessage);
    h.expandAllProps();

    assert.strictEqual(h.dropValue('Kind of value for Background'), 'resource');

    const key = h.doc.querySelector('#props-viewport input[aria-label="Background resource key"]') as HTMLInputElement;
    assert.ok(key, 'expected the resource key field');
    assert.strictEqual(key.value, 'ProbeBrush', 'the authored key should be prefilled, not blank');
    assert.ok(key.readOnly, 'the RPC cannot assign resources, so the key is not editable');
    key.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.ok(!h.posted.some(m => m.type === 'setProperty'), 'no markup string is written');
});

test('a bound property shows its path and mode read-only and never writes markup', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({ type: 'capabilities', canEdit: true, canPick: true, canHighlight: true } as ExtensionToWebviewMessage);
    const text = {
        ...AUTHORED_PROPS.props[0], valueSource: 'Binding',
        authored: '{Binding Vm.Title, Mode=OneWay}', authoredKind: 'binding',
    };
    h.send({ type: 'properties', properties: { ...AUTHORED_PROPS, props: [text] } } as unknown as ExtensionToWebviewMessage);
    h.expandAllProps();
    h.posted.length = 0;

    assert.strictEqual(h.dropValue('Kind of value for Text'), 'binding');

    const path = h.doc.querySelector('#props-viewport input[aria-label="Text binding path"]') as HTMLInputElement;
    assert.strictEqual(path.value, 'Vm.Title', 'path comes from authoredKey');
    assert.ok(path.readOnly, 'the RPC cannot install a binding');
    const mode = h.doc.querySelector('#props-viewport [aria-label="Text binding mode"]');
    assert.strictEqual(mode?.textContent, 'OneWay', 'mode is parsed out of the authored markup');
    assert.ok(![...h.doc.querySelectorAll('#props-viewport button')].some(b => /Apply binding|Switch to/.test(b.textContent ?? '')));
    assert.ok(!h.posted.some(m => m.type === 'setProperty'));
});

test('a live binding without authoredKey takes its path from the markup', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    const text = {
        name: 'Text', value: 'Hello', valueType: 'System.String', editKind: 'text', valueSource: 'Binding',
        binding: '{Binding Title, Mode=OneWay}', authored: '{Binding Title, Mode=OneWay}',
    };
    h.send({ type: 'properties', properties: { ...LIVE_PROPS, props: [text] } } as unknown as ExtensionToWebviewMessage);
    h.expandAllProps();
    const path = h.doc.querySelector('#props-viewport input[aria-label="Text binding path"]') as HTMLInputElement;
    assert.strictEqual(path.value, 'Title');
});

test('an unbound property does not offer the binding kind', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({ type: 'properties', properties: LIVE_PROPS } as ExtensionToWebviewMessage);
    h.expandAllProps();
    const options = [...(h.drop('Kind of value for Opacity')?.querySelectorAll('[data-value]') ?? [])]
        .map(o => (o as HTMLElement).dataset.value);
    assert.ok(!options.includes('binding') && !options.includes('resource'), options.join(','));
});

/**
 * A deliberate mix of the four cases the native window's curation predicate
 * distinguishes: core, set-here, style-supplied, and plain defaults.
 */
const CURATION_PROPS = {
    handle: '234881525',
    canEdit: true,
    props: [
        { name: 'Width', value: '120', valueType: 'Windows.Foundation.Double', valueSource: 'Local', editKind: 'number', writeType: 'Double' },
        { name: 'Opacity', value: '0.5', valueType: 'Windows.Foundation.Double', valueSource: 'Default', editKind: 'number', writeType: 'Double' },
        { name: 'Grid.Row', value: '2', valueType: 'Windows.Foundation.Int32', valueSource: 'Local', editKind: 'number', writeType: 'Int32' },
        { name: 'CornerRadius', value: '0,0,0,0', valueType: 'Microsoft.UI.Xaml.CornerRadius', valueSource: 'Default', editKind: 'text', writeType: 'CornerRadius' },
        { name: 'IsTabStop', value: 'True', valueType: 'Windows.Foundation.Boolean', valueSource: 'Style', editKind: 'bool', writeType: 'Boolean' },
        { name: 'AutomationProperties.AccessibilityView', value: 'Content', valueType: 'Microsoft.UI.Xaml.Automation.Peers.AccessibilityView', valueSource: 'Default', editKind: 'enum', writeType: 'AccessibilityView', enumValues: ['Raw', 'Control', 'Content'] },
    ],
};

function curated(h: ReturnType<typeof loadPanel>): string[] {
    return Array.from(h.doc.querySelectorAll('#props-viewport [data-prop]'))
        .map((el) => el.getAttribute('data-prop') ?? '');
}

function groupTitles(h: ReturnType<typeof loadPanel>): string[] {
    return Array.from(h.doc.querySelectorAll('#props-viewport .pgroup'))
        .map((el) => (el.querySelector('span:nth-child(1)')?.textContent ?? '').trim());
}

test('the default view shows the curated subset, not every property', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({ type: 'properties', properties: CURATION_PROPS } as unknown as ExtensionToWebviewMessage);

    const shown = curated(h);
    // Core properties survive even on their default value, and anything set
    // locally survives even when it is not core.
    assert.ok(shown.includes('Width'), 'a locally set core property should show');
    assert.ok(shown.includes('Opacity'), 'a core property shows even at its default');
    assert.ok(shown.includes('Grid.Row'), 'a locally set non-core property should show');
    // A plain default that nobody is core or set is noise.
    assert.ok(!shown.includes('CornerRadius'), 'an untouched non-core default should be hidden');
    assert.ok(!shown.includes('IsTabStop'), 'a style-supplied non-core value should be hidden');
    assert.ok(
        !shown.includes('AutomationProperties.AccessibilityView'),
        'attached automation defaults are exactly the noise the user complained about',
    );
});

test('show all reveals the rest and offers the way back', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({ type: 'properties', properties: CURATION_PROPS } as unknown as ExtensionToWebviewMessage);

    const link = h.doc.querySelector('#props-viewport .plink') as HTMLElement;
    assert.strictEqual(link.textContent, 'Show all 6 properties');

    link.dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));
    const shown = curated(h);
    assert.ok(shown.includes('CornerRadius'), 'show-all must include the hidden defaults');
    assert.ok(shown.includes('IsTabStop'), 'show-all must include style-supplied values');
    assert.strictEqual(
        (h.doc.querySelector('#props-viewport .plink') as HTMLElement).textContent,
        'Show common properties only',
    );
});

test('automation noise is parked in its own group, not collapsed away', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({ type: 'properties', properties: CURATION_PROPS } as unknown as ExtensionToWebviewMessage);
    (h.doc.querySelector('#props-viewport .plink') as HTMLElement)
        .dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));

    const other = Array.from(h.doc.querySelectorAll('#props-viewport .pgroup'))
        .find((el) => (el.textContent ?? '').includes('Other')) as HTMLElement;
    assert.ok(other, 'expected an Other group');
    // Categories are labels now: no caret, no expanded state, nothing to click.
    assert.strictEqual(other.tagName, 'DIV', 'the heading is not a button');
    assert.strictEqual(other.getAttribute('aria-expanded'), null, 'headings do not toggle');
    assert.strictEqual(h.doc.querySelector('.pgroup-caret'), null, 'no category carets remain');
    assert.ok(
        curated(h).includes('AutomationProperties.AccessibilityView'),
        'every category renders its rows',
    );
});

test('rows are grouped by role, core first then alphabetical', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({ type: 'properties', properties: CURATION_PROPS } as unknown as ExtensionToWebviewMessage);

    assert.deepStrictEqual(groupTitles(h), ['Layout', 'Appearance']);
    // Width is core so it sorts ahead of Grid.Row despite the alphabet.
    assert.deepStrictEqual(curated(h), ['Width', 'Grid.Row', 'Opacity']);
});

test('the Set view lists only what the element or its style actually supplies', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({ type: 'properties', properties: CURATION_PROPS } as unknown as ExtensionToWebviewMessage);

    (h.doc.getElementById('pview-set') as HTMLElement)
        .dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));

    assert.deepStrictEqual(groupTitles(h), ['Authored on this element', 'From a style']);
    const shown = curated(h);
    assert.ok(shown.includes('Width') && shown.includes('Grid.Row'), 'locally set values are authored here');
    assert.ok(shown.includes('IsTabStop'), 'the style contribution is the point of this view');
    assert.ok(!shown.includes('Opacity'), 'an untouched default is not set anywhere');
    assert.ok(!shown.includes('CornerRadius'), 'an untouched default is not set anywhere');
});

test('the property filter matches the name and the value', async () => {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({ type: 'properties', properties: CURATION_PROPS } as unknown as ExtensionToWebviewMessage);

    const filter = h.doc.getElementById('prop-filter') as HTMLInputElement;
    filter.value = 'grid';
    filter.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 220));
    assert.deepStrictEqual(curated(h), ['Grid.Row'], 'filtering by name');

    // The filter also reaches values, so searching for a colour or a number
    // finds the property holding it without knowing its name.
    filter.value = '0.5';
    filter.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 220));
    assert.deepStrictEqual(curated(h), ['Opacity'], 'filtering by value');

    filter.value = 'nothingmatchesthis';
    filter.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 220));
    assert.ok(
        (h.doc.getElementById('props-viewport')?.textContent ?? '').includes('No property matches'),
        'an empty filter result needs an explanation, not a blank pane',
    );
});

/**
 * The colour swatch is still an `input[type="color"]`, but its popup is ours.
 *
 * On Windows the native popup is OS chrome: it ignores both the page's
 * `color-scheme` and the VS Code theme, so it renders light inside a dark
 * panel. The webview suppresses it and opens a themed popup instead, so these
 * guard that the suppression stays in place and that the replacement still
 * behaves like the control it stands in for.
 */
async function openColorPicker(): Promise<{ h: Harness; swatch: HTMLInputElement }> {
    const h = loadPanel();
    await h.sendAndFlush({ type: 'tree', tree: LIVE_TREE } as ExtensionToWebviewMessage);
    h.send({ type: 'capabilities', canEdit: true, canPick: true, canHighlight: true } as ExtensionToWebviewMessage);
    h.send({ type: 'properties', properties: AUTHORED_PROPS } as ExtensionToWebviewMessage);
    h.revealAllProps();
    h.expandAllProps();
    // The brush comes from a resource, so colour is a deliberate KIND choice.
    h.pickDrop('Kind of value for Background', 'color');
    const swatch = h.doc.querySelector('#props-viewport .pswatch') as HTMLInputElement;
    assert.ok(swatch, 'the colour property should render a swatch');

    const down = new h.dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    swatch.dispatchEvent(down);
    assert.ok(down.defaultPrevented, 'the native OS colour dialog must be suppressed');
    return { h, swatch };
}

test('the colour swatch opens the themed picker instead of the OS dialog', async () => {
    const { h } = await openColorPicker();
    const pop = h.doc.querySelector('.wcp-pop');
    assert.ok(pop, 'a themed popup should replace the suppressed native one');
    assert.ok(pop?.querySelector('.wcp-sv'), 'saturation/value area');
    assert.ok(pop?.querySelector('.wcp-hue'), 'hue slider');
    assert.ok(pop?.querySelector('.wcp-hex'), 'hex field');
    assert.strictEqual(
        pop?.querySelectorAll('.wcp-preset').length,
        10,
        'the OS dialog offered basic colours, so the replacement needs presets too',
    );
});

test('the picker seeds itself from the colour the property already has', async () => {
    const { h } = await openColorPicker();
    const hex = h.doc.querySelector('.wcp-hex') as HTMLInputElement;
    // AUTHORED_PROPS Background is #FF3FBF6F; the alpha is dropped for the picker.
    assert.strictEqual(hex.value.toLowerCase(), '#3fbf6f');
});

test('picking a colour previews live and commits once, on Done', async () => {
    const { h, swatch } = await openColorPicker();
    const edits = () => h.posted.filter((m) => m.type === 'setProperty');
    const before = edits().length;

    const preset = h.doc.querySelectorAll<HTMLElement>('.wcp-preset')[7];
    preset.click();

    assert.strictEqual(swatch.value.toLowerCase(), '#0078d4', 'the swatch follows the picker');
    const text = h.doc.querySelector('#props-viewport .pcolor .pfield') as HTMLInputElement;
    assert.strictEqual(
        text.value.toLowerCase(),
        '#0078d4',
        'the text field mirrors the swatch while picking, as it did natively',
    );
    assert.strictEqual(edits().length, before, 'dragging must not spam the engine with writes');

    (h.doc.querySelector('.wcp-done') as HTMLElement).click();

    assert.strictEqual(h.doc.querySelector('.wcp-pop'), null, 'Done closes the popup');
    const written = edits();
    assert.strictEqual(written.length, before + 1, 'exactly one write lands');
    assert.strictEqual(written[written.length - 1].name, 'Background');
    assert.strictEqual(String(written[written.length - 1].value).toLowerCase(), '#0078d4');
});

test('Escape restores the original colour and writes nothing', async () => {
    const { h, swatch } = await openColorPicker();
    const before = h.posted.filter((m) => m.type === 'setProperty').length;

    h.doc.querySelectorAll<HTMLElement>('.wcp-preset')[3].click();
    assert.notStrictEqual(swatch.value.toLowerCase(), '#3fbf6f', 'preview applied');

    h.doc.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', {
        key: 'Escape', bubbles: true, cancelable: true,
    }));

    assert.strictEqual(h.doc.querySelector('.wcp-pop'), null, 'Escape closes the popup');
    assert.strictEqual(
        swatch.value.toLowerCase(),
        '#3fbf6f',
        'cancelling has to undo the live preview, like the native dialog did',
    );
    assert.strictEqual(
        h.posted.filter((m) => m.type === 'setProperty').length,
        before,
        'a cancelled pick must not reach the engine',
    );
});

test('typing a hex into the picker drives the swatch', async () => {
    const { h, swatch } = await openColorPicker();
    const hex = h.doc.querySelector('.wcp-hex') as HTMLInputElement;
    hex.value = '#ff8c00';
    hex.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
    assert.strictEqual(swatch.value.toLowerCase(), '#ff8c00');

    // Partial input while the user is still typing must not throw or reset.
    hex.value = '#ff8';
    hex.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
    assert.strictEqual(swatch.value.toLowerCase(), '#ffff88');
});
