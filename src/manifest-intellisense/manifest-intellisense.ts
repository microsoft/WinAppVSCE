/**
 * Main entry point for AppxManifest IntelliSense.
 * Registers completion, hover, and diagnostics providers for manifest XML files.
 */

import * as vscode from 'vscode';
import { SchemaModel } from '../manifest-schema/schema-model';
import { MANIFEST_SELECTOR } from '../manifest-schema/manifest-path';
import { ManifestCompletionProvider } from './completion-provider';
import { ManifestHoverProvider } from './hover-provider';
import { ManifestDiagnosticsProvider } from './diagnostics-provider';
import { ManifestDefinitionProvider } from './definition-provider';

/** Trigger characters for completions. */
const TRIGGER_CHARACTERS = ['<', ' ', '"', '=', '/'];

/**
 * Register all manifest IntelliSense providers.
 * Call this from the extension's activate function.
 * 
 * @param context VS Code extension context
 * @param getSchema Shared schema getter provided by the extension.
 */
export function registerManifestIntelliSense(
    context: vscode.ExtensionContext,
    getSchema: () => SchemaModel
): void {
    // Register completion provider
    const completionProvider = new ManifestCompletionProvider(getSchema);
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            MANIFEST_SELECTOR,
            completionProvider,
            ...TRIGGER_CHARACTERS
        )
    );

    // Register hover provider
    const hoverProvider = new ManifestHoverProvider(getSchema);
    context.subscriptions.push(
        vscode.languages.registerHoverProvider(MANIFEST_SELECTOR, hoverProvider)
    );

    // Register definition provider
    const definitionProvider = new ManifestDefinitionProvider(getSchema);
    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider(MANIFEST_SELECTOR, definitionProvider)
    );

    // Register diagnostics provider
    const diagnosticsProvider = new ManifestDiagnosticsProvider(getSchema);
    diagnosticsProvider.activate(context);
}
