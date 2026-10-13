/**
 * JSON-RPC 2.0 client for the `winapp-devtools` engine.
 *
 * The engine publishes a named pipe per app process. Connecting directly from
 * the extension host (rather than shelling out to `winapp devtools call`) is
 * what makes a live panel possible: a persistent connection can receive the
 * protocol's push events, where one-shot CLI invocations can only poll.
 *
 * Everything state-changing is feature-detected against the capability manifest
 * returned by `DevTools.negotiate`, so an engine that drops or renames a method
 * degrades to a disabled button instead of an unhandled rejection.
 */

import * as net from 'net';
import { EventEmitter } from 'events';
import { NdjsonFramer, encodeNdjson } from './ndjson';
import {
    devToolsPipePath,
    NegotiateResult,
    DevToolsEventName,
    USED_EVENTS,
} from './protocol';

/** Milliseconds before an in-flight request is abandoned. */
const REQUEST_TIMEOUT_MS = 15_000;

/** How long to keep retrying the initial connect before giving up. */
const CONNECT_TIMEOUT_MS = 20_000;

/** Delay between connect attempts while the engine is still starting up. */
const CONNECT_RETRY_DELAY_MS = 250;

export class DevToolsError extends Error {
    constructor(
        message: string,
        readonly code?: number,
        readonly data?: unknown,
    ) {
        super(message);
        this.name = 'DevToolsError';
    }
}

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timer: NodeJS.Timeout;
    method: string;
}

interface JsonRpcResponse {
    jsonrpc?: string;
    id?: number | string | null;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
    method?: string;
    params?: unknown;
}

/**
 * A live connection to one app's DevTools engine.
 *
 * Emits protocol events by name (`VisualTree.changed`, `Selection.picked`, …)
 * plus a `'closed'` event when the pipe drops.
 */
export class DevToolsClient extends EventEmitter {
    private socket: net.Socket | undefined;
    private readonly framer = new NdjsonFramer();
    private readonly pending = new Map<number, PendingRequest>();
    private nextId = 1;
    private negotiated: NegotiateResult | undefined;
    private disposed = false;

    private constructor(readonly processId: number) {
        super();
    }

    /**
     * Opens a connection and negotiates capabilities.
     *
     * The pipe does not exist the instant the app's PID is known — the engine
     * creates it a moment later — so connection is retried until
     * {@link CONNECT_TIMEOUT_MS} elapses.
     */
    static async connect(processId: number, token?: { isCancellationRequested: boolean }): Promise<DevToolsClient> {
        const client = new DevToolsClient(processId);
        const pipePath = devToolsPipePath(processId);
        const deadline = Date.now() + CONNECT_TIMEOUT_MS;
        let lastError: Error | undefined;

        for (;;) {
            if (token?.isCancellationRequested) {
                throw new DevToolsError('Connecting to DevTools was cancelled.');
            }
            try {
                client.socket = await openPipe(pipePath);
                break;
            } catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
                if (Date.now() >= deadline) {
                    throw new DevToolsError(
                        `Could not connect to the DevTools engine on ${pipePath} after ${CONNECT_TIMEOUT_MS}ms. ` +
                        `Last error: ${lastError.message}`
                    );
                }
                await delay(CONNECT_RETRY_DELAY_MS);
            }
        }

        client.attachSocketHandlers();

        try {
            client.negotiated = await client.send<NegotiateResult>('DevTools.negotiate', {});
        } catch (err) {
            client.dispose();
            throw err;
        }

