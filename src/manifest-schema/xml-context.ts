/**
 * XML cursor context analyzer.
 * Determines what the user is editing at the cursor position in an XML document.
 */

/** The type of context the cursor is in. */
export type XmlContextType =
    | 'elementOpen'      // Inside an opening tag, suggesting child element names: <|
    | 'attributeName'    // After element name/attributes, suggesting attribute names: <Elem |
    | 'attributeValue'   // Inside an attribute value: attr="|"
    | 'text'             // Between tags (text content)
    | 'closingTag'       // Inside a closing tag: </|
    | 'unknown';

/** Full context information at the cursor position. */
export interface XmlContext {
    type: XmlContextType;
    /** The element tag name at cursor (for attributeName/attributeValue). */
    currentElement?: string;
    /** The namespace prefix of the current element. */
    currentPrefix?: string;
    /** The attribute name being completed (for attributeValue). */
    currentAttribute?: string;
    /** List of attributes already present on the current element. */
    existingAttributes?: string[];
    /** The parent element path (ancestors). */
    parentPath: ParentElement[];
    /** The immediate parent element. */
    parentElement?: string;
    /** The parent element's namespace prefix. */
    parentPrefix?: string;
    /** Text typed so far for the current completion (filter text). */
    partialText?: string;
}

/** Represents an ancestor element in the path. */
export interface ParentElement {
    name: string;
    prefix: string;
}

/**
 * Analyze the XML text at the given offset to determine context for IntelliSense.
 */
export function getXmlContext(text: string, offset: number): XmlContext {
    // Find what we're inside of by scanning backwards from offset
    const before = text.substring(0, offset);

    // Check if we're inside an attribute value
    const attrValueCtx = checkAttributeValue(before, text, offset);
    if (attrValueCtx) { return attrValueCtx; }

    // Check if we're in an opening/self-closing tag (attribute name position)
    const attrNameCtx = checkAttributeName(before, text, offset);
    if (attrNameCtx) { return attrNameCtx; }

    // Check if we're typing a new element tag
    const elemCtx = checkElementOpen(before, text, offset);
    if (elemCtx) { return elemCtx; }

    // Check for closing tag
    const closeCtx = checkClosingTag(before);
    if (closeCtx) { return closeCtx; }

    // Default: text content between tags — suggest child elements
    const parentPath = findParentPath(before);
    const parent = parentPath.length > 0 ? parentPath[parentPath.length - 1] : undefined;
    return {
        type: 'text',
        parentPath,
        parentElement: parent?.name,
        parentPrefix: parent?.prefix,
    };
}

