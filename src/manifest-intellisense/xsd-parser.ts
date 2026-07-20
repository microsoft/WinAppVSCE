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
const TYPES_NS = 'http://schemas.microsoft.com/appx/manifest/types';

interface ParsedSchemaDocument {
    doc: Document;
    targetNs: string;
}

interface SchemaParseContext {
    attributeDefinitions: Map<string, Element>;
    attributeGroupDefinitions: Map<string, Element>;
}

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

    const parsedDocs = loadSchemaDocuments(schemasDir);
    const parseContext = buildParseContext(parsedDocs);

    // First pass: parse all types (simple types with enumerations)
    for (const { doc, targetNs } of parsedDocs) {
        parseSimpleTypes(doc, targetNs, model);
    }

    // Second pass: parse elements and complex types
    for (const { doc, targetNs } of parsedDocs) {
        parseElements(doc, targetNs, model, parseContext);
        parseComplexTypes(doc, targetNs, model, parseContext);
    }

    // Third pass: resolve type references on elements
    resolveTypeReferences(model);

    return model;
}

function loadSchemaDocuments(schemasDir: string): ParsedSchemaDocument[] {
    return fs.readdirSync(schemasDir)
        .filter(file => file.endsWith('.xsd'))
        .map(file => {
            const filePath = path.join(schemasDir, file);
            let content = fs.readFileSync(filePath, 'utf-8');
            if (content.charCodeAt(0) === 0xFEFF) {
                content = content.substring(1);
            }

            const doc = new DOMParser().parseFromString(content, 'application/xml');
            const targetNs = doc.documentElement?.getAttribute('targetNamespace') || '';
            return { doc, targetNs };
        });
}

function buildParseContext(parsedDocs: ParsedSchemaDocument[]): SchemaParseContext {
    const attributeDefinitions = new Map<string, Element>();
    const attributeGroupDefinitions = new Map<string, Element>();

    for (const { doc, targetNs } of parsedDocs) {
        const root = doc.documentElement;
        if (!root) { continue; }

        const topLevelChildren = getDirectChildElements(root);
        for (const child of topLevelChildren) {
            const localName = getLocalName(child);
            const name = child.getAttribute('name');
            if (!name) { continue; }

            const key = `${targetNs}|${name}`;
            if (localName === 'attribute' && !attributeDefinitions.has(key)) {
                attributeDefinitions.set(key, child);
            }
            if (localName === 'attributeGroup' && !attributeGroupDefinitions.has(key)) {
                attributeGroupDefinitions.set(key, child);
            }
        }
    }

    return { attributeDefinitions, attributeGroupDefinitions };
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
    return values;
}

/** Parse top-level xs:element definitions. */
function parseElements(doc: Document, targetNs: string, model: SchemaModel, parseContext: SchemaParseContext): void {
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

        const typeReference = resolveTypeReference(elem.getAttribute('type'), elem, doc);
        const schemaElem: SchemaElement = {
            name,
            namespace: targetNs,
            documentation: extractDocumentation(elem),
            children: [],
            attributes: [],
            typeName: typeReference?.localName,
        };

        const inlineTypes = getDirectChildrenByLocalName(elem, 'complexType');
        if (inlineTypes.length > 0) {
            parseComplexTypeContent(inlineTypes[0], targetNs, schemaElem, model, parseContext, doc);
        }

        model.elements.set(key, schemaElem);
    }
}

/** Parse top-level xs:complexType definitions and associate them with elements. */
function parseComplexTypes(doc: Document, targetNs: string, model: SchemaModel, parseContext: SchemaParseContext): void {
    const root = doc.documentElement;
    if (!root) { return; }

    const complexTypes = getElementsByLocalName(root, 'complexType');
    for (const ct of complexTypes) {
        if (ct.parentNode !== root) { continue; }
        const typeName = ct.getAttribute('name');
        if (!typeName) { continue; }

        const key = `${targetNs}|type:${typeName}`;
        const schemaElem: SchemaElement = {
            name: typeName,
            namespace: targetNs,
            documentation: extractDocumentation(ct),
            children: [],
            attributes: [],
        };

        parseComplexTypeContent(ct, targetNs, schemaElem, model, parseContext, doc);
        model.elements.set(key, schemaElem);
    }
}

