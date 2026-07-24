/**
 * Type definitions for the parsed XSD schema model used by IntelliSense.
 */

/** Represents a parsed XSD element definition. */
export interface SchemaElement {
    /** Local name of the element (e.g., "Package", "Identity"). */
    name: string;
    /** Namespace URI this element belongs to. */
    namespace: string;
    /** Documentation from xs:annotation/xs:documentation. */
    documentation?: string;
    /** Child elements allowed inside this element. */
    children: SchemaChildRef[];
    /** Attributes defined on this element. */
    attributes: SchemaAttribute[];
    /** The complex type name if this element references a named type. */
    typeName?: string;
    /** Base simple type name used for the element's text content, if any. */
    simpleTypeName?: string;
    /** Namespace URI for the element's base simple type, if any. */
    simpleTypeNamespace?: string;
    /** Base complex type name if this type extends another type. */
    baseTypeName?: string;
    /** Absolute path to the XSD file where this element is defined. */
    sourceFile?: string;
    /** 0-based line number in the source XSD file. */
    sourceLine?: number;
}

/** Reference to a child element within a parent. */
export interface SchemaChildRef {
    /** Local name of the child element. */
    name: string;
    /** Namespace URI (empty string for same namespace as parent). */
    namespace: string;
    /** Minimum occurrences (0 = optional). */
    minOccurs: number;
    /** Maximum occurrences (-1 = unbounded). */
    maxOccurs: number;
    /** Named complex type referenced by the child element, if any. */
    typeName?: string;
}

/** Represents an attribute on an element. */
export interface SchemaAttribute {
    /** Attribute name. */
    name: string;
    /** True when the attribute must be namespace-qualified in XML. */
    qualified?: boolean;
    /** Namespace URI used when the attribute is namespace-qualified. */
    namespace?: string;
    /** Whether the attribute is required. */
    required: boolean;
    /** Type name (simple type reference). */
    typeName?: string;
    /** Enumerated values if the type is a restriction with enumerations. */
    enumerations?: string[];
    /** Most-derived pattern constraints (regex strings) from xs:pattern facets. */
    patterns?: string[];
    /** Pattern constraints grouped by restriction level (OR within, AND between sets). */
    patternSets?: string[][];
    /** Minimum string length from xs:minLength. */
    minLength?: number;
    /** Maximum string length from xs:maxLength. */
    maxLength?: number;
    /** Documentation. */
    documentation?: string;
    /** Absolute path to the XSD file where this attribute is defined. */
    sourceFile?: string;
    /** 0-based line number in the source XSD file. */
    sourceLine?: number;
}

/** A simple type with enumeration restrictions. */
export interface SchemaEnumType {
    /** Type name. */
    name: string;
    /** Namespace URI. */
    namespace: string;
    /** Allowed values. */
    values: string[];
    /** Documentation. */
    documentation?: string;
}

/** A simple type with pattern/length constraints. */
export interface SchemaPatternType {
    /** Type name. */
    name: string;
    /** Namespace URI. */
    namespace: string;
    /** Pattern constraints (regex strings). */
    patterns: string[];
    /** Minimum string length. */
    minLength?: number;
    /** Maximum string length. */
    maxLength?: number;
    /** Base type name (for inheritance chain resolution). */
    baseType?: string;
}

/** The full schema model combining all parsed XSD information. */
export interface SchemaModel {
    /** All element definitions keyed by "namespace|localName". */
    elements: Map<string, SchemaElement>;
    /** All enum types keyed by "namespace|typeName". */
    enumTypes: Map<string, SchemaEnumType>;
    /** All pattern types keyed by "namespace|typeName". */
    patternTypes: Map<string, SchemaPatternType>;
    /** Namespace URI to common prefix mapping. */
    namespacePrefixes: Map<string, string>;
    /** Substitution groups: abstract element local name → concrete members. */
    substitutionGroups: Map<string, Array<{ name: string; namespace: string }>>;
}

/** Well-known namespace URIs for AppxManifest. */
export const MANIFEST_NAMESPACES: Record<string, string> = {
    '': 'http://schemas.microsoft.com/appx/manifest/foundation/windows10',
    'foundation2': 'http://schemas.microsoft.com/appx/manifest/foundation/windows10/2',
    'uap': 'http://schemas.microsoft.com/appx/manifest/uap/windows10',
    'uap2': 'http://schemas.microsoft.com/appx/manifest/uap/windows10/2',
    'uap3': 'http://schemas.microsoft.com/appx/manifest/uap/windows10/3',
    'uap4': 'http://schemas.microsoft.com/appx/manifest/uap/windows10/4',
    'uap5': 'http://schemas.microsoft.com/appx/manifest/uap/windows10/5',
    'uap6': 'http://schemas.microsoft.com/appx/manifest/uap/windows10/6',
    'uap7': 'http://schemas.microsoft.com/appx/manifest/uap/windows10/7',
    'uap8': 'http://schemas.microsoft.com/appx/manifest/uap/windows10/8',
    'uap10': 'http://schemas.microsoft.com/appx/manifest/uap/windows10/10',
    'uap11': 'http://schemas.microsoft.com/appx/manifest/uap/windows10/11',
    'uap12': 'http://schemas.microsoft.com/appx/manifest/uap/windows10/12',
    'uap13': 'http://schemas.microsoft.com/appx/manifest/uap/windows10/13',
    'rescap': 'http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities',
    'desktop': 'http://schemas.microsoft.com/appx/manifest/desktop/windows10',
    'desktop2': 'http://schemas.microsoft.com/appx/manifest/desktop/windows10/2',
    'desktop3': 'http://schemas.microsoft.com/appx/manifest/desktop/windows10/3',
    'com': 'http://schemas.microsoft.com/appx/manifest/com/windows10',
    'm': 'http://schemas.microsoft.com/appx/2010/manifest',
    't': 'http://schemas.microsoft.com/appx/manifest/types',
};

/** Reverse map: namespace URI → preferred prefix. */
export const URI_TO_PREFIX: Map<string, string> = new Map(
    Object.entries(MANIFEST_NAMESPACES).map(([prefix, uri]) => [uri, prefix])
);
