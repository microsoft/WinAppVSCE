import { MANIFEST_NAMESPACES, SchemaAttribute, SchemaElement, SchemaModel, URI_TO_PREFIX } from '../manifest-schema/schema-model';
import { SUBSTITUTION_GROUPS } from '../manifest-schema/substitution-groups';
import { getXmlContext, splitPrefixedName } from '../manifest-schema/xml-context';
// Re-export validation from shared module so existing consumers don't break
export { validateManifestText, findSchemaElementExact, ManifestDiagnostic } from '../manifest-schema/schema-validation';

export type ManifestCompletionKind = 'element' | 'attribute' | 'enumValue' | 'closingTag';

export interface ManifestCompletionSuggestion {
    kind: ManifestCompletionKind;
    label: string;
    insertText: string;
    detail?: string;
    documentation?: string;
    sortText?: string;
    filterText?: string;
}

export interface ManifestHoverInfo {
    kind: 'element' | 'attribute';
    name: string;
    namespace?: string;
    elementName?: string;
    documentation?: string;
    required?: boolean;
    typeName?: string;
    enumerations?: string[];
    requiredAttributes?: string[];
    optionalAttributes?: string[];
    childElements?: Array<{ displayName: string; required: boolean }>;
}

export function getManifestCompletions(
    schema: SchemaModel,
    text: string,
    offset: number
): ManifestCompletionSuggestion[] {
    const ctx = getXmlContext(text, offset);

    switch (ctx.type) {
        case 'elementOpen':
            return completeElementOrAttributes(schema, ctx.parentElement, ctx.parentPrefix, ctx.partialText || '', text);
        case 'attributeName':
            return getAttributeCompletions(schema, ctx.currentElement, ctx.currentPrefix, ctx.existingAttributes, text);
        case 'attributeValue':
            return getAttributeValueCompletions(schema, ctx.currentElement, ctx.currentPrefix, ctx.currentAttribute, text);
        case 'text':
            return getChildCompletions(schema, ctx.parentElement, ctx.parentPrefix, text).map(item => ({
                ...item,
                insertText: `<${item.insertText}`,
                filterText: `<${item.filterText || item.label}`,
            }));
        case 'closingTag':
            return getClosingTagCompletions(ctx.parentElement, ctx.parentPrefix);
        default:
            return [];
    }
}

function completeElementOrAttributes(
    schema: SchemaModel,
    parentName: string | undefined,
    parentPrefix: string | undefined,
    partial: string,
    docText: string
): ManifestCompletionSuggestion[] {
    const items: ManifestCompletionSuggestion[] = [];

    if (partial) {
        const { prefix, localName } = splitPrefixedName(partial);
        const elem = findManifestElement(schema, localName, prefix || undefined, docText);
        if (elem) {
            // User typed a known element name — show only attribute completions
            const attrItems = getAttributeCompletions(schema, localName, prefix || undefined, [], docText);
            items.push(...attrItems.map(attr => ({
                ...attr,
                insertText: ` ${attr.insertText}`,
                sortText: `2_${attr.label}`,
            })));
            return items;
        }
    }

    // No partial or partial doesn't match an element — show child elements
    if (parentName) {
        items.push(...getChildCompletions(schema, parentName, parentPrefix, docText));
    }

    return items;
}

export function getChildCompletions(
    schema: SchemaModel,
    parentName: string | undefined,
    parentPrefix: string | undefined,
    docText: string
): ManifestCompletionSuggestion[] {
    if (!parentName) { return []; }

    const items: ManifestCompletionSuggestion[] = [];
    const parentElem = findManifestElement(schema, parentName, parentPrefix, docText);
    if (!parentElem) { return items; }

    const docPrefixes = extractDocumentPrefixes(docText);
    const seen = new Set<string>();

    for (const child of parentElem.children) {
        const substitutions = SUBSTITUTION_GROUPS[child.name];
        if (substitutions) {
            for (const sub of substitutions) {
                const subPrefix = getPrefixForNamespace(sub.namespace, docPrefixes);
                const subDisplayName = subPrefix ? `${subPrefix}:${sub.name}` : sub.name;
                if (seen.has(subDisplayName)) { continue; }
                seen.add(subDisplayName);

                const subElem = schema.elements.get(`${sub.namespace}|${sub.name}`);
                items.push({
                    kind: 'element',
                    label: subDisplayName,
                    insertText: buildElementSnippet(subDisplayName, subElem),
                    detail: `(${subPrefix || sub.namespace})`,
                    documentation: subElem?.documentation,
                    sortText: `0_${sub.name}`,
                });
            }
            continue;
        }

        const childElem = schema.elements.get(`${child.namespace}|${child.name}`);
        const prefix = getPrefixForNamespace(child.namespace, docPrefixes);
        const displayName = prefix ? `${prefix}:${child.name}` : child.name;
        if (seen.has(displayName)) { continue; }
        seen.add(displayName);

        items.push({
            kind: 'element',
            label: displayName,
            insertText: buildElementSnippet(displayName, childElem),
            detail: child.namespace ? `(${URI_TO_PREFIX.get(child.namespace) || child.namespace})` : undefined,
            documentation: childElem?.documentation,
            sortText: child.minOccurs > 0 ? `0_${child.name}` : `1_${child.name}`,
        });
    }

    return items;
}

