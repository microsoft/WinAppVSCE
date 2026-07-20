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

/** Document selector for manifest files. */
const MANIFEST_SELECTOR: vscode.DocumentSelector = [
    { language: 'xml', pattern: '**/[Aa]ppx[Mm]anifest.xml' },
    { language: 'xml', pattern: '**/*.appxmanifest' },
];

/** Trigger characters for completions. */
const TRIGGER_CHARACTERS = ['<', ' ', '"', '='];

/**
 * Register all manifest IntelliSense providers.
 * Call this from the extension's activate function.
 */
export function registerManifestIntelliSense(context: vscode.ExtensionContext): void {
    const config = vscode.workspace.getConfiguration('winapp.manifest');
    if (!config.get<boolean>('intelliSense.enable', true)) {
        return;
    }

    // Load schema from bundled XSD files
    const schemasDir = path.join(context.extensionPath, 'schemas');
    let schema: SchemaModel;

    try {
        schema = loadSchemaModel(schemasDir);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showWarningMessage(
            `WinApp: Failed to load manifest schemas for IntelliSense: ${message}`
        );
        return;
    }

    // Register completion provider
    const completionProvider = new ManifestCompletionProvider(schema);
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            MANIFEST_SELECTOR,
            completionProvider,
            ...TRIGGER_CHARACTERS
        )
    );

    // Register hover provider
    const hoverProvider = new ManifestHoverProvider(schema);
    context.subscriptions.push(
        vscode.languages.registerHoverProvider(MANIFEST_SELECTOR, hoverProvider)
    );

    // Register diagnostics provider
    const diagnosticsProvider = new ManifestDiagnosticsProvider(schema);
    diagnosticsProvider.activate(context);

    // Listen for configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('winapp.manifest')) {
                // Configuration changed; a full reload would be ideal but for now just notify
                vscode.window.showInformationMessage(
                    'WinApp: Manifest IntelliSense configuration changed. Reload window to apply all changes.'
                );
            }
        })
    );
}
