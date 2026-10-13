/**
 * TypeScript mirror of the `winapp-devtools` protocol contract.
 *
 * The authoritative definition is `winapp-devtools-schema.json`, shipped by the
 * CLI next to `winapp.exe`. These types are hand-maintained against that file;
 * `npm run check-devtools-schema` diffs the bundled schema against the method
 * and event names declared here so an upstream rename fails the build instead
 * of surfacing as a runtime error in a user's panel.
 *
 * Only the subset of the surface the DevTools panel actually consumes is typed.
 * The protocol advertises its full capability manifest at runtime via
 * `DevTools.negotiate`, so callers must feature-detect rather than assume a
 * method exists (see `DevToolsClient.supports`).
 */

/** Pipe name the DevTools engine publishes for a given app process. */
export function devToolsPipePath(processId: number): string {
    return `\\\\.\\pipe\\winapp-devtools-${processId}`;
}

// ---------------------------------------------------------------------------
// Negotiation
// ---------------------------------------------------------------------------

/**
 * Result of `DevTools.negotiate`. This is the capability manifest: it lists the
 * domains, methods and events the *connected engine* actually supports, which
 * may be a subset or superset of what this file knows about.
 */
export interface NegotiateResult {
    protocol: string;
    protocolVersion: string;
    experimental: boolean;
    processId: number;
    /** False when the engine refuses state-changing calls (read-only posture). */
    mutation: boolean;
    posture: string;
    connectionId: string;
    /** Opaque token identifying this connection as the owner of UI/mutation state. */
    ownerToken: string;
    domains: string[];
    methods: string[];
    events: string[];
    access: Record<string, AccessLevel>;
}

export type AccessLevel = 'read' | 'ui' | 'mutation';

// ---------------------------------------------------------------------------
// Visual tree
// ---------------------------------------------------------------------------

export interface VisualNode {
    /** Opaque live handle. Only valid for the lifetime of the connection. */
    handle: string;
    name: string;
    type: string;
    /** Source file that declared the element, e.g. `ms-appx:///MainWindow.xaml`. */
    file?: string;
    id?: string;
    uniqueName?: boolean;
    childCount?: number;
    children?: VisualNode[];
}

export interface VisualTreeEnumerateParams {
    /** Restrict to app-authored elements, hiding control-template internals. */
    authored?: boolean;
    depth?: number | string;
    root?: string;
    rootHandle?: string;
    window?: string;
}

/**
 * `VisualTree.enumerate` is declared as a `oneOf`: the engine answers with a
 * bare array, or with an envelope carrying classification metadata, depending
 * on the call. Both shapes come from the same engine — this is the current
 * contract, not a concession to an older one.
 * {@link normalizeEnumerateResult} collapses both into a node array.
 */
export type VisualTreeEnumerateResult =
    | VisualNode[]
    | {
        nodes: VisualNode[];
        authored?: boolean;
        sourceInstrumented?: boolean;
        classificationTruncated?: boolean;
        classifiedNodes?: number;
        censusNodes?: number;
        authoredNodes?: number;
        classifier?: string;
    };

