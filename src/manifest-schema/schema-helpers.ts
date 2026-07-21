/**
 * Shared schema-aware validation helpers for AppxManifest value checks.
 */

import { SchemaModel, SchemaAttribute, SchemaPatternType } from './schema-model';
import { validateAttributeValuePattern, validateAttributeValueLength } from './schema-validation';

const TYPES_NS = 'http://schemas.microsoft.com/appx/manifest/types';

/**
 * Look up a named simple type from the schema's patternTypes map.
 * Returns undefined if the type doesn't exist in the loaded schema.
 */
export function getPatternType(schema: SchemaModel, typeName: string): SchemaPatternType | undefined {
    return schema.patternTypes.get(`${TYPES_NS}|${typeName}`);
}

/**
 * Build a minimal SchemaAttribute from a pattern type for use with the
 * shared validation functions. Resolves the full inheritance chain to
 * collect all applicable patterns, minLength, and maxLength.
 */
export function buildAttributeFromPatternType(
    schema: SchemaModel,
    typeName: string
): SchemaAttribute | undefined {
    const patternSets: string[][] = [];
    let minLength: number | undefined;
    let maxLength: number | undefined;

    let currentKey: string | undefined = `${TYPES_NS}|${typeName}`;
    const visited = new Set<string>();

    while (currentKey && !visited.has(currentKey)) {
        visited.add(currentKey);
        const pt = schema.patternTypes.get(currentKey);
        if (!pt) { break; }

        if (pt.patterns.length > 0) {
            patternSets.push([...pt.patterns]);
        }

        if (pt.minLength !== undefined) {
            minLength = minLength !== undefined ? Math.max(minLength, pt.minLength) : pt.minLength;
        }
        if (pt.maxLength !== undefined) {
            maxLength = maxLength !== undefined ? Math.min(maxLength, pt.maxLength) : pt.maxLength;
        }

        if (pt.baseType) {
            const ns: string = currentKey.split('|')[0];
            const baseKey = `${ns}|${pt.baseType}`;
            if (schema.patternTypes.has(baseKey)) {
                currentKey = baseKey;
            } else {
                currentKey = schema.patternTypes.has(`${TYPES_NS}|${pt.baseType}`)
                    ? `${TYPES_NS}|${pt.baseType}`
                    : undefined;
            }
        } else {
            currentKey = undefined;
        }
    }

    if (patternSets.length === 0 && minLength === undefined && maxLength === undefined) {
        return undefined;
    }

    return {
        name: typeName,
        required: false,
        typeName,
        patterns: patternSets[0] ? [...patternSets[0]] : undefined,
        patternSets: patternSets.length > 0 ? patternSets : undefined,
        minLength,
        maxLength,
    };
}

/**
 * Validate a field value against a named XSD simple type.
 * Returns null if valid, or an error message string if invalid.
 * Returns null if the type is not found in the schema (fallback to semantic rules).
 */
export function validateValueAgainstType(
    schema: SchemaModel,
    typeName: string,
    value: string
): string | null {
    const attr = buildAttributeFromPatternType(schema, typeName);
    if (!attr) { return null; }

    if (!validateAttributeValuePattern(attr, value)) {
        return `Value does not match the expected format for ${typeName}`;
    }

    const lengthError = validateAttributeValueLength(attr, value);
    if (lengthError) { return lengthError; }

    return null;
}

/**
 * Check if a value matches any of the patterns defined in a named XSD type.
 * Returns true if valid (or type not found), false if it fails all patterns.
 */
export function matchesSchemaPattern(
    schema: SchemaModel,
    typeName: string,
    value: string
): boolean {
    const attr = buildAttributeFromPatternType(schema, typeName);
    if (!attr) { return true; }
    return validateAttributeValuePattern(attr, value);
}

/**
 * Check if a value is within the length constraints of a named XSD type.
 * Returns null if valid, or an error message string if invalid.
 * Returns null if the type is not found.
 */
export function checkSchemaLength(
    schema: SchemaModel,
    typeName: string,
    value: string
): string | null {
    const attr = buildAttributeFromPatternType(schema, typeName);
    if (!attr) { return null; }
    return validateAttributeValueLength(attr, value);
}

/**
 * Check if a color value is valid according to the ST_Color schema type.
 */
export function isValidSchemaColor(schema: SchemaModel, value: string): boolean {
    return matchesSchemaPattern(schema, 'ST_Color', value);
}
