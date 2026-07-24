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
    SchemaPatternType,
    URI_TO_PREFIX,
} from './schema-model';
// Note: This file is part of the shared manifest-schema module.
// It has no VS Code dependency and can be consumed by both manifest-intellisense and manifest-editor.

const XS_NS = 'http://www.w3.org/2001/XMLSchema';
const TYPES_NS = 'http://schemas.microsoft.com/appx/manifest/types';

interface ParsedSchemaDocument {
    doc: Document;
    targetNs: string;
    filePath: string;
}

interface SchemaParseContext {
    attributeDefinitions: Map<string, Element>;
    attributeGroupDefinitions: Map<string, Element>;
    documentFiles: Map<Document, string>;
}

/**
 * Load and parse all XSD files from the schemas/ directory.
 * Returns a populated SchemaModel.
 */
export function loadSchemaModel(schemasDir: string): SchemaModel {
    const model: SchemaModel = {
        elements: new Map(),
        enumTypes: new Map(),
        patternTypes: new Map(),
        namespacePrefixes: new Map(URI_TO_PREFIX),
        substitutionGroups: new Map(),
    };

    const parsedDocs = loadSchemaDocuments(schemasDir);
    const parseContext = buildParseContext(parsedDocs);

    // First pass: parse all types (simple types with enumerations)
    for (const { doc, targetNs } of parsedDocs) {
        parseSimpleTypes(doc, targetNs, model);
    }

    // Second pass: parse elements and complex types
    for (const { doc, targetNs, filePath } of parsedDocs) {
        parseElements(doc, targetNs, model, parseContext, filePath);
        parseComplexTypes(doc, targetNs, model, parseContext, filePath);
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
            return { doc, targetNs, filePath };
        });
}

function buildParseContext(parsedDocs: ParsedSchemaDocument[]): SchemaParseContext {
    const attributeDefinitions = new Map<string, Element>();
    const attributeGroupDefinitions = new Map<string, Element>();
    const documentFiles = new Map<Document, string>();

    for (const { doc, targetNs, filePath } of parsedDocs) {
        documentFiles.set(doc, filePath);
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

    return { attributeDefinitions, attributeGroupDefinitions, documentFiles };
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

        const key = `${targetNs}|${name}`;

        const values = extractEnumerations(st);
        if (values.length > 0) {
            model.enumTypes.set(key, {
                name,
                namespace: targetNs,
                values,
                documentation: extractDocumentation(st),
            });
        }

        // Extract pattern/length constraints
        const patternType = extractPatternType(st, name, targetNs);
        if (patternType) {
            model.patternTypes.set(key, patternType);
        }
    }
}

/** Extract pattern and length facets from a simple type. */
function extractPatternType(element: Element, name: string, namespace: string): SchemaPatternType | null {
    const patterns: string[] = [];
    let minLength: number | undefined;
    let maxLength: number | undefined;
    let baseType: string | undefined;

    const restrictions = getElementsByLocalName(element, 'restriction');
    for (const restriction of restrictions) {
        const base = restriction.getAttribute('base');
        if (base && !baseType) {
            baseType = getLocalNameFromQName(base);
        }

        const patternElems = getDirectChildrenByLocalName(restriction, 'pattern');
        for (const p of patternElems) {
            const val = p.getAttribute('value');
            if (val) { patterns.push(val); }
        }

        const minLenElems = getDirectChildrenByLocalName(restriction, 'minLength');
        for (const ml of minLenElems) {
            const val = ml.getAttribute('value');
            if (val) { minLength = parseInt(val, 10); }
        }

        const maxLenElems = getDirectChildrenByLocalName(restriction, 'maxLength');
        for (const ml of maxLenElems) {
            const val = ml.getAttribute('value');
            if (val) { maxLength = parseInt(val, 10); }
        }
    }

    if (patterns.length === 0 && minLength === undefined && maxLength === undefined) {
        return null;
    }

    return { name, namespace, patterns, minLength, maxLength, baseType };
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
function parseElements(
    doc: Document,
    targetNs: string,
    model: SchemaModel,
    parseContext: SchemaParseContext,
    filePath: string
): void {
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
            sourceFile: filePath,
            sourceLine: getNodeSourceLine(elem),
        };

        const inlineTypes = getDirectChildrenByLocalName(elem, 'complexType');
        if (inlineTypes.length > 0) {
            parseComplexTypeContent(inlineTypes[0], targetNs, schemaElem, model, parseContext, doc, filePath);
        }

        model.elements.set(key, schemaElem);

        // Track substitution group membership
        const subGroupAttr = elem.getAttribute('substitutionGroup');
        if (subGroupAttr) {
            const resolved = resolveTypeReference(subGroupAttr, elem, doc);
            const headName = resolved ? resolved.localName : subGroupAttr;
            const existing = model.substitutionGroups.get(headName) || [];
            if (!existing.some(e => e.name === name && e.namespace === targetNs)) {
                existing.push({ name, namespace: targetNs });
            }
            model.substitutionGroups.set(headName, existing);
        }
    }
}

