/**
 * A fake DevTools engine, speaking the real protocol over a real named pipe.
 *
 * The contract between the extension and a running WinUI app is a named pipe
 * carrying NDJSON-framed JSON-RPC. That contract is reproducible without a
 * WinUI app, a debugger, or a desktop session, so this stands in for the
 * engine and lets the client be tested deterministically.
 *
 * Responses default to a small but realistic capability manifest and tree.
 * Individual tests override single methods, or register a handler that throws
 * or stalls, to drive the error and timeout paths.
 */

import * as net from 'net';
import { devToolsPipePath } from '../../devtools/protocol';
import { encodeNdjson, NdjsonFramer } from '../../devtools/ndjson';

/**
 * Answers one request. Throwing produces a JSON-RPC error; returning
 * `undefined` sends nothing at all, which drives the client's request timeout.
 */
export type MethodHandler = (params: Record<string, unknown>) => unknown | Promise<unknown>;

export interface FakeEngineOptions {
    /** Methods to advertise in negotiation. Defaults to everything handled. */
    methods?: string[];
    /** Engine-side overrides, merged over the defaults. */
    handlers?: Record<string, MethodHandler>;
    /** Advertise a read-only posture, which makes the panel hide its editors. */
    readOnly?: boolean;
}

/** The capability manifest a stock managed app reports, trimmed to what we drive. */
const DEFAULT_METHODS = [
    'DevTools.negotiate',
    'DevTools.releaseOwnedState',
    'VisualTree.enumerate',
    'VisualTree.enable',
    'Property.get',
    'Property.enable',
    'Selection.arm',
    'Selection.disarm',
    'Selection.enable',
    'Overlay.highlight',
    'Overlay.layout',
    'Overlay.enable',
    'Focus.enable',
    'Layout.get',
    'Source.get',
    'Binding.diagnose',
    'Binding.walk',
    'Binding.restore',
    'Resource.resolve',
    'Comment.list',
    'Comment.add',
    'Comment.resolve',
    'Comment.delete',
    'Surface.list',
    'Surface.setActive',
    'HotReload.setProperty',
];

/** A two-level tree: a Grid holding a TextBlock, which is enough to render rows. */
export const FAKE_TREE = {
    nodes: [
        {
            handle: 'h-root',
            type: 'Microsoft.UI.Xaml.Controls.Grid',
            name: 'RootGrid',
            childCount: 1,
            children: [
                {
                    handle: 'h-title',
                    type: 'Microsoft.UI.Xaml.Controls.TextBlock',
                    name: 'TitleText',
                    childCount: 0,
                    children: [],
                },
            ],
        },
    ],
};

export const FAKE_PROPERTIES = {
    handle: 'h-title',
    type: 'Microsoft.UI.Xaml.Controls.TextBlock',
    name: 'TitleText',
    properties: [
        {
            name: 'Text',
            value: 'Hello',
            type: 'System.String',
            editKind: 'text',
            authoredKind: 'literal',
            valueSource: 'Local',
        },
        {
            name: 'Margin',
            value: '4,8,16,2',
            type: 'Microsoft.UI.Xaml.Thickness',
            editKind: 'fields',
            authoredKind: 'literal',
            valueSource: 'Local',
        },
        {
            name: 'Opacity',
            value: '1',
            type: 'System.Double',
            editKind: 'number',
            authoredKind: 'literal',
            valueSource: 'Default',
        },
    ],
};

export class FakeDevToolsEngine {
    private readonly server: net.Server;
    private readonly sockets = new Set<net.Socket>();
    private readonly handlers: Record<string, MethodHandler>;

    /** Every request the engine received, in order. Lets tests assert on calls. */
    readonly received: { method: string; params: Record<string, unknown> }[] = [];

    private constructor(server: net.Server, options: FakeEngineOptions) {
        this.server = server;
        this.handlers = { ...FakeDevToolsEngine.defaultHandlers(options), ...(options.handlers ?? {}) };
    }