/** Parse the content model of a complexType (children and attributes). */
function parseComplexTypeContent(
    ct: Element,
    targetNs: string,
    schemaElem: SchemaElement,
    model: SchemaModel,
    parseContext: SchemaParseContext,
    doc: Document
): void {
    const complexContent = getDirectChildrenByLocalName(ct, 'complexContent')[0];
    const extension = complexContent
        ? getDirectChildrenByLocalName(complexContent, 'extension')[0]
        : undefined;
    const scope = extension ?? ct;

    if (extension) {
        const baseReference = resolveTypeReference(extension.getAttribute('base'), extension, doc);
        schemaElem.baseTypeName = baseReference?.localName;
    }

    parseChildElements(scope, targetNs, schemaElem, model, parseContext, doc);
    parseAttributesAndGroups(scope, targetNs, schemaElem, model, parseContext, doc);
}

function parseChildElements(
    scope: Element,
    targetNs: string,
    schemaElem: SchemaElement,
    model: SchemaModel,
    parseContext: SchemaParseContext,
    doc: Document
): void {
    for (const container of collectParticleContainers(scope)) {
        const childElements = getDirectChildrenByLocalName(container, 'element');
        for (const childElem of childElements) {
            const childRef = parseChildRef(childElem, targetNs, doc);
            if (childRef) {
                mergeChild(schemaElem.children, childRef);
            }

            const childName = childElem.getAttribute('name');
            if (childName) {
                const inlineTypes = getDirectChildrenByLocalName(childElem, 'complexType');
                if (inlineTypes.length > 0) {
                    const childKey = `${targetNs}|${childName}`;
                    if (!model.elements.has(childKey)) {
                        const inlineElem: SchemaElement = {
                            name: childName,
                            namespace: targetNs,
                            documentation: extractDocumentation(childElem),
                            children: [],
                            attributes: [],
                        };
                        parseComplexTypeContent(inlineTypes[0], targetNs, inlineElem, model, parseContext, doc);
                        model.elements.set(childKey, inlineElem);
                    }
                }
            }
        }
    }
}

function parseAttributesAndGroups(
    scope: Element,
    targetNs: string,
    schemaElem: SchemaElement,
    model: SchemaModel,
    parseContext: SchemaParseContext,
    doc: Document
): void {
    for (const child of getDirectChildElements(scope)) {
        const localName = getLocalName(child);
        if (localName === 'attribute') {
            const attrDef = parseAttribute(child, targetNs, model, parseContext, doc);
            if (attrDef) {
                mergeAttribute(schemaElem.attributes, attrDef);
            }
            continue;
        }

        if (localName === 'attributeGroup') {
            expandAttributeGroup(child, targetNs, schemaElem, model, parseContext, doc, new Set<string>());
        }
    }
}

function expandAttributeGroup(
    attributeGroupRef: Element,
    targetNs: string,
    schemaElem: SchemaElement,
    model: SchemaModel,
    parseContext: SchemaParseContext,
    doc: Document,
    visitedGroups: Set<string>
): void {
    const ref = attributeGroupRef.getAttribute('ref');
    if (!ref) { return; }

    const resolvedRef = resolveQName(ref, attributeGroupRef, doc);
    const key = `${resolvedRef.namespace}|${resolvedRef.localName}`;
    if (visitedGroups.has(key)) { return; }
    visitedGroups.add(key);

    const groupDefinition = parseContext.attributeGroupDefinitions.get(key);
    if (!groupDefinition) { return; }

    for (const child of getDirectChildElements(groupDefinition)) {
        const localName = getLocalName(child);
        if (localName === 'attribute') {
            const attrDef = parseAttribute(child, targetNs, model, parseContext, doc);
            if (attrDef) {
                mergeAttribute(schemaElem.attributes, attrDef);
            }
            continue;
        }

        if (localName === 'attributeGroup') {
            expandAttributeGroup(child, targetNs, schemaElem, model, parseContext, doc, visitedGroups);
        }
    }
}