export function getAttributeCompletions(
    schema: SchemaModel,
    elementName: string | undefined,
    prefix: string | undefined,
    existingAttrs: string[] | undefined,
    docText: string
): ManifestCompletionSuggestion[] {
    if (!elementName) { return []; }

    const elem = findManifestElement(schema, elementName, prefix, docText);
    if (!elem) { return []; }

    const existing = new Set(existingAttrs || []);
    const docPrefixes = extractDocumentPrefixes(docText);
    const items: ManifestCompletionSuggestion[] = [];

    for (const attr of elem.attributes) {
        const displayName = formatAttributeName(attr, docPrefixes, schema, true);
        if (!displayName) { continue; }
        if (existing.has(displayName)) { continue; }

        let detail = attr.required ? '(required)' : '(optional)';
        let insertText = `${displayName}="\${1:}"`;

        if (attr.enumerations && attr.enumerations.length > 0) {
            detail += ` [${attr.enumerations.slice(0, 5).join(', ')}${attr.enumerations.length > 5 ? '...' : ''}]`;
            if (attr.enumerations.length <= 20) {
                insertText = `${displayName}="\${1|${attr.enumerations.join(',')}|}"`;
            }
        }

        items.push({
            kind: 'attribute',
            label: displayName,
            insertText,
            detail,
            documentation: attr.documentation,
            sortText: attr.required ? `0_${displayName}` : `1_${displayName}`,
        });
    }

    return items;
}

export function getAttributeValueCompletions(
    schema: SchemaModel,
    elementName: string | undefined,
    prefix: string | undefined,
    attrName: string | undefined,
    docText: string
): ManifestCompletionSuggestion[] {
    if (!elementName || !attrName) { return []; }

    const elem = findManifestElement(schema, elementName, prefix, docText);
    if (!elem) { return []; }

    const attr = findAttribute(elem.attributes, attrName, docText);
    if (!attr?.enumerations) { return []; }

    return attr.enumerations.map((value, idx) => ({
        kind: 'enumValue',
        label: value,
        insertText: value,
        sortText: String(idx).padStart(4, '0'),
    }));
}

export function getClosingTagCompletions(
    parentName: string | undefined,
    parentPrefix: string | undefined
): ManifestCompletionSuggestion[] {
    if (!parentName) { return []; }
    const displayName = parentPrefix ? `${parentPrefix}:${parentName}` : parentName;
    return [{
        kind: 'closingTag',
        label: displayName,
        insertText: `${displayName}>`,
    }];
}

export function getManifestHover(schema: SchemaModel, text: string, offset: number): ManifestHoverInfo | undefined {
    const word = getWordAtOffset(text, offset);
    if (!word) { return undefined; }

    const lineInfo = getLineInfo(text, offset);
    const lineBeforeWord = lineInfo.text.substring(0, word.start - lineInfo.start);

    if (lineBeforeWord.match(/<\/?$/)) {
        return getElementHover(schema, word.value, text);
    }

    const beforeOffset = text.substring(0, offset);
    const tagStart = beforeOffset.lastIndexOf('<');
    if (tagStart >= 0) {
        const tagContent = beforeOffset.substring(tagStart);
        if (!tagContent.includes('>')) {
            const elemMatch = /^<([a-zA-Z_][\w.-]*(?::[a-zA-Z_][\w.-]*)?)/.exec(tagContent);
            if (elemMatch) {
                const elemName = elemMatch[1];
                const { localName } = splitPrefixedName(elemName);
                if (word.value !== elemName && word.value !== localName) {
                    return getAttributeHover(schema, word.value, elemName, text) || getElementHover(schema, word.value, text);
                }
                return getElementHover(schema, elemName, text);
            }
        }
    }

    return getElementHover(schema, word.value, text);
}

