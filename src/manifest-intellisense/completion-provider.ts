/**
 * CompletionItemProvider for AppxManifest XML files.
 * Provides schema-driven element, attribute, and value completions.
 */

import * as vscode from 'vscode';
import { SchemaModel, SchemaElement, MANIFEST_NAMESPACES, URI_TO_PREFIX } from './schema-model';
import { getXmlContext, splitPrefixedName, XmlContext } from './xml-context';

/**
 * Known XSD substitution groups: abstract elements mapped to their concrete substitutions.
 * These are elements like VisualElementsChoice that users never type directly.
 */
const SUBSTITUTION_GROUPS: Record<string, Array<{ name: string; namespace: string }>> = {
    'VisualElementsChoice': [
        { name: 'VisualElements', namespace: 'http://schemas.microsoft.com/appx/manifest/uap/windows10' },
    ],
    'ApplicationExtensionChoice': [
        { name: 'Extension', namespace: 'http://schemas.microsoft.com/appx/manifest/uap/windows10' },
    ],
    'CapabilityChoice': [
        { name: 'Capability', namespace: 'http://schemas.microsoft.com/appx/manifest/foundation/windows10' },
        { name: 'Capability', namespace: 'http://schemas.microsoft.com/appx/manifest/uap/windows10' },
        { name: 'DeviceCapability', namespace: 'http://schemas.microsoft.com/appx/manifest/foundation/windows10' },
    ],
    'HoloContentChoice': [],
};

