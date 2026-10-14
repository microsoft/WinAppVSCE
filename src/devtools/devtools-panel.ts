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
    PropertyGetResult,
    SelectionEvent,
    VisualNode,
    SourceResult,
    VisualTreeEnumerateResult,
} from './protocol';
import { openSourceLocation } from './source-navigation';
import { diagnoseBinding, resolveResource, restoreBinding } from './binding-handlers';
import { highlightTarget } from './overlay';

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

    private readonly disposables: vscode.Disposable[] = [];
    private client: DevToolsClient | undefined;
    private refreshTimer: NodeJS.Timeout | undefined;
    private authoredOnly = true;
    private selectedHandle: string | undefined;
    private focusTracking = false;
    private layoutOn = false;
    private disposed = false;
    private commentPoll: NodeJS.Timeout | undefined;
    private commentsVisible = false;
    private lastCommentsJson = '';
    private lastTree: VisualNode[] = [];

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
        private readonly processId: number,
        private readonly extensionUri: vscode.Uri,
    ) {
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
    ): Promise<DevToolsPanel> {
        const existing = DevToolsPanel.open.get(processId);
        if (existing && !existing.disposed) {
            existing.panel.reveal(viewColumn, true);
            return existing;
        }

        const panel = vscode.window.createWebviewPanel(
            DevToolsPanel.viewType,
            'WinUI DevTools',
            { viewColumn, preserveFocus: true },
            {
                enableScripts: true,
                // The tree and the selected element's properties are rebuilt on
                // reconnect, so the view can be serialized rather than pinned
                // in memory while hidden.
                retainContextWhenHidden: false,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'images')],
            },
        );

        const instance = new DevToolsPanel(panel, processId, extensionUri);
        DevToolsPanel.open.set(processId, instance);
        return instance;
    }

    /** Closes the panel for a process, if one is open. */
    static closeFor(processId: number): void {
        DevToolsPanel.open.get(processId)?.dispose();
    }

    // -----------------------------------------------------------------------

    /** Connects to the engine and performs the initial load. */
    private async connect(): Promise<void> {
        this.post({ type: 'status', status: { state: 'connecting', processId: this.processId } });

        try {
            this.client = await DevToolsClient.connect(this.processId);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.post({ type: 'status', status: { state: 'error', message } });
            return;
        }

        if (this.disposed) {
            this.client.dispose();
            return;
        }

        const info = this.client.info;
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
        await this.client.enableEventStreams();

        // The separate native DevTools window would otherwise duplicate this
        // panel; close it once if the engine opened one at startup.
        //
        // We deliberately do NOT poll to keep it closed. Taking over the
        // overlay's "Open the DevTools Window" button that way let the window
        // become visible for up to a poll interval before we closed it, which
        // read as a flash. Honouring that button needs an engine-side signal
        // rather than a race; see the note in native window follow-up work.
        if (this.client.supports('Window.close')) {
            await this.client.trySend('Window.close', { owner: this.client.ownerToken });
        }

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
            this.selectedHandle = handle;
            this.post({ type: 'selectHandle', handle });
            this.post({ type: 'pickStateChanged', armed: false });
            void this.loadProperties(handle);
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
            this.post({
                type: 'status',
                status: {
                    state: 'disconnected',
                    message: err?.message ?? 'The app disconnected.',
                },
            });
        });
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
        const walk = (nodes: VisualNode[]): string | undefined => {
            for (const node of nodes) {
                if (node.handle === handle) { return node.name || undefined; }
                const hit = walk(node.children ?? []);
                if (hit) { return hit; }
            }
            return undefined;
        };
        return walk(this.lastTree);
    }

    /**
     * The protocol has no `Comment.changed` event, so a comment added from the
     * overlay would never reach the panel. Polling only runs while the Comments
     * tab is actually on screen, and only re-posts when the list differs.
     */
    private startCommentPoll(): void {
        if (this.commentPoll) { return; }
        this.commentPoll = setInterval(() => {
            if (!this.commentsVisible || this.disposed) { return; }
            void this.refreshComments(false);
        }, COMMENT_POLL_MS);
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
        if (!client || this.disposed) { return; }

        const result = await client.trySend('Comment.list', {}) as CommentListResult | undefined;
        const comments = (result?.comments ?? []).map((row) => ({
            id: row.id,
            text: row.text,
            status: row.status,
            element: row.element,
            handle: row.handle,
            // Carried so the panel can offer the declaration as a link. In the
            // native window this is read-only text; in an editor it can open.
            file: row.file || row.uri,
            line: row.line,
            // The engine reports placed:false when it could not re-find the
            // element, which is exactly when a human should confirm.
            requiresConfirmation: row.placed === false,
        }));

        const json = JSON.stringify(comments);
        if (!force && json === this.lastCommentsJson) { return; }
        this.lastCommentsJson = json;

        this.post({ type: 'comments', comments });
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

        try {
            const result = await client.send<VisualTreeEnumerateResult>('VisualTree.enumerate', {
                authored: this.authoredOnly,
                depth: DEFAULT_TREE_DEPTH,
            });
            const nodes = normalizeEnumerateResult(result);
            this.lastTree = nodes;
            this.post({ type: 'tree', tree: { nodes, authored: this.authoredOnly } });
        } catch (err) {
            if (this.disposed) { return; }
            const message = err instanceof Error ? err.message : String(err);
            this.post({ type: 'status', status: { state: 'error', message } });
        }
    }

    private async loadProperties(handle: string): Promise<void> {
        const client = this.client;
        if (!client || this.disposed) { return; }

        try {
            const result = await client.send<PropertyGetResult>('Property.get', { handle });
            const source = await this.resolveSource(handle);

            const payload: PropertiesPayload = {
                handle,
                props: result?.props ?? [],
                source,
                canEdit: client.canMutate && client.supports('HotReload.setProperty'),
            };
            this.post({ type: 'properties', properties: payload });
        } catch (err) {
            if (this.disposed) { return; }
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
                if (!client) { return; }
                const failure = await this.addComment(client, message.handle, message.text);
                if (failure) {
                    this.log(`Comment.add failed: ${failure}`);
                    this.post({ type: 'commentError', message: failure });
                }
                await this.refreshComments(true);
                return;
            }

            case 'resolveComment':
                if (!client) { return; }
                try {
                    await client.send('Comment.resolve', { id: message.id });
                } catch (err) {
                    const text = err instanceof Error ? err.message : String(err);
                    this.log(`Comment.resolve failed: ${text}`);
                    this.post({ type: 'commentError', message: text });
                }
                await this.refreshComments(true);
                return;

            case 'deleteComment':
                if (!client) { return; }
                try {
                    await client.send('Comment.delete', { id: message.id });
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
                if (confirmation) {
                    this.post(confirmation);
                    return;
                }
                await this.loadProperties(message.handle);
                return;
            }

            case 'resolveResource':
                if (!client) { return; }
                this.post(await resolveResource(client, message.handle, message.name));
                return;

            case 'goToSource':
                await openSourceLocation(message.file, message.line, message.column);
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
                }
                await this.loadProperties(message.handle);
                return;
            }

            case 'clearProperty':
                if (!client) { return; }
                await client.trySend('HotReload.clearProperty', {
                    handle: message.handle,
                    prop: message.name,
                });
                await this.loadProperties(message.handle);
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
        DevToolsPanel.open.delete(this.processId);

        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = undefined;
        }

        this.stopCommentPoll();
        if (this.client) {
            void this.client.releaseOwnedState().finally(() => this.client?.dispose());
        }

        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables.length = 0;
        this.panel.dispose();
    }
}
