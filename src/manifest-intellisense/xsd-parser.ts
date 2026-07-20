/**
 * XSD parser — reads .xsd files and populates a SchemaModel.
 * Extracts element definitions, attributes, child elements, and enumerated types.
 */

import { DOMParser } from '@xmldom/xmldom';
import type { Document, Element } from '@xmldom/xmldom';
import * as fs from 'fs';
import * as path from 'path';
import {
    SchemaModel,
    SchemaElement,
    SchemaAttribute,
    SchemaChildRef,
    SchemaEnumType,
    URI_TO_PREFIX,
} from './schema-model';

const XS_NS = 'http://www.w3.org/2001/XMLSchema';

/**
 * Load and parse all XSD files from the schemas/ directory.
 * Returns a populated SchemaModel.
 */
export function loadSchemaModel(schemasDir: string): SchemaModel {
    const model: SchemaModel = {
        elements: new Map(),
        enumTypes: new Map(),
        namespacePrefixes: new Map(URI_TO_PREFIX),
    };

    const xsdFiles = fs.readdirSync(schemasDir).filter(f => f.endsWith('.xsd'));

    // First pass: parse all types (simple types with enumerations)
    for (const file of xsdFiles) {
        const filePath = path.join(schemasDir, file);
        let content = fs.readFileSync(filePath, 'utf-8');
        // Strip BOM if present
        if (content.charCodeAt(0) === 0xFEFF) {
            content = content.substring(1);
        }
        const doc = new DOMParser().parseFromString(content, 'application/xml');
        const targetNs = doc.documentElement?.getAttribute('targetNamespace') || '';
        parseSimpleTypes(doc, targetNs, model);
    }

    // Second pass: parse elements and complex types
    for (const file of xsdFiles) {
        const filePath = path.join(schemasDir, file);
        let content = fs.readFileSync(filePath, 'utf-8');
        if (content.charCodeAt(0) === 0xFEFF) {
            content = content.substring(1);
        }
        const doc = new DOMParser().parseFromString(content, 'application/xml');
        const targetNs = doc.documentElement?.getAttribute('targetNamespace') || '';
        parseElements(doc, targetNs, model);
        parseComplexTypes(doc, targetNs, model);
    }

    // Third pass: resolve type references on elements
    resolveTypeReferences(model);

    return model;
}

/** Parse xs:simpleType elements with enumeration restrictions. */
function parseSimpleTypes(doc: Document, targetNs: string, model: SchemaModel): void {
    const root = doc.documentElement;
    if (!root) { return; }

    const simpleTypes = getElementsByLocalName(root, 'simpleType');
    for (const st of simpleTypes) {
        // Only top-level simple types (direct children of xs:schema)
        if (st.parentNode !== root) { continue; }
        const name = st.getAttribute('name');
        if (!name) { continue; }

        const values = extractEnumerations(st);
        if (values.length > 0) {
            const key = `${targetNs}|${name}`;
            model.enumTypes.set(key, {
                name,
                namespace: targetNs,
                values,
                documentation: extractDocumentation(st),
            });
        }
    }
}

/** Extract xs:enumeration values from a simple type or its restriction. */
function extractEnumerations(element: Element): string[] {
    const values: string[] = [];
    const restrictions = getElementsByLocalName(element, 'restriction');
    for (const restriction of restrictions) {
        const enums = getElementsByLocalName(restriction, 'enumeration');
        for (const e of enums) {
            const val = e.getAttribute('value');
            if (val) { values.push(val); }
        }
    }
    // Also check xs:union memberTypes for enum types
    return values;
}

/** Parse top-level xs:element definitions. */
function parseElements(doc: Document, targetNs: string, model: SchemaModel): void {
    const root = doc.documentElement;
    if (!root) { return; }

    const elements = getElementsByLocalName(root, 'element');
    for (const elem of elements) {
        // Only top-level elements
        if (elem.parentNode !== root) { continue; }
        const name = elem.getAttribute('name');
        if (!name) { continue; }

        const key = `${targetNs}|${name}`;
        if (model.elements.has(key)) { continue; }

        const schemaElem: SchemaElement = {
            name,
            namespace: targetNs,
            documentation: extractDocumentation(elem),
            children: [],
            attributes: [],
            typeName: elem.getAttribute('type') || undefined,
        };

        // If the element has an inline complexType, parse it
        const inlineTypes = getElementsByLocalName(elem, 'complexType');
        if (inlineTypes.length > 0 && inlineTypes[0].parentNode === elem) {
            parseComplexTypeContent(inlineTypes[0], targetNs, schemaElem, model, doc);
        }

        model.elements.set(key, schemaElem);
    }
}

