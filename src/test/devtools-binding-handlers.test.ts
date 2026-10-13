/**
 * Tests for the binding and resource inspection handlers.
 *
 * These were extracted from the panel's message switch precisely because they
 * are pure translations of protocol results into webview messages, with no
 * panel state involved. A hand-rolled stub client is enough: what matters is
 * the reshaping, not the transport, which is covered in devtools-client.test.
 */

import { test } from 'node:test';
import * as assert from 'assert';
import { DevToolsClient } from '../devtools/devtools-client';
import { diagnoseBinding, resolveResource, restoreBinding } from '../devtools/binding-handlers';
import { BindingPayload, ExtensionToWebviewMessage } from '../devtools/devtools-types';

type Replies = Record<string, unknown>;

/** Narrows a handler result to the binding message it is expected to be. */
function bindingOf(message: ExtensionToWebviewMessage): BindingPayload {
    assert.strictEqual(message.type, 'binding');
    return (message as Extract<ExtensionToWebviewMessage, { type: 'binding' }>).binding;
}

/** Narrows a handler result to the resource message it is expected to be. */
function resourceOf(message: ExtensionToWebviewMessage): { key: string; resolved?: string } {
    assert.strictEqual(message.type, 'resource');
    return (message as Extract<ExtensionToWebviewMessage, { type: 'resource' }>).resource;
}

/** Records calls and answers from a canned map; absent keys answer undefined. */
function stubClient(replies: Replies) {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const client = {
        calls,
        trySend: async (method: string, params: Record<string, unknown>) => {
            calls.push({ method, params });
            return replies[method];
        },
    };
    return client as unknown as DevToolsClient & { calls: typeof calls };
}

// ───────────────────────────── diagnose ─────────────────────────────

test('a healthy binding is reported as ok with its path and mode', async () => {
    const client = stubClient({
        'Binding.diagnose': { state: 'ok', path: 'Vm.Title', source: 'ViewModel', mode: 'OneWay' },
        'Binding.walk': { segments: [{ path: 'Vm', value: 'MainViewModel' }, { path: 'Title', value: 'Hello' }] },
    });

    const message = await diagnoseBinding(client, 'h-title', 'Text');

    assert.strictEqual(message.type, 'binding');
    const binding = bindingOf(message);
    assert.strictEqual(binding.ok, true);
    assert.strictEqual(binding.path, 'Vm.Title');
    assert.strictEqual(binding.mode, 'OneWay');
});

test('the engine also counts "bound" as healthy, not just "ok"', async () => {
    const client = stubClient({ 'Binding.diagnose': { state: 'bound' } });

    const message = await diagnoseBinding(client, 'h-title', 'Text');

    assert.strictEqual(bindingOf(message).ok, true);
});

test('a broken binding is reported with its state and not marked ok', async () => {
    const client = stubClient({ 'Binding.diagnose': { state: 'path-error' } });

    const message = await diagnoseBinding(client, 'h-title', 'Text');

    const binding = bindingOf(message);
    assert.strictEqual(binding.ok, false);
    assert.strictEqual(binding.status, 'path-error');
});

test('an app with no managed agent says so instead of showing an empty panel', async () => {
    // Native AOT and C++ apps answer nothing at all here.
    const client = stubClient({});

    const message = await diagnoseBinding(client, 'h-title', 'Text');

    const binding = bindingOf(message);
    assert.strictEqual(binding.unavailable, true);
    assert.match(String(binding.message), /managed/i);
});

test('the path walk is not attempted when diagnosis found nothing', async () => {
    const client = stubClient({});

    await diagnoseBinding(client, 'h-title', 'Text');

    assert.ok(!client.calls.some((c) => c.method === 'Binding.walk'));
});

test('walk segments are flattened into readable path = value lines', async () => {
    const client = stubClient({
        'Binding.diagnose': { state: 'ok' },
        'Binding.walk': {
            segments: [
                { path: 'Vm', value: 'MainViewModel' },
                { path: 'Missing' },
            ],
        },
    });

    const message = await diagnoseBinding(client, 'h-title', 'Text');

    // A segment with no value is where the chain broke, so it must render as a
    // bare path rather than "Missing = undefined".
    assert.deepStrictEqual(
        bindingOf(message).walk,
        ['Vm = MainViewModel', 'Missing'],
    );
});

