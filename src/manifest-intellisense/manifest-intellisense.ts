/**
 * Main entry point for AppxManifest IntelliSense.
 * Registers completion, hover, and diagnostics providers for manifest XML files.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { loadSchemaModel } from './xsd-parser';
import { SchemaModel } from './schema-model';
import { ManifestCompletionProvider } from './completion-provider';
import { ManifestHoverProvider } from './hover-provider';
import { ManifestDiagnosticsProvider } from './diagnostics-provider';
import { ManifestDefinitionProvider } from './definition-provider';

/** Document selector for manifest files. */
const MANIFEST_SELECTOR: vscode.DocumentSelector = [
    { language: 'xml', pattern: '**/[Aa]ppx[Mm]anifest.xml' },
    { language: 'xml', pattern: '**/*.appxmanifest' },
];

/** Trigger characters for completions. */
const TRIGGER_CHARACTERS = ['<', ' ', '"', '=', '/'];

/**
 * Register all manifest IntelliSense providers.
 * Call this from the extension's activate function.
 */
export function registerManifestIntelliSense(context: vscode.ExtensionContext): void {
    const schemasDir = path.join(context.extensionPath, 'schemas');
    let schema: SchemaModel | undefined;
    let loadFailed = false;

    const getSchema = (): SchemaModel | undefined => {
        if (schema) {
            return schema;
        }
        if (loadFailed) {
            return undefined;
        }

        try {
            schema = loadSchemaModel(schemasDir);
            return schema;
        } catch (err) {
            loadFailed = true;
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showWarningMessage(
                `WinApp: Failed to load manifest schemas for IntelliSense: ${message}`
            );
            return undefined;
        }
    };

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
