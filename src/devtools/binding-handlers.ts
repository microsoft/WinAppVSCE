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
    path?: string;
    source?: string;
    mode?: string;
    resolvedValue?: string;
    targetValue?: string;
    restoreScope?: string;
    rebindScope?: string;
}

export interface BindingWalkResult {
    segments?: { path: string; value?: string }[];
}

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
            name,
            binding: { unavailable: true, message: 'Binding diagnosis needs a managed (.NET) app.' },
        };
    }

    const walk = await client.trySend('Binding.walk', {
        handle,
        prop: name,
    }) as BindingWalkResult | undefined;

    return {
        type: 'binding',
        name,
        binding: {
            status: result.state,
            ok: result.state === 'ok' || result.state === 'bound',
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
): Promise<ExtensionToWebviewMessage | undefined> {
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
            name,
            scope: restored.restoreScope ?? restored.rebindScope,
        };
    }

    return undefined;
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
        name,
        resource: { key: resource?.prop ?? name, resolved: resource?.value },
    };
}
