/**
 * Unit tests for the XSD parser module.
 *
 * Run: npx tsx --test src/test/xsd-parser.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { loadSchemaModel } from '../manifest-intellisense/xsd-parser';
import { SchemaModel } from '../manifest-intellisense/schema-model';

const SCHEMAS_DIR = path.join(__dirname, '..', '..', 'schemas');

describe('loadSchemaModel', () => {
    let model: SchemaModel;
    const FOUNDATION_NS = 'http://schemas.microsoft.com/appx/manifest/foundation/windows10';
    const UAP_NS = 'http://schemas.microsoft.com/appx/manifest/uap/windows10';
    const COM_NS = 'http://schemas.microsoft.com/appx/manifest/com/windows10';

    it('loads without throwing', () => {
        model = loadSchemaModel(SCHEMAS_DIR);
        assert.ok(model);
    });

    it('populates elements map', () => {
        model = loadSchemaModel(SCHEMAS_DIR);
        assert.ok(model.elements.size > 0, 'should have parsed some elements');
    });

    it('populates enumTypes map', () => {
        model = loadSchemaModel(SCHEMAS_DIR);
        assert.ok(model.enumTypes.size > 0, 'should have parsed some enum types');
    });

    it('parses Package element from foundation schema', () => {
        model = loadSchemaModel(SCHEMAS_DIR);
        const pkg = model.elements.get(`${FOUNDATION_NS}|Package`);
        assert.ok(pkg, 'Package element should exist');
        assert.equal(pkg.name, 'Package');
        assert.equal(pkg.namespace, FOUNDATION_NS);
        assert.ok(pkg.children.length > 0, 'Package should have child elements');
    });

    it('Package has expected children (Identity, Properties, Dependencies, etc.)', () => {
        model = loadSchemaModel(SCHEMAS_DIR);
        const pkg = model.elements.get(`${FOUNDATION_NS}|Package`);
        assert.ok(pkg);
        const childNames = pkg.children.map(c => c.name);
        assert.ok(childNames.includes('Identity'), 'Package should have Identity child');
        assert.ok(childNames.includes('Properties'), 'Package should have Properties child');
        assert.ok(childNames.includes('Dependencies'), 'Package should have Dependencies child');
        assert.ok(childNames.includes('Resources'), 'Package should have Resources child');
        assert.ok(childNames.includes('Applications'), 'Package should have Applications child');
        assert.ok(childNames.includes('Capabilities'), 'Package should have Capabilities child');
    });

    it('parses Identity type with attributes (as CT_Identity)', () => {
        model = loadSchemaModel(SCHEMAS_DIR);
        // Identity is defined as a named complex type CT_Identity, not a top-level element
        const identity = model.elements.get(`${FOUNDATION_NS}|type:CT_Identity`);
        assert.ok(identity, 'CT_Identity type should exist');
        assert.ok(identity.attributes.length > 0, 'Identity should have attributes');

        const nameAttr = identity.attributes.find(a => a.name === 'Name');
        assert.ok(nameAttr, 'Identity should have Name attribute');
        assert.ok(nameAttr.required, 'Name should be required');

        const publisherAttr = identity.attributes.find(a => a.name === 'Publisher');
        assert.ok(publisherAttr, 'Identity should have Publisher attribute');
        assert.ok(publisherAttr.required, 'Publisher should be required');

        const versionAttr = identity.attributes.find(a => a.name === 'Version');
        assert.ok(versionAttr, 'Identity should have Version attribute');
        assert.ok(versionAttr.required, 'Version should be required');

        const archAttr = identity.attributes.find(a => a.name === 'ProcessorArchitecture');
        assert.ok(archAttr, 'Identity should have ProcessorArchitecture attribute');
        assert.equal(archAttr.required, false, 'ProcessorArchitecture should be optional');
    });

    it('parses enum types (e.g., processor architecture values)', () => {
        model = loadSchemaModel(SCHEMAS_DIR);
        // Find an enum type that contains architecture values
        let foundArch = false;
        for (const [, enumType] of model.enumTypes) {
            if (enumType.values.includes('x86') && enumType.values.includes('x64')) {
                foundArch = true;
                assert.ok(enumType.values.includes('arm'), 'should include arm');
                break;
            }
        }
        assert.ok(foundArch, 'Should find a processor architecture enum type');
    });

    it('parses VisualElements from UAP schema', () => {
        model = loadSchemaModel(SCHEMAS_DIR);
        const ve = model.elements.get(`${UAP_NS}|VisualElements`);
        assert.ok(ve, 'VisualElements element should exist');
        assert.ok(ve.attributes.length > 0, 'VisualElements should have attributes');

        const displayName = ve.attributes.find(a => a.name === 'DisplayName');
        assert.ok(displayName, 'VisualElements should have DisplayName attribute');
        assert.ok(displayName.required, 'DisplayName should be required');
    });

    it('sets up namespacePrefixes map', () => {
        model = loadSchemaModel(SCHEMAS_DIR);
        assert.ok(model.namespacePrefixes.size > 0);
        assert.equal(
            model.namespacePrefixes.get(UAP_NS),
            'uap'
        );
    });

    it('resolves referenced attributes on inline complex types', () => {
        model = loadSchemaModel(SCHEMAS_DIR);
        const resource = model.elements.get(`${FOUNDATION_NS}|Resource`);
        assert.ok(resource, 'Resource element should exist');

        const scale = resource.attributes.find(attribute => attribute.name === 'Scale');
        const dxFeatureLevel = resource.attributes.find(attribute => attribute.name === 'DXFeatureLevel');
        assert.ok(scale, 'Resource should include the referenced Scale attribute');
        assert.equal(scale.typeName, 'ST_Scale_All');
        assert.ok(dxFeatureLevel, 'Resource should include the referenced DXFeatureLevel attribute');
    });

    it('expands referenced attribute groups', () => {
        model = loadSchemaModel(SCHEMAS_DIR);
        const extension = model.elements.get(`${UAP_NS}|Extension`);
        assert.ok(extension, 'uap:Extension element should exist');

        assert.ok(extension.attributes.some(attribute => attribute.name === 'Executable'));
        assert.ok(extension.attributes.some(attribute => attribute.name === 'EntryPoint'));
        assert.ok(extension.attributes.some(attribute => attribute.name === 'TrustLevel'));
    });

    it('marks qualified attributes from referenced groups', () => {
        model = loadSchemaModel(SCHEMAS_DIR);
        const application = model.elements.get(`${FOUNDATION_NS}|Application`);
        assert.ok(application, 'Application element should exist');

        const trustLevel = application.attributes.find(attribute => attribute.name === 'TrustLevel');
        assert.ok(trustLevel, 'Application should include TrustLevel');
        assert.equal(trustLevel.qualified, true);
    });

    it('materializes child elements that use named complex types', () => {
        model = loadSchemaModel(SCHEMAS_DIR);
        const implementedCategories = model.elements.get(`${COM_NS}|ImplementedCategories`);
        assert.ok(implementedCategories, 'ImplementedCategories child element should resolve to a schema element');
        assert.ok(implementedCategories.children.some(child => child.name === 'ImplementedCategory'));
    });

    it('merges inherited members from complex type extensions', () => {
        model = loadSchemaModel(SCHEMAS_DIR);
        const exeServerClass = model.elements.get(`${COM_NS}|type:CT_ExeServerClass`);
        assert.ok(exeServerClass, 'CT_ExeServerClass type should exist');
        assert.ok(exeServerClass.attributes.some(attribute => attribute.name === 'Id'));
        assert.ok(exeServerClass.attributes.some(attribute => attribute.name === 'DisplayName'));
        assert.ok(exeServerClass.children.some(child => child.name === 'DefaultIcon'));
    });

    it('tracks sourceFile and sourceLine for elements', () => {
        model = loadSchemaModel(SCHEMAS_DIR);
        const pkg = model.elements.get(`${FOUNDATION_NS}|Package`);
        assert.ok(pkg, 'Package element should exist');
        assert.ok(pkg.sourceFile, 'Package should have sourceFile set');
        assert.ok(pkg.sourceFile.endsWith('.xsd'), 'sourceFile should be an XSD file');
        assert.equal(typeof pkg.sourceLine, 'number', 'sourceLine should be a number');
        assert.ok(pkg.sourceLine >= 0, 'sourceLine should be non-negative');
    });

    it('tracks sourceFile and sourceLine for attributes', () => {
        model = loadSchemaModel(SCHEMAS_DIR);
        const identity = model.elements.get(`${FOUNDATION_NS}|type:CT_Identity`);
        assert.ok(identity, 'CT_Identity type should exist');
        const nameAttr = identity.attributes.find(a => a.name === 'Name');
        assert.ok(nameAttr, 'Name attribute should exist');
        assert.ok(nameAttr.sourceFile, 'Name attribute should have sourceFile');
        assert.ok(nameAttr.sourceFile.endsWith('.xsd'), 'sourceFile should be an XSD file');
        assert.equal(typeof nameAttr.sourceLine, 'number', 'sourceLine should be a number');
    });

    it('resolves pattern constraints on Identity Name attribute', () => {
        model = loadSchemaModel(SCHEMAS_DIR);
        const identity = model.elements.get(`${FOUNDATION_NS}|type:CT_Identity`);
        assert.ok(identity);
        const nameAttr = identity.attributes.find(a => a.name === 'Name');
        assert.ok(nameAttr);
        assert.ok(nameAttr.patterns && nameAttr.patterns.length > 0,
            'Name attribute should have pattern constraints resolved from its XSD type');
    });

    it('resolves pattern constraints on Identity Version attribute', () => {
        model = loadSchemaModel(SCHEMAS_DIR);
        const identity = model.elements.get(`${FOUNDATION_NS}|type:CT_Identity`);
        assert.ok(identity);
        const versionAttr = identity.attributes.find(a => a.name === 'Version');
        assert.ok(versionAttr);
        assert.ok(versionAttr.patterns && versionAttr.patterns.length > 0,
            'Version attribute should have pattern constraints');

        // The version pattern should match dotted quad format (e.g. 1.0.0.0)
        const regex = new RegExp(`^(?:${versionAttr.patterns[0]})$`);
        assert.ok(regex.test('1.0.0.0'), 'Pattern should match valid version 1.0.0.0');
        assert.ok(!regex.test('not.a.version'), 'Pattern should not match invalid version');
    });

    it('populates patternTypes map', () => {
        model = loadSchemaModel(SCHEMAS_DIR);
        assert.ok(model.patternTypes.size > 0, 'Should have parsed some pattern types');

        // ST_PackageVersion should have patterns
        let foundVersionType = false;
        for (const [key, pt] of model.patternTypes) {
            if (key.includes('ST_PackageVersion') || key.includes('ST_VersionQuad')) {
                foundVersionType = true;
                assert.ok(pt.patterns.length > 0, `${key} should have patterns`);
                break;
            }
        }
        assert.ok(foundVersionType, 'Should find a version-related pattern type');
    });

    it('registers simple-typed elements like DisplayName and Logo', () => {
        model = loadSchemaModel(SCHEMAS_DIR);

        // DisplayName is a simple-typed element in the Properties complex type
        // It should be discoverable via findManifestElement or as a registered element
        const displayName = model.elements.get(`${FOUNDATION_NS}|DisplayName`);
        assert.ok(displayName, 'DisplayName should be registered as an element');
        assert.equal(displayName.name, 'DisplayName');
    });
});
