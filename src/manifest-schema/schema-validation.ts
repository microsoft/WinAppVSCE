/**
 * Schema-driven XML validation for AppxManifest files.
 * Validates manifest XML against the parsed XSD schema model.
 * 
 * This module is part of the shared manifest-schema infrastructure and has
 * no VS Code dependency — it can be consumed by both manifest-intellisense
 * (for real-time diagnostics) and manifest-editor (for form validation).
 */

import { DOMParser } from '@xmldom/xmldom';
import type { Element } from '@xmldom/xmldom';
import { SchemaElement, SchemaModel, SchemaAttribute } from './schema-model';
import { SUBSTITUTION_GROUPS } from './substitution-groups';

/** A diagnostic produced by schema validation. */
export interface ManifestDiagnostic {
    message: string;
    severity: 'warning' | 'error';
    line: number;
    col: number;
    endCol: number;
}

/**
 * Validate an entire manifest XML document against the schema model.
 * Parses the XML and walks all elements, checking required attributes,
 * enum values, pattern constraints, and length restrictions.
 */
export function validateManifestText(
    schema: SchemaModel,
    text: string,
    level: 'warning' | 'error' = 'warning'
): ManifestDiagnostic[] {
    const diagnostics: ManifestDiagnostic[] = [];
    const lines = text.split(/\r?\n/);

    const errors: Array<{ message: string; line: number; col: number }> = [];
    const parser = new DOMParser({
        onError: (errorLevel: string, message: string) => {
            if (errorLevel === 'warning') { return; }
            const lineMatch = /line[:\s]+(\d+)/i.exec(message);
            const colMatch = /col(?:umn)?[:\s]+(\d+)/i.exec(message);
            errors.push({
                message,
                line: lineMatch ? parseInt(lineMatch[1], 10) - 1 : 0,
                col: colMatch ? parseInt(colMatch[1], 10) - 1 : 0,
            });
        },
    });

    const doc = parser.parseFromString(text, 'application/xml');

    for (const err of errors) {
        const safeLine = clamp(err.line, 0, Math.max(lines.length - 1, 0));
        diagnostics.push({
            message: `XML Error: ${err.message}`,
            severity: 'error',
            line: safeLine,
            col: Math.max(err.col, 0),
            endCol: getLineLength(lines, safeLine),
        });
    }

    if (errors.length > 0 || !doc?.documentElement) {
        return diagnostics;
    }

    validateElement(schema, doc.documentElement, diagnostics, level, lines);
    return diagnostics;
}

/**
 * Validate a single XML element against the schema.
 * Checks required attributes, enum values, patterns, and lengths.
 */
function validateElement(
    schema: SchemaModel,
    element: Element,
    diagnostics: ManifestDiagnostic[],
    severity: 'warning' | 'error',
    lines: string[]
): void {
    const localName = element.localName || element.nodeName.split(':').pop() || '';
    const ns = element.namespaceURI || '';

    const schemaDef = findSchemaElementExact(schema, localName, ns);
    if (!schemaDef) {
        validateChildren(schema, element, undefined, diagnostics, severity, lines);
        return;
    }

    const resolvedAttributes = resolveElementAttributes(element);

    // Check required attributes
    for (const attr of schemaDef.attributes) {
        if (attr.required && !findResolvedAttribute(resolvedAttributes, attr)) {
            const range = getElementRange(element, lines);
            diagnostics.push({
                message: `Missing required attribute '${attr.name}' on <${localName}>`,
                severity,
                ...range,
            });
        }
    }

    // Check enum values
    for (const attr of schemaDef.attributes) {
        if (!attr.enumerations || attr.enumerations.length === 0) { continue; }
        const resolvedAttribute = findResolvedAttribute(resolvedAttributes, attr);
        if (resolvedAttribute && !attr.enumerations.includes(resolvedAttribute.value)) {
            const range = getAttributeValueRange(element, resolvedAttribute.displayName, lines);
            diagnostics.push({
                message: `Invalid value '${resolvedAttribute.value}' for attribute '${attr.name}'. Expected one of: ${attr.enumerations.slice(0, 10).join(', ')}`,
                severity,
                ...range,
            });
        }
    }

    // Validate attribute values against pattern constraints
    for (const attr of schemaDef.attributes) {
        if (!hasPatternConstraints(attr)) { continue; }
        if (attr.enumerations && attr.enumerations.length > 0) { continue; } // enum validation already covers this
        const resolvedAttribute = findResolvedAttribute(resolvedAttributes, attr);
        if (!resolvedAttribute) { continue; }
        if (!validateAttributeValuePattern(attr, resolvedAttribute.value)) {
            const range = getAttributeValueRange(element, resolvedAttribute.displayName, lines);
            diagnostics.push({
                message: `Value '${resolvedAttribute.value}' for attribute '${attr.name}' does not match the expected pattern`,
                severity,
                ...range,
            });
        }
    }

    // Validate attribute value lengths
    for (const attr of schemaDef.attributes) {
        if (attr.minLength === undefined && attr.maxLength === undefined) { continue; }
        const resolvedAttribute = findResolvedAttribute(resolvedAttributes, attr);
        if (!resolvedAttribute) { continue; }
        if (attr.minLength !== undefined && resolvedAttribute.value.length < attr.minLength) {
            const range = getAttributeValueRange(element, resolvedAttribute.displayName, lines);
            diagnostics.push({
                message: `Value for '${attr.name}' must be at least ${attr.minLength} characters (got ${resolvedAttribute.value.length})`,
                severity,
                ...range,
            });
        }
        if (attr.maxLength !== undefined && resolvedAttribute.value.length > attr.maxLength) {
            const range = getAttributeValueRange(element, resolvedAttribute.displayName, lines);
            diagnostics.push({
                message: `Value for '${attr.name}' exceeds maximum length of ${attr.maxLength} characters (got ${resolvedAttribute.value.length})`,
                severity,
                ...range,
            });
        }
    }

    validateChildren(schema, element, schemaDef, diagnostics, severity, lines);
}