/** Parse a child element reference. */
function parseChildRef(elem: Element, targetNs: string, doc: Document): SchemaChildRef | null {
    let name = elem.getAttribute('name');
    let ns = targetNs;

    if (!name) {
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
    const typeReference = resolveTypeReference(elem.getAttribute('type'), elem, doc);

    return {
        name,
        namespace: ns,
        minOccurs,
        maxOccurs,
        typeName: typeReference?.localName,
    };
}

/** Parse an xs:attribute definition. */
function parseAttribute(
    attr: Element,
    targetNs: string,
    model: SchemaModel,
    parseContext: SchemaParseContext,
    doc: Document
): SchemaAttribute | null {
    let sourceAttr = attr;
    let name = attr.getAttribute('name');

    if (!name) {
        const ref = attr.getAttribute('ref');
        if (ref) {
            const resolvedRef = resolveQName(ref, attr, doc);
            name = resolvedRef.localName;
            const referencedAttr = parseContext.attributeDefinitions.get(`${resolvedRef.namespace}|${resolvedRef.localName}`);
            if (referencedAttr) {
                sourceAttr = referencedAttr;
            }
        }
    }

    if (!name) { return null; }

    const use = attr.getAttribute('use') || sourceAttr.getAttribute('use') || 'optional';
    const typeReference = resolveTypeReference(
        sourceAttr.getAttribute('type') || attr.getAttribute('type'),
        sourceAttr,
        sourceAttr.ownerDocument || doc
    );

    let enumerations: string[] | undefined;
    let typeName = typeReference?.localName;

    if (typeReference) {
        const typeKey = `${typeReference.namespace}|${typeReference.localName}`;
        const enumType = model.enumTypes.get(typeKey);
        if (enumType) {
            enumerations = enumType.values;
        }
    }

    const inlineSimple = getDirectChildrenByLocalName(sourceAttr, 'simpleType')[0] || getDirectChildrenByLocalName(attr, 'simpleType')[0];
    if (inlineSimple) {
        const vals = extractEnumerations(inlineSimple);
        if (vals.length > 0) {
            enumerations = vals;
            if (!typeName) {
                typeName = inlineSimple.getAttribute('name') || undefined;
            }
        }
    }

    return {
        name,
        required: use === 'required',
        typeName,
        enumerations,
        documentation: extractDocumentation(attr) || extractDocumentation(sourceAttr),
    };
}

/** Resolve type references on elements that reference named complex types. */
function resolveTypeReferences(model: SchemaModel): void {
    const resolvedKeys = new Set<string>();
    const resolvingKeys = new Set<string>();

    const resolveElementByKey = (key: string): SchemaElement | undefined => {
        const elem = model.elements.get(key);
        if (!elem) { return undefined; }
        if (resolvedKeys.has(key)) { return elem; }
        if (resolvingKeys.has(key)) { return elem; }

        resolvingKeys.add(key);

        if (elem.baseTypeName) {
            const baseMatch = findTypeEntry(elem.baseTypeName, elem.namespace, model);
            if (baseMatch) {
                const baseElem = resolveElementByKey(baseMatch.key) || baseMatch.element;
                const localChildren = cloneChildRefs(elem.children);
                const mergedChildren = cloneChildRefs(baseElem.children);
                mergeChildren(mergedChildren, localChildren);
                elem.children = mergedChildren;

                const localAttributes = cloneAttributes(elem.attributes);
                const mergedAttributes = cloneAttributes(baseElem.attributes);
                mergeAttributes(mergedAttributes, localAttributes);
                elem.attributes = mergedAttributes;
                if (!elem.documentation && baseElem.documentation) {
                    elem.documentation = baseElem.documentation;
                }
            }
        }

        if (elem.typeName && elem.children.length === 0 && elem.attributes.length === 0) {
            const typeMatch = findTypeEntry(elem.typeName, elem.namespace, model);
            if (typeMatch) {
                const resolvedType = resolveElementByKey(typeMatch.key) || typeMatch.element;
                elem.children = cloneChildRefs(resolvedType.children);
                elem.attributes = cloneAttributes(resolvedType.attributes);
                if (!elem.documentation && resolvedType.documentation) {
                    elem.documentation = resolvedType.documentation;
                }
            }
        }

        resolvingKeys.delete(key);
        resolvedKeys.add(key);
        return elem;
    };

    for (const key of Array.from(model.elements.keys())) {
        resolveElementByKey(key);
    }

    for (const [, elem] of Array.from(model.elements)) {
        for (const child of elem.children) {
            const childKey = `${child.namespace}|${child.name}`;
            if (model.elements.has(childKey) || !child.typeName) { continue; }

            const typeMatch = findTypeEntry(child.typeName, child.namespace, model);
            if (!typeMatch) { continue; }

            const resolvedType = resolveElementByKey(typeMatch.key) || typeMatch.element;
            model.elements.set(childKey, {
                name: child.name,
                namespace: child.namespace,
                documentation: resolvedType.documentation,
                children: cloneChildRefs(resolvedType.children),
                attributes: cloneAttributes(resolvedType.attributes),
                typeName: child.typeName,
            });
        }
    }

    for (const key of Array.from(model.elements.keys())) {
        resolveElementByKey(key);
    }
}

/** Find a named complex type in the model. */
function findTypeEntry(
    typeName: string,
    defaultNs: string,
    model: SchemaModel
): { key: string; element: SchemaElement } | undefined {
    const normalizedTypeName = getLocalNameFromQName(typeName);

    const sameNsKey = `${defaultNs}|type:${normalizedTypeName}`;
    const sameNsType = model.elements.get(sameNsKey);
    if (sameNsType) {
        return { key: sameNsKey, element: sameNsType };
    }

    const typesKey = `${TYPES_NS}|type:${normalizedTypeName}`;
    const typesType = model.elements.get(typesKey);
    if (typesType) {
        return { key: typesKey, element: typesType };
    }

    for (const [key, elem] of model.elements) {
        if (key.endsWith(`|type:${normalizedTypeName}`)) {
            return { key, element: elem };
        }
    }

    return undefined;
}

function resolveTypeReference(
    typeName: string | null,
    contextElement: Element,
    doc: Document
): { namespace: string; localName: string } | undefined {
    if (!typeName) { return undefined; }
    return resolveQName(typeName, contextElement, doc);
}

/** Resolve a QName (prefix:localName) to namespace + localName. */
function resolveQName(qname: string, contextElement: Element, _doc: Document): { namespace: string; localName: string } {
    const colonIdx = qname.indexOf(':');
    if (colonIdx === -1) {
        const root = contextElement.ownerDocument?.documentElement;
        const targetNs = root?.getAttribute('targetNamespace') || '';
        return { namespace: targetNs, localName: qname };
    }

    const prefix = qname.substring(0, colonIdx);
    const localName = qname.substring(colonIdx + 1);

    let node: Element | null = contextElement;
    while (node) {
        const nsAttr = node.getAttribute(`xmlns:${prefix}`);
        if (nsAttr) {
            return { namespace: nsAttr, localName };
        }
        node = node.parentNode as Element | null;
        if (node && node.nodeType !== 1) { node = null; }
    }

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
    const annotations = getDirectChildrenByLocalName(element, 'annotation');
    for (const ann of annotations) {
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
            if (getLocalName(elem) === localName) {
                results.push(elem);
            }
            results.push(...getElementsByLocalName(elem, localName));
        }
    }
    return results;
}

