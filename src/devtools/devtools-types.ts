/**
 * Message contract between the DevTools panel host and its webview.
 *
 * The webview never talks to the pipe directly — it posts intents here and the
 * extension host performs the protocol calls. That keeps the owner token and
 * the socket out of webview script, and means a compromised page cannot issue
 * arbitrary mutations.
 */

import { PropertyRow, VisualNode } from './protocol';

/** A visual tree node flattened for transfer, with children already resolved. */
export interface TreePayload {
    nodes: VisualNode[];
    /** True when the tree was filtered to app-authored elements. */
    authored: boolean;
    truncated?: boolean;
}

export interface SourceLocation {
    file: string;
    line?: number;
    column?: number;
}

export interface PropertiesPayload {
    handle: string;
    props: PropertyRow[];
    /** Resolved declaration site for the element itself, when known. */
    source?: SourceLocation;
    /** False when the engine refuses mutations, so editors render read-only. */
    canEdit: boolean;
}

export interface StatusPayload {
    state: 'connecting' | 'connected' | 'disconnected' | 'error';
    message?: string;
    processId?: number;
    protocolVersion?: string;
    experimental?: boolean;
}

/** A UI comment captured against a live element. */
export interface CommentPayload {
    id: string;
    text: string;
    /** open | resolved | stale | dismissed, mirroring the engine's lifecycle. */
    status?: string;
    element?: string;
    automationId?: string;
    window?: string;
    handle?: string;
    /** True when the engine matched the element weakly and wants a human check. */
    requiresConfirmation?: boolean;
}

/** One diagnosed binding, as reported by the managed binding agent. */
export interface BindingPayload {
    status?: string;
    ok?: boolean;
    source?: string;
    path?: string;
    mode?: string;
    value?: string;
    walk?: string[];
    /** True for Native AOT and C++ apps, where no managed agent can attach. */
    unavailable?: boolean;
    message?: string;
}

/** A top-level window or island the app is rendering. */
export interface SurfacePayload {
    id: string;
    title?: string;
    active?: boolean;
}

/** The box model behind the layout adorner. Mirrors LayoutResult in the engine schema. */
export interface LayoutSize { w?: number; h?: number }
export interface LayoutPoint { x?: number; y?: number }
export interface LayoutPayload {
    handle: string;
    desired?: LayoutSize;
    render?: LayoutSize;
    actual?: LayoutSize;
    offset?: LayoutPoint;
    inParent?: LayoutPoint;
    parent?: {
        type?: string;
        handle?: string;
        orientation?: string;
        spacing?: string;
        padding?: string;
        w?: number;
        h?: number;
        childIndex?: number;
        childCount?: number;
    };
    grid?: { row?: string; column?: string; rowSpan?: string; columnSpan?: string };
}

/** Messages the extension host sends to the webview. */
export type ExtensionToWebviewMessage =
    | { type: 'status'; status: StatusPayload }
    | { type: 'tree'; tree: TreePayload }
    | { type: 'properties'; properties: PropertiesPayload }
    | { type: 'propertiesError'; handle: string; message: string }
    | { type: 'selectHandle'; handle: string }
    | { type: 'pickStateChanged'; armed: boolean }
    | { type: 'treeInvalidated'; reason?: string }
    | { type: 'comments'; comments: CommentPayload[] }
    | { type: 'commentError'; message: string }
    | { type: 'binding'; name: string; binding: BindingPayload }
    | { type: 'bindingRestoreConfirm'; name: string; scope?: string }
    | { type: 'resource'; name: string; resource: { key: string; resolved?: string } }
    | { type: 'surfaces'; surfaces: SurfacePayload[] }
    | { type: 'layout'; layout: LayoutPayload }
    | { type: 'focusChanged'; handle?: string; label?: string }
    | { type: 'capabilities'; canEdit: boolean; canPick: boolean; canHighlight: boolean };

/** Messages the webview sends to the extension host. */
export type WebviewToExtensionMessage =
    | { type: 'ready' }
    | { type: 'refreshTree'; authored: boolean }
    | { type: 'selectNode'; handle: string }
    | { type: 'hoverNode'; handle: string | undefined }
    | { type: 'expandNode'; handle: string }
    | { type: 'togglePick'; armed: boolean }
    | { type: 'toggleFocusTracking'; armed: boolean }
    | { type: 'toggleLayout'; armed: boolean; handle?: string }
    | { type: 'setSurface'; surface: string }
    | { type: 'loadComments' }
    | { type: 'commentsHidden' }
    | { type: 'addComment'; handle: string; text: string }
    | { type: 'resolveComment'; id: string }
    | { type: 'deleteComment'; id: string }
    | { type: 'diagnoseBinding'; handle: string; name: string }
    | { type: 'restoreBinding'; handle: string; name: string; confirm?: boolean }
    | { type: 'resolveResource'; handle: string; name: string }
    | { type: 'goToSource'; file: string; line?: number; column?: number }
    | { type: 'setProperty'; handle: string; name: string; value: string; writeType?: string }
    | { type: 'clearProperty'; handle: string; name: string };