export function getElementHover(
    schema: SchemaModel,
    name: string,
    docText: string
): ManifestHoverInfo | undefined {
    const { prefix, localName } = splitPrefixedName(name);
    const elem = findManifestElement(schema, localName, prefix || undefined, docText);
    if (!elem) { return undefined; }

    const docPrefixes = extractDocumentPrefixes(docText);
    const requiredAttributes = elem.attributes
        .filter(a => a.required)
        .map(a => formatAttributeName(a, docPrefixes, schema))
        .filter((name): name is string => Boolean(name));
    const optionalAttributes = elem.attributes
        .filter(a => !a.required)
        .map(a => formatAttributeName(a, docPrefixes, schema))
        .filter((name): name is string => Boolean(name));
    const seenDisplayNames = new Set<string>();
    const childElements: Array<{ displayName: string; required: boolean }> = [];
    for (const child of elem.children.slice(0, 15)) {
        const childPrefix = URI_TO_PREFIX.get(child.namespace) || '';
        const displayName = childPrefix ? `${childPrefix}:${child.name}` : child.name;
        if (seenDisplayNames.has(displayName)) { continue; }
        seenDisplayNames.add(displayName);
        childElements.push({ displayName, required: child.minOccurs > 0 });
        if (childElements.length >= 10) { break; }
    }

    return {
        kind: 'element',
        name,
        namespace: elem.namespace,
        documentation: elem.documentation,
        requiredAttributes,
        optionalAttributes,
        childElements,
    };
}

export function getAttributeHover(
    schema: SchemaModel,
    attrName: string,
    elementName: string,
    docText: string
): ManifestHoverInfo | undefined {
    const { prefix, localName } = splitPrefixedName(elementName);
    const elem = findManifestElement(schema, localName, prefix || undefined, docText);
    if (!elem) { return undefined; }

    const attr = findAttribute(elem.attributes, attrName, docText);
    if (!attr) { return undefined; }

    const docPrefixes = extractDocumentPrefixes(docText);
    return {
        kind: 'attribute',
        name: formatAttributeName(attr, docPrefixes, schema) || attrName,
        elementName,
        documentation: attr.documentation,
        required: attr.required,
        typeName: attr.typeName,
        enumerations: attr.enumerations,
    };
}

export function formatManifestHoverMarkdown(info: ManifestHoverInfo): string {
    if (info.kind === 'attribute') {
        const parts = [`**\`${info.name}\`** on \`<${info.elementName}>\`\n\n`];
        if (info.documentation) {
            parts.push(`${info.documentation}\n\n`);
        }
        parts.push(`- ${info.required ? '**Required**' : 'Optional'}\n`);
        if (info.typeName) {
            parts.push(`- Type: \`${info.typeName}\`\n`);
        }
        if (info.enumerations && info.enumerations.length > 0) {
            parts.push(`- Allowed values: ${info.enumerations.map(value => `\`${value}\``).join(', ')}\n`);
        }
        return parts.join('');
    }

    const nsLabel = info.namespace ? (URI_TO_PREFIX.get(info.namespace) || info.namespace) : '';
    const parts = [`**\`<${info.name}>\`**`];
    if (nsLabel) {
        parts.push(` _(${nsLabel})_`);
    }
    parts.push('\n\n');

    if (info.documentation) {
        parts.push(`${info.documentation}\n\n`);
    }

    if (info.requiredAttributes && info.requiredAttributes.length > 0 || info.optionalAttributes && info.optionalAttributes.length > 0) {
        parts.push('**Attributes:**\n');
        if (info.requiredAttributes && info.requiredAttributes.length > 0) {
            parts.push(`- Required: ${info.requiredAttributes.map(name => `\`${name}\``).join(', ')}\n`);
        }
        if (info.optionalAttributes && info.optionalAttributes.length > 0) {
            parts.push(`- Optional: ${info.optionalAttributes.map(name => `\`${name}\``).join(', ')}\n`);
        }
    }

    if (info.childElements && info.childElements.length > 0) {
        parts.push('\n**Child elements:**\n');
        for (const child of info.childElements) {
            parts.push(`- \`<${child.displayName}>\`${child.required ? ' (required)' : ''}\n`);
        }
    }

    return parts.join('');
}

export function findManifestElement(
    schema: SchemaModel,
    name: string,
    prefix: string | undefined,
    docText: string
): SchemaElement | undefined {
    const docPrefixes = extractDocumentPrefixes(docText);
    const ns = resolveNamespaceFromPrefix(prefix || '', docPrefixes);

    const key = `${ns}|${name}`;
    let elem = schema.elements.get(key);
    if (elem) { return elem; }

    const typeKey = `${ns}|type:CT_${name}`;
    elem = schema.elements.get(typeKey);
    if (elem) { return elem; }

    if (prefix) { return undefined; }

    // AppxManifest documents often omit prefixes for elements that conceptually belong
    // to the default foundation namespace. Prefer that match before falling back across
    // namespaces so unprefixed lookups stay stable instead of picking an arbitrary peer.
    const defaultNamespaceMatch = schema.elements.get(`${MANIFEST_NAMESPACES['']}|${name}`);
    if (defaultNamespaceMatch) {
        return defaultNamespaceMatch;
    }

    for (const [candidateKey, candidate] of schema.elements) {
        if (candidateKey.endsWith(`|${name}`) && !candidateKey.includes('|type:')) {
            return candidate;
        }
    }

    return undefined;
}

