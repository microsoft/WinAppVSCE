/**
 * Diagnostics provider for AppxManifest XML files.
 * Validates the manifest against the XSD schema and reports issues.
 */

import * as vscode from 'vscode';
import { SchemaModel } from '../manifest-schema/schema-model';
import { validateManifestText } from '../manifest-schema/schema-validation';

const MANIFEST_CONFIG_SECTION = 'winapp.manifest';
const INTELLISENSE_ENABLE_CONFIG_KEY = 'intelliSense.enable';
const DIAGNOSTICS_LEVEL_CONFIG_KEY = 'diagnostics.level';
const STRICT_CHILD_PLACEMENT_CONFIG_KEY = 'intelliSense.diagnostics.strictChildPlacement';
const VALIDATION_DEBOUNCE_MS = 500;

export class ManifestDiagnosticsProvider {
    private readonly diagnosticCollection: vscode.DiagnosticCollection;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly pendingValidations = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(private readonly getSchema: () => SchemaModel) {
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection('winapp-manifest');
    }

    /** Activate the diagnostics provider. */
    activate(context: vscode.ExtensionContext): void {
        // Validate on open
        this.disposables.push(
            vscode.workspace.onDidOpenTextDocument(doc => this.validateIfManifest(doc))
        );
        // Validate on change (debounced)
        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument(e => {
                const key = e.document.uri.toString();
                const existingTimeout = this.pendingValidations.get(key);
                if (existingTimeout) {
                    clearTimeout(existingTimeout);
                }

                const timeout = setTimeout(() => {
                    this.pendingValidations.delete(key);
                    this.validateIfManifest(e.document);
                }, VALIDATION_DEBOUNCE_MS);

                this.pendingValidations.set(key, timeout);
            })
        );
        // Validate on save
        this.disposables.push(
            vscode.workspace.onDidSaveTextDocument(doc => this.validateIfManifest(doc))
        );
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration(event => {
                if (!event.affectsConfiguration(MANIFEST_CONFIG_SECTION)) { return; }
                this.refreshOpenManifestDiagnostics();
            })
        );
        // Clear when closed
        this.disposables.push(
            vscode.workspace.onDidCloseTextDocument(doc => {
                const key = doc.uri.toString();
                const timeout = this.pendingValidations.get(key);
                if (timeout) {
                    clearTimeout(timeout);
                    this.pendingValidations.delete(key);
                }
                this.diagnosticCollection.delete(doc.uri);
            })
        );

        // Validate already open documents
        for (const doc of vscode.workspace.textDocuments) {
            this.validateIfManifest(doc);
        }

        context.subscriptions.push(this.diagnosticCollection);
        for (const d of this.disposables) {
            context.subscriptions.push(d);
        }
    }

    /** Check if document is a manifest and validate if so. */
    private validateIfManifest(document: vscode.TextDocument): void {
        if (!this.isManifestFile(document)) { return; }

        const config = vscode.workspace.getConfiguration(MANIFEST_CONFIG_SECTION);
        if (!config.get<boolean>(INTELLISENSE_ENABLE_CONFIG_KEY, true)) {
            this.diagnosticCollection.delete(document.uri);
            return;
        }

        const level = config.get<string>(DIAGNOSTICS_LEVEL_CONFIG_KEY, 'warning');
        if (level === 'off') {
            this.diagnosticCollection.delete(document.uri);
            return;
        }

        const diagnostics = this.validate(document, level);
        this.diagnosticCollection.set(document.uri, diagnostics);
    }

    /** Re-run diagnostics for open manifest documents after configuration changes. */
    private refreshOpenManifestDiagnostics(): void {
        const config = vscode.workspace.getConfiguration(MANIFEST_CONFIG_SECTION);
        const enabled = config.get<boolean>(INTELLISENSE_ENABLE_CONFIG_KEY, true);
        const level = config.get<string>(DIAGNOSTICS_LEVEL_CONFIG_KEY, 'warning');
        if (!enabled || level === 'off') {
            this.diagnosticCollection.clear();
            return;
        }

        for (const document of vscode.workspace.textDocuments) {
            this.validateIfManifest(document);
        }
    }

    /** Check if a document is a manifest file. */
    private isManifestFile(document: vscode.TextDocument): boolean {
        if (document.uri.scheme !== 'file') { return false; }
        const fsPath = document.uri.fsPath.toLowerCase();
        return fsPath.endsWith('appxmanifest.xml') || fsPath.endsWith('.appxmanifest');
    }

    /** Validate the manifest document. */
    private validate(document: vscode.TextDocument, level: string): vscode.Diagnostic[] {
        const diagnostics = validateManifestText(
            this.getSchema(),
            document.getText(),
            level === 'error' ? 'error' : 'warning',
            {
                strictChildPlacement: vscode.workspace
                    .getConfiguration(MANIFEST_CONFIG_SECTION)
                    .get<boolean>(STRICT_CHILD_PLACEMENT_CONFIG_KEY, false),
            }
        );

        const filteredDiagnostics = level === 'error'
            ? diagnostics.filter(diagnostic => diagnostic.severity === 'error')
            : diagnostics;

        return filteredDiagnostics.map(d => {
            const range = new vscode.Range(d.line, d.col, d.line, d.endCol);
            const diagnostic = new vscode.Diagnostic(
                range,
                d.message,
                d.severity === 'error'
                    ? vscode.DiagnosticSeverity.Error
                    : d.severity === 'warning'
                        ? vscode.DiagnosticSeverity.Warning
                        : vscode.DiagnosticSeverity.Hint
            );
            diagnostic.source = 'Manifest Schema';
            if (d.schemaUri) {
                diagnostic.relatedInformation = [
                    new vscode.DiagnosticRelatedInformation(
                        new vscode.Location(document.uri, range),
                        `Schema namespace: ${d.schemaUri}`
                    ),
                ];
            }
            return diagnostic;
        });
    }
}
