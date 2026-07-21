/**
 * Shared manifest schema infrastructure.
 * 
 * This module provides XSD schema parsing, schema model types, XML context
 * analysis, and schema-driven validation for AppxManifest files.
 * 
 * It has NO dependency on VS Code and can be consumed by both:
 * - manifest-intellisense (real-time IntelliSense in text editors)
 * - manifest-editor (webview form editor validation)
 */

// Schema model types and namespace constants
export {
    SchemaElement,
    SchemaChildRef,
    SchemaAttribute,
    SchemaEnumType,
    SchemaPatternType,
    SchemaModel,
    MANIFEST_NAMESPACES,
    URI_TO_PREFIX,
} from './schema-model';

// XSD parser
export { loadSchemaModel } from './xsd-parser';

// XML context analysis
export {
    XmlContextType,
    XmlContext,
    ParentElement,
    getXmlContext,
    findParentPath,
    splitPrefixedName,
} from './xml-context';

// Schema-driven validation
export {
    ManifestDiagnostic,
    ManifestValidationOptions,
    validateManifestText,
    findSchemaElementExact,
    validateAttributeValuePattern,
    validateAttributeValueLength,
    validateAttributeValueEnum,
    getAttributeValueRange,
} from './schema-validation';

export {
    getPatternType,
    buildAttributeFromPatternType,
    validateValueAgainstType,
    matchesSchemaPattern,
    checkSchemaLength,
    isValidSchemaColor,
} from './schema-helpers';