/** Parse top-level xs:complexType definitions and associate them with elements. */
function parseComplexTypes(
    doc: Document,
    targetNs: string,
    model: SchemaModel,
    parseContext: SchemaParseContext,
    filePath: string
): void {
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
            sourceFile: filePath,
            sourceLine: getNodeSourceLine(ct),
        };

        parseComplexTypeContent(ct, targetNs, schemaElem, model, parseContext, doc, filePath);
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
    doc: Document,
    filePath: string
): void {
    const complexContent = getDirectChildrenByLocalName(ct, 'complexContent')[0];
    const extension = complexContent
        ? getDirectChildrenByLocalName(complexContent, 'extension')[0]
        : undefined;
    const simpleContent = getDirectChildrenByLocalName(ct, 'simpleContent')[0];
    const simpleExtension = simpleContent
        ? getDirectChildrenByLocalName(simpleContent, 'extension')[0]
        : undefined;
    const simpleRestriction = simpleContent
        ? getDirectChildrenByLocalName(simpleContent, 'restriction')[0]
        : undefined;
    const simpleContentScope = simpleExtension ?? simpleRestriction;
    const scope = extension ?? simpleContentScope ?? ct;

    if (extension) {
        const baseReference = resolveTypeReference(extension.getAttribute('base'), extension, doc);
        schemaElem.baseTypeName = baseReference?.localName;
    }

    if (simpleContentScope) {
        const baseReference = resolveTypeReference(simpleContentScope.getAttribute('base'), simpleContentScope, doc);
        schemaElem.simpleTypeName = baseReference?.localName;
        schemaElem.simpleTypeNamespace = baseReference?.namespace;
    }

    parseChildElements(scope, targetNs, schemaElem, model, parseContext, doc, filePath);
    parseAttributesAndGroups(scope, targetNs, schemaElem, model, parseContext, doc, filePath);
}

