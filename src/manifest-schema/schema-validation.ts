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
        validateChildren(schema, element, diagnostics, severity, lines);
        return;
    }

    // Check required attributes
    for (const attr of schemaDef.attributes) {
        // TODO: Resolve qualified attributes via namespace-aware DOM lookup instead of skipping validation.
        if (attr.qualified) { continue; }
        if (attr.required && !element.hasAttribute(attr.name)) {
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
        if (attr.qualified) { continue; }
        if (!attr.enumerations || attr.enumerations.length === 0) { continue; }
        const value = element.getAttribute(attr.name);
        if (value !== null && !attr.enumerations.includes(value)) {
            const range = getElementRange(element, lines);
            diagnostics.push({
                message: `Invalid value '${value}' for attribute '${attr.name}'. Expected one of: ${attr.enumerations.slice(0, 10).join(', ')}`,
                severity,
                ...range,
            });
        }
    }

    // Validate attribute values against pattern constraints
    for (const attr of schemaDef.attributes) {
        if (attr.qualified) { continue; }
        if (!attr.patterns || attr.patterns.length === 0) { continue; }
        if (attr.enumerations && attr.enumerations.length > 0) { continue; } // enum validation already covers this
        const value = element.getAttribute(attr.name);
        if (value === null) { continue; }
        const matchesAnyPattern = attr.patterns.some(pattern => {
            // XSD-sourced regexes can be expensive on arbitrarily long input, so cap the value length.
            if (value.length > 1024) {
                return true;
            }
            try {
                return new RegExp(`^(?:${pattern})$`).test(value);
            } catch {
                return true; // skip invalid regex patterns
            }
        });
        if (!matchesAnyPattern) {
            const range = getAttributeValueRange(element, attr.name, lines);
            diagnostics.push({
                message: `Value '${value}' for attribute '${attr.name}' does not match the expected pattern`,
                severity,
                ...range,
            });
        }
    }

    // Validate attribute value lengths
    for (const attr of schemaDef.attributes) {
        if (attr.qualified) { continue; }
        if (attr.minLength === undefined && attr.maxLength === undefined) { continue; }
        const value = element.getAttribute(attr.name);
        if (value === null) { continue; }
        if (attr.minLength !== undefined && value.length < attr.minLength) {
            const range = getAttributeValueRange(element, attr.name, lines);
            diagnostics.push({
                message: `Value for '${attr.name}' must be at least ${attr.minLength} characters (got ${value.length})`,
                severity,
                ...range,
            });
        }
        if (attr.maxLength !== undefined && value.length > attr.maxLength) {
            const range = getAttributeValueRange(element, attr.name, lines);
            diagnostics.push({
                message: `Value for '${attr.name}' exceeds maximum length of ${attr.maxLength} characters (got ${value.length})`,
                severity,
                ...range,
            });
        }
    }

    validateChildren(schema, element, diagnostics, severity, lines);
}

function validateChildren(
    schema: SchemaModel,
    element: Element,
    diagnostics: ManifestDiagnostic[],
    severity: 'warning' | 'error',
    lines: string[]
): void {
    const children = element.childNodes;
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.nodeType === 1) {
            validateElement(schema, child as Element, diagnostics, severity, lines);
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
 * Returns true if valid (or no patterns), false if it fails all patterns.
 * Useful for manifest-editor to validate individual field values against XSD patterns.
 */
export function validateAttributeValuePattern(attr: SchemaAttribute, value: string): boolean {
    if (!attr.patterns || attr.patterns.length === 0) { return true; }
    if (attr.enumerations && attr.enumerations.length > 0) { return true; } // enum check takes precedence
    if (value.length > 1024) { return true; } // ReDoS safety
    return attr.patterns.some(pattern => {
        try {
            return new RegExp(`^(?:${pattern})$`).test(value);
        } catch {
            return true;
        }
    });
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
