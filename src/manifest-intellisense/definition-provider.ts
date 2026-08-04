import * as vscode from 'vscode';
import { extractDocumentPrefixes, findAttribute, findManifestElement } from './intellisense-logic';
import { SchemaModel } from '../manifest-schema/schema-model';
import { getXmlContext, splitPrefixedName } from '../manifest-schema/xml-context';

const XML_NAME_REGEX = /[A-Za-z_][\w.:-]*/;

export class ManifestDefinitionProvider implements vscode.DefinitionProvider {
    constructor(private readonly getSchema: () => SchemaModel) {}

    provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): vscode.Definition | undefined {
        const config = vscode.workspace.getConfiguration('winapp.manifest');
        if (!config.get<boolean>('intelliSense.enable', true)) {
            return undefined;
        }

        const schema = this.getSchema();

        const text = document.getText();
        const docPrefixes = extractDocumentPrefixes(text);
        const offset = document.offsetAt(position);
        const context = getXmlContext(text, offset);
        const wordRange = document.getWordRangeAtPosition(position, XML_NAME_REGEX);
        const word = wordRange ? document.getText(wordRange) : undefined;

        if (context.type === 'attributeName' && context.currentElement && word) {
            const element = findManifestElement(schema, context.currentElement, context.currentPrefix || undefined, text, docPrefixes);
            if (element) {
                const attribute = findAttribute(element.attributes, word, text, docPrefixes);
                if (attribute?.sourceFile && attribute.sourceLine !== undefined) {
                    return new vscode.Location(
                        vscode.Uri.file(attribute.sourceFile),
                        new vscode.Position(attribute.sourceLine, 0)
                    );
                }
            }
        }

        if (!word) {
            return undefined;
        }

        const { prefix, localName } = splitPrefixedName(word);
        const element = findManifestElement(schema, localName, prefix || undefined, text, docPrefixes);
        if (!element?.sourceFile || element.sourceLine === undefined) {
            return undefined;
        }

        return new vscode.Location(
            vscode.Uri.file(element.sourceFile),
            new vscode.Position(element.sourceLine, 0)
        );
    }
}
