/**
 * Diagnostics provider for AppxManifest XML files.
 * Validates the manifest against the XSD schema and reports issues.
 */

import * as vscode from 'vscode';
import { SchemaModel } from './schema-model';
import { validateManifestText } from './intellisense-logic';

export class ManifestDiagnosticsProvider {
    private readonly diagnosticCollection: vscode.DiagnosticCollection;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly schema: SchemaModel) {
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection('winapp-manifest');
    }

    /** Activate the diagnostics provider. */
    activate(context: vscode.ExtensionContext): void {
        // Validate on open
        this.disposables.push(
            vscode.workspace.onDidOpenTextDocument(doc => this.validateIfManifest(doc))
        );
        // Validate on change (debounced)
        let timeout: ReturnType<typeof setTimeout> | undefined;
        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument(e => {
                if (timeout) { clearTimeout(timeout); }
                timeout = setTimeout(() => this.validateIfManifest(e.document), 500);
            })
        );
        // Validate on save
        this.disposables.push(
            vscode.workspace.onDidSaveTextDocument(doc => this.validateIfManifest(doc))
        );
        // Clear when closed
        this.disposables.push(
            vscode.workspace.onDidCloseTextDocument(doc => {
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

        const config = vscode.workspace.getConfiguration('winapp.manifest');
        if (!config.get<boolean>('intelliSense.enable', true)) { return; }

        const level = config.get<string>('diagnostics.level', 'warning');
        if (level === 'off') {
            this.diagnosticCollection.delete(document.uri);
            return;
        }

        const diagnostics = this.validate(document, level);
        this.diagnosticCollection.set(document.uri, diagnostics);
    }

    /** Check if a document is a manifest file. */
    private isManifestFile(document: vscode.TextDocument): boolean {
        if (document.uri.scheme !== 'file') { return false; }
        const fsPath = document.uri.fsPath.toLowerCase();
        return fsPath.endsWith('appxmanifest.xml') || fsPath.endsWith('.appxmanifest');
    }

    /** Validate the manifest document. */
    private validate(document: vscode.TextDocument, level: string): vscode.Diagnostic[] {
        return validateManifestText(
            this.schema,
            document.getText(),
            level === 'error' ? 'error' : 'warning'
        ).map(diagnostic => new vscode.Diagnostic(
            new vscode.Range(diagnostic.line, diagnostic.col, diagnostic.line, diagnostic.endCol),
            diagnostic.message,
            diagnostic.severity === 'error'
                ? vscode.DiagnosticSeverity.Error
                : vscode.DiagnosticSeverity.Warning
        ));
    }
}
