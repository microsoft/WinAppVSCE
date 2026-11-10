/**
 * Binding and resource inspection handlers.
 *
 * These three webview messages are pure translations: call one or two protocol
 * methods, reshape the result into the message the property grid renders. They
 * touch no panel state beyond the client, so they live here rather than in the
 * panel's message switch, where they were the largest block by some distance.
 */

import { DevToolsClient } from './devtools-client';
import { ExtensionToWebviewMessage } from './devtools-types';

/**
 * Shapes of the parity-domain results we consume. These mirror the bundled
 * schema's `$defs`; only the fields the panel renders are declared.
 */
export interface BindingDiagnoseResult {
    state?: string;
    reason?: string;
    path?: string;
    source?: string;
    mode?: string;
    resolvedValue?: string;
    targetValue?: string;
    restoreScope?: string;
    restoreOwner?: string;
    rebindScope?: string;
    bound?: string;
}

export interface BindingWalkResult {
    segments?: { path: string; value?: string }[];
}

/** Engine states the native window reads as a working binding. */
const WORKING_STATES = new Set(['evaluated', 'ok', 'silent']);
/** Engine states for a live binding that resolved badly; still worth capturing. */
const BROKEN_STATES = new Set(['bad-segment', 'null-link', 'no-datacontext', 'threw']);

/** Outcome of a restore the engine did not apply, or `undefined` once it did. */
export type RestoreOutcome = ExtensionToWebviewMessage | { failed: string } | undefined;

/**
 * Diagnoses one bound property, following up with a path walk when the engine
 * answered at all.
 */
export async function diagnoseBinding(
    client: DevToolsClient,
    handle: string,
    name: string,
): Promise<ExtensionToWebviewMessage> {
    const result = await client.trySend('Binding.diagnose', {
        handle,
        prop: name,
    }) as BindingDiagnoseResult | undefined;

    if (!result) {
        // Native AOT and C++ apps have no managed agent to ask.
        return {
            type: 'binding',
            handle,
            name,
            binding: { unavailable: true, message: 'Binding diagnosis needs a managed (.NET) app.' },
        };
    }

    const walk = await client.trySend('Binding.walk', {
        handle,
        prop: name,
    }) as BindingWalkResult | undefined;

    const state = result.state ?? '';
    // As the native window does, save a live binding so Restore binding has
    // something to put back after a literal edit replaces it.
    if (WORKING_STATES.has(state) || BROKEN_STATES.has(state)) {
        await client.trySend('Binding.capture', { handle, prop: name });
    }

    return {
        type: 'binding',
        handle,
        name,
        binding: {
            status: result.state,
            ok: WORKING_STATES.has(state),
            source: result.source,
            path: result.path,
            mode: result.mode,
            value: result.resolvedValue ?? result.targetValue,
            walk: (walk?.segments ?? []).map((segment) =>
                segment.path + (segment.value === undefined ? '' : ' = ' + segment.value)),
        },
    };
}

/**
 * Re-establishes a binding the user overwrote.
 *
 * Returns a confirmation message when the engine wants the user warned first,
 * and `undefined` once the restore has actually been applied — the caller
 * reloads the property grid in that case.
 */
export async function restoreBinding(
    client: DevToolsClient,
    handle: string,
    name: string,
    confirm: boolean | undefined,
): Promise<RestoreOutcome> {
    const restored = await client.trySend('Binding.restore', {
        handle,
        prop: name,
        // An {x:Bind} restore re-pushes every compiled binding on the owning
        // page, so the engine refuses until the user has been told that.
        // Without this the button does nothing.
        ...(confirm ? { confirmOwnerRebind: true } : {}),
    }) as BindingDiagnoseResult | undefined;

    if (restored?.state === 'confirmation-required') {
        return {
            type: 'bindingRestoreConfirm',
            handle,
            name,
            scope: ownerName(restored.restoreOwner) ?? restored.rebindScope,
        };
    }
    // The app can drop the binding again while it is reattached, so check it held.
    if (!restored || restored.state !== 'restored' || restored.bound === 'False') {
        return { failed: restored?.reason ?? 'the engine did not answer' };
    }

    return undefined;
}

/** "MainWindow_obj1_Bindings" is the generated class; the reader knows it as MainWindow. */
function ownerName(owner: string | undefined): string | undefined {
    return owner ? owner.replace(/_obj\d+_Bindings$/, '') : undefined;
}

/** Resolves a `{StaticResource}` or `{ThemeResource}` key to its current value. */
export async function resolveResource(
    client: DevToolsClient,
    handle: string,
    name: string,
): Promise<ExtensionToWebviewMessage> {
    const resource = await client.trySend('Resource.resolve', {
        handle,
        prop: name,
    }) as { prop?: string; value?: string } | undefined;

    return {
        type: 'resource',
        handle,
        name,
        resource: { key: resource?.prop ?? name, resolved: resource?.value },
    };
}
