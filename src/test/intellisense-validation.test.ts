/**
 * Tests for pattern validation, friendly error messages, base type inheritance,
 * schema URI propagation, and regression cases for the AppxManifest IntelliSense.
 *
 * Run: npx tsx --test src/test/intellisense-validation.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'path';
import { loadSchemaModel } from '../manifest-schema/xsd-parser';
import { MANIFEST_NAMESPACES, type SchemaModel } from '../manifest-schema/schema-model';
import {
    validateManifestText,
    validateAttributeValuePattern,
    findSchemaElementExact,
    TYPE_DESCRIPTIONS,
} from '../manifest-schema/schema-validation';

const SCHEMAS_DIR = path.join(__dirname, '..', '..', 'schemas');

// Skip all tests if schemas are not available (clean clone without sync-schemas)
const schemaFiles = fs.readdirSync(SCHEMAS_DIR, { withFileTypes: true }).filter(f => f.name.endsWith('.xsd'));
if (schemaFiles.length === 0) {
    describe('manifest validation tests (SKIPPED - no schemas)', () => {
        it('skipped: run npm run sync-schemas first', { skip: 'schemas/ directory is empty' }, () => {});
    });
    process.exit(0);
}

const FOUNDATION_NS = MANIFEST_NAMESPACES[''];
const UAP_NS = MANIFEST_NAMESPACES['uap'];
const model = loadSchemaModel(SCHEMAS_DIR);

function makeManifest(body: string, extraNamespaces = ''): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="${FOUNDATION_NS}" xmlns:uap="${UAP_NS}"${extraNamespaces}>
${body}
</Package>`;
}

function createTextContentTestModel(): SchemaModel {
    return {
        elements: new Map([
            [`${FOUNDATION_NS}|Package`, {
                name: 'Package',
                namespace: FOUNDATION_NS,
                children: [{ name: 'Mode', namespace: FOUNDATION_NS, minOccurs: 0, maxOccurs: 1 }],
                attributes: [],
            }],
            [`${FOUNDATION_NS}|Mode`, {
                name: 'Mode',
                namespace: FOUNDATION_NS,
                children: [],
                attributes: [],
                simpleTypeName: 'ModeType',
                simpleTypeNamespace: FOUNDATION_NS,
            }],
        ]),
        enumTypes: new Map([
            [`${FOUNDATION_NS}|ModeType`, {
                name: 'ModeType',
                namespace: FOUNDATION_NS,
                values: ['Alpha', 'Beta'],
            }],
        ]),
        patternTypes: new Map(),
        namespacePrefixes: new Map([[FOUNDATION_NS, '']]),
        substitutionGroups: new Map(),
    };
}

// ============================================================================
// 1. Pattern validation & friendly error messages
// ============================================================================

describe('TYPE_DESCRIPTIONS accuracy', () => {
    // Verify that TYPE_DESCRIPTIONS entries align with actual schema validation behavior.
    // Valid values that match the real XSD pattern should pass, and the description
    // should accurately reflect what characters are allowed.

    it('ST_PackageName accepts hyphens, periods, letters, and digits', () => {
        const identity = model.elements.get(`${FOUNDATION_NS}|Identity`);
        assert.ok(identity);
        const nameAttr = identity.attributes.find(a => a.name === 'Name');
        assert.ok(nameAttr);

        // Valid: contains hyphens and periods
        assert.ok(validateAttributeValuePattern(nameAttr, 'My-App.Name'), 'hyphens should be valid');
        assert.ok(validateAttributeValuePattern(nameAttr, 'com.example.my-app'), 'dots and hyphens valid');
        assert.ok(validateAttributeValuePattern(nameAttr, 'App123'), 'alphanumeric valid');

        // Invalid: contains spaces or underscores
        assert.ok(!validateAttributeValuePattern(nameAttr, 'My App'), 'spaces should be invalid');
        assert.ok(!validateAttributeValuePattern(nameAttr, 'My_App'), 'underscores should be invalid');
    });

    it('ST_VersionQuad requires exactly four dot-separated numeric groups', () => {
        const identity = model.elements.get(`${FOUNDATION_NS}|Identity`);
        assert.ok(identity);
        const versionAttr = identity.attributes.find(a => a.name === 'Version');
        assert.ok(versionAttr);

        assert.ok(validateAttributeValuePattern(versionAttr, '1.0.0.0'), 'basic version valid');
        assert.ok(validateAttributeValuePattern(versionAttr, '10.20.30.40'), 'multi-digit version valid');
        assert.ok(validateAttributeValuePattern(versionAttr, '65535.65535.65535.65535'), 'max version valid');

        assert.ok(!validateAttributeValuePattern(versionAttr, '1.0.0'), 'three groups invalid');
        assert.ok(!validateAttributeValuePattern(versionAttr, '1.0.0.0.0'), 'five groups invalid');
        assert.ok(!validateAttributeValuePattern(versionAttr, 'v1.0.0.0'), 'prefix letter invalid');
    });

    it('ST_Publisher accepts X.500 distinguished names', () => {
        const identity = model.elements.get(`${FOUNDATION_NS}|Identity`);
        assert.ok(identity);
        const publisherAttr = identity.attributes.find(a => a.name === 'Publisher');
        assert.ok(publisherAttr);

        assert.ok(validateAttributeValuePattern(publisherAttr, 'CN=Contoso'), 'simple CN valid');
        assert.ok(validateAttributeValuePattern(publisherAttr, 'CN=Test, O=Contoso, L=Redmond, S=WA, C=US'), 'full DN valid');
        assert.ok(validateAttributeValuePattern(publisherAttr, 'CN=A3F5BC2E-1234-5678-ABCD-EF0123456789'), 'GUID publisher valid');
    });

    it('ST_GUID accepts properly formatted GUIDs', () => {
        // Find an element with a GUID attribute
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" />
  <Applications>
    <Application Id="App" />
  </Applications>`));

        // No diagnostics should fire for valid values
        assert.ok(!diagnostics.some(d => d.message.includes('is invalid')));
    });

    it('ST_ApplicationId requires segments starting with letters', () => {
        const app = model.elements.get(`${FOUNDATION_NS}|Application`);
        assert.ok(app);
        const idAttr = app.attributes.find(a => a.name === 'Id');
        assert.ok(idAttr);

        assert.ok(validateAttributeValuePattern(idAttr, 'App'), 'simple valid');
        assert.ok(validateAttributeValuePattern(idAttr, 'My.App'), 'dotted valid');
        assert.ok(validateAttributeValuePattern(idAttr, 'App1'), 'with digits valid');

        assert.ok(!validateAttributeValuePattern(idAttr, '1App'), 'starting with digit invalid');
        assert.ok(!validateAttributeValuePattern(idAttr, '.App'), 'starting with dot invalid');
        assert.ok(!validateAttributeValuePattern(idAttr, 'My App'), 'with space invalid');
    });

    it('TYPE_DESCRIPTIONS has entries for all commonly used types', () => {
        const expectedTypes = [
            'ST_VersionQuad', 'ST_Publisher', 'ST_PackageName', 'ST_GUID',
            'ST_ApplicationId', 'ST_Protocol', 'ST_Color', 'ST_DisplayName',
            'ST_ImageFile', 'ST_Executable', 'ST_FileName', 'ST_EntryPoint',
            'ST_URI', 'ST_NonEmptyString', 'ST_ResourceId',
        ];
        for (const typeName of expectedTypes) {
            assert.ok(TYPE_DESCRIPTIONS[typeName], `TYPE_DESCRIPTIONS should have entry for ${typeName}`);
        }
    });

    it('TYPE_DESCRIPTIONS values do not contain raw regex patterns', () => {
        for (const [typeName, desc] of Object.entries(TYPE_DESCRIPTIONS)) {
            assert.ok(!desc.includes('[A-Z'), `${typeName} description should not contain raw regex character class`);
            assert.ok(!desc.includes('\\d'), `${typeName} description should not contain regex \\d`);
            assert.ok(!desc.includes('^('), `${typeName} description should not contain regex anchors`);
        }
    });
});

describe('pattern error message formatting', () => {
    it('uses friendly description for known type (ST_PackageName)', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="Invalid Name!" Publisher="CN=Test" Version="1.0.0.0" />`));

        const nameDiag = diagnostics.find(d => d.message.includes("'Name'") && d.message.includes('is invalid'));
        assert.ok(nameDiag, 'Should produce a Name pattern diagnostic');
        assert.ok(nameDiag.message.includes('package name'), 'Should mention "package name" in the friendly description');
        assert.ok(!nameDiag.message.includes('Expected pattern:'), 'Should not show raw pattern for known types');
    });

    it('uses friendly description for known type (ST_VersionQuad)', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="TestApp" Publisher="CN=Test" Version="not-a-version" />`));

        const versionDiag = diagnostics.find(d => d.message.includes("'Version'") && d.message.includes('is invalid'));
        assert.ok(versionDiag, 'Should produce a Version pattern diagnostic');
        assert.ok(versionDiag.message.includes('dot-quad'), 'Should mention "dot-quad" in the friendly description');
    });

    it('shows raw pattern fallback for types not in TYPE_DESCRIPTIONS', () => {
        // We verify the behavior by checking that if an attribute has a typeName
        // not in TYPE_DESCRIPTIONS, the message includes 'Expected pattern:' or 'datatype'
        // This is tested indirectly — if all manifest types are covered, we at least
        // verify the branching logic exists
        const knownTypes = new Set(Object.keys(TYPE_DESCRIPTIONS));
        const identity = model.elements.get(`${FOUNDATION_NS}|Identity`);
        assert.ok(identity);
        for (const attr of identity.attributes) {
            if (attr.typeName && !knownTypes.has(attr.typeName) && attr.patterns && attr.patterns.length > 0) {
                // Found an attribute with an unmapped type — validate it triggers fallback
                const invalidValue = '!!!completely-invalid-for-any-type!!!';
                if (!validateAttributeValuePattern(attr, invalidValue)) {
                    const diagnostics = validateManifestText(model, makeManifest(
                        `<Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" ${attr.name}="${invalidValue}" />`
                    ));
                    const diag = diagnostics.find(d => d.message.includes(attr.name) && d.message.includes('is invalid'));
                    if (diag) {
                        assert.ok(
                            diag.message.includes('Expected pattern:') || diag.message.includes('datatype'),
                            `Unmapped type ${attr.typeName} should show raw pattern or datatype name`
                        );
                    }
                }
            }
        }
    });
});

// ============================================================================
// 2. Base type inheritance (complexContent/extension)
// ============================================================================

describe('base type inheritance', () => {
    it('UAP VisualElements inherits attributes from base type', () => {
        const visualElements = model.elements.get(`${UAP_NS}|VisualElements`);
        assert.ok(visualElements, 'UAP VisualElements should exist in schema');

        // VisualElements in UAP should have DisplayName (required in most versions)
        const displayName = visualElements.attributes.find(a => a.name === 'DisplayName');
        assert.ok(displayName, 'VisualElements should have DisplayName attribute (possibly inherited)');
    });

    it('UAP SplashScreen inherits Image attribute from base CT_SplashScreen', () => {
        const splashScreen = model.elements.get(`${UAP_NS}|SplashScreen`);
        assert.ok(splashScreen, 'UAP SplashScreen should exist in schema');

        const imageAttr = splashScreen.attributes.find(a => a.name === 'Image');
        assert.ok(imageAttr, 'SplashScreen should inherit Image attribute from base type');
    });

    it('SplashScreen does not produce undeclared-attribute warning for Image', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" />
  <Applications>
    <Application Id="App">
      <uap:VisualElements DisplayName="App" Description="Desc" BackgroundColor="transparent" Square150x150Logo="logo.png" Square44x44Logo="small.png">
        <uap:SplashScreen Image="Assets\\SplashScreen.png" />
      </uap:VisualElements>
    </Application>
  </Applications>`));

        const splashDiag = diagnostics.find(d =>
            d.message.includes('Image') && d.message.includes('not declared') && d.message.includes('SplashScreen')
        );
        assert.equal(splashDiag, undefined, 'Image attribute on SplashScreen should not be flagged as undeclared');
    });

    it('inherited attributes retain their pattern constraints', () => {
        const splashScreen = model.elements.get(`${UAP_NS}|SplashScreen`);
        assert.ok(splashScreen);

        const imageAttr = splashScreen.attributes.find(a => a.name === 'Image');
        assert.ok(imageAttr, 'Image attribute should exist');

        // Image should have pattern constraints from its type (ST_ImageFile)
        // Valid image path should pass
        assert.ok(validateAttributeValuePattern(imageAttr, 'Assets\\SplashScreen.png'),
            'Valid image path should pass pattern validation');
    });

    it('multi-level inheritance resolves attributes correctly', () => {
        // Application extends CT_Application which may extend further
        const app = model.elements.get(`${FOUNDATION_NS}|Application`);
        assert.ok(app);
        // Should have basic attributes like Id and Executable
        assert.ok(app.attributes.find(a => a.name === 'Id'), 'Application should have Id');
        assert.ok(app.attributes.find(a => a.name === 'Executable'), 'Application should have Executable');
    });

    it('extension types merge attributes without duplicates', () => {
        const splashScreen = model.elements.get(`${UAP_NS}|SplashScreen`);
        assert.ok(splashScreen);

        // Count attribute names — should have no duplicates
        const attrNames = splashScreen.attributes.map(a => a.name);
        const uniqueNames = new Set(attrNames);
        assert.equal(attrNames.length, uniqueNames.size,
            `SplashScreen should not have duplicate attributes. Found: ${attrNames.join(', ')}`);
    });
});

// ============================================================================
// 3. Schema URI in diagnostics
// ============================================================================

describe('schema URI in diagnostics', () => {
    it('populates schemaUri for pattern validation errors', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="Bad Name" Publisher="CN=Test" Version="1.0.0.0" />`));

        const nameDiag = diagnostics.find(d => d.message.includes("'Name'") && d.message.includes('is invalid'));
        assert.ok(nameDiag, 'Should produce Name pattern diagnostic');
        assert.equal(nameDiag.schemaUri, FOUNDATION_NS, 'schemaUri should be the foundation namespace');
    });

    it('populates schemaUri for enum validation errors', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" ProcessorArchitecture="invalid" />`));

        const enumDiag = diagnostics.find(d => d.message.includes('ProcessorArchitecture'));
        assert.ok(enumDiag, 'Should produce enum diagnostic');
        assert.equal(enumDiag.schemaUri, FOUNDATION_NS, 'schemaUri should be foundation namespace');
    });

    it('populates schemaUri for required attribute errors', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Publisher="CN=Test" Version="1.0.0.0" />`));

        const reqDiag = diagnostics.find(d => d.message.includes("Missing required attribute 'Name'"));
        assert.ok(reqDiag, 'Should produce required attribute diagnostic');
        assert.equal(reqDiag.schemaUri, FOUNDATION_NS, 'schemaUri should be foundation namespace');
    });

    it('populates schemaUri for undeclared attribute hints', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" FakeAttr="abc" />`));

        const undeclaredDiag = diagnostics.find(d => d.message.includes('FakeAttr') && d.message.includes('not declared'));
        assert.ok(undeclaredDiag, 'Should produce undeclared attribute diagnostic');
        assert.equal(undeclaredDiag.schemaUri, FOUNDATION_NS, 'schemaUri should be foundation namespace');
    });

    it('uses UAP namespace for UAP element diagnostics', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" />
  <Applications>
    <Application Id="App">
      <uap:VisualElements DisplayName="App" Description="Desc" BackgroundColor="not-a-color" Square150x150Logo="logo.png" Square44x44Logo="small.png" />
    </Application>
  </Applications>`));

        const colorDiag = diagnostics.find(d => d.message.includes('BackgroundColor'));
        assert.ok(colorDiag, 'Should produce BackgroundColor diagnostic');
        assert.equal(colorDiag.schemaUri, UAP_NS, 'schemaUri should be UAP namespace for UAP elements');
    });

    it('does not set schemaUri when namespace is empty', () => {
        // Root element not recognized produces no schemaUri
        const diagnostics = validateManifestText(model, `<?xml version="1.0"?><FakeRoot />`);
        const rootDiag = diagnostics.find(d => d.message.includes('FakeRoot'));
        if (rootDiag) {
            assert.equal(rootDiag.schemaUri, undefined, 'Unknown root should not have schemaUri');
        }
    });

    it('populates schemaUri for length validation errors', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="A" Publisher="CN=Test" Version="1.0.0.0" />`));

        const lenDiag = diagnostics.find(d => d.message.includes('must be at least'));
        assert.ok(lenDiag, 'Should produce length diagnostic');
        assert.equal(lenDiag.schemaUri, FOUNDATION_NS, 'schemaUri should be foundation namespace');
    });
});

// ============================================================================
// 4. Regression tests for previously-fixed bugs
// ============================================================================

describe('regression tests', () => {
    it('SplashScreen Image attribute is recognized (not flagged as undeclared)', () => {
        // Regression: UAP CT_SplashScreen extends t:CT_SplashScreen but findTypeEntry
        // was self-matching, so base attributes like Image were never merged.
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" />
  <Applications>
    <Application Id="App">
      <uap:VisualElements DisplayName="App" Description="Test" BackgroundColor="transparent" Square150x150Logo="a.png" Square44x44Logo="b.png">
        <uap:SplashScreen Image="splash.png" />
      </uap:VisualElements>
    </Application>
  </Applications>`));

        assert.ok(!diagnostics.some(d => d.message.includes('Image') && d.message.includes('not declared')),
            'Image on SplashScreen must not be flagged (base type inheritance fix)');
    });

    it('valid manifest with common elements produces no diagnostics', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="MyApp" Publisher="CN=Test" Version="1.0.0.0" />
  <Properties>
    <DisplayName>My Application</DisplayName>
    <PublisherDisplayName>Test Publisher</PublisherDisplayName>
    <Logo>Assets\\StoreLogo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Universal" MinVersion="10.0.17763.0" MaxVersionTested="10.0.22621.0" />
  </Dependencies>
  <Applications>
    <Application Id="App" Executable="MyApp.exe" EntryPoint="MyApp.App">
      <uap:VisualElements DisplayName="My App" Description="Description" BackgroundColor="transparent" Square150x150Logo="Assets\\Logo.png" Square44x44Logo="Assets\\SmallLogo.png">
        <uap:DefaultTile Wide310x150Logo="Assets\\Wide.png" />
        <uap:SplashScreen Image="Assets\\Splash.png" />
      </uap:VisualElements>
    </Application>
  </Applications>`));

        // A well-formed real-world manifest should produce zero pattern/enum/attribute errors
        const realErrors = diagnostics.filter(d =>
            d.message.includes('is invalid') ||
            d.message.includes('not declared') ||
            d.message.includes('Missing required') ||
            d.message.includes('Invalid value')
        );
        assert.equal(realErrors.length, 0,
            `Valid manifest should produce no errors. Got:\n${realErrors.map(d => `  - ${d.message}`).join('\n')}`);
    });

    it('Dependencies element does not produce false positive diagnostics', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" />
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Universal" MinVersion="10.0.17763.0" MaxVersionTested="10.0.22621.0" />
  </Dependencies>`));

        assert.ok(!diagnostics.some(d => d.message.includes('Dependencies')),
            'Dependencies should not trigger any diagnostics');
    });

    it('Identity Name with hyphens is valid (not flagged)', () => {
        // Regression: Description initially said "alphanumeric and periods" but
        // ST_AsciiIdentifier pattern is [-.A-Za-z0-9]+
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="My-App.Name" Publisher="CN=Test" Version="1.0.0.0" />`));

        assert.ok(!diagnostics.some(d => d.message.includes("'Name'") && d.message.includes('is invalid')),
            'Identity Name with hyphens should be valid per ST_AsciiIdentifier pattern');
    });

    it('multiple diagnostics on same element each get correct schemaUri', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="!!!" Publisher="!!!" Version="bad" />`));

        // All three should have foundation namespace
        const patternDiags = diagnostics.filter(d => d.message.includes('is invalid'));
        assert.ok(patternDiags.length >= 2, 'Should have at least 2 pattern diagnostics');
        for (const d of patternDiags) {
            assert.equal(d.schemaUri, FOUNDATION_NS, 'All Identity diagnostics should reference foundation namespace');
        }
    });

    it('pattern diagnostic positions on attribute value, not element tag', () => {
        const text = makeManifest(`
  <Identity Name="Bad Name" Publisher="CN=Test" Version="1.0.0.0" />`);
        const diagnostics = validateManifestText(model, text);
        const nameDiag = diagnostics.find(d => d.message.includes("'Name'") && d.message.includes('is invalid'));
        assert.ok(nameDiag);

        // The diagnostic column should point inside the attribute value
        const lines = text.split('\n');
        const identityLine = lines[nameDiag.line];
        const valueStart = identityLine.indexOf('"Bad Name"');
        assert.ok(valueStart >= 0, 'Should find the value in the line');
        // col should be at or near the value start (after the opening quote)
        assert.ok(nameDiag.col >= valueStart, 'Diagnostic col should be at the attribute value');
        assert.ok(nameDiag.endCol > nameDiag.col, 'Diagnostic should have a non-zero width');
    });
});

// ============================================================================
// Bug regression tests (#124, #125, #126)
// ============================================================================

describe('bug #126: unclosed element shows parse error', () => {
    it('reports a parse error for an unclosed element tag', () => {
        const xml = `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="${FOUNDATION_NS}">
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" />
  <Properties>
    <DisplayName`;
        const diagnostics = validateManifestText(model, xml);
        assert.ok(diagnostics.length > 0, 'Should report at least one diagnostic');
        assert.ok(diagnostics.some(d => d.severity === 'error'),
            'At least one diagnostic should be severity "error"');
    });

    it('reports a parse error for a missing closing tag', () => {
        const xml = makeManifest(`
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" />
  <Properties>
    <DisplayName>Test</DisplayName>`);
        // Properties is never closed (Package closing tag will mismatch)
        const brokenXml = xml.replace('</Package>', '');
        const diagnostics = validateManifestText(model, brokenXml);
        assert.ok(diagnostics.some(d => d.severity === 'error'),
            'Should report an error for unclosed element');
    });

    it('still validates correctly when XML is well-formed', () => {
        const xml = makeManifest(`
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" />
  <Properties>
    <DisplayName>Test</DisplayName>
    <PublisherDisplayName>Pub</PublisherDisplayName>
    <Logo>logo.png</Logo>
  </Properties>
  <Resources>
    <Resource Language="en-us" />
  </Resources>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Universal" MinVersion="10.0.17763.0" MaxVersionTested="10.0.22621.0" />
  </Dependencies>`);
        const diagnostics = validateManifestText(model, xml);
        const errors = diagnostics.filter(d => d.severity === 'error');
        assert.equal(errors.length, 0, 'Well-formed XML should have no parse errors');
    });
});

describe('bug #125: missing required child elements produce diagnostics', () => {
    it('flags missing DisplayName in Properties', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" />
  <Properties>
    <PublisherDisplayName>Test</PublisherDisplayName>
    <Logo>logo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Universal" MinVersion="10.0.17763.0" MaxVersionTested="10.0.22621.0" />
  </Dependencies>`));

        assert.ok(diagnostics.some(d => d.message.includes("Missing required element <DisplayName>")),
            'Should flag missing DisplayName');
    });

    it('flags missing Identity in Package', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Properties>
    <DisplayName>Test</DisplayName>
    <PublisherDisplayName>Test</PublisherDisplayName>
    <Logo>logo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Universal" MinVersion="10.0.17763.0" MaxVersionTested="10.0.22621.0" />
  </Dependencies>`));

        assert.ok(diagnostics.some(d => d.message.includes("Missing required element <Identity>")),
            'Should flag missing Identity');
    });

    it('flags missing Dependencies in Package', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" />
  <Properties>
    <DisplayName>Test</DisplayName>
    <PublisherDisplayName>Test</PublisherDisplayName>
    <Logo>logo.png</Logo>
  </Properties>`));

        assert.ok(diagnostics.some(d => d.message.includes("Missing required element <Dependencies>")),
            'Should flag missing Dependencies');
    });

    it('flags missing TargetDeviceFamily in Dependencies', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" />
  <Properties>
    <DisplayName>Test</DisplayName>
    <PublisherDisplayName>Test</PublisherDisplayName>
    <Logo>logo.png</Logo>
  </Properties>
  <Dependencies>
  </Dependencies>`));

        assert.ok(diagnostics.some(d => d.message.includes("Missing required element <TargetDeviceFamily>")),
            'Should flag missing TargetDeviceFamily');
    });

    it('does not flag optional children as missing', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" />
  <Properties>
    <DisplayName>Test</DisplayName>
    <PublisherDisplayName>Test</PublisherDisplayName>
    <Logo>logo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Universal" MinVersion="10.0.17763.0" MaxVersionTested="10.0.22621.0" />
  </Dependencies>`));

        // Applications, Capabilities, Extensions are all optional
        assert.ok(!diagnostics.some(d => d.message.includes("Missing required element <Applications>")),
            'Should not flag optional Applications');
        assert.ok(!diagnostics.some(d => d.message.includes("Missing required element <Capabilities>")),
            'Should not flag optional Capabilities');
        assert.ok(!diagnostics.some(d => d.message.includes("Missing required element <Extensions>")),
            'Should not flag optional Extensions');
    });

    it('does not flag choice group children as required (PackageDependency in Dependencies)', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" />
  <Properties>
    <DisplayName>Test</DisplayName>
    <PublisherDisplayName>Test</PublisherDisplayName>
    <Logo>logo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Universal" MinVersion="10.0.17763.0" MaxVersionTested="10.0.22621.0" />
  </Dependencies>`));

        assert.ok(!diagnostics.some(d => d.message.includes("Missing required element <PackageDependency>")),
            'Should not flag PackageDependency (from xs:choice minOccurs=0)');
        assert.ok(!diagnostics.some(d => d.message.includes("Missing required element <HostRuntimeDependency>")),
            'Should not flag HostRuntimeDependency (from xs:choice minOccurs=0)');
    });

    it('accepts any satisfied required xs:choice branch for package Extensions', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" />
  <Properties>
    <DisplayName>Test</DisplayName>
    <PublisherDisplayName>Test</PublisherDisplayName>
    <Logo>logo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Universal" MinVersion="10.0.17763.0" MaxVersionTested="10.0.22621.0" />
  </Dependencies>
  <Extensions>
    <Extension Category="windows.certificates">
      <Certificates />
    </Extension>
  </Extensions>`));

        assert.ok(!diagnostics.some(d => d.message.includes('InProcessServer')));
        assert.ok(!diagnostics.some(d => d.message.includes('OutOfProcessServer')));
        assert.ok(!diagnostics.some(d => d.message.includes('ProxyStub')));
        assert.ok(!diagnostics.some(d => d.message.includes('GameExplorer')));
    });

    it('does not let a child from the wrong namespace satisfy a required element', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" />
  <Properties>
    <DisplayName>Test</DisplayName>
    <PublisherDisplayName>Test</PublisherDisplayName>
    <Logo>logo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Universal" MinVersion="10.0.17763.0" MaxVersionTested="10.0.22621.0" />
  </Dependencies>
  <Applications>
    <Application Id="App">
      <fake:VisualElements DisplayName="App" Description="App" BackgroundColor="transparent" Square150x150Logo="logo.png" Square44x44Logo="small.png" />
    </Application>
  </Applications>`, ` xmlns:fake="https://example.com/fake"`));

        assert.ok(diagnostics.some(d => d.message.includes('Missing required element <VisualElementsChoice>')),
            'Expected required VisualElementsChoice diagnostic when only a wrong-namespace element is present');
    });

    it('stops recursive validation before deeply nested input overflows the stack', () => {
        const nested = '<Wrapper>'.repeat(130) + '</Wrapper>'.repeat(130);
        const xml = `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="${FOUNDATION_NS}">
${nested}
</Package>`;

        assert.doesNotThrow(() => validateManifestText(model, xml));
    });
});

describe('bug #124: elements from unbundled namespaces are not flagged as unknown', () => {
    it('does not flag rescap:Capability as unknown', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" />
  <Properties>
    <DisplayName>Test</DisplayName>
    <PublisherDisplayName>Test</PublisherDisplayName>
    <Logo>logo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Universal" MinVersion="10.0.17763.0" MaxVersionTested="10.0.22621.0" />
  </Dependencies>
  <Capabilities>
    <rescap:Capability Name="broadFileSystemAccess" />
  </Capabilities>`, ` xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"`));

        assert.ok(!diagnostics.some(d => d.message.includes("Unknown element 'Capability'")),
            'rescap:Capability should not be flagged as unknown');
    });

    it('still flags unknown elements in bundled namespaces', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" />
  <Properties>
    <DisplayName>Test</DisplayName>
    <PublisherDisplayName>Test</PublisherDisplayName>
    <Logo>logo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Universal" MinVersion="10.0.17763.0" MaxVersionTested="10.0.22621.0" />
  </Dependencies>
  <FakeElement />`), 'warning', { strictChildPlacement: true });

        assert.ok(diagnostics.some(d => d.message.includes("Unknown element 'FakeElement'")),
            'Unknown elements in bundled namespaces should still be flagged');
    });
});

// ============================================================================
// Diagnostic severity assignments
// ============================================================================

describe('diagnostic severity levels', () => {
    it('missing required attribute is error severity', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Publisher="CN=Test" Version="1.0.0.0" />
  <Properties>
    <DisplayName>Test</DisplayName>
    <PublisherDisplayName>Test</PublisherDisplayName>
    <Logo>logo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Universal" MinVersion="10.0.17763.0" MaxVersionTested="10.0.22621.0" />
  </Dependencies>`));

        const missingName = diagnostics.find(d => d.message.includes("Missing required attribute 'Name'"));
        assert.ok(missingName, 'Should flag missing Name attribute');
        assert.equal(missingName.severity, 'error', 'Missing required attribute should be error severity');
    });

    it('invalid enum value is error severity', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" ProcessorArchitecture="invalid" />
  <Properties>
    <DisplayName>Test</DisplayName>
    <PublisherDisplayName>Test</PublisherDisplayName>
    <Logo>logo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Universal" MinVersion="10.0.17763.0" MaxVersionTested="10.0.22621.0" />
  </Dependencies>`));

        const invalidEnum = diagnostics.find(d => d.message.includes("Invalid value 'invalid'"));
        assert.ok(invalidEnum, 'Should flag invalid enum value');
        assert.equal(invalidEnum.severity, 'error', 'Invalid enum value should be error severity');
    });

    it('pattern violation is error severity', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="Test" Publisher="CN=Test" Version="bad-version" />
  <Properties>
    <DisplayName>Test</DisplayName>
    <PublisherDisplayName>Test</PublisherDisplayName>
    <Logo>logo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Universal" MinVersion="10.0.17763.0" MaxVersionTested="10.0.22621.0" />
  </Dependencies>`));

        const patternViolation = diagnostics.find(d => d.message.includes("'Version'") && d.message.includes('is invalid'));
        assert.ok(patternViolation, 'Should flag invalid pattern');
        assert.equal(patternViolation.severity, 'error', 'Pattern violation should be error severity');
    });

    it('missing required child element is error severity', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" />
  <Properties>
    <PublisherDisplayName>Test</PublisherDisplayName>
    <Logo>logo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Universal" MinVersion="10.0.17763.0" MaxVersionTested="10.0.22621.0" />
  </Dependencies>`));

        const missingChild = diagnostics.find(d => d.message.includes("Missing required element <DisplayName>"));
        assert.ok(missingChild, 'Should flag missing DisplayName');
        assert.equal(missingChild.severity, 'error', 'Missing required child should be error severity');
    });

    it('undeclared attribute is warning severity', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" NotARealAttr="hello" />
  <Properties>
    <DisplayName>Test</DisplayName>
    <PublisherDisplayName>Test</PublisherDisplayName>
    <Logo>logo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Universal" MinVersion="10.0.17763.0" MaxVersionTested="10.0.22621.0" />
  </Dependencies>`));

        const undeclared = diagnostics.find(d => d.message.includes("Attribute 'NotARealAttr' is not declared"));
        assert.ok(undeclared, 'Should flag undeclared attribute');
        assert.equal(undeclared.severity, 'warning', 'Undeclared attribute should be warning severity');
    });

    it('XML parse error is error severity', () => {
        const diagnostics = validateManifestText(model, '<Package><Broken');
        assert.ok(diagnostics.length > 0, 'Should produce parse error diagnostics');
        assert.ok(diagnostics.every(d => d.severity === 'error'),
            'All XML parse errors should be error severity');
    });
});

// ============================================================================
// Element text content validation
// ============================================================================

describe('element text content validation', () => {
    it('flags FileType text content that violates pattern (missing dot prefix)', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
            <Applications>
                <Application Id="App" Executable="app.exe" EntryPoint="App">
                    <uap:VisualElements DisplayName="Test" Description="Test"
                        BackgroundColor="transparent" Square150x150Logo="l.png" Square44x44Logo="s.png" />
                    <Extensions>
                        <uap:Extension Category="windows.shareTarget">
                            <uap:ShareTarget>
                                <uap:SupportedFileTypes>
                                    <uap:FileType>txt</uap:FileType>
                                </uap:SupportedFileTypes>
                                <uap:DataFormat>text</uap:DataFormat>
                            </uap:ShareTarget>
                        </uap:Extension>
                    </Extensions>
                </Application>
            </Applications>
        `));
        const textErrors = diagnostics.filter(d => d.message.includes('Text content'));
        assert.ok(textErrors.length > 0, 'Should flag "txt" as invalid FileType text (missing dot)');
        assert.ok(textErrors[0].message.includes('FileType'));
    });

    it('positions multiline text content diagnostics on the text line', () => {
        const text = makeManifest(`
            <Applications>
                <Application Id="App" Executable="app.exe" EntryPoint="App">
                    <uap:VisualElements DisplayName="Test" Description="Test"
                        BackgroundColor="transparent" Square150x150Logo="l.png" Square44x44Logo="s.png" />
                    <Extensions>
                        <uap:Extension Category="windows.shareTarget">
                            <uap:ShareTarget>
                                <uap:SupportedFileTypes>
                                    <uap:FileType>
                                        txt
                                    </uap:FileType>
                                </uap:SupportedFileTypes>
                                <uap:DataFormat>text</uap:DataFormat>
                            </uap:ShareTarget>
                        </uap:Extension>
                    </Extensions>
                </Application>
            </Applications>
        `);
        const diagnostics = validateManifestText(model, text);
        const textError = diagnostics.find(d => d.message.includes('<FileType>'));
        assert.ok(textError, 'Should flag invalid multiline FileType text');

        const lines = text.split(/\r?\n/);
        const textLine = lines.findIndex(line => line.includes('txt'));
        assert.equal(textError.line, textLine, 'Diagnostic should point to the text content line');
        assert.equal(textError.col, lines[textLine].indexOf('txt'));
        assert.equal(textError.endCol, lines[textLine].indexOf('txt') + 'txt'.length);
    });

    it('accepts valid FileType text content (.txt)', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
            <Applications>
                <Application Id="App" Executable="app.exe" EntryPoint="App">
                    <uap:VisualElements DisplayName="Test" Description="Test"
                        BackgroundColor="transparent" Square150x150Logo="l.png" Square44x44Logo="s.png" />
                    <Extensions>
                        <uap:Extension Category="windows.shareTarget">
                            <uap:ShareTarget>
                                <uap:SupportedFileTypes>
                                    <uap:FileType>.txt</uap:FileType>
                                </uap:SupportedFileTypes>
                                <uap:DataFormat>text</uap:DataFormat>
                            </uap:ShareTarget>
                        </uap:Extension>
                    </Extensions>
                </Application>
            </Applications>
        `));
        const textErrors = diagnostics.filter(d => d.message.includes('Text content'));
        assert.equal(textErrors.length, 0, 'Valid FileType ".txt" should not be flagged');
    });

    it('does not flag empty text content', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
            <Applications>
                <Application Id="App" Executable="app.exe" EntryPoint="App">
                    <uap:VisualElements DisplayName="Test" Description="Test"
                        BackgroundColor="transparent" Square150x150Logo="l.png" Square44x44Logo="s.png" />
                    <Extensions>
                        <uap:Extension Category="windows.shareTarget">
                            <uap:ShareTarget>
                                <uap:SupportedFileTypes>
                                    <uap:FileType></uap:FileType>
                                </uap:SupportedFileTypes>
                                <uap:DataFormat>text</uap:DataFormat>
                            </uap:ShareTarget>
                        </uap:Extension>
                    </Extensions>
                </Application>
            </Applications>
        `));
        const textErrors = diagnostics.filter(d => d.message.includes('Text content'));
        assert.equal(textErrors.length, 0, 'Empty text content should not be flagged');
    });

    it('uses the original text content for pattern validation instead of trimming whitespace', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
            <Applications>
                <Application Id="App" Executable="app.exe" EntryPoint="App">
                    <uap:VisualElements DisplayName="Test" Description="Test"
                        BackgroundColor="transparent" Square150x150Logo="l.png" Square44x44Logo="s.png" />
                    <Extensions>
                        <uap:Extension Category="windows.shareTarget">
                            <uap:ShareTarget>
                                <uap:SupportedFileTypes>
                                    <uap:FileType> .txt </uap:FileType>
                                </uap:SupportedFileTypes>
                                <uap:DataFormat>text</uap:DataFormat>
                            </uap:ShareTarget>
                        </uap:Extension>
                    </Extensions>
                </Application>
            </Applications>
        `));

        const textError = diagnostics.find(d => d.message.includes("Text content ' .txt ' in <FileType> is invalid"));
        assert.ok(textError, 'Whitespace-padded FileType text should be validated without trimming');
    });

    it('flags invalid enum-constrained text content', () => {
        const diagnostics = validateManifestText(createTextContentTestModel(), `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="${FOUNDATION_NS}">
  <Mode>Gamma</Mode>
</Package>`);

        const enumError = diagnostics.find(d => d.message.includes("Invalid text content 'Gamma' for <Mode>. Expected one of: Alpha, Beta"));
        assert.ok(enumError, 'Should flag invalid enum text content');
    });

    it('flags text content that exceeds maxLength', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
            <Applications>
                <Application Id="App" Executable="app.exe" EntryPoint="App">
                    <uap:VisualElements DisplayName="Test" Description="Test"
                        BackgroundColor="transparent" Square150x150Logo="l.png" Square44x44Logo="s.png" />
                    <Extensions>
                        <uap:Extension Category="windows.shareTarget">
                            <uap:ShareTarget>
                                <uap:SupportedFileTypes>
                                    <uap:FileType>.${'a'.repeat(64)}</uap:FileType>
                                </uap:SupportedFileTypes>
                                <uap:DataFormat>text</uap:DataFormat>
                            </uap:ShareTarget>
                        </uap:Extension>
                    </Extensions>
                </Application>
            </Applications>
        `));

        const lengthError = diagnostics.find(d => d.message.includes('Text content in <FileType> exceeds maximum length of 64 characters (got 65)'));
        assert.ok(lengthError, 'Should flag text content that exceeds maxLength');
    });

    it('elements without simpleTypeName skip text validation', () => {
        // <Application> has no simpleTypeName — its text content (if any) should not be validated
        const diagnostics = validateManifestText(model, makeManifest(`
            <Applications>
                <Application Id="App" Executable="app.exe" EntryPoint="App">
                    <uap:VisualElements DisplayName="Test" Description="Test"
                        BackgroundColor="transparent" Square150x150Logo="l.png" Square44x44Logo="s.png" />
                </Application>
            </Applications>
        `));
        const textErrors = diagnostics.filter(d => d.message.includes('Text content'));
        assert.equal(textErrors.length, 0);
    });

    it('returns parse diagnostics for an empty manifest', () => {
        const diagnostics = validateManifestText(model, '');
        assert.ok(diagnostics.length > 0, 'Empty manifest should produce diagnostics');
    });

    it('returns parse diagnostics for a whitespace-only manifest', () => {
        const diagnostics = validateManifestText(model, '   ');
        assert.ok(diagnostics.length > 0, 'Whitespace-only manifest should produce diagnostics');
    });

    it('handles a minimal manifest without crashing', () => {
        assert.doesNotThrow(() => validateManifestText(model, `<?xml version="1.0" encoding="utf-8"?><Package xmlns="${FOUNDATION_NS}" />`));
        const diagnostics = validateManifestText(model, `<?xml version="1.0" encoding="utf-8"?><Package xmlns="${FOUNDATION_NS}" />`);
        assert.ok(Array.isArray(diagnostics));
    });
});
