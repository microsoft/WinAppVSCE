/**
 * CompletionItemProvider for AppxManifest XML files.
 * Provides schema-driven element, attribute, and value completions.
 */

import * as vscode from 'vscode';
import { SchemaModel } from './schema-model';
import { getManifestCompletions } from './intellisense-logic';

export class ManifestCompletionProvider implements vscode.CompletionItemProvider {
    constructor(private readonly schema: SchemaModel) {}

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        _context: vscode.CompletionContext
    ): vscode.CompletionItem[] | undefined {
        return getManifestCompletions(this.schema, document.getText(), document.offsetAt(position)).map(suggestion => {
            const kind = suggestion.kind === 'attribute'
                ? vscode.CompletionItemKind.Field
                : suggestion.kind === 'enumValue'
                    ? vscode.CompletionItemKind.EnumMember
                    : vscode.CompletionItemKind.Property;

            const item = new vscode.CompletionItem(suggestion.label, kind);
            item.insertText = new vscode.SnippetString(suggestion.insertText);
            item.detail = suggestion.detail;
            item.documentation = suggestion.documentation
                ? new vscode.MarkdownString(suggestion.documentation)
                : undefined;
            item.sortText = suggestion.sortText;
            item.filterText = suggestion.filterText;
            return item;
        });
    }
}
