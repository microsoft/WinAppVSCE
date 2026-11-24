/**
 * Tests for the DevTools client against a real named pipe.
 *
 * The client is the half of the integration that has no UI, so it was the
 * largest untested surface in the feature. Nothing here is mocked at the
 * module level: a fake engine listens on the same pipe path the real engine
 * would, and the client connects to it over the real socket and framing. What
 * is exercised is therefore the actual transport, not a model of it.
 *
 * Each test uses a distinct process id so the pipe names cannot collide when
 * the runner executes files in parallel.
 */

import { test, type TestContext } from 'node:test';
import * as assert from 'assert';
import { DevToolsClient, DevToolsError } from '../devtools/devtools-client';
import { FakeDevToolsEngine, FAKE_TREE } from './helpers/fake-devtools-engine';

/** Keeps pipe names unique per test within this file. */
let nextPid = 900_000;
function pid(): number {
    return nextPid++;
}

/**
 * Starts an engine and a connected client, registering teardown so a failing
 * assertion cannot leave a pipe listening.
 */
async function connected(
    t: TestContext,
    options: Parameters<typeof FakeDevToolsEngine.start>[1] = {},
): Promise<{ engine: FakeDevToolsEngine; client: DevToolsClient }> {
    const processId = pid();
    const engine = await FakeDevToolsEngine.start(processId, options);
    const client = await DevToolsClient.connect(processId);
    t.after(async () => {
        client.dispose();
        await engine.stop();
    });
    return { engine, client };
}

/** Resolves with the first emission of an event, or rejects on timeout. */
function once(client: DevToolsClient, event: string, ms = 2_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
        (client as unknown as { once(e: string, l: (p: unknown) => void): void })
            .once(event, (payload: unknown) => {
                clearTimeout(timer);
                resolve(payload);
            });
    });
}

// ───────────────────────────── connecting ─────────────────────────────

test('connecting negotiates and exposes the capability manifest', async (t) => {
    const { client } = await connected(t);

    assert.strictEqual(client.info?.protocolVersion, '1.0');
    assert.strictEqual(client.ownerToken, 'fake-owner-token');
    assert.strictEqual(client.canMutate, true);
});

test('negotiation is the first thing sent on the wire', async (t) => {
    const { engine } = await connected(t);

    assert.strictEqual(engine.received[0].method, 'DevTools.negotiate');
});

test('a read-only engine reports that it will not accept mutations', async (t) => {
    const { client } = await connected(t, { readOnly: true });

    assert.strictEqual(client.canMutate, false);
    assert.strictEqual(client.info?.posture, 'read-only');
});

test('connecting retries until the engine appears', async (t) => {
    const processId = pid();

    // The engine is not listening yet. This is the real startup ordering: the
    // app's pid is known well before its DevTools pipe accepts connections.
    const connecting = DevToolsClient.connect(processId);

    const engine = await new Promise<FakeDevToolsEngine>((resolve) => {
        setTimeout(() => void FakeDevToolsEngine.start(processId).then(resolve), 600);
    });

    const client = await connecting;
    t.after(async () => {
        client.dispose();
        await engine.stop();
    });

    assert.strictEqual(client.ownerToken, 'fake-owner-token');
});

test('connecting gives up promptly when cancelled', async (t) => {
    void t;
    // No engine on this pipe, so the connect loop is mid-retry when it checks
    // the token. Without the check this would block for the full 20s timeout.
    await assert.rejects(
        () => DevToolsClient.connect(pid(), { isCancellationRequested: true }),
        /cancelled/i,
    );
});

test('a failed negotiation disposes the client rather than leaving it half-open', async (t) => {
    const processId = pid();
    const engine = await FakeDevToolsEngine.start(processId, {
        handlers: {
            'DevTools.negotiate': () => { throw new Error('engine is still warming up'); },
        },
    });
    t.after(async () => { await engine.stop(); });

    await assert.rejects(() => DevToolsClient.connect(processId), /warming up/);
});

// ───────────────────────────── requests ─────────────────────────────

test('a request resolves with the engine result', async (t) => {
    const { client } = await connected(t);

    const tree = await client.send('VisualTree.enumerate', { depth: 12 });

    assert.deepStrictEqual(tree, FAKE_TREE);
});

test('request parameters reach the engine intact', async (t) => {
    const { engine, client } = await connected(t);

    await client.send('Property.get', { handle: 'h-title', computed: true });

    const call = engine.received.find((r) => r.method === 'Property.get');
    assert.deepStrictEqual(call?.params, { handle: 'h-title', computed: true });
});

test('concurrent requests resolve to their own responses', async (t) => {
    // The engine answers in the reverse of the call order, so a client that
    // paired responses positionally instead of by id would swap these.
    const { client } = await connected(t, {
        handlers: {
            'Property.get': async (params) => {
                const handle = params.handle as string;
                if (handle === 'slow') {
                    await new Promise((r) => setTimeout(r, 250));
                }
                return { handle };
            },
        },
    });

    const [slow, fast] = await Promise.all([
        client.send<{ handle: string }>('Property.get', { handle: 'slow' }),
        client.send<{ handle: string }>('Property.get', { handle: 'fast' }),
    ]);

    assert.strictEqual(slow.handle, 'slow');
    assert.strictEqual(fast.handle, 'fast');
});

test('a protocol error rejects with its code and message', async (t) => {
    const { client } = await connected(t, {
        handlers: {
            'Property.get': () => { throw new Error('no such handle'); },
        },
    });

    await assert.rejects(
        () => client.send('Property.get', { handle: 'gone' }),
        (err: unknown) => {
            assert.ok(err instanceof DevToolsError);
            assert.match(err.message, /no such handle/);
            return true;
        },
    );
});

