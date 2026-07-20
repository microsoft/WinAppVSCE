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
}

/** Represents an attribute on an element. */
export interface SchemaAttribute {
    /** Attribute name. */
    name: string;
    /** Whether the attribute is required. */
    required: boolean;
    /** Type name (simple type reference). */
    typeName?: string;
    /** Enumerated values if the type is a restriction with enumerations. */
    enumerations?: string[];
    /** Documentation. */
    documentation?: string;
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

/** The full schema model combining all parsed XSD information. */
export interface SchemaModel {
    /** All element definitions keyed by "namespace|localName". */
    elements: Map<string, SchemaElement>;
    /** All enum types keyed by "namespace|typeName". */
    enumTypes: Map<string, SchemaEnumType>;
    /** Namespace URI to common prefix mapping. */
    namespacePrefixes: Map<string, string>;
}

/** Well-known namespace URIs for AppxManifest. */
export const MANIFEST_NAMESPACES: Record<string, string> = {
    '': 'http://schemas.microsoft.com/appx/manifest/foundation/windows10',
    'uap': 'http://schemas.microsoft.com/appx/manifest/uap/windows10',
    'uap2': 'http://schemas.microsoft.com/appx/manifest/uap/windows10/2',
    'uap3': 'http://schemas.microsoft.com/appx/manifest/uap/windows10/3',
    'uap4': 'http://schemas.microsoft.com/appx/manifest/uap/windows10/4',
    'uap5': 'http://schemas.microsoft.com/appx/manifest/uap/windows10/5',
    'uap6': 'http://schemas.microsoft.com/appx/manifest/uap/windows10/6',
    'uap7': 'http://schemas.microsoft.com/appx/manifest/uap/windows10/7',
    'uap10': 'http://schemas.microsoft.com/appx/manifest/uap/windows10/10',
    'rescap': 'http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities',
    'desktop': 'http://schemas.microsoft.com/appx/manifest/desktop/windows10',
    'desktop2': 'http://schemas.microsoft.com/appx/manifest/desktop/windows10/2',
    'desktop3': 'http://schemas.microsoft.com/appx/manifest/desktop/windows10/3',
    'com': 'http://schemas.microsoft.com/appx/manifest/com/windows10',
    't': 'http://schemas.microsoft.com/appx/manifest/types',
};

/** Reverse map: namespace URI → preferred prefix. */
export const URI_TO_PREFIX: Map<string, string> = new Map(
    Object.entries(MANIFEST_NAMESPACES).map(([prefix, uri]) => [uri, prefix])
);