/** Check if cursor is inside an attribute value (between quotes). */
function checkAttributeValue(before: string, _text: string, _offset: number): XmlContext | null {
    // Look for pattern: attrName="partial  or  attrName='partial
    // We need to be inside quotes and inside a tag
    const tagStart = before.lastIndexOf('<');
    if (tagStart === -1) { return null; }
    const tagEnd = findLastTagBoundary(before);
    if (tagEnd > tagStart) { return null; }
    const tagContent = before.substring(tagStart);

    // Check if we're inside a quoted attribute value
    // Count quotes after the last unquoted attribute assignment
    const attrMatch = /([a-zA-Z_][\w.-]*(?::[a-zA-Z_][\w.-]*)?)\s*=\s*(['"])([^'"]*?)$/s.exec(tagContent);
    if (!attrMatch) { return null; }

    const attrName = attrMatch[1];
    const quoteChar = attrMatch[2];
    const partialValue = attrMatch[3];

    // Verify the quote is not closed
    const afterAttr = tagContent.substring(tagContent.lastIndexOf(quoteChar + partialValue));
    // Simple check: count quotes of this type after the =
    const quoteIdx = tagContent.indexOf(quoteChar, attrMatch.index + attrName.length);
    const afterAssign = quoteIdx === -1 ? '' : tagContent.substring(quoteIdx);
    const quoteCount = (afterAssign.match(new RegExp(quoteChar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    if (quoteCount >= 2) { return null; } // Both quotes present, we're past the value

    // Extract element name from the tag
    const elemMatch = /^<\/?([a-zA-Z_][\w.-]*(?::[a-zA-Z_][\w.-]*)?)/.exec(tagContent);
    if (!elemMatch) { return null; }
    const fullName = elemMatch[1];
    const { prefix, localName } = splitPrefixedName(fullName);

    const parentPath = findParentPath(before.substring(0, tagStart));

    return {
        type: 'attributeValue',
        currentElement: localName,
        currentPrefix: prefix,
        currentAttribute: attrName,
        partialText: partialValue,
        parentPath,
        existingAttributes: extractExistingAttributes(tagContent),
    };
}

/** Check if cursor is in attribute name position (inside an opening tag). */
function checkAttributeName(before: string, _text: string, _offset: number): XmlContext | null {
    const tagStart = before.lastIndexOf('<');
    if (tagStart === -1) { return null; }
    const tagEnd = findLastTagBoundary(before);
    if (tagEnd > tagStart) { return null; }
    const tagContent = before.substring(tagStart);

    // Must not be a closing tag
    if (/^<\//.test(tagContent)) { return null; }

    // Check we're past the element name and in attribute position
    // Pattern: <ElementName ...attrs... |
    const elemMatch = /^<([a-zA-Z_][\w.-]*(?::[a-zA-Z_][\w.-]*)?)\s+/s.exec(tagContent);
    if (!elemMatch) { return null; }

    // Make sure we're not inside a quoted value (odd number of unmatched quotes)
    const afterElemName = tagContent.substring(elemMatch[0].length);
    if (isInsideQuotes(afterElemName)) { return null; }

    const fullName = elemMatch[1];
    const { prefix, localName } = splitPrefixedName(fullName);

    // Get partial attribute name being typed
    const partialMatch = /(\w[\w.-]*)$/.exec(tagContent);
    const partialText = partialMatch ? partialMatch[1] : '';

    const parentPath = findParentPath(before.substring(0, tagStart));

    return {
        type: 'attributeName',
        currentElement: localName,
        currentPrefix: prefix,
        partialText,
        parentPath,
        existingAttributes: extractExistingAttributes(tagContent),
    };
}

/** Check if cursor is at an element open position (after <). */
function checkElementOpen(before: string, _text: string, _offset: number): XmlContext | null {
    // Look for < at the end (possibly with partial element name)
    const match = /<([a-zA-Z_][\w.-]*(?::[a-zA-Z_][\w.-]*)?)?$/.exec(before);
    if (!match) { return null; }

    const partialText = match[1] || '';
    const tagStart = match.index;
    const parentPath = findParentPath(before.substring(0, tagStart));
    const parent = parentPath.length > 0 ? parentPath[parentPath.length - 1] : undefined;

    return {
        type: 'elementOpen',
        partialText,
        parentPath,
        parentElement: parent?.name,
        parentPrefix: parent?.prefix,
    };
}

/** Check if we're inside a closing tag. */
function checkClosingTag(before: string): XmlContext | null {
    const match = /<\/([a-zA-Z_][\w.-]*(?::[a-zA-Z_][\w.-]*)?)?$/.exec(before);
    if (!match) { return null; }

    const parentPath = findParentPath(before.substring(0, match.index));
    const parent = parentPath.length > 0 ? parentPath[parentPath.length - 1] : undefined;

    return {
        type: 'closingTag',
        partialText: match[1] || '',
        parentPath,
        parentElement: parent?.name,
        parentPrefix: parent?.prefix,
    };
}

/**
 * Find the parent element path by scanning backwards through the XML.
 * Returns the stack of open (unclosed) elements.
 */
export function findParentPath(textBefore: string): ParentElement[] {
    // Strip XML comments (loop handles edge cases where removal reveals new comment patterns)
    let prev: string;
    do { prev = textBefore; textBefore = textBefore.replace(/<!--[\s\S]*?-->/g, ''); } while (textBefore !== prev);
    textBefore = textBefore.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
    const stack: ParentElement[] = [];

    // Quote-aware tag scanner: skip '>' inside quoted attribute values
    const tagRegex = /<(\/?[a-zA-Z_][\w.-]*(?::[a-zA-Z_][\w.-]*)?)(\s[^]*?)?(\/?)\s*>/g;
    let match: RegExpExecArray | null;
    let searchFrom = 0;

    while (searchFrom < textBefore.length) {
        tagRegex.lastIndex = searchFrom;
        match = tagRegex.exec(textBefore);
        if (!match) { break; }

        // Validate we didn't stop inside a quoted attribute value
        const attrPart = match[2] || '';
        const singleQuotes = (attrPart.match(/'/g) || []).length;
        const doubleQuotes = (attrPart.match(/"/g) || []).length;
        if (singleQuotes % 2 !== 0 || doubleQuotes % 2 !== 0) {
            // Unbalanced quotes — the regex stopped at a > inside a quote
            // Skip past this match and retry
            searchFrom = match.index + match[0].length;
            continue;
        }

        searchFrom = match.index + match[0].length;
        const tagNamePart = match[1];
        const selfClose = match[3] === '/';

        if (tagNamePart.startsWith('/')) {
            // Closing tag
            const closeName = tagNamePart.slice(1);
            const { prefix, localName } = splitPrefixedName(closeName);
            for (let i = stack.length - 1; i >= 0; i--) {
                if (stack[i].name === localName && stack[i].prefix === prefix) {
                    stack.splice(i, 1);
                    break;
                }
            }
        } else if (!selfClose) {
            // Opening tag (not self-closing)
            const { prefix, localName } = splitPrefixedName(tagNamePart);
            stack.push({ name: localName, prefix });
        }
    }

    return stack;
}

/** Split a potentially prefixed name into prefix and localName. */
export function splitPrefixedName(name: string): { prefix: string; localName: string } {
    const colonIdx = name.indexOf(':');
    if (colonIdx === -1) {
        return { prefix: '', localName: name };
    }
    return {
        prefix: name.substring(0, colonIdx),
        localName: name.substring(colonIdx + 1),
    };
}

/** Extract existing attribute names from a tag string. */
function extractExistingAttributes(tagContent: string): string[] {
    const attrs: string[] = [];
    const attrRegex = /\s([a-zA-Z_][\w.-]*(?::[a-zA-Z_][\w.-]*)?)\s*=/g;
    let m: RegExpExecArray | null;
    while ((m = attrRegex.exec(tagContent)) !== null) {
        attrs.push(m[1]);
    }
    return attrs;
}

/** Check if the given text ends inside a quoted string. */
function isInsideQuotes(text: string): boolean {
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"' && !inSingle) { inDouble = !inDouble; }
        if (ch === "'" && !inDouble) { inSingle = !inSingle; }
    }
    return inSingle || inDouble;
}

function findLastTagBoundary(text: string): number {
    let inSingle = false;
    let inDouble = false;
    let lastBoundary = -1;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"' && !inSingle) {
            inDouble = !inDouble;
            continue;
        }
        if (ch === "'" && !inDouble) {
            inSingle = !inSingle;
            continue;
        }
        if (ch === '>' && !inSingle && !inDouble) {
            lastBoundary = i;
        }
    }
    return lastBoundary;
}