/** Parse top-level xs:complexType definitions and associate them with elements. */
function parseComplexTypes(doc: Document, targetNs: string, model: SchemaModel): void {
    const root = doc.documentElement;
    if (!root) { return; }

    const complexTypes = getElementsByLocalName(root, 'complexType');
    for (const ct of complexTypes) {
        if (ct.parentNode !== root) { continue; }
        const typeName = ct.getAttribute('name');
        if (!typeName) { continue; }

        // Create a synthetic element entry for this type so we can resolve references later
        const key = `${targetNs}|type:${typeName}`;
        const schemaElem: SchemaElement = {
            name: typeName,
            namespace: targetNs,
            documentation: extractDocumentation(ct),
            children: [],
            attributes: [],
        };

        parseComplexTypeContent(ct, targetNs, schemaElem, model, doc);
        model.elements.set(key, schemaElem);
    }
}

/** Parse the content model of a complexType (children and attributes). */
function parseComplexTypeContent(
    ct: Element,
    targetNs: string,
    schemaElem: SchemaElement,
    model: SchemaModel,
    doc: Document
): void {
    // Parse child elements from xs:all, xs:sequence, xs:choice
    const containers = [
        ...getElementsByLocalName(ct, 'all'),
        ...getElementsByLocalName(ct, 'sequence'),
        ...getElementsByLocalName(ct, 'choice'),
    ];

    for (const container of containers) {
        // Only direct containers of this complex type (not deeply nested)
        if (!isDescendantOf(container, ct)) { continue; }
        const childElements = getElementsByLocalName(container, 'element');
        for (const childElem of childElements) {
            if (childElem.parentNode !== container) { continue; }
            const childRef = parseChildRef(childElem, targetNs, doc);
            if (childRef) {
                schemaElem.children.push(childRef);
            }

            // If this child element has an inline complexType, register it as a schema element
            const childName = childElem.getAttribute('name');
            if (childName) {
                const inlineTypes = getElementsByLocalName(childElem, 'complexType');
                if (inlineTypes.length > 0 && inlineTypes[0].parentNode === childElem) {
                    const childKey = `${targetNs}|${childName}`;
                    if (!model.elements.has(childKey)) {
                        const inlineElem: SchemaElement = {
                            name: childName,
                            namespace: targetNs,
                            documentation: extractDocumentation(childElem),
                            children: [],
                            attributes: [],
                        };
                        parseComplexTypeContent(inlineTypes[0], targetNs, inlineElem, model, doc);
                        model.elements.set(childKey, inlineElem);
                    }
                }
            }
        }
    }

    // Parse attributes
    const attrs = getElementsByLocalName(ct, 'attribute');
    for (const attr of attrs) {
        if (!isDirectOrNearChild(attr, ct)) { continue; }
        const attrDef = parseAttribute(attr, targetNs, model, doc);
        if (attrDef) {
            schemaElem.attributes.push(attrDef);
        }
    }
}

/** Parse a child element reference. */
function parseChildRef(elem: Element, targetNs: string, doc: Document): SchemaChildRef | null {
    let name = elem.getAttribute('name');
    let ns = targetNs;

    if (!name) {
        // It might be a ref
        const ref = elem.getAttribute('ref');
        if (ref) {
            const resolved = resolveQName(ref, elem, doc);
            name = resolved.localName;
            ns = resolved.namespace;
        }
    }

    if (!name) { return null; }

    const minOccurs = parseInt(elem.getAttribute('minOccurs') || '1', 10);
    const maxOccursStr = elem.getAttribute('maxOccurs') || '1';
    const maxOccurs = maxOccursStr === 'unbounded' ? -1 : parseInt(maxOccursStr, 10);

    return { name, namespace: ns, minOccurs, maxOccurs };
}

/** Parse an xs:attribute definition. */
function parseAttribute(attr: Element, targetNs: string, model: SchemaModel, doc: Document): SchemaAttribute | null {
    const name = attr.getAttribute('name');
    if (!name) { return null; }

    const use = attr.getAttribute('use') || 'optional';
    const typeRef = attr.getAttribute('type') || '';

    let enumerations: string[] | undefined;
    let typeName: string | undefined;

    if (typeRef) {
        const resolved = resolveQName(typeRef, attr, doc);
        typeName = resolved.localName;
        const typeKey = `${resolved.namespace}|${resolved.localName}`;
        const enumType = model.enumTypes.get(typeKey);
        if (enumType) {
            enumerations = enumType.values;
        }
    }

    // Check for inline simple type with enumerations
    const inlineSimple = getElementsByLocalName(attr, 'simpleType');
    if (inlineSimple.length > 0) {
        const vals = extractEnumerations(inlineSimple[0]);
        if (vals.length > 0) {
            enumerations = vals;
        }
    }

    return {
        name,
        required: use === 'required',
        typeName,
        enumerations,
        documentation: extractDocumentation(attr),
    };
}