        return client;
    }

    /** The capability manifest from negotiation. Undefined until connected. */
    get info(): NegotiateResult | undefined {
        return this.negotiated;
    }

    /**
     * Owner token identifying this connection for UI and mutation calls.
     * Methods with `ui` or `mutation` access reject calls without it.
     */
    get ownerToken(): string {
        return this.negotiated?.ownerToken ?? '';
    }

    /** True when the engine advertised this method in its capability manifest. */
    supports(method: string): boolean {
        return this.negotiated?.methods.includes(method) ?? false;
    }

    /** True when the engine will accept state-changing calls on this connection. */
    get canMutate(): boolean {
        return this.negotiated?.mutation === true;
    }

    /**
     * Issues a request and resolves with its result.
     *
     * Rejects with {@link DevToolsError} on a protocol error, timeout, or if the
     * connection drops while the request is in flight.
     */
    send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        if (this.disposed || !this.socket || this.socket.destroyed) {
            return Promise.reject(new DevToolsError(`DevTools connection is closed (calling ${method}).`));
        }

        const id = this.nextId++;
        const payload = { jsonrpc: '2.0', id, method, params };

        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new DevToolsError(`DevTools request ${method} timed out after ${REQUEST_TIMEOUT_MS}ms.`));
            }, REQUEST_TIMEOUT_MS);

            this.pending.set(id, {
                resolve: resolve as (value: unknown) => void,
                reject,
                timer,
                method,
            });

            try {
                this.socket!.write(encodeNdjson(payload));
            } catch (err) {
                this.settle(id, undefined, err instanceof Error ? err : new Error(String(err)));
            }
        });
    }

    /**
     * Calls a method only if the engine advertises it, returning undefined
     * otherwise. Used for optional niceties so a trimmed-down engine does not
     * break the panel.
     */
    async trySend<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T | undefined> {
        if (!this.supports(method)) {
            this.emit('protocolError', method, new DevToolsError(`The engine does not advertise ${method}.`));
            return undefined;
        }
        try {
            return await this.send<T>(method, params);
        } catch (err) {
            // Swallowing the value keeps optional calls non-fatal, but the
            // failure is still announced so it cannot fail invisibly.
            this.emit('protocolError', method, err instanceof Error ? err : new Error(String(err)));
            return undefined;
        }
    }

    /**
     * Turns on the engine-side event streams the panel relies on.
     *
     * Each domain gates its own notifications behind an `enable` call; domains
     * the engine does not advertise are skipped silently.
     */
    async enableEventStreams(): Promise<void> {
        for (const method of ['VisualTree.enable', 'Property.enable', 'Selection.enable', 'Overlay.enable', 'Focus.enable']) {
            await this.trySend(method, {});
        }
    }

    /** Releases any overlay/selection state this connection owns. */
    async releaseOwnedState(): Promise<void> {
        await this.trySend('DevTools.releaseOwnedState', { owner: this.ownerToken });
    }

    override on<K extends DevToolsEventName>(event: K, listener: (payload: unknown) => void): this;
    override on(event: 'closed', listener: (reason?: Error) => void): this;
    override on(event: 'protocolError', listener: (method: string, error: Error) => void): this;
    override on(event: string, listener: (...args: never[]) => void): this {
        return super.on(event, listener as (...args: unknown[]) => void);
    }

    dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true;

        for (const [id] of this.pending) {
            this.settle(id, undefined, new DevToolsError('DevTools connection disposed.'));
        }
        this.pending.clear();

        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.destroy();
            this.socket = undefined;
        }
        this.removeAllListeners();
    }

    // -----------------------------------------------------------------------

    private attachSocketHandlers(): void {
        const socket = this.socket!;

        socket.on('data', (chunk: Buffer) => {
            let messages: unknown[];
            try {
                messages = this.framer.push(chunk);
            } catch (err) {
                this.failAll(err instanceof Error ? err : new Error(String(err)));
                return;
            }
            for (const message of messages) {
                this.dispatch(message as JsonRpcResponse);
            }
        });

        socket.on('error', (err) => this.failAll(err));
        socket.on('close', () => this.failAll(new DevToolsError('DevTools pipe closed.')));
    }

    /** Routes one decoded message to a pending request or an event listener. */
    private dispatch(message: JsonRpcResponse): void {
        // Notifications carry a method and no id — these are the push events.
        if (message.method && (message.id === undefined || message.id === null)) {
            if (USED_EVENTS.includes(message.method as DevToolsEventName)) {
                this.emit(message.method, message.params ?? {});
            }
            return;
        }

        if (typeof message.id !== 'number') { return; }

        if (message.error) {
            this.settle(
                message.id,
                undefined,
                new DevToolsError(message.error.message, message.error.code, message.error.data),
            );
            return;
        }

        this.settle(message.id, message.result, undefined);
    }

    private settle(id: number, result: unknown, error: Error | undefined): void {
        const entry = this.pending.get(id);
        if (!entry) { return; }
        this.pending.delete(id);
        clearTimeout(entry.timer);
        if (error) {
            entry.reject(error);
        } else {
            entry.resolve(result);
        }
    }

    /** Rejects every in-flight request and signals that the connection is gone. */
    private failAll(err: Error): void {
        if (this.disposed) { return; }

        const ids = [...this.pending.keys()];
        for (const id of ids) {
            this.settle(id, undefined, err);
        }

        if (this.socket && !this.socket.destroyed) {
            this.socket.destroy();
        }
        this.emit('closed', err);
    }
}

/** Resolves once the pipe accepts a connection, rejecting on the first failure. */
function openPipe(pipePath: string): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const socket = net.connect(pipePath);
        const onError = (err: Error) => {
            socket.removeAllListeners();
            socket.destroy();
            reject(err);
        };
        socket.once('error', onError);
        socket.once('connect', () => {
            socket.removeListener('error', onError);
            resolve(socket);
        });
    });
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