    /**
     * Starts an engine on the pipe path for a process id.
     *
     * The id need not belong to a real process — it only names the pipe — but
     * it should be unique per test so parallel runs cannot collide.
     */
    static async start(processId: number, options: FakeEngineOptions = {}): Promise<FakeDevToolsEngine> {
        const server = net.createServer();
        const engine = new FakeDevToolsEngine(server, options);

        server.on('connection', (socket) => engine.onConnection(socket));

        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(devToolsPipePath(processId), () => {
                server.removeListener('error', reject);
                resolve();
            });
        });

        return engine;
    }

    /** Pushes a notification to every connected client. */
    emit(method: string, params: Record<string, unknown> = {}): void {
        const frame = encodeNdjson({ jsonrpc: '2.0', method, params });
        for (const socket of this.sockets) {
            socket.write(frame);
        }
    }

    /** Writes a raw string, for tests that need to break the framing on purpose. */
    writeRaw(text: string): void {
        for (const socket of this.sockets) {
            socket.write(text);
        }
    }

    /** Drops the connection without a close frame, as a crashing app would. */
    killConnections(): void {
        for (const socket of [...this.sockets]) {
            socket.destroy();
        }
        this.sockets.clear();
    }

    async stop(): Promise<void> {
        this.killConnections();
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }

    // -----------------------------------------------------------------------

    private onConnection(socket: net.Socket): void {
        this.sockets.add(socket);
        const framer = new NdjsonFramer();

        socket.on('data', (chunk: Buffer) => {
            let messages: unknown[];
            try {
                messages = framer.push(chunk);
            } catch {
                socket.destroy();
                return;
            }
            for (const message of messages) {
                void this.handle(socket, message as { id?: number; method?: string; params?: Record<string, unknown> });
            }
        });

        socket.on('error', () => { /* the client half-closing is normal in teardown */ });
        socket.on('close', () => this.sockets.delete(socket));
    }

    private async handle(
        socket: net.Socket,
        message: { id?: number; method?: string; params?: Record<string, unknown> },
    ): Promise<void> {
        if (!message.method) { return; }
        this.received.push({ method: message.method, params: message.params ?? {} });

        const handler = this.handlers[message.method];
        if (!handler) {
            // Mirrors the engine: an unknown method is an error, not a silence.
            this.reply(socket, message.id, undefined, {
                code: -32601,
                message: `Method not found: ${message.method}`,
            });
            return;
        }

        try {
            const result = await handler(message.params ?? {});
            // A handler that returns nothing is stalling on purpose, to let a
            // test drive the client's request timeout.
            if (result === undefined) { return; }
            this.reply(socket, message.id, result);
        } catch (err) {
            this.reply(socket, message.id, undefined, {
                code: -32000,
                message: err instanceof Error ? err.message : String(err),
            });
        }
    }

    private reply(
        socket: net.Socket,
        id: number | undefined,
        result?: unknown,
        error?: { code: number; message: string },
    ): void {
        if (id === undefined || socket.destroyed) { return; }
        socket.write(encodeNdjson(error
            ? { jsonrpc: '2.0', id, error }
            : { jsonrpc: '2.0', id, result }));
    }

    /**
     * Note the ordering: the blanket acknowledgement for every advertised
     * method goes in first so the specific payloads below can override it.
     */
    private static defaultHandlers(options: FakeEngineOptions): Record<string, MethodHandler> {
        const methods = options.methods ?? DEFAULT_METHODS;
        return {
            ...Object.fromEntries(methods.map((m) => [m, () => ({ ok: true })])),

            'DevTools.negotiate': () => ({
                protocol: 'winapp-devtools',
                protocolVersion: '1.0',
                experimental: false,
                processId: 4242,
                mutation: !options.readOnly,
                posture: options.readOnly ? 'read-only' : 'full',
                connectionId: 'fake-connection',
                ownerToken: 'fake-owner-token',
                domains: ['DevTools', 'VisualTree', 'Property', 'Overlay'],
                methods,
                events: [
                    'VisualTree.changed',
                    'Selection.picked',
                    'Property.changed',
                    'Focus.changed',
                ],
                access: {},
            }),
            'VisualTree.enumerate': () => FAKE_TREE,
            'Property.get': () => FAKE_PROPERTIES,
            'Comment.list': () => ({ comments: [] }),
            'Surface.list': () => ({ surfaces: [{ name: 'MainWindow', active: true }] }),
            'Layout.get': () => ({
                desired: { width: 100, height: 20 },
                render: { width: 100, height: 20 },
                actual: { width: 100, height: 20 },
            }),
        };
    }
}
