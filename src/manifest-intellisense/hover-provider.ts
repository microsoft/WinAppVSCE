/**
 * HoverProvider for AppxManifest XML files.
 * Shows documentation for elements and attributes on hover.
 */

import * as vscode from 'vscode';
import { SchemaModel, SchemaElement, URI_TO_PREFIX, MANIFEST_NAMESPACES } from './schema-model';
import { splitPrefixedName } from './xml-context';

export class ManifestHoverProvider implements vscode.HoverProvider {
    constructor(private readonly schema: SchemaModel) {}

    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): vscode.Hover | undefined {
        const text = document.getText();
        const offset = document.offsetAt(position);
        const line = document.lineAt(position.line).text;

        // Determine if we're hovering over an element name or attribute name
        const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_][\w.-]*(?::[a-zA-Z_][\w.-]*)*/);
        if (!wordRange) { return undefined; }

        const word = document.getText(wordRange);

        const lineBeforeWord = line.substring(0, wordRange.start.character);

        // Is it an element name (after < or </) ?
        if (lineBeforeWord.match(/<\/?$/)) {
            return this.hoverElement(word, text);
        }

        // Check if we're inside a tag (attribute position) by scanning backwards from offset
        // for the most recent unmatched '<'. This handles multi-line tags correctly.
        const beforeOffset = text.substring(0, offset);
        const tagStart = beforeOffset.lastIndexOf('<');
        if (tagStart >= 0) {
            const tagContent = beforeOffset.substring(tagStart);
            // If we find '>' between the tag start and cursor, we're NOT inside a tag
            if (!tagContent.includes('>')) {
                // We're inside an open tag — extract element name
                const elemMatch = /^<([a-zA-Z_][\w.-]*(?::[a-zA-Z_][\w.-]*)?)/.exec(tagContent);
                if (elemMatch) {
                    const elemName = elemMatch[1];
                    // Only treat as attribute hover if the word is NOT the element name itself
                    const { localName } = splitPrefixedName(elemName);
                    if (word !== elemName && word !== localName) {
                        return this.hoverAttribute(word, elemName, text) || this.hoverElement(word, text);
                    }
                    // Word IS the element name — show element hover
                    return this.hoverElement(elemName, text);
                }
            }
        }

        // Try as element name (might be a child element reference)
        return this.hoverElement(word, text);
    }

    /** Show hover documentation for an element. */
    private hoverElement(name: string, docText: string): vscode.Hover | undefined {
        const { prefix, localName } = splitPrefixedName(name);
        const elem = this.findElement(localName, prefix, docText);
        if (!elem) { return undefined; }

        const md = new vscode.MarkdownString();
        const nsLabel = URI_TO_PREFIX.get(elem.namespace) || elem.namespace;
        md.appendMarkdown(`**\`<${name}>\`**`);
        if (nsLabel) {
            md.appendMarkdown(` _(${nsLabel})_`);
        }
        md.appendMarkdown('\n\n');

        if (elem.documentation) {
            md.appendMarkdown(elem.documentation + '\n\n');
        }

        // Show attributes summary
        if (elem.attributes.length > 0) {
            md.appendMarkdown('**Attributes:**\n');
            const required = elem.attributes.filter(a => a.required);
            const optional = elem.attributes.filter(a => !a.required);
            if (required.length > 0) {
                md.appendMarkdown(`- Required: ${required.map(a => `\`${a.name}\``).join(', ')}\n`);
            }
            if (optional.length > 0) {
                md.appendMarkdown(`- Optional: ${optional.map(a => `\`${a.name}\``).join(', ')}\n`);
            }
        }

        // Show child elements
        if (elem.children.length > 0) {
            md.appendMarkdown('\n**Child elements:**\n');
            for (const child of elem.children.slice(0, 10)) {
                const childPrefix = URI_TO_PREFIX.get(child.namespace) || '';
                const displayName = childPrefix ? `${childPrefix}:${child.name}` : child.name;
                const req = child.minOccurs > 0 ? ' (required)' : '';
                md.appendMarkdown(`- \`<${displayName}>\`${req}\n`);
            }
            if (elem.children.length > 10) {
                md.appendMarkdown(`- _...and ${elem.children.length - 10} more_\n`);
            }
        }

        return new vscode.Hover(md);
    }

    /** Show hover documentation for an attribute. */
    private hoverAttribute(attrName: string, elementName: string, docText: string): vscode.Hover | undefined {
        const { prefix, localName } = splitPrefixedName(elementName);
        const elem = this.findElement(localName, prefix, docText);
        if (!elem) { return undefined; }

        const attr = elem.attributes.find(a => a.name === attrName);
        if (!attr) { return undefined; }

        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**\`${attrName}\`** on \`<${elementName}>\`\n\n`);

        if (attr.documentation) {
            md.appendMarkdown(attr.documentation + '\n\n');
        }

        md.appendMarkdown(`- ${attr.required ? '**Required**' : 'Optional'}\n`);
        if (attr.typeName) {
            md.appendMarkdown(`- Type: \`${attr.typeName}\`\n`);
        }
        if (attr.enumerations && attr.enumerations.length > 0) {
            md.appendMarkdown(`- Allowed values: ${attr.enumerations.map(v => `\`${v}\``).join(', ')}\n`);
        }

        return new vscode.Hover(md);
    }

    /** Find a schema element by name and prefix. */
    private findElement(name: string, prefix: string, docText: string): SchemaElement | undefined {
        const docPrefixes = this.extractDocumentPrefixes(docText);
        const ns = this.resolveNamespaceFromPrefix(prefix, docPrefixes);

        const key = `${ns}|${name}`;
        let elem = this.schema.elements.get(key);
        if (elem) { return elem; }

        // Try type lookup
        const typeKey = `${ns}|type:CT_${name}`;
        elem = this.schema.elements.get(typeKey);
        if (elem) { return elem; }

        // Fallback: search by name
        for (const [k, v] of this.schema.elements) {
            if (k.endsWith(`|${name}`) && !k.includes('|type:')) {
                return v;
            }
        }

        return undefined;
    }

    /** Extract xmlns prefix declarations from document. */
    private extractDocumentPrefixes(text: string): Map<string, string> {
        const prefixes = new Map<string, string>();
        const regex = /xmlns(?::([a-zA-Z][\w]*))?="([^"]+)"/g;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) !== null) {
            prefixes.set(match[1] || '', match[2]);
        }
        return prefixes;
    }

    /** Resolve prefix to namespace URI. */
    private resolveNamespaceFromPrefix(prefix: string, docPrefixes: Map<string, string>): string {
        const docNs = docPrefixes.get(prefix);
        if (docNs) { return docNs; }
        return MANIFEST_NAMESPACES[prefix] || '';
    }
}