/** Collapses either shape of `VisualTree.enumerate` into a plain node array. */
export function normalizeEnumerateResult(result: VisualTreeEnumerateResult | undefined): VisualNode[] {
    if (!result) { return []; }
    if (Array.isArray(result)) { return result; }
    return Array.isArray(result.nodes) ? result.nodes : [];
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

/**
 * One entry in a property's value-precedence chain, analogous to a CSS cascade
 * entry. `winner` marks the source that produced the effective value, and
 * `file`/`line` point at the declaration when the engine could resolve it.
 */
export interface PropertyChainEntry {
    source: string;
    value: string;
    winner: boolean;
    targetType?: string;
    file?: string;
    line?: number;
}

/**
 * A single row in the property grid. `editKind` tells the client which editor
 * to render; `children` makes this a tree rather than a flat list.
 */
export interface PropertyRow {
    name: string;
    value: string;
    valueType: string;
    editKind: string;
    valueSource?: string;
    fields?: string[];
    writeType?: string;
    enumValues?: string[];
    valueState?: string;
    binding?: string;
    authored?: string;
    authoredKind?: string;
    authoredKey?: string;
    /** True when the engine withheld the value (e.g. passwords). */
    redacted?: boolean;
    chain?: PropertyChainEntry[];
    children?: PropertyRow[];
}

export interface PropertyGetResult {
    handle: string;
    props: PropertyRow[];
    authoredState?: string;
}

/** Params shared by the handle-scoped read methods. */
export interface HandleParams {
    handle: string;
    root?: string;
    window?: string;
}

export interface SetPropertyParams {
    handle: string;
    /** Property name. The engine accepts either `name` or `prop`. */
    name?: string;
    prop?: string;
    type?: string;
    value: string;
    root?: string;
    window?: string;
}

export interface ClearPropertyParams {
    handle: string;
    name?: string;
    prop?: string;
    root?: string;
    window?: string;
}

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

export interface SourceResult {
    handle: string;
    fileName?: string;
    lineNumber?: number;
    columnNumber?: number;
    authoredFileName?: string;
    authoredLineNumber?: number;
    authoredColumnNumber?: number;
    authoredState?: string;
    coordinateProvenance?: string;
    sourceEvidence?: string;
    xaml?: string;
}

// ---------------------------------------------------------------------------
// Overlay / selection — these carry the owner token
// ---------------------------------------------------------------------------

export interface OwnerParams {
    owner: string;
    root?: string;
    window?: string;
}

export interface OwnerHandleParams extends OwnerParams {
    handle: string;
}

export interface SelectionArmResult {
    armed: boolean;
    armOwner: string;
    revision: number;
}

export interface WindowStateResult {
    open: boolean;
    owner: string;
    revision: number;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface VisualTreeChangedEvent {
    added?: number;
    removed?: number;
    origin?: string;
}

export interface VisualTreeInvalidatedEvent {
    reason?: string;
    droppedEvents?: number;
    origin?: string;
}

export interface SelectionEvent {
    handle: string;
    generation?: number;
    origin?: string;
}

export interface PropertyChangedEvent {
    handle: string;
    name?: string;
    prop?: string;
    value?: string;
    origin?: string;
}

/** Event names this client subscribes to, keyed to their payload types. */
export interface DevToolsEventMap {
    'VisualTree.changed': VisualTreeChangedEvent;
    'VisualTree.invalidated': VisualTreeInvalidatedEvent;
    'Selection.picked': SelectionEvent;
    'Selection.armChanged': SelectionArmResult & { origin?: string };
    'Focus.changed': SelectionEvent;
    'Property.changed': PropertyChangedEvent;
    'Overlay.stateChanged': Record<string, unknown>;
}

export type DevToolsEventName = keyof DevToolsEventMap;

/**
 * Methods this client actually calls. Kept as a const array so the schema-drift
 * check can diff it against the bundled schema's capability manifest.
 *
 * This list must mirror the call sites exactly — `check-devtools-schema` fails
 * the build in both directions. An aspirational entry here with no call site
 * reads as an implemented feature when it is not.
 */
export const USED_METHODS = [
    'DevTools.negotiate',
    'DevTools.releaseOwnedState',
    'VisualTree.enumerate',
    'VisualTree.enable',
    'Property.get',
    'Property.enable',
    'Source.get',
    'Overlay.highlight',
    'Overlay.enable',
    'Selection.arm',
    'Selection.disarm',
    'Selection.enable',
    'Focus.enable',
    'HotReload.setProperty',
    'HotReload.clearProperty',
    'Comment.list',
    'Comment.add',
    'Comment.resolve',
    'Comment.delete',
    'Binding.diagnose',
    'Binding.walk',
    'Binding.restore',
    'Resource.resolve',
    'Layout.get',
    'Overlay.layout',
    'Surface.list',
    'Surface.setActive',
    'Window.close',
] as const;

/** Events this client subscribes to. Also diffed by the schema-drift check. */
export const USED_EVENTS: DevToolsEventName[] = [
    'VisualTree.changed',
    'VisualTree.invalidated',
    'Selection.picked',
    'Selection.armChanged',
    'Focus.changed',
    'Property.changed',
    'Overlay.stateChanged',
];