test('an unknown method rejects rather than hanging', async (t) => {
    const { client } = await connected(t);

    await assert.rejects(
        () => client.send('Nonexistent.method'),
        /Method not found/,
    );
});

// ───────────────────────────── trySend ─────────────────────────────

test('trySend returns undefined for a method the engine does not advertise', async (t) => {
    const { engine, client } = await connected(t, {
        methods: ['DevTools.negotiate', 'VisualTree.enumerate'],
    });

    const result = await client.trySend('Binding.diagnose', { handle: 'h-title' });

    assert.strictEqual(result, undefined);
    // The point of the capability check is to not spend a round trip at all.
    assert.ok(!engine.received.some((r) => r.method === 'Binding.diagnose'));
});

test('an unadvertised method is announced rather than failing invisibly', async (t) => {
    const { client } = await connected(t, {
        methods: ['DevTools.negotiate'],
    });

    const seen: string[] = [];
    client.on('protocolError', (method: string) => { seen.push(method); });

    await client.trySend('Overlay.highlight', {});

    assert.deepStrictEqual(seen, ['Overlay.highlight']);
});

test('trySend swallows an engine failure but still reports it', async (t) => {
    const { client } = await connected(t, {
        handlers: {
            'Overlay.highlight': () => { throw new Error('overlay is not attached'); },
        },
    });

    const errors: Error[] = [];
    client.on('protocolError', (_method: string, error: Error) => { errors.push(error); });

    const result = await client.trySend('Overlay.highlight', { handle: 'h-title' });

    assert.strictEqual(result, undefined, 'optional calls must stay non-fatal');
    assert.match(errors[0].message, /not attached/);
});

test('enableEventStreams turns on the advertised domains and skips the rest', async (t) => {
    const { engine, client } = await connected(t, {
        methods: ['DevTools.negotiate', 'VisualTree.enable', 'Property.enable'],
    });

    await client.enableEventStreams();

    const enables = engine.received.map((r) => r.method).filter((m) => m.endsWith('.enable'));
    assert.deepStrictEqual(enables, ['VisualTree.enable', 'Property.enable']);
});

test('releasing owned state identifies this connection as the owner', async (t) => {
    const { engine, client } = await connected(t);

    await client.releaseOwnedState();

    const call = engine.received.find((r) => r.method === 'DevTools.releaseOwnedState');
    assert.strictEqual(call?.params.owner, 'fake-owner-token');
});

// ───────────────────────────── push events ─────────────────────────────

test('an engine notification is re-emitted to listeners', async (t) => {
    const { engine, client } = await connected(t);

    const picked = once(client, 'Selection.picked');
    engine.emit('Selection.picked', { handle: 'h-title' });

    assert.deepStrictEqual(await picked, { handle: 'h-title' });
});

test('a notification outside the known set is ignored', async (t) => {
    const { engine, client } = await connected(t);

    let fired = false;
    (client as unknown as { on(e: string, l: () => void): void })
        .on('Imaginary.event', () => { fired = true; });

    engine.emit('Imaginary.event', {});
    // A notification the engine invented must not reach the panel; give it a
    // beat to arrive so this is not vacuously true.
    await new Promise((r) => setTimeout(r, 100));

    assert.strictEqual(fired, false);
});

test('a notification arriving mid-request does not disturb it', async (t) => {
    const { engine, client } = await connected(t, {
        handlers: {
            'VisualTree.enumerate': async () => {
                await new Promise((r) => setTimeout(r, 150));
                return FAKE_TREE;
            },
        },
    });

    const pending = client.send('VisualTree.enumerate', {});
    engine.emit('Property.changed', { handle: 'h-title' });

    assert.deepStrictEqual(await pending, FAKE_TREE);
});

// ───────────────────────────── connection loss ─────────────────────────────

test('losing the pipe rejects everything in flight', async (t) => {
    const { engine, client } = await connected(t, {
        handlers: {
            // Never answers, so the request is still pending when the app dies.
            'VisualTree.enumerate': () => undefined,
        },
    });

    const pending = client.send('VisualTree.enumerate', {});
    engine.killConnections();

    await assert.rejects(pending, /pipe closed/i);
});

test('losing the pipe announces that the connection is gone', async (t) => {
    const { engine, client } = await connected(t);

    const closed = once(client, 'closed');
    engine.killConnections();

    assert.ok(await closed instanceof Error);
});

test('a request after the connection dropped fails immediately', async (t) => {
    const { engine, client } = await connected(t);

    engine.killConnections();
    await once(client, 'closed');

    await assert.rejects(
        () => client.send('VisualTree.enumerate', {}),
        /connection is closed/i,
    );
});

test('malformed framing from the engine tears the connection down', async (t) => {
    const { engine, client } = await connected(t, {
        handlers: { 'VisualTree.enumerate': () => undefined },
    });

    const pending = client.send('VisualTree.enumerate', {});
    engine.writeRaw('this is not json\n');

    // The alternative — ignoring the garbage — would leave the request hanging
    // for the full request timeout with no explanation.
    await assert.rejects(pending);
});

test('disposing rejects pending requests and closes the connection', async (t) => {
    const { client } = await connected(t, {
        handlers: { 'VisualTree.enumerate': () => undefined },
    });

    const pending = client.send('VisualTree.enumerate', {});
    client.dispose();

    await assert.rejects(pending, /disposed/i);
    await assert.rejects(() => client.send('Property.get', {}), /closed/i);
});

test('disposing twice is harmless', async (t) => {
    const { client } = await connected(t);

    client.dispose();
    client.dispose();

    assert.ok(true, 'the second dispose must not throw');
});