function validateChildren(
    schema: SchemaModel,
    element: Element,
    schemaDef: SchemaElement | undefined,
    diagnostics: ManifestDiagnostic[],
    severity: 'warning' | 'error',
    lines: string[]
): void {
    const children = element.childNodes;
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.nodeType === 1) {
            const childElement = child as Element;
            if (schemaDef) {
                validateChildPlacement(schema, element, schemaDef, childElement, diagnostics, lines);
            }
            validateElement(schema, childElement, diagnostics, severity, lines);
        }
    }
}

/**
 * Find a schema element by exact namespace and local name.
 */
export function findSchemaElementExact(
    schema: SchemaModel,
    name: string,
    namespace: string
): SchemaElement | undefined {
    return schema.elements.get(`${namespace}|${name}`);
}

/**
 * Test an attribute value against its schema-defined pattern constraints.
 * Returns true if valid (or no patterns), false if it fails any required pattern set.
 * Useful for manifest-editor to validate individual field values against XSD patterns.
 */
export function validateAttributeValuePattern(attr: SchemaAttribute, value: string): boolean {
    const patternSets = getPatternSets(attr);
    if (patternSets.length === 0) { return true; }
    if (attr.enumerations && attr.enumerations.length > 0) { return true; } // enum check takes precedence
    if (value.length > 1024) { return true; } // ReDoS safety
    return patternSets.every(patternSet => patternSet.some(pattern => {
        try {
            return new RegExp(`^(?:${pattern})$`).test(value);
        } catch {
            return true;
        }
    }));
}

/**
 * Test an attribute value against its schema-defined length constraints.
 * Returns null if valid, or an error message string if invalid.
 */
export function validateAttributeValueLength(attr: SchemaAttribute, value: string): string | null {
    if (attr.minLength !== undefined && value.length < attr.minLength) {
        return `Value must be at least ${attr.minLength} characters (got ${value.length})`;
    }
    if (attr.maxLength !== undefined && value.length > attr.maxLength) {
        return `Value exceeds maximum length of ${attr.maxLength} characters (got ${value.length})`;
    }
    return null;
}

/**
 * Test an attribute value against its enumeration constraints.
 * Returns true if valid (or no enumerations), false if not in the allowed set.
 */
export function validateAttributeValueEnum(attr: SchemaAttribute, value: string): boolean {
    if (!attr.enumerations || attr.enumerations.length === 0) { return true; }
    return attr.enumerations.includes(value);
}

/**
 * Get the range of an attribute value in the source text for diagnostic positioning.
 */
export function getAttributeValueRange(element: Element, attrName: string, lines: string[]): { line: number; col: number; endCol: number } {
    const elemLine = (element as unknown as { lineNumber?: number }).lineNumber;
    const startLine = typeof elemLine === 'number' ? elemLine - 1 : 0;

    const searchEnd = Math.min(startLine + 10, lines.length);
    for (let i = startLine; i < searchEnd; i++) {
        const lineText = lines[i];
        const regex = new RegExp(`${attrName}\\s*=\\s*(['"])([^'"]*?)\\1`);
        const match = regex.exec(lineText);
        if (match) {
            const valueStart = match.index + match[0].indexOf(match[2]);
            return { line: i, col: valueStart, endCol: valueStart + match[2].length };
        }
    }

    return getElementRange(element, lines);
}

