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
        const ns = 'http://schemas.microsoft.com/appx/manifest/foundation/windows10';
        const pkg = model.elements.get(`${ns}|Package`);
        assert.ok(pkg, 'Package element should exist');
        assert.equal(pkg.name, 'Package');
        assert.equal(pkg.namespace, ns);
        assert.ok(pkg.children.length > 0, 'Package should have child elements');
    });

    it('Package has expected children (Identity, Properties, Dependencies, etc.)', () => {
        model = loadSchemaModel(SCHEMAS_DIR);
        const ns = 'http://schemas.microsoft.com/appx/manifest/foundation/windows10';
        const pkg = model.elements.get(`${ns}|Package`);
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
        const ns = 'http://schemas.microsoft.com/appx/manifest/foundation/windows10';
        // Identity is defined as a named complex type CT_Identity, not a top-level element
        const identity = model.elements.get(`${ns}|type:CT_Identity`);
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
        const ns = 'http://schemas.microsoft.com/appx/manifest/uap/windows10';
        const ve = model.elements.get(`${ns}|VisualElements`);
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
            model.namespacePrefixes.get('http://schemas.microsoft.com/appx/manifest/uap/windows10'),
            'uap'
        );
    });
});