export class ManifestCompletionProvider implements vscode.CompletionItemProvider {
    constructor(private readonly schema: SchemaModel) {}

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        _context: vscode.CompletionContext
    ): vscode.CompletionItem[] | undefined {
        const text = document.getText();
        const offset = document.offsetAt(position);
        const ctx = getXmlContext(text, offset);

        switch (ctx.type) {
            case 'elementOpen':
                return this.completeElementOrAttributes(ctx, text);
            case 'attributeName':
                return this.completeAttributeName(ctx.currentElement, ctx.currentPrefix, ctx.existingAttributes, text);
            case 'attributeValue':
                return this.completeAttributeValue(ctx.currentElement, ctx.currentPrefix, ctx.currentAttribute, text);
            case 'text':
                return this.completeChildElement(ctx.parentElement, ctx.parentPrefix, text);
            case 'closingTag':
                return this.completeClosingTag(ctx.parentElement, ctx.parentPrefix);
            default:
                return undefined;
        }
    }

    /**
     * Complete element names or attribute names when typing after <.
     * When the partial text exactly matches a known element, also offer attribute completions
     * so the user can proceed to attributes without needing a space first.
     */
    private completeElementOrAttributes(
        ctx: XmlContext,
        docText: string
    ): vscode.CompletionItem[] {
        const parentName = ctx.parentElement;
        const parentPrefix = ctx.parentPrefix;
        const partial = ctx.partialText || '';

        const items: vscode.CompletionItem[] = [];

        // Always add child element completions
        if (parentName) {
            items.push(...this.getChildCompletions(parentName, parentPrefix, docText));
        }

        // If partial text matches a known element exactly, also offer its attribute completions
        if (partial) {
            const { prefix, localName } = splitPrefixedName(partial);
            const elem = this.findElement(localName, prefix || undefined, docText);
            if (elem) {
                const attrItems = this.completeAttributeName(localName, prefix || undefined, [], docText);
                for (const attr of attrItems) {
                    // Prepend a space since we're right after the element name
                    if (attr.insertText instanceof vscode.SnippetString) {
                        attr.insertText = new vscode.SnippetString(' ' + attr.insertText.value);
                    } else if (typeof attr.insertText === 'string') {
                        attr.insertText = ' ' + attr.insertText;
                    }
                    // Make attribute items sort after element items
                    attr.sortText = `2_${attr.label}`;
                    items.push(attr);
                }
            }
        }

        return items;
    }

    /** Complete child elements when cursor is between tags (text context). */
    private completeChildElement(
        parentName: string | undefined,
        parentPrefix: string | undefined,
        docText: string
    ): vscode.CompletionItem[] {
        if (!parentName) { return []; }
        return this.getChildCompletions(parentName, parentPrefix, docText).map(item => {
            // For text context, we need to insert the full element with < prefix
            if (item.insertText instanceof vscode.SnippetString) {
                item.insertText = new vscode.SnippetString('<' + item.insertText.value);
            } else if (typeof item.insertText === 'string') {
                item.insertText = '<' + item.insertText;
            }
            item.filterText = '<' + (item.filterText || item.label);
            return item;
        });
    }

    /** Get child element completions for a parent element. */
    private getChildCompletions(
        parentName: string,
        parentPrefix: string | undefined,
        docText: string
    ): vscode.CompletionItem[] {
        const items: vscode.CompletionItem[] = [];
        const parentElem = this.findElement(parentName, parentPrefix, docText);
        if (!parentElem) { return items; }

        const docPrefixes = this.extractDocumentPrefixes(docText);
        const seen = new Set<string>();

        for (const child of parentElem.children) {
            // Handle abstract/substitution group elements
            const substitutions = SUBSTITUTION_GROUPS[child.name];
            if (substitutions) {
                for (const sub of substitutions) {
                    const subPrefix = this.getPrefixForNamespace(sub.namespace, docPrefixes);
                    const subDisplayName = subPrefix ? `${subPrefix}:${sub.name}` : sub.name;
                    if (seen.has(subDisplayName)) { continue; }
                    seen.add(subDisplayName);

                    const subElem = this.schema.elements.get(`${sub.namespace}|${sub.name}`);
                    const item = new vscode.CompletionItem(subDisplayName, vscode.CompletionItemKind.Property);
                    let snippet = subDisplayName;
                    let attrIdx = 1;
                    if (subElem) {
                        for (const attr of subElem.attributes.filter(a => a.required)) {
                            snippet += ` ${attr.name}="\${${attrIdx}:}"`;
                            attrIdx++;
                        }
                    }
                    if (subElem && subElem.children.length > 0) {
                        snippet += `>\n\t\${${attrIdx}}\n</${subDisplayName}>`;
                    } else {
                        snippet += ` />\${0}`;
                    }
                    item.insertText = new vscode.SnippetString(snippet);
                    item.detail = `(${subPrefix || sub.namespace})`;
                    item.documentation = subElem?.documentation ? new vscode.MarkdownString(subElem.documentation) : undefined;
                    item.sortText = `0_${sub.name}`;
                    items.push(item);
                }
                continue;
            }

            const childElem = this.schema.elements.get(`${child.namespace}|${child.name}`);
            const prefix = this.getPrefixForNamespace(child.namespace, docPrefixes);

            const displayName = prefix ? `${prefix}:${child.name}` : child.name;

            // Deduplicate by display name
            if (seen.has(displayName)) { continue; }
            seen.add(displayName);

            const item = new vscode.CompletionItem(displayName, vscode.CompletionItemKind.Property);

            // Build snippet with required attributes
            let snippet = displayName;
            let attrIdx = 1;
            if (childElem) {
                const requiredAttrs = childElem.attributes.filter(a => a.required);
                for (const attr of requiredAttrs) {
                    snippet += ` ${attr.name}="\${${attrIdx}:}"`;
                    attrIdx++;
                }
            }

            // Determine if this should be self-closing or have content
            if (childElem && childElem.children.length > 0) {
                snippet += `>\n\t\${${attrIdx}}\n</${displayName}>`;
            } else if (childElem && childElem.children.length === 0 && childElem.attributes.length > 0) {
                snippet += ` />\${0}`;
            } else {
                snippet += `>\${${attrIdx}}</${displayName}>`;
            }

            item.insertText = new vscode.SnippetString(snippet);
            item.detail = child.namespace ? `(${URI_TO_PREFIX.get(child.namespace) || child.namespace})` : undefined;
            item.documentation = childElem?.documentation ? new vscode.MarkdownString(childElem.documentation) : undefined;
            item.sortText = child.minOccurs > 0 ? `0_${child.name}` : `1_${child.name}`;

            items.push(item);
        }

        return items;
    }

    /** Complete attribute names for the current element. */
    private completeAttributeName(
        elementName: string | undefined,
        prefix: string | undefined,
        existingAttrs: string[] | undefined,
        docText: string
    ): vscode.CompletionItem[] {
        if (!elementName) { return []; }

        const elem = this.findElement(elementName, prefix, docText);
        if (!elem) { return []; }

        const existing = new Set(existingAttrs || []);
        const items: vscode.CompletionItem[] = [];

        for (const attr of elem.attributes) {
            if (existing.has(attr.name)) { continue; }

            const item = new vscode.CompletionItem(attr.name, vscode.CompletionItemKind.Field);
            item.insertText = new vscode.SnippetString(`${attr.name}="\${1:}"`);
            item.detail = attr.required ? '(required)' : '(optional)';
            item.documentation = attr.documentation ? new vscode.MarkdownString(attr.documentation) : undefined;
            item.sortText = attr.required ? `0_${attr.name}` : `1_${attr.name}`;

            if (attr.enumerations && attr.enumerations.length > 0) {
                // Show enum values as detail
                item.detail = (item.detail || '') + ` [${attr.enumerations.slice(0, 5).join(', ')}${attr.enumerations.length > 5 ? '...' : ''}]`;
                // Use choice snippet for small enum sets
                if (attr.enumerations.length <= 20) {
                    const choices = attr.enumerations.join(',');
                    item.insertText = new vscode.SnippetString(`${attr.name}="\${1|${choices}|}"`);
                }
            }

            items.push(item);
        }

        return items;
    }

    /** Complete attribute values (enum values). */
    private completeAttributeValue(
        elementName: string | undefined,
        prefix: string | undefined,
        attrName: string | undefined,
        docText: string
    ): vscode.CompletionItem[] {
        if (!elementName || !attrName) { return []; }

        const elem = this.findElement(elementName, prefix, docText);
        if (!elem) { return []; }

        const attr = elem.attributes.find(a => a.name === attrName);
        if (!attr || !attr.enumerations) { return []; }

        return attr.enumerations.map((val, idx) => {
            const item = new vscode.CompletionItem(val, vscode.CompletionItemKind.EnumMember);
            item.sortText = String(idx).padStart(4, '0');
            return item;
        });
    }

    /** Complete closing tag. */
    private completeClosingTag(
        parentName: string | undefined,
        parentPrefix: string | undefined
    ): vscode.CompletionItem[] {
        if (!parentName) { return []; }
        const displayName = parentPrefix ? `${parentPrefix}:${parentName}` : parentName;
        const item = new vscode.CompletionItem(displayName, vscode.CompletionItemKind.Property);
        item.insertText = `${displayName}>`;
        return [item];
    }

    /** Find a schema element by name and prefix, resolving namespace from the document. */
    private findElement(name: string, prefix: string | undefined, docText: string): SchemaElement | undefined {
        const docPrefixes = this.extractDocumentPrefixes(docText);
        const ns = this.resolveNamespaceFromPrefix(prefix || '', docPrefixes);

        // Direct lookup
        const key = `${ns}|${name}`;
        let elem = this.schema.elements.get(key);
        if (elem) { return elem; }

        // Try type lookup
        const typeKey = `${ns}|type:CT_${name}`;
        elem = this.schema.elements.get(typeKey);
        if (elem) { return elem; }

        // Fallback: search by name across all namespaces
        for (const [k, v] of this.schema.elements) {
            if (k.endsWith(`|${name}`) && !k.includes('|type:')) {
                return v;
            }
        }

        return undefined;
    }

    /** Extract xmlns prefix declarations from the document text. */
    private extractDocumentPrefixes(text: string): Map<string, string> {
        const prefixes = new Map<string, string>();
        const regex = /xmlns(?::([a-zA-Z][\w]*))?="([^"]+)"/g;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) !== null) {
            const prefix = match[1] || '';
            const uri = match[2];
            prefixes.set(prefix, uri);
        }
        return prefixes;
    }

    /** Resolve a prefix to a namespace URI using document declarations or well-known mappings. */
    private resolveNamespaceFromPrefix(prefix: string, docPrefixes: Map<string, string>): string {
        // First try document declarations
        const docNs = docPrefixes.get(prefix);
        if (docNs) { return docNs; }

        // Fall back to well-known mappings
        return MANIFEST_NAMESPACES[prefix] || '';
    }

    /** Get the prefix for a namespace URI based on the document or well-known mappings. */
    private getPrefixForNamespace(ns: string, docPrefixes: Map<string, string>): string {
        // Search document prefixes first
        for (const [prefix, uri] of docPrefixes) {
            if (uri === ns) { return prefix; }
        }
        // Fall back to well-known
        return URI_TO_PREFIX.get(ns) || '';
    }
}