export function extractDocumentPrefixes(text: string): Map<string, string> {
    text = text.replace(/<!--[\s\S]*?-->/g, '');
    const prefixes = new Map<string, string>();
    const regex = /xmlns(?::([a-zA-Z][\w]*))?\s*=\s*["']([^"']+)["']/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
        const prefix = match[1] || '';
        if (!prefixes.has(prefix)) {
            prefixes.set(prefix, match[2]);
        }
    }
    return prefixes;
}

export function resolveNamespaceFromPrefix(prefix: string, docPrefixes: Map<string, string>): string {
    const docNs = docPrefixes.get(prefix);
    if (docNs) { return docNs; }
    return MANIFEST_NAMESPACES[prefix] || '';
}

export function getPrefixForNamespace(ns: string, docPrefixes: Map<string, string>): string {
    for (const [prefix, uri] of docPrefixes) {
        if (uri === ns) { return prefix; }
    }
    return URI_TO_PREFIX.get(ns) || '';
}

function buildElementSnippet(displayName: string, element: SchemaElement | undefined): string {
    let snippet = displayName;
    let attrIndex = 1;

    if (element) {
        for (const attr of element.attributes.filter(attribute => attribute.required)) {
            snippet += ` ${attr.name}="\${${attrIndex}:}"`;
            attrIndex++;
        }
    }

    if (element && element.children.length > 0) {
        snippet += `>\n\t\${${attrIndex}}\n</${displayName}>`;
    } else if (element && element.children.length === 0 && element.attributes.length > 0) {
        snippet += ' />\${0}';
    } else {
        snippet += `>\${${attrIndex}}</${displayName}>`;
    }

    return snippet;
}

export function findAttribute(attributes: SchemaAttribute[], attrName: string, docText: string): SchemaAttribute | undefined {
    const { prefix, localName } = splitPrefixedName(attrName);
    if (!prefix) {
        return attributes.find(attribute => !attribute.qualified && attribute.name === attrName)
            || attributes.find(attribute => attribute.name === attrName);
    }

    const namespace = resolveNamespaceFromPrefix(prefix, extractDocumentPrefixes(docText));
    return attributes.find(attribute =>
        attribute.name === localName
        && attribute.qualified
        && attribute.namespace === namespace
    );
}

function formatAttributeName(
    attr: Pick<SchemaAttribute, 'name' | 'qualified' | 'namespace'>,
    docPrefixes: Map<string, string>,
    schema: SchemaModel,
    requireDeclaredPrefix = false
): string | undefined {
    if (!attr.qualified) {
        return attr.name;
    }

    const prefix = getDeclaredPrefixForNamespace(attr.namespace || '', docPrefixes)
        || (!requireDeclaredPrefix ? schema.namespacePrefixes.get(attr.namespace || '') : undefined);
    if (!prefix) {
        return undefined;
    }
    return `${prefix}:${attr.name}`;
}

function getDeclaredPrefixForNamespace(namespace: string, docPrefixes: Map<string, string>): string | undefined {
    for (const [prefix, uri] of docPrefixes) {
        if (uri === namespace && prefix) {
            return prefix;
        }
    }
    return undefined;
}

function getWordAtOffset(text: string, offset: number): { value: string; start: number; end: number } | undefined {
    if (offset < 0 || offset > text.length) { return undefined; }

    const isWordChar = (char: string) => /[A-Za-z0-9_.:-]/.test(char);
    let start = offset;
    let end = offset;

    while (start > 0 && isWordChar(text[start - 1])) {
        start--;
    }
    while (end < text.length && isWordChar(text[end])) {
        end++;
    }

    if (start === end) { return undefined; }
    return { value: text.slice(start, end), start, end };
}

function getLineInfo(text: string, offset: number): { start: number; end: number; text: string } {
    const start = text.lastIndexOf('\n', Math.max(offset - 1, 0)) + 1;
    const endIndex = text.indexOf('\n', offset);
    const end = endIndex === -1 ? text.length : endIndex;
    return {
        start,
        end,
        text: text.slice(start, end),
    };
}
