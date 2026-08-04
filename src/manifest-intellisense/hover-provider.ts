/**
 * HoverProvider for AppxManifest XML files.
 * Shows documentation for elements and attributes on hover.
 */

import * as vscode from 'vscode';
import { SchemaModel } from '../manifest-schema/schema-model';
import { formatManifestHoverMarkdown, getManifestHover } from './intellisense-logic';

export class ManifestHoverProvider implements vscode.HoverProvider {
    constructor(private readonly getSchema: () => SchemaModel) {}

    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): vscode.Hover | undefined {
        const config = vscode.workspace.getConfiguration('winapp.manifest');
        if (!config.get<boolean>('intelliSense.enable', true)) {
            return undefined;
        }

        const schema = this.getSchema();

        const hover = getManifestHover(schema, document.getText(), document.offsetAt(position));
        if (!hover) { return undefined; }
        return new vscode.Hover(new vscode.MarkdownString(formatManifestHoverMarkdown(hover)));
    }
}
