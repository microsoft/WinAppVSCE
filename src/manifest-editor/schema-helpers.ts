/**
 * Schema-aware validation helpers for the manifest editor.
 * 
 * Provides functions that use the shared XSD schema model to validate
 * individual field values, replacing hand-written regex patterns with
 * schema-derived constraints.
 * 
 * Semantic rules NOT expressible in XSD (version comparison, reserved names,
 * image extension checks, etc.) remain in manifest-validator.ts.
 */

import { SchemaModel, SchemaAttribute, SchemaPatternType } from '../manifest-schema/schema-model';
import { validateAttributeValuePattern, validateAttributeValueLength } from '../manifest-schema/schema-validation';

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
    const allPatterns: string[] = [];
    let minLength: number | undefined;
    let maxLength: number | undefined;

    let currentKey: string | undefined = `${TYPES_NS}|${typeName}`;
    const visited = new Set<string>();

    while (currentKey && !visited.has(currentKey)) {
        visited.add(currentKey);
        const pt = schema.patternTypes.get(currentKey);
        if (!pt) { break; }

        // Collect patterns from this level
        if (pt.patterns.length > 0 && allPatterns.length === 0) {
            // Use the most-derived type's patterns (first ones found)
            allPatterns.push(...pt.patterns);
        }

        // Use most restrictive length constraints (max of minLengths, min of maxLengths)
        if (pt.minLength !== undefined) {
            minLength = minLength !== undefined ? Math.max(minLength, pt.minLength) : pt.minLength;
        }
        if (pt.maxLength !== undefined) {
            maxLength = maxLength !== undefined ? Math.min(maxLength, pt.maxLength) : pt.maxLength;
        }

        // Walk up the inheritance chain
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

    if (allPatterns.length === 0 && minLength === undefined && maxLength === undefined) {
        return undefined;
    }

    return {
        name: typeName,
        required: false,
        typeName,
        patterns: allPatterns.length > 0 ? allPatterns : undefined,
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
    if (!attr) { return null; } // type not found, skip schema validation

    // Check pattern constraints
    if (!validateAttributeValuePattern(attr, value)) {
        return `Value does not match the expected format for ${typeName}`;
    }

    // Check length constraints
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
    if (!attr) { return true; } // type not found, assume valid
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
 * This replaces the hand-written HEX_COLOR_REGEX + NAMED_COLORS check.
 */
export function isValidSchemaColor(schema: SchemaModel, value: string): boolean {
    return matchesSchemaPattern(schema, 'ST_Color', value);
}
