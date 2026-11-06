/**
 * Hosts the WinUI DevTools webview and bridges it to a running app's engine.
 *
 * One panel owns one {@link DevToolsClient}. The webview renders the visual
 * tree and property grid; every protocol call is made here so the owner token
 * and the pipe stay in the extension host.
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { DevToolsClient, DevToolsError } from './devtools-client';
import { getDevToolsWebviewContent } from './webview-content';
import {
    ExtensionToWebviewMessage,
    PropertiesPayload,
    SourceLocation,
    WebviewToExtensionMessage,
} from './devtools-types';
import {
    normalizeEnumerateResult,
    InspectorOpenRequestedEvent,
    PropertyGetResult,
    SelectionEvent,
    VisualNode,
    SourceResult,
    VisualTreeEnumerateResult,
} from './protocol';
import { copySourcePath, openSourceLocation, revealSourceLocation } from './source-navigation';
import { diagnoseBinding, resolveResource, restoreBinding } from './binding-handlers';
import { highlightTarget } from './overlay';
import { DevToolsCli } from './devtools-cli';
import { countNamedNodes, findTreeNode, replaceSubtree, subtreeRoot } from './tree-model';

/**
 * Depth requested from `VisualTree.enumerate`.
 *
 * The protocol returns the subtree in a single response, so an unbounded
 * request on a large app produces a very large payload. This depth covers
 * typical page structure; deeper levels load when a node is expanded.
 */
const DEFAULT_TREE_DEPTH = 12;

/** Coalescing window for `VisualTree.changed`, which can fire per-element. */
const TREE_REFRESH_DEBOUNCE_MS = 300;

/**
 * How often to re-read the comment list while the Comments tab is visible.
 * The protocol has no change event for comments, so this is the only way a
 * comment added from the overlay reaches the panel.
 */
const COMMENT_POLL_MS = 1500;

/** The engine only emits `Property.changed` for DevTools writes, so app-driven changes are polled. */
const PROPERTY_POLL_MS = 1000;

/** Engine error code for a handle that no longer resolves (token `not-found`). */
const ENGINE_NOT_FOUND = -32009;

/**
 * Shapes of the parity-domain results we consume. These mirror the bundled
 * schema's `$defs`; only the fields the panel renders are declared.
 */
interface CommentListResult {
    comments?: {
        id: string;
        text: string;
        status?: string;
        element?: string;
        handle?: string;
        file?: string;
        uri?: string;
        line?: number;
        placed?: boolean;
    }[];
}

interface VisualTreePreviewResult {
    previews?: {
        handle: string;
        preview: string;
        automationId?: string;
        file?: string;
        line?: number;
    }[];
}

/**
 * The engine's cap on one `VisualTree.getPreviews` call. Asking for more is a
 * protocol error rather than a truncated answer, so the panel chunks instead.
 */
const PREVIEW_BATCH = 256;

interface SurfaceListResult {
    surfaces?: { name: string; window?: string; active?: boolean }[];
}

export class DevToolsPanel {
    private static readonly viewType = 'winapp.devToolsPanel';

    /** Panels keyed by process id so a second launch reuses nothing stale. */
    private static readonly open = new Map<number, DevToolsPanel>();
    private static readonly commentPanels = new Map<string, DevToolsPanel>();

    private readonly disposables: vscode.Disposable[] = [];
    private client: DevToolsClient | undefined;
    private refreshTimer: NodeJS.Timeout | undefined;
    private authoredOnly = true;
    private fullTree = false;
    private selectedHandle: string | undefined;
    private focusTracking = false;
    private layoutOn = false;
    private disposed = false;
    private commentPoll: NodeJS.Timeout | undefined;
    private propertyPoll: NodeJS.Timeout | undefined;
    private propertyPollBusy = false;
    private lastPropsKey: string | undefined;
    private commentsVisible = false;
    private lastCommentsJson = '';
    private lastTree: VisualNode[] = [];
    private readonly cli: DevToolsCli;
    private connected = false;
    private connecting = false;
    private ended = false;
    private treeRevision = 0;
    private readonly expanding = new Set<string>();
    private refreshingComments = false;