/** Resolve type references on elements that reference named complex types. */
function resolveTypeReferences(model: SchemaModel): void {
    for (const [, elem] of model.elements) {
        if (elem.typeName && elem.children.length === 0 && elem.attributes.length === 0) {
            // Try to find the complex type
            const resolved = resolveTypeName(elem.typeName, elem.namespace, model);
            if (resolved) {
                elem.children = resolved.children;
                elem.attributes = resolved.attributes;
                if (!elem.documentation && resolved.documentation) {
                    elem.documentation = resolved.documentation;
                }
            }
        }
    }
}

/** Find a named complex type in the model. */
function resolveTypeName(typeName: string, defaultNs: string, model: SchemaModel): SchemaElement | undefined {
    // The type might be prefixed (e.g., "t:ST_Something" or "CT_Something")
    // Try the same namespace first
    const sameNsKey = `${defaultNs}|type:${typeName}`;
    if (model.elements.has(sameNsKey)) {
        return model.elements.get(sameNsKey);
    }

    // Try types namespace
    const typesNs = 'http://schemas.microsoft.com/appx/manifest/types';
    const typesKey = `${typesNs}|type:${typeName}`;
    if (model.elements.has(typesKey)) {
        return model.elements.get(typesKey);
    }

    // Search all namespaces
    for (const [key, elem] of model.elements) {
        if (key.endsWith(`|type:${typeName}`)) {
            return elem;
        }
    }

    return undefined;
}

/** Resolve a QName (prefix:localName) to namespace + localName. */
function resolveQName(qname: string, contextElement: Element, _doc: Document): { namespace: string; localName: string } {
    const colonIdx = qname.indexOf(':');
    if (colonIdx === -1) {
        // No prefix — use the target namespace of the schema
        const root = contextElement.ownerDocument?.documentElement;
        const targetNs = root?.getAttribute('targetNamespace') || '';
        return { namespace: targetNs, localName: qname };
    }

    const prefix = qname.substring(0, colonIdx);
    const localName = qname.substring(colonIdx + 1);

    // Look up the prefix in the schema element's namespace declarations
    let node: Element | null = contextElement;
    while (node) {
        const nsAttr = node.getAttribute(`xmlns:${prefix}`);
        if (nsAttr) {
            return { namespace: nsAttr, localName };
        }
        node = node.parentNode as Element | null;
        if (node && node.nodeType !== 1) { node = null; }
    }

    // Check the root element
    const root = contextElement.ownerDocument?.documentElement;
    if (root) {
        const nsAttr = root.getAttribute(`xmlns:${prefix}`);
        if (nsAttr) {
            return { namespace: nsAttr, localName };
        }
    }

    return { namespace: '', localName };
}

/** Extract documentation text from xs:annotation/xs:documentation. */
function extractDocumentation(element: Element): string | undefined {
    const annotations = getElementsByLocalName(element, 'annotation');
    for (const ann of annotations) {
        if (ann.parentNode !== element) { continue; }
        const docs = getElementsByLocalName(ann, 'documentation');
        for (const doc of docs) {
            const text = doc.textContent?.trim();
            if (text) { return text; }
        }
    }
    return undefined;
}

/** Get all descendant elements with a given local name (ignoring namespace). */
function getElementsByLocalName(parent: Element, localName: string): Element[] {
    const results: Element[] = [];
    const children = parent.childNodes;
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.nodeType === 1) {
            const elem = child as Element;
            const ln = elem.localName || elem.nodeName.split(':').pop();
            if (ln === localName) {
                results.push(elem);
            }
            // Recurse
            results.push(...getElementsByLocalName(elem, localName));
        }
    }
    return results;
}

/** Check if a node is a descendant of a given ancestor. */
function isDescendantOf(node: Element, ancestor: Element): boolean {
    let current = node.parentNode;
    while (current) {
        if (current === ancestor) { return true; }
        current = current.parentNode;
    }
    return false;
}

/** Check if an attribute element is a direct or near-child of the complex type. */
function isDirectOrNearChild(attr: Element, ct: Element): boolean {
    // Attributes can be direct children of complexType, or inside xs:complexContent/xs:extension
    let current = attr.parentNode;
    let depth = 0;
    while (current && depth < 4) {
        if (current === ct) { return true; }
        current = current.parentNode;
        depth++;
    }
    return false;
}
