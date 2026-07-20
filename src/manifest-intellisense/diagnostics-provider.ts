/**
 * Diagnostics provider for AppxManifest XML files.
 * Validates the manifest against the XSD schema and reports issues.
 */

import * as vscode from 'vscode';
import { DOMParser } from '@xmldom/xmldom';
import type { Element } from '@xmldom/xmldom';
import { SchemaModel, SchemaElement, MANIFEST_NAMESPACES, URI_TO_PREFIX } from './schema-model';

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
        const text = document.getText();
        const diagnostics: vscode.Diagnostic[] = [];
        const severity = level === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;

        // Parse the XML
        const errors: Array<{ message: string; line: number; col: number }> = [];
        const parser = new DOMParser({
            onError: (level: string, msg: string) => {
                if (level === 'warning') { return; }
                const lineMatch = /line[:\s]+(\d+)/i.exec(msg);
                const colMatch = /col(?:umn)?[:\s]+(\d+)/i.exec(msg);
                errors.push({
                    message: msg,
                    line: lineMatch ? parseInt(lineMatch[1], 10) - 1 : 0,
                    col: colMatch ? parseInt(colMatch[1], 10) - 1 : 0,
                });
            },
        });

        const doc = parser.parseFromString(text, 'application/xml');

        // Report XML parse errors
        for (const err of errors) {
            const line = Math.max(0, Math.min(err.line, document.lineCount - 1));
            const range = new vscode.Range(line, err.col, line, document.lineAt(line).text.length);
            diagnostics.push(new vscode.Diagnostic(range, `XML Error: ${err.message}`, vscode.DiagnosticSeverity.Error));
        }

        if (errors.length > 0 || !doc || !doc.documentElement) {
            return diagnostics;
        }

        // Schema validation
        const root = doc.documentElement;
        this.validateElement(root, document, text, diagnostics, severity);

        return diagnostics;
    }

    /** Validate an element against the schema. */
    private validateElement(
        element: Element,
        document: vscode.TextDocument,
        text: string,
        diagnostics: vscode.Diagnostic[],
        severity: vscode.DiagnosticSeverity
    ): void {
        const localName = element.localName || element.nodeName.split(':').pop() || '';
        const ns = element.namespaceURI || '';

        const schemaDef = this.findSchemaElement(localName, ns);
        if (!schemaDef) {
            // We don't know this element — skip validation (might be from a schema we didn't load)
            // Still validate children
            this.validateChildren(element, document, text, diagnostics, severity);
            return;
        }

        // Validate required attributes
        for (const attr of schemaDef.attributes) {
            if (attr.required && !element.getAttribute(attr.name)) {
                const range = this.getElementRange(element, document, text);
                if (range) {
                    diagnostics.push(new vscode.Diagnostic(
                        range,
                        `Missing required attribute '${attr.name}' on <${localName}>`,
                        severity
                    ));
                }
            }
        }

        // Validate attribute values against enumerations
        for (const attr of schemaDef.attributes) {
            if (!attr.enumerations || attr.enumerations.length === 0) { continue; }
            const value = element.getAttribute(attr.name);
            if (value && !attr.enumerations.includes(value)) {
                const range = this.getAttributeValueRange(element, attr.name, document, text);
                if (range) {
                    diagnostics.push(new vscode.Diagnostic(
                        range,
                        `Invalid value '${value}' for attribute '${attr.name}'. Expected one of: ${attr.enumerations.slice(0, 10).join(', ')}`,
                        severity
                    ));
                }
            }
        }

        // Validate children
        this.validateChildren(element, document, text, diagnostics, severity);
    }

    /** Recursively validate child elements. */
    private validateChildren(
        element: Element,
        document: vscode.TextDocument,
        text: string,
        diagnostics: vscode.Diagnostic[],
        severity: vscode.DiagnosticSeverity
    ): void {
        const children = element.childNodes;
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            if (child.nodeType === 1) {
                this.validateElement(child as Element, document, text, diagnostics, severity);
            }
        }
    }

    /** Find a schema element definition — exact match only for validation. */
    private findSchemaElement(name: string, ns: string): SchemaElement | undefined {
        // Only use exact namespace + name match for validation to avoid false positives.
        // Do NOT fall back to type:CT_ or cross-namespace searches — those cause false positives
        // for elements defined in extension schemas (v2, v3, etc.) whose targetNamespace
        // differs from the document's default xmlns.
        const key = `${ns}|${name}`;
        return this.schema.elements.get(key);
    }

    /** Get the range of an element's opening tag in the document. */
    private getElementRange(element: Element, document: vscode.TextDocument, text: string): vscode.Range | null {
        const lineNum = (element as unknown as { lineNumber?: number }).lineNumber;
        const colNum = (element as unknown as { columnNumber?: number }).columnNumber;
        if (typeof lineNum === 'number' && typeof colNum === 'number') {
            const line = Math.max(0, lineNum - 1);
            const col = Math.max(0, colNum - 1);
            return new vscode.Range(line, col, line, document.lineAt(Math.min(line, document.lineCount - 1)).text.length);
        }
        return null;
    }

    /** Get the range of an attribute value in the document. */
    private getAttributeValueRange(element: Element, attrName: string, document: vscode.TextDocument, text: string): vscode.Range | null {
        // Use element position as fallback
        return this.getElementRange(element, document, text);
    }
}