function getDirectChildElements(parent: Element): Element[] {
    const results: Element[] = [];
    const children = parent.childNodes;
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.nodeType === 1) {
            results.push(child as Element);
        }
    }
    return results;
}

function getDirectChildrenByLocalName(parent: Element, localName: string): Element[] {
    return getDirectChildElements(parent).filter(child => getLocalName(child) === localName);
}

function collectParticleContainers(scope: Element): Element[] {
    const containers: Element[] = [];

    const visit = (node: Element): void => {
        for (const child of getDirectChildElements(node)) {
            const localName = getLocalName(child);
            if (localName === 'element') {
                continue;
            }
            if (localName === 'all' || localName === 'sequence' || localName === 'choice') {
                containers.push(child);
                visit(child);
            }
        }
    };

    visit(scope);
    return containers;
}

function mergeAttributes(target: SchemaAttribute[], source: SchemaAttribute[]): void {
    for (const attribute of source) {
        mergeAttribute(target, attribute);
    }
}

function mergeAttribute(target: SchemaAttribute[], source: SchemaAttribute): void {
    const existing = target.find(attribute => attribute.name === source.name);
    if (!existing) {
        target.push({
            ...source,
            enumerations: source.enumerations ? [...source.enumerations] : undefined,
        });
        return;
    }

    existing.required = existing.required || source.required;
    existing.typeName = existing.typeName || source.typeName;
    existing.documentation = existing.documentation || source.documentation;
    if (source.enumerations?.length) {
        existing.enumerations = Array.from(new Set([...(existing.enumerations || []), ...source.enumerations]));
    }
}

function mergeChildren(target: SchemaChildRef[], source: SchemaChildRef[]): void {
    for (const child of source) {
        mergeChild(target, child);
    }
}

function mergeChild(target: SchemaChildRef[], source: SchemaChildRef): void {
    const existing = target.find(child => child.name === source.name && child.namespace === source.namespace);
    if (!existing) {
        target.push({ ...source });
        return;
    }

    existing.minOccurs = Math.min(existing.minOccurs, source.minOccurs);
    existing.maxOccurs = existing.maxOccurs === -1 || source.maxOccurs === -1
        ? -1
        : Math.max(existing.maxOccurs, source.maxOccurs);
    existing.typeName = existing.typeName || source.typeName;
}

function cloneAttributes(attributes: SchemaAttribute[]): SchemaAttribute[] {
    return attributes.map(attribute => ({
        ...attribute,
        enumerations: attribute.enumerations ? [...attribute.enumerations] : undefined,
    }));
}

function cloneChildRefs(children: SchemaChildRef[]): SchemaChildRef[] {
    return children.map(child => ({ ...child }));
}

function getLocalName(element: Element): string {
    return element.localName || element.nodeName.split(':').pop() || '';
}

function getLocalNameFromQName(qname: string): string {
    const colonIdx = qname.indexOf(':');
    return colonIdx === -1 ? qname : qname.substring(colonIdx + 1);
}