test('a diagnosis without a walk still produces an empty chain, not undefined', async () => {
    const client = stubClient({ 'Binding.diagnose': { state: 'ok' } });

    const message = await diagnoseBinding(client, 'h-title', 'Text');

    assert.deepStrictEqual(bindingOf(message).walk, []);
});

test('the resolved value wins over the target value when both are present', async () => {
    const client = stubClient({
        'Binding.diagnose': { state: 'ok', resolvedValue: 'from source', targetValue: 'on element' },
    });

    const message = await diagnoseBinding(client, 'h-title', 'Text');

    assert.strictEqual(bindingOf(message).value, 'from source');
});

test('the target value is used when the source could not be resolved', async () => {
    const client = stubClient({
        'Binding.diagnose': { state: 'path-error', targetValue: 'on element' },
    });

    const message = await diagnoseBinding(client, 'h-title', 'Text');

    assert.strictEqual(bindingOf(message).value, 'on element');
});

// ───────────────────────────── restore ─────────────────────────────

test('restoring a binding the engine wants confirmed asks the user first', async () => {
    const client = stubClient({
        'Binding.restore': { state: 'confirmation-required', restoreScope: 'MainPage' },
    });

    const message = await restoreBinding(client, 'h-title', 'Text', false);

    assert.strictEqual(message?.type, 'bindingRestoreConfirm');
    assert.strictEqual((message as Extract<ExtensionToWebviewMessage, { type: 'bindingRestoreConfirm' }>).scope, 'MainPage');
});

test('the confirmation falls back to the older rebindScope spelling', async () => {
    const client = stubClient({
        'Binding.restore': { state: 'confirmation-required', rebindScope: 'MainWindow' },
    });

    const message = await restoreBinding(client, 'h-title', 'Text', false);

    assert.strictEqual((message as Extract<ExtensionToWebviewMessage, { type: 'bindingRestoreConfirm' }>).scope, 'MainWindow');
});

test('an unconfirmed restore does not claim the user agreed', async () => {
    const client = stubClient({ 'Binding.restore': { state: 'ok' } });

    await restoreBinding(client, 'h-title', 'Text', false);

    // Sending the flag unasked would re-push every compiled binding on the page.
    assert.strictEqual(client.calls[0].params.confirmOwnerRebind, undefined);
});

test('a confirmed restore passes the flag the engine is waiting for', async () => {
    const client = stubClient({ 'Binding.restore': { state: 'ok' } });

    await restoreBinding(client, 'h-title', 'Text', true);

    assert.strictEqual(client.calls[0].params.confirmOwnerRebind, true);
});

test('a completed restore returns nothing so the caller reloads the grid', async () => {
    const client = stubClient({ 'Binding.restore': { state: 'ok' } });

    const message = await restoreBinding(client, 'h-title', 'Text', true);

    assert.strictEqual(message, undefined);
});

test('a restore the engine ignored entirely is treated as completed', async () => {
    const client = stubClient({});

    const message = await restoreBinding(client, 'h-title', 'Text', false);

    assert.strictEqual(message, undefined);
});

// ───────────────────────────── resources ─────────────────────────────

test('a resolved resource reports its key and value', async () => {
    const client = stubClient({
        'Resource.resolve': { prop: 'AccentFillColorDefaultBrush', value: '#FF0078D4' },
    });

    const message = await resolveResource(client, 'h-title', 'Foreground');

    const resource = resourceOf(message);
    assert.strictEqual(resource.key, 'AccentFillColorDefaultBrush');
    assert.strictEqual(resource.resolved, '#FF0078D4');
});

test('an unresolvable resource falls back to the property name as its key', async () => {
    const client = stubClient({});

    const message = await resolveResource(client, 'h-title', 'Foreground');

    const resource = resourceOf(message);
    assert.strictEqual(resource.key, 'Foreground');
    assert.strictEqual(resource.resolved, undefined);
});
