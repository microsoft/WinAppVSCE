/**
 * HoverProvider for AppxManifest XML files.
 * Shows documentation for elements and attributes on hover.
 */

import * as vscode from 'vscode';
import { SchemaModel } from './schema-model';
import { formatManifestHoverMarkdown, getManifestHover } from './intellisense-logic';

export class ManifestHoverProvider implements vscode.HoverProvider {
    constructor(private readonly schema: SchemaModel) {}

    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): vscode.Hover | undefined {
        const hover = getManifestHover(this.schema, document.getText(), document.offsetAt(position));
        if (!hover) { return undefined; }
        return new vscode.Hover(new vscode.MarkdownString(formatManifestHoverMarkdown(hover)));
    }
}
