/**
 * Tests for the shared manifest-schema module and schema-helpers integration.
 *
 * Run: npx tsx --test src/test/schema-shared.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import {
    loadSchemaModel,
    SchemaModel,
    MANIFEST_NAMESPACES,
    URI_TO_PREFIX,
    validateManifestText,
    findSchemaElementExact,
    validateAttributeValuePattern,
    validateAttributeValueLength,
    validateAttributeValueEnum,
    splitPrefixedName,
    getXmlContext,
    findParentPath,
    validateValueAgainstType,
    matchesSchemaPattern,
    isValidSchemaColor,
    buildAttributeFromPatternType,
    checkSchemaLength,
} from '../manifest-schema';

const SCHEMAS_DIR = path.join(__dirname, '..', '..', 'schemas');
const FOUNDATION_NS = 'http://schemas.microsoft.com/appx/manifest/foundation/windows10';

let model: SchemaModel;

describe('manifest-schema barrel exports', () => {
    it('exports loadSchemaModel and it loads successfully', () => {
        model = loadSchemaModel(SCHEMAS_DIR);
        assert.ok(model.elements.size > 0);
        assert.ok(model.enumTypes.size > 0);
        assert.ok(model.patternTypes.size > 0);
    });

    it('exports MANIFEST_NAMESPACES with expected prefixes', () => {
        assert.equal(MANIFEST_NAMESPACES[''], 'http://schemas.microsoft.com/appx/manifest/foundation/windows10');
        assert.equal(MANIFEST_NAMESPACES['uap'], 'http://schemas.microsoft.com/appx/manifest/uap/windows10');
    });

    it('exports URI_TO_PREFIX as a Map', () => {
        assert.ok(URI_TO_PREFIX instanceof Map);
        assert.equal(URI_TO_PREFIX.get('http://schemas.microsoft.com/appx/manifest/foundation/windows10'), '');
    });

    it('exports splitPrefixedName', () => {
        assert.deepEqual(splitPrefixedName('uap:VisualElements'), { prefix: 'uap', localName: 'VisualElements' });
        assert.deepEqual(splitPrefixedName('Package'), { prefix: '', localName: 'Package' });
    });

    it('exports getXmlContext', () => {
        const ctx = getXmlContext('<Package><', 10);
        assert.equal(ctx.type, 'elementOpen');
    });

    it('exports findParentPath', () => {
        const stack = findParentPath('<Package><Identity Name="x" /></Package><Resources>');
        assert.equal(stack.length, 1);
        assert.equal(stack[0].name, 'Resources');
    });
});

describe('schema-validation shared functions', () => {
    it('validateManifestText finds missing required attributes', () => {
        model = loadSchemaModel(SCHEMAS_DIR);
        const xml = `<?xml version="1.0"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10">
  <Identity />
</Package>`;
        const diags = validateManifestText(model, xml);
        assert.ok(diags.some(d => d.message.includes("Missing required attribute 'Name'")));
    });

    it('validateManifestText warns when the root element is not in the schema', () => {
        model = loadSchemaModel(SCHEMAS_DIR);
        const xml = `<?xml version="1.0"?>
<UnknownRoot xmlns="${FOUNDATION_NS}">
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" />
</UnknownRoot>`;
        const diags = validateManifestText(model, xml);
        assert.ok(diags.some(d => d.message.includes("Root element 'UnknownRoot' not recognized in schema") && d.severity === 'warning'));
    });

    it('validateManifestText reports undeclared attributes as hints', () => {
        model = loadSchemaModel(SCHEMAS_DIR);
        const xml = `<?xml version="1.0"?>
<Package xmlns="${FOUNDATION_NS}">
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" ExtraAttribute="value" />
</Package>`;
        const diags = validateManifestText(model, xml);
        assert.ok(diags.some(d => d.message.includes("Attribute 'ExtraAttribute' is not declared") && d.severity === 'hint'));
    });

    it('validateManifestText preserves relaxed child placement by default for known schema elements', () => {
        model = loadSchemaModel(SCHEMAS_DIR);
        const xml = `<?xml version="1.0"?>
<Package xmlns="${FOUNDATION_NS}">
  <Applications>
    <Application Id="App">
      <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" />
    </Application>
  </Applications>
</Package>`;
        const diags = validateManifestText(model, xml);
        assert.ok(!diags.some(d => d.message.includes("Element 'Identity' is not allowed under <Application>")));
    });

    it('validateManifestText flags misplaced known schema elements in strict child placement mode', () => {
        model = loadSchemaModel(SCHEMAS_DIR);
        const xml = `<?xml version="1.0"?>
<Package xmlns="${FOUNDATION_NS}">
  <Applications>
    <Application Id="App">
      <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" />
    </Application>
  </Applications>
</Package>`;
        const diags = validateManifestText(model, xml, 'warning', { strictChildPlacement: true });
        assert.ok(diags.some(d => d.message.includes("Element 'Identity' is not allowed under <Application>") && d.severity === 'warning'));
    });

    it('findSchemaElementExact finds Package element', () => {
        model = loadSchemaModel(SCHEMAS_DIR);
        const pkg = findSchemaElementExact(model, 'Package', FOUNDATION_NS);
        assert.ok(pkg);
        assert.equal(pkg.name, 'Package');
    });

    it('validateAttributeValuePattern validates regex patterns', () => {
        const attr = { name: 'test', required: false, patterns: ['^[A-Z]+$'] };
        assert.equal(validateAttributeValuePattern(attr, 'ABC'), true);
        assert.equal(validateAttributeValuePattern(attr, 'abc'), false);
    });

    it('validateAttributeValuePattern applies all inherited pattern sets with AND semantics', () => {
        const attr = {
            name: 'test',
            required: false,
            patternSets: [['[A-Z]+'], ['AB|ABC']],
        };
        assert.equal(validateAttributeValuePattern(attr, 'AB'), true);
        assert.equal(validateAttributeValuePattern(attr, 'A'), false);
    });

    it('validateAttributeValuePattern returns true when no patterns', () => {
        assert.equal(validateAttributeValuePattern({ name: 'x', required: false }, 'anything'), true);
    });

    it('validateAttributeValuePattern skips values over 1024 chars (ReDoS safety)', () => {
        const attr = { name: 'test', required: false, patterns: ['^[A-Z]+$'] };
        const longValue = 'a'.repeat(1025);
        assert.equal(validateAttributeValuePattern(attr, longValue), true);
    });

    it('validateAttributeValueLength validates min/max', () => {
        const attr = { name: 'x', required: false, minLength: 3, maxLength: 50 };
        assert.equal(validateAttributeValueLength(attr, 'ab'), 'Value must be at least 3 characters (got 2)');
        assert.equal(validateAttributeValueLength(attr, 'abc'), null);
        assert.equal(validateAttributeValueLength(attr, 'x'.repeat(51)),
            'Value exceeds maximum length of 50 characters (got 51)');
    });

    it('validateAttributeValueEnum checks allowed values', () => {
        const attr = { name: 'x', required: false, enumerations: ['a', 'b', 'c'] };
        assert.equal(validateAttributeValueEnum(attr, 'a'), true);
        assert.equal(validateAttributeValueEnum(attr, 'd'), false);
        assert.equal(validateAttributeValueEnum({ name: 'y', required: false }, 'anything'), true);
    });
});

describe('schema-helpers for manifest-editor', () => {
    it('buildAttributeFromPatternType resolves ST_PackageName with inheritance', () => {
        model = loadSchemaModel(SCHEMAS_DIR);
        const attr = buildAttributeFromPatternType(model, 'ST_PackageName');
        assert.ok(attr);
        assert.equal(attr.minLength, 3);
        assert.equal(attr.maxLength, 50);
        assert.ok(attr.patternSets && attr.patternSets.length > 0);
        // Patterns come from ST_AsciiIdentifier base type and lengths from ST_PackageName.
        assert.ok(attr.patternSets?.some(patternSet => patternSet.includes('[-.A-Za-z0-9]+')));
    });

    it('buildAttributeFromPatternType resolves ST_VersionQuad', () => {
        model = loadSchemaModel(SCHEMAS_DIR);
        const attr = buildAttributeFromPatternType(model, 'ST_VersionQuad');
        assert.ok(attr);
        assert.ok(attr.patterns && attr.patterns.length > 0);
    });

    it('buildAttributeFromPatternType returns undefined for unknown type', () => {
        model = loadSchemaModel(SCHEMAS_DIR);
        assert.equal(buildAttributeFromPatternType(model, 'ST_NonExistent'), undefined);
    });

    it('validateValueAgainstType validates ST_PackageName correctly', () => {
        model = loadSchemaModel(SCHEMAS_DIR);
        // Valid name
        assert.equal(validateValueAgainstType(model, 'ST_PackageName', 'My.App'), null);
        // Too short
        assert.ok(validateValueAgainstType(model, 'ST_PackageName', 'ab'));
        // Too long
        assert.ok(validateValueAgainstType(model, 'ST_PackageName', 'a'.repeat(51)));
        // Invalid characters
        assert.ok(validateValueAgainstType(model, 'ST_PackageName', 'My App'));
    });

    it('validateValueAgainstType validates ST_VersionQuad', () => {
        model = loadSchemaModel(SCHEMAS_DIR);
        assert.equal(validateValueAgainstType(model, 'ST_VersionQuad', '1.0.0.0'), null);
        assert.equal(validateValueAgainstType(model, 'ST_VersionQuad', '10.0.26100.0'), null);
        assert.ok(validateValueAgainstType(model, 'ST_VersionQuad', '1.0.0'));
        assert.ok(validateValueAgainstType(model, 'ST_VersionQuad', 'abc'));
    });

    it('matchesSchemaPattern validates ST_GUID', () => {
        model = loadSchemaModel(SCHEMAS_DIR);
        assert.equal(matchesSchemaPattern(model, 'ST_GUID', '12345678-1234-1234-1234-123456789012'), true);
        assert.equal(matchesSchemaPattern(model, 'ST_GUID', 'not-a-guid'), false);
    });

    it('matchesSchemaPattern returns true for unknown types', () => {
        model = loadSchemaModel(SCHEMAS_DIR);
        assert.equal(matchesSchemaPattern(model, 'ST_Unknown', 'anything'), true);
    });

    it('isValidSchemaColor validates hex and named colors', () => {
        model = loadSchemaModel(SCHEMAS_DIR);
        assert.equal(isValidSchemaColor(model, '#FF0000'), true);
        assert.equal(isValidSchemaColor(model, 'cornflowerBlue'), true);
        assert.equal(isValidSchemaColor(model, 'transparent'), true);
        assert.equal(isValidSchemaColor(model, 'notAColor'), false);
        assert.equal(isValidSchemaColor(model, '#GGG'), false);
    });

    it('checkSchemaLength validates ST_DisplayName length', () => {
        model = loadSchemaModel(SCHEMAS_DIR);
        assert.equal(checkSchemaLength(model, 'ST_DisplayName', 'My App'), null);
        assert.ok(checkSchemaLength(model, 'ST_DisplayName', 'x'.repeat(257)));
    });

    it('validateValueAgainstType validates ST_Publisher_2010_v2', () => {
        model = loadSchemaModel(SCHEMAS_DIR);
        assert.equal(validateValueAgainstType(model, 'ST_Publisher_2010_v2', 'CN=Contoso'), null);
        assert.equal(validateValueAgainstType(model, 'ST_Publisher_2010_v2', 'CN=Contoso, O=Contoso Ltd'), null);
    });

    it('validateValueAgainstType validates ST_ApplicationId', () => {
        model = loadSchemaModel(SCHEMAS_DIR);
        assert.equal(validateValueAgainstType(model, 'ST_ApplicationId', 'App'), null);
        assert.equal(validateValueAgainstType(model, 'ST_ApplicationId', 'My.App'), null);
    });
});

describe('manifest-editor validateManifest with schema', () => {
    it('validates identity.name using schema when provided', async () => {
        // Dynamic import to avoid pulling in vscode types at module level
        const { validateManifest } = await import('../manifest-editor/manifest-validator.js');
        model = loadSchemaModel(SCHEMAS_DIR);
        const baseData = {
            identity: { name: '', publisher: 'CN=Test', version: '1.0.0.0', processorArchitecture: 'x64' },
            phoneIdentity: undefined,
            properties: { displayName: 'Test', publisherDisplayName: 'Test', logo: 'test.png', description: '' },
            dependencies: { targetDeviceFamilies: [], packageDependencies: [], mainPackageDependencies: [], driverConstraints: [], osPackageDependencies: [], hostRuntimeDependencies: [], externalDependencies: [] },
            resources: [],
            applications: [],
            capabilities: [],
        };

        // Missing name
        const errors1 = validateManifest(baseData as any, model);
        assert.ok(errors1.some((e: any) => e.field === 'identity.name'));

        // Invalid name (spaces)
        const errors2 = validateManifest({ ...baseData, identity: { ...baseData.identity, name: 'My App' } } as any, model);
        assert.ok(errors2.some((e: any) => e.field === 'identity.name'));

        // Valid name with schema
        const errors3 = validateManifest({ ...baseData, identity: { ...baseData.identity, name: 'My.Valid.App' } } as any, model);
        assert.ok(!errors3.some((e: any) => e.field === 'identity.name'));
    });

    it('validates invalid package name with schema', async () => {
        const { validateManifest } = await import('../manifest-editor/manifest-validator.js');
        model = loadSchemaModel(SCHEMAS_DIR);
        const baseData = {
            identity: { name: 'My App', publisher: 'CN=Test', version: '1.0.0.0', processorArchitecture: 'x64' },
            phoneIdentity: undefined,
            properties: { displayName: 'Test', publisherDisplayName: 'Test', logo: 'test.png', description: '' },
            dependencies: { targetDeviceFamilies: [], packageDependencies: [], mainPackageDependencies: [], driverConstraints: [], osPackageDependencies: [], hostRuntimeDependencies: [], externalDependencies: [] },
            resources: [],
            applications: [],
            capabilities: [],
        };

        // Schema validates — space in name is invalid per ST_PackageName
        const errors = validateManifest(baseData as any, model);
        assert.ok(errors.some((e: any) => e.field === 'identity.name'));
    });

    it('still applies semantic publisher validation when schema is provided', async () => {
        const { validateManifest } = await import('../manifest-editor/manifest-validator.js');
        model = loadSchemaModel(SCHEMAS_DIR);
        const data = {
            identity: { name: 'My.Valid.App', publisher: 'Not a DN', version: '1.0.0.0', processorArchitecture: 'x64' },
            phoneIdentity: undefined,
            properties: { displayName: 'Test', publisherDisplayName: 'Test', logo: 'test.png', description: '' },
            dependencies: { targetDeviceFamilies: [], packageDependencies: [], mainPackageDependencies: [], driverConstraints: [], osPackageDependencies: [], hostRuntimeDependencies: [], externalDependencies: [] },
            resources: [],
            applications: [],
            capabilities: [],
        };

        const errors = validateManifest(data as any, model);
        assert.ok(errors.some((e: any) => e.field === 'identity.publisher'));
    });
});