function getElementRange(element: Element, lines: string[]): { line: number; col: number; endCol: number } {
    const lineNumber = (element as unknown as { lineNumber?: number }).lineNumber;
    const columnNumber = (element as unknown as { columnNumber?: number }).columnNumber;
    const line = typeof lineNumber === 'number' ? clamp(lineNumber - 1, 0, Math.max(lines.length - 1, 0)) : 0;
    const col = typeof columnNumber === 'number' ? Math.max(columnNumber - 1, 0) : 0;
    return { line, col, endCol: getLineLength(lines, line) };
}

function getLineLength(lines: string[], line: number): number {
    return lines[line]?.length ?? 0;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

interface ResolvedElementAttribute {
    displayName: string;
    localName: string;
    namespace?: string;
    value: string;
}

function validateChildPlacement(
    schema: SchemaModel,
    parentElement: Element,
    schemaDef: SchemaElement,
    childElement: Element,
    diagnostics: ManifestDiagnostic[],
    lines: string[]
): void {
    const parentLocalName = parentElement.localName || parentElement.nodeName.split(':').pop() || '';
    const childLocalName = childElement.localName || childElement.nodeName.split(':').pop() || '';
    const childNamespace = childElement.namespaceURI || '';
    if (isAllowedChild(schemaDef, childLocalName, childNamespace)) {
        return;
    }

    const childSchemaDef = findSchemaElementExact(schema, childLocalName, childNamespace);
    const range = getElementRange(childElement, lines);
    diagnostics.push({
        message: childSchemaDef
            ? `Element '${childLocalName}' is not allowed as a child of '${parentLocalName}'`
            : `Unknown element '${childLocalName}'`,
        severity: 'warning',
        ...range,
    });
}

function isAllowedChild(schemaDef: SchemaElement, childName: string, childNamespace: string): boolean {
    return schemaDef.children.some(child => {
        if (child.name === childName && child.namespace === childNamespace) {
            return true;
        }
        return (SUBSTITUTION_GROUPS[child.name] || []).some(substitution =>
            substitution.name === childName && substitution.namespace === childNamespace
        );
    });
}

function resolveElementAttributes(element: Element): ResolvedElementAttribute[] {
    const resolved: ResolvedElementAttribute[] = [];
    const attributes = element.attributes;
    if (!attributes) {
        return resolved;
    }

    for (let i = 0; i < attributes.length; i++) {
        const attribute = attributes.item(i);
        if (!attribute) { continue; }

        const displayName = attribute.nodeName;
        if (displayName === 'xmlns' || displayName.startsWith('xmlns:')) {
            continue;
        }

        const localName = attribute.localName || displayName.split(':').pop() || '';
        const prefix = attribute.prefix || displayName.split(':')[0];
        resolved.push({
            displayName,
            localName,
            namespace: displayName.includes(':') ? resolveNamespacePrefix(element, prefix) : undefined,
            value: attribute.nodeValue || '',
        });
    }

    return resolved;
}

function findResolvedAttribute(
    resolvedAttributes: ResolvedElementAttribute[],
    schemaAttribute: SchemaAttribute
): ResolvedElementAttribute | undefined {
    return resolvedAttributes.find(attribute => {
        if (attribute.localName !== schemaAttribute.name) {
            return false;
        }
        if (schemaAttribute.qualified) {
            return attribute.namespace === schemaAttribute.namespace;
        }
        return attribute.namespace === undefined;
    });
}

function resolveNamespacePrefix(contextElement: Element, prefix: string): string | undefined {
    let node: Element | null = contextElement;
    while (node) {
        const namespace = node.getAttribute(`xmlns:${prefix}`);
        if (namespace) {
            return namespace;
        }
        node = node.parentNode as Element | null;
        if (node && node.nodeType !== 1) {
            node = null;
        }
    }
    return undefined;
}

function hasPatternConstraints(attr: SchemaAttribute): boolean {
    return getPatternSets(attr).length > 0;
}

function getPatternSets(attr: SchemaAttribute): string[][] {
    if (attr.patternSets && attr.patternSets.length > 0) {
        return attr.patternSets.filter(patternSet => patternSet.length > 0);
    }
    return attr.patterns && attr.patterns.length > 0 ? [attr.patterns] : [];
}