    /** Shared across panels so protocol noise lands in one place. */
    private static output: vscode.OutputChannel | undefined;

    private log(message: string): void {
        if (!DevToolsPanel.output) {
            DevToolsPanel.output = vscode.window.createOutputChannel('WinUI DevTools');
        }
        DevToolsPanel.output.appendLine(`[${new Date().toISOString()}] pid ${this.processId}: ${message}`);
    }

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly processId: number | undefined,
        private readonly extensionUri: vscode.Uri,
        private readonly sourceRoot: string,
    ) {
        this.cli = new DevToolsCli(extensionUri.fsPath, message => this.log(message));
        this.panel.webview.html = getDevToolsWebviewContent(
            this.panel.webview,
            crypto.randomBytes(16).toString('hex'),
        );

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(
            (message: WebviewToExtensionMessage) => void this.handleMessage(message),
            null,
            this.disposables,
        );
    }

    /**
     * Opens (or focuses) the DevTools panel for a process and connects to it.
     *
     * Connection failures surface inside the panel rather than as a modal, so a
     * DevTools problem never blocks the debug session that triggered it.
     */
    static async show(
        processId: number,
        extensionUri: vscode.Uri,
        viewColumn: vscode.ViewColumn = vscode.ViewColumn.Active,
        sourceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? extensionUri.fsPath,
    ): Promise<DevToolsPanel> {
        const existing = DevToolsPanel.open.get(processId);
        if (existing && !existing.disposed && !existing.ended) {
            existing.panel.reveal(viewColumn, false);
            return existing;
        }
        existing?.dispose();
        // A relaunch gets a new PID; the previous run's disconnected panel is now just a stale tab.
        for (const stale of [...DevToolsPanel.open.values()]) {
            if (stale.ended && stale.sourceRoot.toLowerCase() === sourceRoot.toLowerCase()) { stale.dispose(); }
        }

        const panel = vscode.window.createWebviewPanel(
            DevToolsPanel.viewType,
            'WinUI DevTools',
            { viewColumn, preserveFocus: true },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'images')],
            },
        );

        const instance = new DevToolsPanel(panel, processId, extensionUri, sourceRoot);
        DevToolsPanel.open.set(processId, instance);
        return instance;
    }

    /** Closes the panel for a process, if one is open. */
    static closeFor(processId: number): void {
        DevToolsPanel.open.get(processId)?.dispose();
    }

    /** The panel's pick shortcut; a contributed keybinding so it never also opens VS Code UI. */
    static togglePickInActive(): void {
        for (const instance of DevToolsPanel.open.values()) {
            if (instance.panel.active) { instance.post({ type: 'togglePick' }); return; }
        }
    }

    static async showComments(extensionUri: vscode.Uri, sourceRoot: string): Promise<DevToolsPanel> {
        const key = sourceRoot.toLowerCase();
        const existing = DevToolsPanel.commentPanels.get(key);
        if (existing && !existing.disposed) {
            existing.panel.reveal(undefined, false);
            existing.post({ type: 'showComments' });
            await existing.refreshComments();
            return existing;
        }
        const panel = vscode.window.createWebviewPanel(
            DevToolsPanel.viewType, 'WinUI DevTools Comments',
            { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
        );
        const instance = new DevToolsPanel(panel, undefined, extensionUri, sourceRoot);
        DevToolsPanel.commentPanels.set(key, instance);
        return instance;
    }

    /** The app owns the pipe, but the workspace owns its saved comments. */
    static disconnectFor(processId: number): void {
        const instance = DevToolsPanel.open.get(processId);
        if (instance) { instance.disconnect(); }
    }

    static disposeAll(): void {
        for (const instance of [...DevToolsPanel.open.values(), ...DevToolsPanel.commentPanels.values()]) {
            instance.dispose();
        }
        DevToolsPanel.output?.dispose();
        DevToolsPanel.output = undefined;
    }

    private disconnect(): void {
        this.ended = true;
        this.connected = false;
        this.treeRevision++;
        this.client?.dispose();
        this.client = undefined;
        this.lastTree = [];
        this.selectedHandle = undefined;
        this.post({ type: 'status', status: { state: 'disconnected', message: 'App disconnected. Saved comments remain available.' } });
        if (this.commentsVisible) {
            void this.refreshComments().catch(error => this.reportError(error));
        }
    }

    private reportError(error: unknown): void {
        const message = error instanceof Error ? error.message : String(error);
        this.log(message);
        this.post({ type: 'status', status: { state: 'error', message } });
    }

    // -----------------------------------------------------------------------

    /** Connects to the engine and performs the initial load. */
    private async connect(): Promise<void> {
        if (this.connecting || this.connected || this.disposed) { return; }
        if (this.processId === undefined || this.ended) {
            this.post({ type: 'status', status: { state: 'disconnected', message: 'Saved workspace comments - no running app required.' } });
            this.post({ type: 'showComments' });
            await this.refreshComments();
            return;
        }
        this.connecting = true;
        this.post({ type: 'status', status: { state: 'connecting', processId: this.processId } });

        try {
            this.client = await DevToolsClient.connect(this.processId);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.post({ type: 'status', status: { state: 'error', message } });
            return;
        } finally {
            this.connecting = false;
        }

        if (this.disposed || this.ended) {
            this.client.dispose();
            this.client = undefined;
            return;
        }

        const info = this.client.info;
        this.connected = true;
        this.post({
            type: 'status',
            status: {
                state: 'connected',
                processId: this.processId,
                protocolVersion: info?.protocolVersion,
                experimental: info?.experimental,
            },
        });

        this.post({
            type: 'capabilities',
            canEdit: this.client.canMutate && this.client.supports('HotReload.setProperty'),
            canPick: this.client.supports('Selection.arm'),
            canHighlight: this.client.supports('Overlay.highlight'),
        });

        this.registerEventHandlers(this.client);
        if (!this.client.supports('Inspector.registerExternal')) {
            this.reportError(new DevToolsError(
                'This winapp DevTools build cannot route the native inspector to Visual Studio Code.'
            ));
        } else {
            try {
                await this.client.registerExternalInspector('Visual Studio Code');
            } catch (error) {
                this.reportError(error);
            }
        }
        await this.client.enableEventStreams();
        this.startPropertyPoll();

        await this.refreshTree();
        await this.refreshSurfaces();
        await this.refreshComments();
    }

    private registerEventHandlers(client: DevToolsClient): void {
        client.on('protocolError', (method, error) => {
            // trySend keeps optional calls non-fatal, but a silent failure is
            // indistinguishable from a no-op bug, so every one is logged.
            this.log(`${method} failed: ${error.message}`);
        });

        client.on('VisualTree.changed', () => this.scheduleTreeRefresh());
        client.on('VisualTree.invalidated', (payload) => {
            const reason = (payload as { reason?: string })?.reason;
            this.post({ type: 'treeInvalidated', reason });
            this.scheduleTreeRefresh();
        });

        client.on('Selection.picked', (payload) => {
            const handle = (payload as SelectionEvent)?.handle;
            if (!handle) { return; }
            this.post({ type: 'pickStateChanged', armed: false });
            // The engine echoes the panel's own selection; revealing it would steal keyboard focus.
            if (handle === this.selectedHandle) { return; }
            void this.revealPickedElement(handle).catch(error => this.reportError(error));
        });

        client.on('Inspector.openRequested', (payload) => {
            const request = payload as InspectorOpenRequestedEvent;
            this.panel.reveal(this.panel.viewColumn, false);
            if (request.view === 'comments') {
                this.post({ type: 'showComments' });
                void this.refreshComments().catch(error => this.reportError(error));
            } else if (request.handle) {
                void this.revealPickedElement(request.handle).catch(error => this.reportError(error));
            } else {
                this.post({ type: 'showInspect' });
            }
        });

        client.on('Selection.armChanged', (payload) => {
            const armed = (payload as { armed?: boolean })?.armed === true;
            this.post({ type: 'pickStateChanged', armed });
        });

        client.on('Property.changed', (payload) => {
            const handle = (payload as { handle?: string })?.handle;
            // Only refresh the pane the user is actually looking at.
            if (handle && handle === this.selectedHandle) {
                void this.loadProperties(handle);
            }
        });

        client.on('Focus.changed', (payload) => {
            if (!this.focusTracking) { return; }
            const focus = payload as { handle?: string; type?: string; name?: string };
            if (!focus?.handle) { return; }
            this.selectedHandle = focus.handle;
            this.post({
                type: 'focusChanged',
                handle: focus.handle,
                label: focus.name || focus.type,
            });
            void this.loadProperties(focus.handle);
        });

        client.on('closed', (err?: Error) => {
            if (err) { this.log(err.message); }
            this.disconnect();
        });
    }

    private async revealPickedElement(handle: string, revealPanel = true): Promise<void> {
        this.selectedHandle = handle;
        if (revealPanel) { this.panel.reveal(this.panel.viewColumn, false); }
        if (!findTreeNode(this.lastTree, handle)) {
            const client = this.client;
            if (!client) { return; }
            const revision = this.treeRevision;
            const result = await client.send<VisualTreeEnumerateResult>('VisualTree.enumerate', {
                rootHandle: handle, authored: false, depth: DEFAULT_TREE_DEPTH,
            });
            if (revision !== this.treeRevision || this.selectedHandle !== handle) { return; }
            // A picked template part may be outside the authored tree. Keep it
            // as an explicit additional root instead of silently hiding it.
            if (!findTreeNode(this.lastTree, handle)) {
                this.lastTree.push(subtreeRoot(result, handle));
            }
            this.postTree();
        }
        if (this.selectedHandle !== handle) { return; }
        if (revealPanel) { this.post({ type: 'selectHandle', handle }); }
        await this.loadProperties(handle);
    }

    private postTree(): void {
        this.post({ type: 'tree', tree: { nodes: this.lastTree, authored: this.authoredOnly } });
    }

    private async expandNode(handle: string): Promise<void> {
        const client = this.client;
        const target = findTreeNode(this.lastTree, handle);
        const revision = this.treeRevision;
        const key = `${revision}:${handle}`;
        if (!client || !target || this.expanding.has(key)) { return; }
        this.expanding.add(key);
        try {
            const result = await client.send<VisualTreeEnumerateResult>('VisualTree.enumerate', {
                rootHandle: handle, authored: this.authoredOnly, depth: DEFAULT_TREE_DEPTH,
            });
            if (revision !== this.treeRevision) { return; }
            const replacement = subtreeRoot(result, handle);
            if ((replacement.childCount ?? 0) > 0 && !(replacement.children?.length)) {
                throw new Error('The engine returned no children for this expandable element.');
            }
            this.lastTree = replaceSubtree(this.lastTree, replacement);
            this.postTree();
        } finally {
            this.expanding.delete(key);
        }
    }

    /**
     * Adds a comment, returning an error message on failure or undefined on
     * success.
     *
     * `Comment.add` accepts either a handle or a name. Handles are only
     * meaningful for the enumeration that produced them, so a selection that
     * went stale between enumerate and add is retried by name before giving up.
     */
    private async addComment(
        client: DevToolsClient,
        handle: string,
        text: string,
    ): Promise<string | undefined> {
        if (!client.supports('Comment.add')) {
            return 'This app\u2019s DevTools engine does not support UI comments.';
        }

        try {
            await client.send('Comment.add', { handle, text });
            return undefined;
        } catch (err) {
            const first = err instanceof Error ? err.message : String(err);
            const name = this.nameForHandle(handle);
            if (!name) { return first; }
            // A name shared by several elements would anchor the comment to
            // whichever one the engine finds first, not the one selected.
            if (countNamedNodes(this.lastTree, name) !== 1) {
                return `${first} The element could not be found again by name because "${name}" is not unique. Select it and try again.`;
            }

            this.log(`Comment.add by handle ${handle} failed (${first}); retrying by name "${name}".`);
            try {
                await client.send('Comment.add', { name, text });
                return undefined;
            } catch (retryErr) {
                return retryErr instanceof Error ? retryErr.message : String(retryErr);
            }
        }
    }

    /** Looks up the x:Name for a handle in the tree we last sent the webview. */
    private nameForHandle(handle: string): string | undefined {
        return findTreeNode(this.lastTree, handle)?.name || undefined;
    }

    /**
     * The protocol has no `Comment.changed` event, so a comment added from the
     * overlay would never reach the panel. Polling only runs while the Comments
     * tab is actually on screen, and only re-posts when the list differs.
     */
    private startCommentPoll(): void {
        if (this.commentPoll) { return; }
        this.commentPoll = setInterval(() => {
            if (!this.commentsVisible || this.disposed || !this.panel.visible) { return; }
            void this.refreshComments(false).catch(error => this.reportError(error));
        }, COMMENT_POLL_MS);
    }

    private startPropertyPoll(): void {
        if (this.propertyPoll) { return; }
        this.propertyPoll = setInterval(() => {
            const handle = this.selectedHandle;
            if (!handle || this.propertyPollBusy || this.disposed || !this.connected || !this.panel.visible) { return; }
            this.propertyPollBusy = true;
            void this.loadProperties(handle, true).finally(() => { this.propertyPollBusy = false; });
        }, PROPERTY_POLL_MS);
    }

    private stopPropertyPoll(): void {
        if (!this.propertyPoll) { return; }
        clearInterval(this.propertyPoll);
        this.propertyPoll = undefined;
    }

    private stopCommentPoll(): void {
        if (!this.commentPoll) { return; }
        clearInterval(this.commentPoll);
        this.commentPoll = undefined;
    }

    /**
     * UI comments live in the repo, not in the app, so the list is pulled on
     * demand rather than mirrored; a second DevTools client may have changed it.
     */
    private async refreshComments(force = true): Promise<void> {
        const client = this.client;
        if (this.disposed || this.refreshingComments) { return; }
        this.refreshingComments = true;
        try {
            const comments = client && this.connected
                ? (await client.send<CommentListResult>('Comment.list', {})).comments?.map(row => ({
                    id: row.id,
                    text: row.text,
                    status: row.status,
                    element: row.element,
                    handle: row.handle,
                    file: row.file || row.uri,
                    line: row.line,
                    requiresConfirmation: row.placed === false,
                })) ?? []
                : await this.cli.comments(this.sourceRoot);
            // Ignore a live response that raced the disconnect. The next read
            // must come from disk and must not resurrect process-local handles.
            if (client && !this.connected) { return; }
            const json = JSON.stringify(comments);
            if (!force && json === this.lastCommentsJson) { return; }
            this.lastCommentsJson = json;
            this.post({ type: 'comments', comments });
        } finally {
            this.refreshingComments = false;
        }
    }

    /**
     * Fetches one-line captions for the rows the webview currently shows.
     *
     * `VisualTree.enumerate` carries no caption, so without this the tree reads
     * as a column of bare type names and you cannot tell two Buttons apart. The
     * webview asks only for what is on screen, because a caption costs a live
     * read of the element.
     */
    private async sendPreviews(handles: string[]): Promise<void> {
        const client = this.client;
        if (!client || this.disposed || handles.length === 0) { return; }
        if (!client.supports('VisualTree.getPreviews')) { return; }

        const previews: NonNullable<VisualTreePreviewResult['previews']> = [];
        for (let i = 0; i < handles.length; i += PREVIEW_BATCH) {
            const batch = handles.slice(i, i + PREVIEW_BATCH);
            const result = await client.trySend(
                'VisualTree.getPreviews',
                { handles: batch },
            ) as VisualTreePreviewResult | undefined;
            if (!result) { return; }
            previews.push(...(result.previews ?? []));
        }

        if (this.disposed) { return; }
        this.post({ type: 'previews', previews });
    }

    private async refreshSurfaces(): Promise<void> {
        const client = this.client;
        if (!client || this.disposed) { return; }

        const result = await client.trySend('Surface.list', {}) as SurfaceListResult | undefined;
        if (!result) { return; }
        this.post({
            type: 'surfaces',
            surfaces: (result.surfaces ?? []).map((entry) => ({
                id: entry.name,
                title: entry.window || entry.name,
                active: entry.active,
            })),
        });
    }

    /** Coalesces bursts of tree-change events into a single reload. */    private scheduleTreeRefresh(): void {
        if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            void this.refreshTree();
        }, TREE_REFRESH_DEBOUNCE_MS);
    }

    private async refreshTree(): Promise<void> {
        const client = this.client;
        if (!client || this.disposed) { return; }

        const revision = ++this.treeRevision;
        try {
            const result = await client.send<VisualTreeEnumerateResult>('VisualTree.enumerate', {
                authored: this.authoredOnly,
                // A filter can only find what was loaded, so filtering loads every level.
                depth: this.fullTree ? -1 : DEFAULT_TREE_DEPTH,
            });
            const nodes = normalizeEnumerateResult(result);
            if (revision !== this.treeRevision) { return; }
            this.lastTree = nodes;
            this.postTree();
            if (this.selectedHandle && !findTreeNode(nodes, this.selectedHandle)) {
                await this.revealPickedElement(this.selectedHandle, false);
            }
        } catch (err) {
            if (this.disposed) { return; }
            const message = err instanceof Error ? err.message : String(err);
            this.post({ type: 'status', status: { state: 'error', message } });
        }
    }

    /** An edit saved to an element the user has since left must not pull the panel back to it. */
    private async reloadIfSelected(handle: string): Promise<void> {
        if (this.selectedHandle !== handle) { return; }
        await this.loadProperties(handle);
    }

    private async loadProperties(handle: string, onlyIfChanged = false): Promise<void> {
        const client = this.client;
        if (!client || this.disposed) { return; }

        try {
            const result = await client.send<PropertyGetResult>('Property.get', { handle });
            if (this.selectedHandle !== handle || !this.connected) { return; }
            const key = handle + '\n' + JSON.stringify(result?.props ?? []);
            if (onlyIfChanged && key === this.lastPropsKey) { return; }
            this.lastPropsKey = key;
            const source = await this.resolveSource(handle);
            if (this.selectedHandle !== handle || !this.connected) { return; }

            const payload: PropertiesPayload = {
                handle,
                props: result?.props ?? [],
                source,
                canEdit: client.canMutate && client.supports('HotReload.setProperty'),
            };
            this.post({ type: 'properties', properties: payload });
        } catch (err) {
            if (this.disposed) { return; }
            if (this.selectedHandle !== handle || !this.connected) { return; }
            if (err instanceof DevToolsError && err.code === ENGINE_NOT_FOUND) {
                this.selectedHandle = undefined;
                this.lastPropsKey = undefined;
                this.post({ type: 'propertiesError', handle, message: 'This element is no longer in the app. Select another element.' });
                return;
            }
            const message = err instanceof Error ? err.message : String(err);
            this.post({ type: 'propertiesError', handle, message });
        }
    }

    /** Asks the engine where an element was declared, preferring authored coordinates. */
    private async resolveSource(handle: string): Promise<SourceLocation | undefined> {
        const client = this.client;
        if (!client) { return undefined; }

        const result = await client.trySend<SourceResult>('Source.get', { handle });
        if (!result) { return undefined; }

        const file = result.authoredFileName || result.fileName;
        if (!file) { return undefined; }

        const line = result.authoredFileName ? result.authoredLineNumber : result.lineNumber;
        const column = result.authoredFileName ? result.authoredColumnNumber : result.columnNumber;
        return { file, line, column };
    }

    // -----------------------------------------------------------------------

    private async handleMessage(message: WebviewToExtensionMessage): Promise<void> {
        try { await this.dispatchMessage(message); }
        catch (error) { this.reportError(error); }
    }

    private async dispatchMessage(message: WebviewToExtensionMessage): Promise<void> {
        const client = this.client;

        switch (message.type) {
            case 'ready':
                await this.connect();
                return;

            case 'refreshTree':
                this.authoredOnly = message.authored;
                await this.refreshTree();
                return;

            case 'selectNode':
                this.selectedHandle = message.handle;
                await this.loadProperties(message.handle);
                if (this.selectedHandle !== message.handle) { return; }
                if (this.layoutOn) {
                    const layout = await client?.trySend('Layout.get', { handle: message.handle });
                    if (layout) { this.post({ type: 'layout', layout: layout as never }); }
                }
                if (client?.supports('Overlay.highlight')) {
                    await client.trySend('Overlay.highlight', {
                        handle: message.handle,
                        owner: client.ownerToken,
                    });
                }
                if (client?.supports('Selection.select')) {
                    const result = await client.trySend<{ selected: boolean }>('Selection.select', {
                        handle: message.handle, owner: client.ownerToken,
                    });
                    if (!result?.selected) {
                        this.reportError(new Error('The app selection could not be synchronized. See the WinUI DevTools output for details.'));
                    }
                }
                return;

            case 'expandNode':
                await this.expandNode(message.handle);
                return;

            case 'loadFullTree':
                if (this.fullTree) { return; }
                this.fullTree = true;
                await this.refreshTree();
                return;

            case 'hoverNode':
                if (!client) { return; }
                await client.trySend('Overlay.highlight', {
                    handle: highlightTarget(message.handle, this.selectedHandle),
                    owner: client.ownerToken,
                });
                return;

            case 'togglePick':
                if (!client) { return; }
                await client.trySend(message.armed ? 'Selection.arm' : 'Selection.disarm', {
                    owner: client.ownerToken,
                });
                return;

            case 'toggleFocusTracking':
                this.focusTracking = message.armed;
                return;

            case 'toggleLayout':
                this.layoutOn = message.armed;
                if (!client) { return; }
                await client.trySend('Overlay.layout', {
                    set: message.armed ? 'on' : 'off',
                    owner: client.ownerToken,
                });
                if (message.armed && message.handle) {
                    const layout = await client.trySend('Layout.get', { handle: message.handle });
                    if (layout) { this.post({ type: 'layout', layout: layout as never }); }
                }
                return;

            case 'setSurface':
                if (!client) { return; }
                await client.trySend('Surface.setActive', {
                    name: message.surface,
                    owner: client.ownerToken,
                });
                await this.refreshSurfaces();
                await this.refreshTree();
                return;

            case 'requestPreviews':
                await this.sendPreviews(message.handles ?? []);
                return;

            case 'loadComments':
                this.commentsVisible = true;
                this.startCommentPoll();
                await this.refreshComments(true);
                return;

            case 'commentsHidden':
                this.commentsVisible = false;
                this.stopCommentPoll();
                return;

            case 'addComment': {
                if (!client) {
                    this.post({ type: 'commentError', message: 'Not connected to the app, so the comment cannot be anchored.' });
                    return;
                }
                const failure = await this.addComment(client, message.handle, message.text);
                if (failure) {
                    this.log(`Comment.add failed: ${failure}`);
                    this.post({ type: 'commentError', message: failure });
                } else {
                    this.post({ type: 'commentAdded' });
                }
                await this.refreshComments(true);
                return;
            }

            case 'resolveComment':
                try {
                    if (client && this.connected) {
                        await client.send('Comment.resolve', { id: message.id });
                    } else {
                        await this.cli.changeComment(this.sourceRoot, message.id, 'resolve');
                    }
                } catch (err) {
                    const text = err instanceof Error ? err.message : String(err);
                    this.log(`Comment.resolve failed: ${text}`);
                    this.post({ type: 'commentError', message: text });
                }
                await this.refreshComments(true);
                return;

            case 'deleteComment':
                try {
                    if (client && this.connected) {
                        await client.send('Comment.delete', { id: message.id });
                    } else {
                        await this.cli.changeComment(this.sourceRoot, message.id, 'delete');
                    }
                } catch (err) {
                    const text = err instanceof Error ? err.message : String(err);
                    this.log(`Comment.delete failed: ${text}`);
                    this.post({ type: 'commentError', message: text });
                }
                await this.refreshComments(true);
                return;

            case 'diagnoseBinding':
                if (!client) { return; }
                this.post(await diagnoseBinding(client, message.handle, message.name));
                return;

            case 'restoreBinding': {
                if (!client) { return; }
                const confirmation = await restoreBinding(
                    client, message.handle, message.name, message.confirm);
                if (confirmation && 'failed' in confirmation) {
                    void vscode.window.showWarningMessage(
                        `Could not restore the binding on ${message.name}: ${confirmation.failed}`);
                    return;
                }
                if (confirmation) {
                    this.post(confirmation);
                    return;
                }
                await this.reloadIfSelected(message.handle);
                return;
            }

            case 'resolveResource':
                if (!client) { return; }
                this.post(await resolveResource(client, message.handle, message.name));
                return;

            case 'goToSource':
                await openSourceLocation(message.file, message.line, message.column, this.sourceRoot, this.panel.viewColumn);
                return;

            case 'revealSource':
                await revealSourceLocation(message.file, this.sourceRoot);
                return;

            case 'copySourcePath':
                await copySourcePath(message.file, this.sourceRoot);
                return;

            case 'setProperty': {
                if (!client) { return; }
                // The engine names the property `prop`; its `name` parameter
                // selects an element by x:Name instead, and `type` is required.
                if (!message.writeType) {
                    void vscode.window.showWarningMessage(
                        `${message.name} does not report a writable type, so it cannot be edited.`
                    );
                    return;
                }
                try {
                    await client.send('HotReload.setProperty', {
                        handle: message.handle,
                        prop: message.name,
                        type: message.writeType,
                        value: message.value,
                    });
                } catch (err) {
                    const detail = err instanceof DevToolsError ? err.message : String(err);
                    void vscode.window.showWarningMessage(`Could not set ${message.name}: ${detail}`);
                    this.post({ type: 'setPropertyFailed', handle: message.handle, name: message.name });
                }
                await this.reloadIfSelected(message.handle);
                return;
            }

            case 'clearProperty':
                if (!client) { return; }
                await client.trySend('HotReload.clearProperty', {
                    handle: message.handle,
                    prop: message.name,
                });
                await this.reloadIfSelected(message.handle);
                return;
        }
    }

    private post(message: ExtensionToWebviewMessage): void {
        if (this.disposed) { return; }
        void this.panel.webview.postMessage(message);
    }

    dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true;
        if (this.processId !== undefined) { DevToolsPanel.open.delete(this.processId); }
        else { DevToolsPanel.commentPanels.delete(this.sourceRoot.toLowerCase()); }

        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = undefined;
        }

        this.stopCommentPoll();
        this.stopPropertyPoll();
        if (this.client) {
            const client = this.client;
            this.client = undefined;
            void client.unregisterExternalInspector()
                .finally(() => client.releaseOwnedState())
                .finally(() => client.dispose());
        }

        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables.length = 0;
        this.panel.dispose();
    }
}