function parseChildElements(
    scope: Element,
    targetNs: string,
    schemaElem: SchemaElement,
    model: SchemaModel,
    parseContext: SchemaParseContext,
    doc: Document,
    filePath: string
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
                const childKey = `${targetNs}|${childName}`;
                const inlineTypes = getDirectChildrenByLocalName(childElem, 'complexType');
                if (inlineTypes.length > 0) {
                    if (!model.elements.has(childKey)) {
                        const inlineElem: SchemaElement = {
                            name: childName,
                            namespace: targetNs,
                            documentation: extractDocumentation(childElem),
                            children: [],
                            attributes: [],
                            sourceFile: filePath,
                            sourceLine: getNodeSourceLine(childElem),
                        };
                        parseComplexTypeContent(inlineTypes[0], targetNs, inlineElem, model, parseContext, doc, filePath);
                        model.elements.set(childKey, inlineElem);
                    }
                } else if (!model.elements.has(childKey)) {
                    const typeAttr = childElem.getAttribute('type');
                    const typeRef = typeAttr ? resolveTypeReference(typeAttr, childElem, doc) : null;
                    const ctKey = `${targetNs}|type:CT_${childName}`;
                    const typeName = typeRef?.localName || (model.elements.has(ctKey) ? `CT_${childName}` : undefined);
                    const simpleElem: SchemaElement = {
                        name: childName,
                        namespace: targetNs,
                        documentation: extractDocumentation(childElem),
                        children: [],
                        attributes: [],
                        typeName,
                        sourceFile: filePath,
                        sourceLine: getNodeSourceLine(childElem),
                    };
                    model.elements.set(childKey, simpleElem);
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
    doc: Document,
    filePath: string
): void {
    for (const child of getDirectChildElements(scope)) {
        const localName = getLocalName(child);
        if (localName === 'attribute') {
            const attrDef = parseAttribute(child, targetNs, model, parseContext, doc, filePath);
            if (attrDef) {
                mergeAttribute(schemaElem.attributes, attrDef);
            }
            continue;
        }

        if (localName === 'attributeGroup') {
            expandAttributeGroup(child, targetNs, schemaElem, model, parseContext, doc, filePath, new Set<string>());
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
    filePath: string,
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
            const attrDef = parseAttribute(child, targetNs, model, parseContext, doc, filePath);
            if (attrDef) {
                mergeAttribute(schemaElem.attributes, attrDef);
            }
            continue;
        }

        if (localName === 'attributeGroup') {
            expandAttributeGroup(child, targetNs, schemaElem, model, parseContext, doc, filePath, visitedGroups);
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
    doc: Document,
    filePath: string
): SchemaAttribute | null {
    let sourceAttr = attr;
    let name = attr.getAttribute('name');
    let resolvedRef: { namespace: string; localName: string } | undefined;

    if (!name) {
        const ref = attr.getAttribute('ref');
        if (ref) {
            resolvedRef = resolveQName(ref, attr, doc);
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
    let patterns: string[] | undefined;
    let patternSets: string[][] | undefined;
    let minLength: number | undefined;
    let maxLength: number | undefined;
    let typeName = typeReference?.localName;

    if (typeReference) {
        const typeKey = `${typeReference.namespace}|${typeReference.localName}`;
        const enumType = model.enumTypes.get(typeKey);
        if (enumType) {
            enumerations = enumType.values;
        }
        // Resolve pattern constraints from type
        const resolvedPatterns = resolvePatternConstraints(typeKey, model);
        if (resolvedPatterns) {
            if (resolvedPatterns.patternSets.length > 0) {
                patternSets = resolvedPatterns.patternSets.map(set => [...set]);
                patterns = [...patternSets[0]];
            }
            minLength = resolvedPatterns.minLength;
            maxLength = resolvedPatterns.maxLength;
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
        // Also check inline patterns
        const inlinePattern = extractPatternType(inlineSimple, '', '');
        if (inlinePattern) {
            if (inlinePattern.patterns.length > 0) {
                patternSets = [inlinePattern.patterns, ...(patternSets || [])];
                patterns = [...inlinePattern.patterns];
            }
            if (inlinePattern.minLength !== undefined) { minLength = inlinePattern.minLength; }
            if (inlinePattern.maxLength !== undefined) { maxLength = inlinePattern.maxLength; }
        }
    }

    // An attribute is namespace-qualified only if:
    // 1. It has form="qualified" explicitly set, OR
    // 2. It is referenced via ref from a DIFFERENT namespace than the current schema's targetNamespace
    const currentTargetNs = attr.ownerDocument?.documentElement?.getAttribute('targetNamespace') || targetNs;
    const isQualified = (attr.getAttribute('form') || sourceAttr.getAttribute('form')) === 'qualified'
        || (resolvedRef !== undefined && resolvedRef.namespace !== '' && resolvedRef.namespace !== currentTargetNs);
    const attributeNamespace = isQualified
        ? resolvedRef?.namespace
            || sourceAttr.ownerDocument?.documentElement?.getAttribute('targetNamespace')
            || attr.ownerDocument?.documentElement?.getAttribute('targetNamespace')
            || targetNs
        : undefined;

    return {
        name,
        qualified: isQualified,
        namespace: attributeNamespace,
        required: use === 'required',
        typeName,
        enumerations,
        patterns,
        patternSets,
        minLength,
        maxLength,
        documentation: extractDocumentation(attr) || extractDocumentation(sourceAttr),
        sourceFile: parseContext.documentFiles.get(sourceAttr.ownerDocument || doc) || filePath,
        sourceLine: getNodeSourceLine(sourceAttr),
    };
}

/** Resolve all pattern/length constraints for a type, walking the inheritance chain.
 * Returns patternSets: each set is the patterns from one restriction level (OR within, AND between).
 */
function resolvePatternConstraints(
    typeKey: string,
    model: SchemaModel
): { patternSets: string[][]; minLength?: number; maxLength?: number } | null {
    const visited = new Set<string>();
    const patternSets: string[][] = [];
    let minLength: number | undefined;
    let maxLength: number | undefined;

    let currentKey: string | undefined = typeKey;
    while (currentKey && !visited.has(currentKey)) {
        visited.add(currentKey);
        const pt = model.patternTypes.get(currentKey);
        if (pt) {
            if (pt.patterns.length > 0) {
                patternSets.push(pt.patterns);
            }
            if (pt.minLength !== undefined && (minLength === undefined || pt.minLength > minLength)) {
                minLength = pt.minLength;
            }
            if (pt.maxLength !== undefined && (maxLength === undefined || pt.maxLength < maxLength)) {
                maxLength = pt.maxLength;
            }
            if (pt.baseType) {
                const ns: string = currentKey.split('|')[0];
                const baseKey: string = `${ns}|${pt.baseType}`;
                if (model.patternTypes.has(baseKey)) {
                    currentKey = baseKey;
                } else {
                    const typesKey = `${TYPES_NS}|${pt.baseType}`;
                    currentKey = model.patternTypes.has(typesKey) ? typesKey : undefined;
                }
            } else {
                currentKey = undefined;
            }
        } else {
            currentKey = undefined;
        }
    }

    if (patternSets.length === 0 && minLength === undefined && maxLength === undefined) {
        return null;
    }
    return { patternSets, minLength, maxLength };
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
            const baseMatch = findTypeEntry(elem.baseTypeName, elem.namespace, model, key);
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
                if (!elem.simpleTypeName && baseElem.simpleTypeName) {
                    elem.simpleTypeName = baseElem.simpleTypeName;
                    elem.simpleTypeNamespace = baseElem.simpleTypeNamespace;
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
                if (!elem.simpleTypeName && resolvedType.simpleTypeName) {
                    elem.simpleTypeName = resolvedType.simpleTypeName;
                    elem.simpleTypeNamespace = resolvedType.simpleTypeNamespace;
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
                simpleTypeName: resolvedType.simpleTypeName,
                simpleTypeNamespace: resolvedType.simpleTypeNamespace,
                sourceFile: resolvedType.sourceFile,
                sourceLine: resolvedType.sourceLine,
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
    model: SchemaModel,
    excludeKey?: string
): { key: string; element: SchemaElement } | undefined {
    const normalizedTypeName = getLocalNameFromQName(typeName);

    const sameNsKey = `${defaultNs}|type:${normalizedTypeName}`;
    if (sameNsKey !== excludeKey) {
        const sameNsType = model.elements.get(sameNsKey);
        if (sameNsType) {
            return { key: sameNsKey, element: sameNsType };
        }
    }

    const typesKey = `${TYPES_NS}|type:${normalizedTypeName}`;
    if (typesKey !== excludeKey) {
        const typesType = model.elements.get(typesKey);
        if (typesType) {
            return { key: typesKey, element: typesType };
        }
    }

    for (const [key, elem] of model.elements) {
        if (key !== excludeKey && key.endsWith(`|type:${normalizedTypeName}`)) {
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
    const existing = target.find(attribute => attribute.name === source.name && attribute.namespace === source.namespace);
    if (!existing) {
        target.push({
            ...source,
            enumerations: source.enumerations ? [...source.enumerations] : undefined,
            patterns: source.patterns ? [...source.patterns] : undefined,
            patternSets: source.patternSets?.map(patternSet => [...patternSet]),
        });
        return;
    }

    existing.required = existing.required || source.required;
    existing.qualified = existing.qualified || source.qualified;
    existing.namespace = existing.namespace || source.namespace;
    existing.typeName = existing.typeName || source.typeName;
    existing.documentation = existing.documentation || source.documentation;
    if (source.enumerations?.length) {
        existing.enumerations = Array.from(new Set([...(existing.enumerations || []), ...source.enumerations]));
    }
    if (source.patterns?.length) {
        existing.patterns = [...(existing.patterns || []), ...source.patterns];
    }
    if (source.patternSets?.length) {
        existing.patternSets = [...(existing.patternSets || []), ...source.patternSets.map(patternSet => [...patternSet])];
    }
    if (source.minLength !== undefined) { existing.minLength = source.minLength; }
    if (source.maxLength !== undefined) { existing.maxLength = source.maxLength; }
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
        patterns: attribute.patterns ? [...attribute.patterns] : undefined,
        patternSets: attribute.patternSets?.map(patternSet => [...patternSet]),
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

function getNodeSourceLine(element: Element): number | undefined {
    const lineNumber = (element as any).lineNumber;
    return typeof lineNumber === 'number' && lineNumber > 0 ? lineNumber - 1 : undefined;
}
