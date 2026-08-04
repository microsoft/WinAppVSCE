/**
 * Shared schema-aware validation helpers for AppxManifest value checks.
 */

import { SchemaModel, SchemaAttribute, SchemaPatternType } from './schema-model';
import { validateAttributeValuePattern, validateAttributeValueLength, TYPE_DESCRIPTIONS } from './schema-validation';
import { resolvePatternConstraints } from './xsd-parser';

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
 * shared validation functions. Delegates to the shared
 * resolvePatternConstraints() walker in xsd-parser.ts to avoid duplicating
 * the inheritance-chain traversal logic.
 */
export function buildAttributeFromPatternType(
    schema: SchemaModel,
    typeName: string
): SchemaAttribute | undefined {
    const resolved = resolvePatternConstraints(`${TYPES_NS}|${typeName}`, schema);
    if (!resolved) {
        return undefined;
    }

    return {
        name: typeName,
        required: false,
        typeName,
        patterns: resolved.patternSets[0] ? [...resolved.patternSets[0]] : undefined,
        patternSets: resolved.patternSets.length > 0
            ? resolved.patternSets.map(set => [...set])
            : undefined,
        minLength: resolved.minLength,
        maxLength: resolved.maxLength,
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
        const friendly = TYPE_DESCRIPTIONS[typeName];
        if (friendly) {
            return `Value does not match the expected format for ${typeName} — expected ${friendly}`;
        }
        const patterns = (attr.patternSets && attr.patternSets.length > 0
            ? attr.patternSets[0] : attr.patterns || [])
            .slice(0, 3).map(p => `/${p}/`);
        const patternHint = patterns.length > 0 ? `\n\nExpected pattern: ${patterns.join(' or ')}` : '';
        return `Value does not match the expected format for ${typeName}${patternHint}`;
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
