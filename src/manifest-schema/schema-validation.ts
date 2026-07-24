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
    severity: 'hint' | 'warning' | 'error';
    line: number;
    col: number;
    endCol: number;
    /** Schema namespace URI for the element that produced this diagnostic. */
    schemaUri?: string;
}

export interface ManifestValidationOptions {
    strictChildPlacement?: boolean;
}

/**
 * Validate an entire manifest XML document against the schema model.
 * Parses the XML and walks all elements, checking required attributes,
 * enum values, pattern constraints, and length restrictions.
 */
export function validateManifestText(
    schema: SchemaModel,
    text: string,
    level: 'warning' | 'error' = 'warning',
    options: ManifestValidationOptions = {}
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

    validateElement(schema, doc.documentElement, diagnostics, level, lines, options, 0);
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
    lines: string[],
    options: ManifestValidationOptions,
    depth: number
): void {
    const localName = element.localName || element.nodeName.split(':').pop() || '';
    const ns = element.namespaceURI || '';

    const schemaDef = findSchemaElementExact(schema, localName, ns);
    if (!schemaDef) {
        if (depth === 0) {
            const range = getElementRange(element, lines);
            diagnostics.push({
                message: `Root element '${localName}' not recognized in schema`,
                severity: 'warning',
                ...range,
            });
        }
        validateChildren(schema, element, undefined, diagnostics, severity, lines, options, depth);
        return;
    }

    const resolvedAttributes = resolveElementAttributes(element);
    const schemaUri = ns || undefined;

    // Check required attributes
    for (const attr of schemaDef.attributes) {
        if (attr.required && !findResolvedAttribute(resolvedAttributes, attr)) {
            const range = getElementRange(element, lines);
            diagnostics.push({
                message: `Missing required attribute '${attr.name}' on <${localName}>`,
                severity,
                schemaUri,
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
                schemaUri,
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
            const patternHint = formatPatternHint(attr);
            diagnostics.push({
                message: `Value '${resolvedAttribute.value}' for attribute '${attr.name}' is invalid${patternHint}`,
                severity,
                schemaUri,
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
                schemaUri,
                ...range,
            });
        }
        if (attr.maxLength !== undefined && resolvedAttribute.value.length > attr.maxLength) {
            const range = getAttributeValueRange(element, resolvedAttribute.displayName, lines);
            diagnostics.push({
                message: `Value for '${attr.name}' exceeds maximum length of ${attr.maxLength} characters (got ${resolvedAttribute.value.length})`,
                severity,
                schemaUri,
                ...range,
            });
        }
    }

    for (const resolvedAttribute of resolvedAttributes) {
        if (resolvedAttribute.displayName.startsWith('xmlns') || resolvedAttribute.displayName.startsWith('xml:')) {
            continue;
        }
        // Use namespace-aware matching: an attribute is declared only if both
        // local name and namespace/qualification match a schema attribute.
        const declaredAttribute = schemaDef.attributes.find(attr => {
            if (attr.name !== resolvedAttribute.localName) { return false; }
            if (attr.qualified) {
                return resolvedAttribute.namespace === attr.namespace;
            }
            return resolvedAttribute.namespace === undefined;
        });
        if (declaredAttribute) {
            continue;
        }
        const range = getAttributeValueRange(element, resolvedAttribute.displayName, lines);
        diagnostics.push({
            message: `Attribute '${resolvedAttribute.displayName}' is not declared in the schema for element '${localName}'`,
            severity: 'hint',
            schemaUri,
            ...range,
        });
    }

    validateChildren(schema, element, schemaDef, diagnostics, severity, lines, options, depth);
}

function validateChildren(
    schema: SchemaModel,
    element: Element,
    schemaDef: SchemaElement | undefined,
    diagnostics: ManifestDiagnostic[],
    severity: 'warning' | 'error',
    lines: string[],
    options: ManifestValidationOptions,
    depth: number
): void {
    const children = element.childNodes;
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.nodeType === 1) {
            const childElement = child as Element;
            if (schemaDef) {
                validateChildPlacement(schema, element, schemaDef, childElement, diagnostics, lines, options);
            }
            validateElement(schema, childElement, diagnostics, severity, lines, options, depth + 1);
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
    lines: string[],
    options: ManifestValidationOptions
): void {
    const childLocalName = childElement.localName || childElement.nodeName.split(':').pop() || '';
    const childNamespace = childElement.namespaceURI || '';
    if (isAllowedChild(schema, schemaDef, childLocalName, childNamespace)) {
        return;
    }

    const parentNs = parentElement.namespaceURI || '';

    const childSchemaDef = findSchemaElementExact(schema, childLocalName, childNamespace);
    if (childSchemaDef) {
        if (!options.strictChildPlacement) {
            return;
        }

        const range = getElementRange(childElement, lines);
        diagnostics.push({
            message: `Element '${childLocalName}' is not allowed under <${parentElement.localName || parentElement.nodeName.split(':').pop() || ''}>`,
            severity: 'warning',
            schemaUri: parentNs || undefined,
            ...range,
        });
        return;
    }
    const range = getElementRange(childElement, lines);
    diagnostics.push({
        message: `Unknown element '${childLocalName}'`,
        severity: 'warning',
        schemaUri: childNamespace || undefined,
        ...range,
    });
}

function isAllowedChild(schema: SchemaModel, schemaDef: SchemaElement, childName: string, childNamespace: string): boolean {
    return schemaDef.children.some(child => {
        if (child.name === childName && child.namespace === childNamespace) {
            return true;
        }
        return (schema.substitutionGroups.get(child.name) || []).some(substitution =>
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

/** Human-readable descriptions for common XSD simple types. */
export const TYPE_DESCRIPTIONS: Record<string, string> = {
    ST_VersionQuad: 'a dot-quad version number (e.g. "1.0.0.0")',
    ST_VersionQuadNoneZero: 'a dot-quad version number with non-zero components',
    ST_Publisher: 'an X.500 distinguished name (e.g. "CN=Contoso")',
    ST_Publisher_2010_v2: 'an X.500 distinguished name (e.g. "CN=Contoso")',
    ST_PackageName: 'a package name using letters, digits, hyphens, and periods (e.g. "MyCompany.My-App")',
    ST_GUID: 'a GUID (e.g. "01234567-89ab-cdef-0123-456789abcdef")',
    ST_ApplicationId: 'a dot-separated identifier where each segment starts with a letter (e.g. "App" or "My.App")',
    ST_Protocol: 'a protocol name using lowercase letters, digits, and ".", "+", "-"',
    ST_Protocol_2010_v2: 'a protocol name using lowercase letters, digits, and ".", "+", "-"',
    ST_Protocol_2019: 'a protocol name using lowercase letters, digits, and ".", "+", "-"',
    ST_Color: 'a hex color (e.g. "#FF0000") or a named color (e.g. "red")',
    ST_DisplayName: 'a display name (1-256 characters, cannot start/end with whitespace)',
    ST_ShortDisplayName: 'a short display name (1-40 characters)',
    ST_Description: 'a description (1-2048 characters)',
    ST_ImageFile: 'an image file path (e.g. "Assets\\Logo.png")',
    ST_Executable: 'an executable path (e.g. "MyApp.exe")',
    ST_ExecutableAnyCase: 'an executable path (e.g. "MyApp.exe")',
    ST_ExecutableNoPath: 'an executable filename without path (e.g. "MyApp.exe")',
    ST_FileName: 'a filename (e.g. "myfile.dll")',
    ST_FileNameFullPath: 'a full file path',
    ST_DllFile: 'a DLL filename (e.g. "mylib.dll")',
    ST_EntryPoint: 'an entry point string (up to 256 characters)',
    ST_ContentType: 'a MIME content type (e.g. "image/png")',
    ST_URI: 'a URI (e.g. "https://example.com")',
    ST_NonEmptyString: 'a non-empty string',
    ST_ResourceId: 'a resource identifier using alphanumeric characters, periods, and hyphens',
    ST_CustomCapability: 'a custom capability in the format "name_publisherId" (e.g. "com.company.cap_abc1de2fg3hij")',
    ST_FTAName: 'a file type association using lowercase letters, digits, hyphens, underscores, and periods (e.g. ".txt")',
    ST_ActivatableClassId: 'an activatable class ID (e.g. "MyNamespace.MyClass")',
    ST_AsciiWindowsId: 'a dot-separated identifier where each segment starts with a letter (e.g. "MyApp.Widget")',
    ST_ProgId: 'a programmatic identifier starting with a letter (e.g. "MyApp.Document.1")',
    ST_Date: 'an ISO date (e.g. "2024-01-15")',
};

/** Build an informative suffix for pattern validation errors. */
function formatPatternHint(attr: SchemaAttribute): string {
    const parts: string[] = [];

    // Try to provide a human-readable description based on the type name
    const friendlyDesc = attr.typeName ? TYPE_DESCRIPTIONS[attr.typeName] : undefined;
    if (friendlyDesc) {
        parts.push(`expected ${friendlyDesc}`);
    } else if (attr.typeName) {
        parts.push(`according to its datatype '${attr.typeName}'`);
    }

    // If no friendly description, fall back to showing the raw pattern
    if (!friendlyDesc) {
        const patternSets = getPatternSets(attr);
        if (patternSets.length > 0) {
            const displayPatterns = patternSets[0]
                .slice(0, 3)
                .map(p => `/${p}/`);
            const patternText = displayPatterns.join(' or ');
            const suffix = patternSets[0].length > 3 ? ' (and more)' : '';
            parts.push(`\n\nExpected pattern: ${patternText}${suffix}`);
        }
    }

    return parts.length > 0 ? ` — ${parts.join('. ')}` : '';
}
