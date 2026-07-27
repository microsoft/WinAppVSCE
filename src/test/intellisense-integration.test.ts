/**
 * Integration tests for AppxManifest IntelliSense logic.
 *
 * Run: npx tsx --test src/test/intellisense-integration.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import Module from 'node:module';
import * as path from 'path';
import { getXmlContext } from '../manifest-schema/xml-context';
import {
    extractDocumentPrefixes,
    findManifestElement,
    formatManifestHoverMarkdown,
    getAttributeCompletions,
    getAttributeValueCompletions,
    getChildCompletions,
    getManifestCompletions,
    getManifestHover,
} from '../manifest-intellisense/intellisense-logic';
import { validateManifestText, findSchemaElementExact } from '../manifest-schema/schema-validation';
import { loadSchemaModel } from '../manifest-schema/xsd-parser';
import { MANIFEST_NAMESPACES } from '../manifest-schema/schema-model';

const SCHEMAS_DIR = path.join(__dirname, '..', '..', 'schemas');

// Skip all tests if schemas are not available (clean clone without sync-schemas)
const schemaFiles = fs.readdirSync(SCHEMAS_DIR, { withFileTypes: true }).filter(f => f.name.endsWith('.xsd'));
if (schemaFiles.length === 0) {
    describe('manifest IntelliSense integration (SKIPPED - no schemas)', () => {
        it('skipped: run npm run sync-schemas first', { skip: 'schemas/ directory is empty' }, () => {});
    });
    process.exit(0);
}

const FOUNDATION_NS = MANIFEST_NAMESPACES[''];
const UAP_NS = MANIFEST_NAMESPACES['uap'];
const COM_NS = MANIFEST_NAMESPACES['com'];
const model = loadSchemaModel(SCHEMAS_DIR);

function makeManifest(body: string, extraNamespaces = ''): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="${FOUNDATION_NS}" xmlns:uap="${UAP_NS}"${extraNamespaces}>
${body}
</Package>`;
}

function makeOpenManifest(body: string, rootNamespaces = `xmlns="${FOUNDATION_NS}" xmlns:uap="${UAP_NS}"`): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<Package ${rootNamespaces}>
${body}`;
}

function assertValidSourceLocation(
    label: string,
    sourceFile: string | undefined,
    sourceLine: number | undefined,
    expectedLinePattern: RegExp
): void {
    assert.ok(sourceFile, `${label} should include a source file`);
    assert.ok(sourceLine !== undefined && sourceLine >= 0, `${label} should include a non-negative source line`);
    assert.ok(fs.existsSync(sourceFile), `${label} source file should exist on disk: ${sourceFile}`);

    const sourceLines = fs.readFileSync(sourceFile, 'utf8').split(/\r?\n/);
    assert.ok(sourceLine < sourceLines.length, `${label} source line should be within file bounds`);
    assert.match(sourceLines[sourceLine], expectedLinePattern, `${label} source line should point at the expected XSD declaration`);
}

describe('manifest completion logic', () => {
    it('returns expected Package child completions', () => {
        const items = getChildCompletions(model, 'Package', undefined, makeManifest(''));
        const labels = items.map(item => item.label);

        assert.ok(labels.includes('Identity'));
        assert.ok(labels.includes('Properties'));
        assert.ok(labels.includes('Dependencies'));
        assert.ok(labels.includes('Resources'));
        assert.ok(labels.includes('Applications'));
        assert.ok(labels.includes('Capabilities'));
        assert.ok(labels.includes('Extensions'));
    });

    it('deduplicates duplicate Package child labels like Capabilities', () => {
        const items = getChildCompletions(model, 'Package', undefined, makeManifest(''));
        const capabilities = items.filter(item => item.label === 'Capabilities');
        assert.equal(capabilities.length, 1);
    });

    it('skips abstract placeholder elements and undeclared-prefix children in completions', () => {
        const items = getChildCompletions(model, 'Package', undefined, makeManifest(''));
        const labels = items.map(item => item.label);

        assert.ok(!labels.includes('AccessControlChoice'));
        assert.ok(!labels.includes('ApplicationDataChoice'));
        assert.ok(!labels.includes('UpdateWhileInUse'));
    });

    it('resolves substitution groups to concrete children for Application', () => {
        const items = getChildCompletions(model, 'Application', undefined, makeManifest(`
  <Applications>
    <Application Id="App" />
  </Applications>`));

        const visualElements = items.find(item => item.label === 'uap:VisualElements');
        assert.ok(visualElements);
        assert.match(visualElements.insertText, /^uap:VisualElements DisplayName="/);
    });

    it('uses document namespace prefixes for concrete substitution children', () => {
        const items = getChildCompletions(
            model,
            'Application',
            undefined,
            makeOpenManifest(`
  <Applications>
    <Application Id="App" />
  </Applications>`, `xmlns="${FOUNDATION_NS}" xmlns:ux="${UAP_NS}"`)
        );

        assert.ok(items.some(item => item.label === 'ux:VisualElements'));
        assert.ok(!items.some(item => item.label === 'uap:VisualElements'));
    });

    it('includes Identity required and optional attributes', () => {
        const items = getAttributeCompletions(model, 'Identity', undefined, [], makeManifest(''));
        const details = new Map(items.map(item => [item.label, item.detail]));

        assert.match(details.get('Name') || '', /^\(required\)/);
        assert.match(details.get('Publisher') || '', /^\(required\)/);
        assert.match(details.get('Version') || '', /^\(required\)/);
        assert.match(details.get('ProcessorArchitecture') || '', /^\(optional\)/);
        assert.match(details.get('ResourceId') || '', /^\(optional\)/);
    });

    it('omits existing attributes from attribute completions', () => {
        const items = getAttributeCompletions(model, 'Identity', undefined, ['Name', 'Publisher'], makeManifest(''));
        const labels = items.map(item => item.label);

        assert.ok(!labels.includes('Name'));
        assert.ok(!labels.includes('Publisher'));
        assert.ok(labels.includes('Version'));
    });

    it('includes enum metadata in ProcessorArchitecture attribute completion', () => {
        const items = getAttributeCompletions(model, 'Identity', undefined, [], makeManifest(''));
        const processorArchitecture = items.find(item => item.label === 'ProcessorArchitecture');

        assert.ok(processorArchitecture);
        assert.match(processorArchitecture.detail || '', /x86, x64, arm, arm64, x86a64/);
        assert.equal(
            processorArchitecture.insertText,
            'ProcessorArchitecture="${1|x86,x64,arm,arm64,x86a64,neutral|}"'
        );
    });

    it('returns enum value completions for ProcessorArchitecture', () => {
        const items = getAttributeValueCompletions(model, 'Identity', undefined, 'ProcessorArchitecture', makeManifest(''));
        assert.deepEqual(items.map(item => item.label), ['x86', 'x64', 'arm', 'arm64', 'x86a64', 'neutral']);
    });

    it('returns enum value completions for prefixed qualified attributes using the local name', () => {
        const items = getAttributeValueCompletions(
            model,
            'Application',
            undefined,
            'ux:TrustLevel',
            makeManifest('', ` xmlns:ux="${MANIFEST_NAMESPACES['uap10']}"`)
        );
        assert.deepEqual(items.map(item => item.label), ['appContainer', 'mediumIL']);
    });

    it('does not fall back across namespaces for prefixed attribute lookups', () => {
        const items = getAttributeValueCompletions(
            model,
            'Application',
            undefined,
            'ux:TrustLevel',
            makeManifest('', ` xmlns:ux="${FOUNDATION_NS}"`)
        );

        assert.deepEqual(items, []);
    });

    it('includes Application attributes used by manifest IntelliSense', () => {
        const items = getAttributeCompletions(model, 'Application', undefined, [], makeManifest(''));
        const labels = items.map(item => item.label);
        const details = new Map(items.map(item => [item.label, item.detail]));

        assert.ok(labels.includes('Id'));
        assert.ok(labels.includes('Executable'));
        assert.ok(labels.includes('EntryPoint'));
        assert.match(details.get('Id') || '', /^\(required\)/);
        assert.match(details.get('Executable') || '', /^\(optional\)/);
    });

    it('uses declared namespace prefixes for qualified attribute completions', () => {
        const items = getAttributeCompletions(
            model,
            'Application',
            undefined,
            [],
            makeManifest('', ` xmlns:ux="${MANIFEST_NAMESPACES['uap10']}"`)
        );

        const trustLevel = items.find(item => item.label === 'ux:TrustLevel');
        assert.ok(trustLevel);
        assert.equal(trustLevel.insertText, 'ux:TrustLevel="${1|appContainer,mediumIL|}"');
    });

    it('ignores commented and nested xmlns rebindings when extracting document prefixes', () => {
        const prefixes = extractDocumentPrefixes(makeManifest(`
  <!-- xmlns:ux="https://example.com/comment-only" -->
  <Applications>
    <Application xmlns:ux="https://example.com/nested-rebind" />
  </Applications>`, ` xmlns:ux="${UAP_NS}"`));

        assert.equal(prefixes.get('ux'), UAP_NS);
    });

    it('skips qualified attribute completions when the namespace is not declared', () => {
        const items = getAttributeCompletions(model, 'Application', undefined, [], makeManifest(''));
        assert.ok(!items.some(item => item.label.endsWith(':TrustLevel')));
    });

    it('offers child element completions in text context', () => {
        const text = makeManifest(`
  <Applications>
    
  </Applications>`);
        const offset = text.indexOf('\n    \n') + 5;
        const items = getManifestCompletions(model, text, offset);
        const application = items.find(item => item.label === 'Application');

        assert.ok(application);
        assert.match(application.insertText, /^<Application Id="/);
        assert.equal(application.filterText, '<Application');
    });

    it('offers attribute completions when the typed element name already matches', () => {
        const text = makeOpenManifest(`
  <Identity`);
        const items = getManifestCompletions(model, text, text.length);

        assert.ok(items.some(item => item.label === 'Name' && item.insertText.startsWith(' Name="')));
        assert.ok(items.some(item => item.label === 'Publisher' && item.sortText === '2_Publisher'));
    });

    it('offers closing tag completions with prefixes preserved', () => {
        const text = makeOpenManifest(`
  <Applications>
    <Application>
      <uap:VisualElements>
      </`);
        const items = getManifestCompletions(model, text, text.length);

        assert.deepEqual(items.map(item => item.label), ['uap:VisualElements']);
        assert.equal(items[0].insertText, 'uap:VisualElements>');
    });

    it('registers slash as a completion trigger character for closing tags', () => {
        const source = fs.readFileSync(
            path.join(__dirname, '..', 'manifest-intellisense', 'manifest-intellisense.ts'),
            'utf8'
        );

        assert.match(source, /const TRIGGER_CHARACTERS = \[[^\]]*'\/'/);
    });

    it('prefers the default namespace match for unprefixed element fallback', () => {
        const element = findManifestElement(
            model,
            'Extension',
            undefined,
            makeOpenManifest('', `xmlns="https://example.com/custom" xmlns:desktop="${MANIFEST_NAMESPACES['desktop4']}"`)
        );

        assert.ok(element);
        assert.equal(element?.namespace, FOUNDATION_NS);
    });

    it('does not produce duplicate child labels for any tested parent', () => {
        const testedParents = ['Package', 'Application', 'Capabilities', 'Applications'];
        for (const parent of testedParents) {
            const items = getChildCompletions(model, parent, undefined, makeManifest(''));
            const labels = items.map(item => item.label);
            assert.equal(labels.length, new Set(labels).size, `${parent} should not have duplicate labels`);
        }
    });
});

describe('manifest hover logic', () => {
    it('returns element hover for Package with children summary', () => {
        const text = makeManifest(`
  <Applications />
  <Properties />
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" />`);
        const offset = text.indexOf('Package') + 2;
        const hover = getManifestHover(model, text, offset);

        assert.ok(hover);
        assert.equal(hover.kind, 'element');
        assert.ok(hover.childElements?.some(child => child.displayName === 'Identity' && child.required));
        assert.ok(hover.childElements?.some(child => child.displayName === 'Applications'));
    });

    it('returns attribute hover instead of element hover inside open tags', () => {
        const text = makeManifest(`
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" ProcessorArchitecture="x64" />`);
        const offset = text.indexOf('ProcessorArchitecture') + 5;
        const hover = getManifestHover(model, text, offset);

        assert.ok(hover);
        assert.equal(hover.kind, 'attribute');
        assert.equal(hover.name, 'ProcessorArchitecture');
        assert.equal(hover.elementName, 'Identity');
        assert.equal(hover.typeName, 'ST_Architecture_v2');
    });

    it('includes allowed values in attribute hover markdown', () => {
        const text = makeManifest(`
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" ProcessorArchitecture="x64" />`);
        const offset = text.indexOf('ProcessorArchitecture') + 3;
        const hover = getManifestHover(model, text, offset);
        assert.ok(hover);

        const markdown = formatManifestHoverMarkdown(hover);
        assert.match(markdown, /Allowed values: `x86`, `x64`, `arm`, `arm64`, `x86a64`, `neutral`/);
    });

    it('shows qualified attribute names with the document prefix in hover', () => {
        const text = makeManifest(`
  <Applications>
    <Application Id="App" ux:TrustLevel="mediumIL" />
  </Applications>`, ` xmlns:ux="${MANIFEST_NAMESPACES['uap10']}"`);
        const offset = text.indexOf('ux:TrustLevel') + 4;
        const hover = getManifestHover(model, text, offset);
        assert.ok(hover);
        assert.equal(hover.kind, 'attribute');
        assert.equal(hover.name, 'ux:TrustLevel');

        const markdown = formatManifestHoverMarkdown(hover);
        assert.match(markdown, /\*\*`ux:TrustLevel`\*\*/);
    });

    it('returns hover for namespace-prefixed elements', () => {
        const text = makeManifest(`
  <Applications>
    <Application Id="App">
      <ux:VisualElements DisplayName="App" Description="App" BackgroundColor="transparent" Square150x150Logo="logo.png" Square44x44Logo="small.png" />
    </Application>
  </Applications>`, ` xmlns:ux="${UAP_NS}"`);
        const offset = text.indexOf('ux:VisualElements') + 4;
        const hover = getManifestHover(model, text, offset);

        assert.ok(hover);
        assert.equal(hover.kind, 'element');
        assert.equal(hover.name, 'ux:VisualElements');
        assert.equal(hover.namespace, UAP_NS);
    });

    it('formats element hover markdown with required and optional attributes', () => {
        const hover = getManifestHover(
            model,
            makeManifest(`
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" />`),
            makeManifest(`
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" />`).indexOf('Identity') + 2
        );
        assert.ok(hover);

        const markdown = formatManifestHoverMarkdown(hover);
        assert.match(markdown, /\*\*Attributes:\*\*/);
        assert.match(markdown, /Required: `Name`, `Publisher`, `Version`/);
        assert.match(markdown, /Optional: `ProcessorArchitecture`, `ResourceId`/);
    });
});

describe('manifest diagnostics integration boundaries', () => {
    it('validateManifestText uses error severity for schema violations', () => {
        const text = makeManifest(`
  <Identity />`);

        const warningDiagnostics = validateManifestText(model, text, 'warning');
        const errorDiagnostics = validateManifestText(model, text, 'error');

        // Schema violations are now always 'error' severity regardless of level param
        assert.ok(warningDiagnostics.some(diagnostic => diagnostic.severity === 'error'));
        assert.ok(errorDiagnostics.some(diagnostic => diagnostic.severity === 'error'));
    });

    it('tracks diagnostics provider wiring through stable config keys and debounce timing', () => {
        // ManifestDiagnosticsProvider depends on vscode APIs and is better covered in
        // VS Code integration tests; here we lock down the public config contract.
        const source = fs.readFileSync(
            path.join(__dirname, '..', 'manifest-intellisense', 'diagnostics-provider.ts'),
            'utf8'
        );

        assert.match(source, /const MANIFEST_CONFIG_SECTION = 'winapp\.manifest'/);
        assert.match(source, /const INTELLISENSE_ENABLE_CONFIG_KEY = 'intelliSense\.enable'/);
        assert.match(source, /const DIAGNOSTICS_LEVEL_CONFIG_KEY = 'diagnostics\.level'/);
        assert.match(source, /const STRICT_CHILD_PLACEMENT_CONFIG_KEY = 'intelliSense\.diagnostics\.strictChildPlacement'/);
        assert.match(source, /const VALIDATION_DEBOUNCE_MS = 500/);
    });
});

describe('manifest diagnostics logic', () => {
    // TODO(M4): Add VS Code extension-host tests for command wiring plus settings/lifecycle behavior.
    // Pure logic tests in this file cover the core IntelliSense and diagnostics behavior for now.
    it('returns no diagnostics for a valid minimal manifest', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" />
  <Properties>
    <DisplayName>Test</DisplayName>
    <PublisherDisplayName>Test Publisher</PublisherDisplayName>
    <Logo>Assets\\StoreLogo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Universal" MinVersion="10.0.17763.0" MaxVersionTested="10.0.22621.0" />
  </Dependencies>`));
        assert.equal(diagnostics.length, 0);
    });

    it('flags missing required attributes', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Applications>
    <Application Executable="demo.exe" />
  </Applications>`));

        assert.ok(diagnostics.some(diagnostic => diagnostic.message.includes("Missing required attribute 'Id'")));
    });

    it('flags invalid enum values', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Applications>
    <Application Id="App">
      <uap:VisualElements DisplayName="App" Description="Desc" BackgroundColor="transparent" Square150x150Logo="logo.png" Square44x44Logo="small.png" AppListEntry="invalid" />
    </Application>
  </Applications>`));

        assert.ok(diagnostics.some(diagnostic => diagnostic.message.includes("Invalid value 'invalid' for attribute 'AppListEntry'")));
    });

    it('returns XML Error diagnostics for malformed XML', () => {
        const diagnostics = validateManifestText(
            model,
            'unexpected text<Package />'
        );

        assert.ok(diagnostics.some(diagnostic => diagnostic.message.startsWith('XML Error:')));
    });

    it('does not treat empty-string required attributes as missing', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="" Publisher="CN=Test" Version="1.0.0.0" />`));

        assert.ok(!diagnostics.some(diagnostic => diagnostic.message.includes("Missing required attribute 'Name'")));
    });

    it('warns for unknown or misplaced child elements', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Applications>
    <Application Id="App">
      <VisualElements />
    </Application>
  </Applications>
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" />`));

        assert.ok(diagnostics.some(diagnostic => diagnostic.message.includes("Unknown element 'VisualElements'")));
    });

    it('findSchemaElementExact only matches exact namespaces', () => {
        assert.ok(findSchemaElementExact(model, 'VisualElements', UAP_NS));
        assert.equal(findSchemaElementExact(model, 'VisualElements', FOUNDATION_NS), undefined);
    });

    it('flags Identity Name with spaces as invalid pattern', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="Invalid Name With Spaces" Publisher="CN=Test" Version="1.0.0.0" />`));

        assert.ok(diagnostics.some(d => d.message.includes("'Name'") && d.message.includes('is invalid')),
            'Name with spaces should violate pattern constraint');
    });

    it('flags Identity Version with wrong format as invalid pattern', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="TestApp" Publisher="CN=Test" Version="not.a.version" />`));

        assert.ok(diagnostics.some(d => d.message.includes("'Version'") && d.message.includes('is invalid')),
            'Version with invalid format should violate pattern constraint');
    });

    it('does not flag valid Identity Name and Version as pattern violations', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="ValidName.App" Publisher="CN=Test" Version="1.2.3.4" />`));

        assert.ok(!diagnostics.some(d => d.message.includes('is invalid')),
            'Valid Name and Version should not trigger pattern violations');
    });

    it('validates qualified attributes when their namespace is declared', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Applications>
    <Application Id="App" uap10:TrustLevel="not-a-real-value" />
  </Applications>`, ` xmlns:uap10="${MANIFEST_NAMESPACES['uap10']}"`));

        assert.ok(diagnostics.some(diagnostic => diagnostic.message.includes('TrustLevel')));
    });

    it('accepts substitution-group children without misplaced-element warnings', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Applications>
    <Application Id="App">
      <uap:VisualElements DisplayName="App" Description="Desc" BackgroundColor="transparent" Square150x150Logo="logo.png" Square44x44Logo="small.png" />
    </Application>
  </Applications>
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" />`));

        assert.ok(!diagnostics.some(diagnostic => diagnostic.message.includes("not allowed as a child of 'Application'")));
    });

    it('does not warn for known elements in unexpected positions (incomplete substitution-group coverage)', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Applications>
    <Application Id="App">
      <Identity Name="Nested" Publisher="CN=Test" Version="1.0.0.0" />
    </Application>
  </Applications>
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" />`));

        // Known schema elements in unexpected positions are not flagged because
        // substitution-group coverage is incomplete and would cause false positives
        assert.ok(!diagnostics.some(diagnostic => diagnostic.message.includes("Identity")));
    });

    it('does not produce false positives on Dependencies or Applications', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" />
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Universal" MinVersion="10.0.17763.0" MaxVersionTested="10.0.19041.0" />
  </Dependencies>
  <Applications>
    <Application Id="App" Executable="App.exe" EntryPoint="App.App" />
  </Applications>`));

        assert.ok(!diagnostics.some(d => d.message.includes("'Dependencies'") || d.message.includes("on <Dependencies>")),
            'Dependencies element should not get false-positive attribute warnings');
        assert.ok(!diagnostics.some(d => d.message.includes("'Applications'") || d.message.includes("on <Applications>")),
            'Applications element should not get false-positive attribute warnings');
    });

    it('positions pattern diagnostics on the attribute value, not the element tag', () => {
        const text = makeManifest(`
  <Identity Name="Bad Name" Publisher="CN=Test" Version="1.0.0.0" />`);
        const diagnostics = validateManifestText(model, text);
        const nameDiag = diagnostics.find(d => d.message.includes("'Name'") && d.message.includes('is invalid'));
        assert.ok(nameDiag, 'Should produce Name pattern diagnostic');

        // The diagnostic should point to the value "Bad Name", not the element start
        const lines = text.split('\n');
        const identityLine = lines.findIndex(l => l.includes('Identity'));
        assert.equal(nameDiag.line, identityLine, 'Diagnostic should be on the Identity line');
        assert.ok(nameDiag.col > 0, 'Diagnostic column should be within the attribute value');
    });

    it('flags values shorter than schema minLength constraints', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="A" Publisher="CN=Test" Version="1.0.0.0" />`));

        assert.ok(
            diagnostics.some(diagnostic => diagnostic.message.includes("Value for 'Name' must be at least 3 characters (got 1)")),
            'Expected a minLength diagnostic for Identity.Name'
        );
    });

    it('flags values longer than schema maxLength constraints', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="${'A'.repeat(51)}" Publisher="CN=Test" Version="1.0.0.0" />`));

        assert.ok(
            diagnostics.some(diagnostic => diagnostic.message.includes("Value for 'Name' exceeds maximum length of 50 characters (got 51)")),
            'Expected a maxLength diagnostic for Identity.Name'
        );
    });

    it('does not emit length diagnostics for values within schema bounds', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="ValidName" Publisher="CN=Test" Version="1.0.0.0" ResourceId="${'R'.repeat(30)}" />`));

        assert.ok(
            !diagnostics.some(diagnostic =>
                diagnostic.message.includes('must be at least') ||
                diagnostic.message.includes('exceeds maximum length')
            ),
            'Values within minLength/maxLength bounds should not trigger length diagnostics'
        );
    });
});

describe('schema and context integration', () => {
    it('finds schema elements using type fallbacks for Identity', () => {
        const identity = findManifestElement(model, 'Identity', undefined, makeManifest(''));
        assert.ok(identity);
        assert.ok(identity.attributes.some(attribute => attribute.name === 'Name' && attribute.required));
    });

    it('finds schema elements for prefixed VisualElements using document prefix mappings', () => {
        const docText = makeManifest('', ` xmlns:ux="${UAP_NS}"`);
        const visualElements = findManifestElement(model, 'VisualElements', 'ux', docText);
        assert.ok(visualElements);
        assert.equal(visualElements.namespace, UAP_NS);
    });

    it('returns source locations for Package, Identity, and VisualElements definitions', () => {
        const defaultDocText = makeManifest('');
        const prefixedDocText = makeManifest('', ` xmlns:ux="${UAP_NS}"`);
        const cases = [
            { label: 'Package', element: findManifestElement(model, 'Package', undefined, defaultDocText), pattern: /<xs:element name="Package"/ },
            { label: 'Identity', element: findManifestElement(model, 'Identity', undefined, defaultDocText), pattern: /<xs:element name="Identity"/ },
            { label: 'VisualElements', element: findManifestElement(model, 'VisualElements', 'ux', prefixedDocText), pattern: /<xs:element name="VisualElements"/ },
        ];

        for (const testCase of cases) {
            assert.ok(testCase.element, `${testCase.label} should resolve from the manifest schema model`);
            assertValidSourceLocation(
                testCase.label,
                testCase.element?.sourceFile,
                testCase.element?.sourceLine,
                testCase.pattern
            );
        }
    });

    it('returns source locations for attributes resolved through findManifestElement', () => {
        const identity = findManifestElement(model, 'Identity', undefined, makeManifest(''));
        const visualElements = findManifestElement(model, 'VisualElements', 'ux', makeManifest('', ` xmlns:ux="${UAP_NS}"`));

        assert.ok(identity);
        assert.ok(visualElements);

        const attrs = [
            { label: 'Identity.Name', attribute: identity?.attributes.find(attribute => attribute.name === 'Name'), pattern: /<xs:attribute name="Name"/ },
            { label: 'Identity.Version', attribute: identity?.attributes.find(attribute => attribute.name === 'Version'), pattern: /<xs:attribute name="Version"/ },
            { label: 'VisualElements.DisplayName', attribute: visualElements?.attributes.find(attribute => attribute.name === 'DisplayName'), pattern: /<xs:attribute name="DisplayName"/ },
        ];

        for (const testCase of attrs) {
            assert.ok(testCase.attribute, `${testCase.label} should resolve from the manifest schema model`);
            assertValidSourceLocation(
                testCase.label,
                testCase.attribute?.sourceFile,
                testCase.attribute?.sourceLine,
                testCase.pattern
            );
        }
    });

    it('points resolved source locations at XSD files on disk', () => {
        const identity = findManifestElement(model, 'Identity', undefined, makeManifest(''));
        const visualElements = findManifestElement(model, 'VisualElements', 'ux', makeManifest('', ` xmlns:ux="${UAP_NS}"`));
        const sourceFiles = [
            identity?.sourceFile,
            identity?.attributes.find(attribute => attribute.name === 'Name')?.sourceFile,
            visualElements?.sourceFile,
            visualElements?.attributes.find(attribute => attribute.name === 'DisplayName')?.sourceFile,
        ];

        for (const sourceFile of sourceFiles) {
            assert.ok(sourceFile, 'Resolved schema entries should include a source file');
            assert.match(sourceFile, /\.xsd$/i);
            assert.ok(fs.existsSync(sourceFile), `Expected schema file to exist: ${sourceFile}`);
        }
    });

    it('does not fall back across namespaces for unknown prefixes', () => {
        const docText = makeManifest('', ` xmlns:ux="${UAP_NS}"`);
        assert.equal(findManifestElement(model, 'VisualElements', 'missing', docText), undefined);
    });

    it('finds nested child elements that use named complex types', () => {
        const docText = `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="${FOUNDATION_NS}" xmlns:com="${COM_NS}">
  <Applications>
    <Application Id="App">
      <Extensions>
        <com:Extension Category="windows.comServer">
          <com:ComServer>
            <com:ExeServer Executable="demo.exe" DisplayName="Demo">
              <com:Class Id="{11111111-1111-1111-1111-111111111111}">
                <com:ImplementedCategories />
              </com:Class>
            </com:ExeServer>
          </com:ComServer>
        </com:Extension>
      </Extensions>
    </Application>
  </Applications>
</Package>`;

        const implementedCategories = findManifestElement(model, 'ImplementedCategories', 'com', docText);
        assert.ok(implementedCategories);
        assert.ok(implementedCategories.children.some(child => child.name === 'ImplementedCategory'));
    });

    it('returns a definition location for a known element name', async () => {
        const originalLoad = (Module as unknown as { _load: Function })._load;
        const mockVscode = {
            workspace: {
                getConfiguration: () => ({
                    get: <T>(_key: string, fallback: T) => fallback,
                }),
            },
            Position: class Position {
                constructor(public line: number, public character: number) {}
            },
            Range: class Range {
                public start: { line: number; character: number };
                public end: { line: number; character: number };
                constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
                    this.start = { line: startLine, character: startCharacter };
                    this.end = { line: endLine, character: endCharacter };
                }
            },
            Location: class Location {
                constructor(public uri: { fsPath: string }, public position: { line: number; character: number }) {}
            },
            Uri: {
                file: (fsPath: string) => ({ fsPath }),
            },
        };

        (Module as unknown as { _load: Function })._load = function(request: string, parent: unknown, isMain: boolean) {
            if (request === 'vscode') {
                return mockVscode;
            }
            return originalLoad.call(this, request, parent, isMain);
        };

        try {
            const { ManifestDefinitionProvider } = await import('../manifest-intellisense/definition-provider.js');
            const text = makeManifest(`
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" />`);
            const offset = text.indexOf('Identity') + 2;
            const position = { line: text.substring(0, offset).split('\n').length - 1, character: offset - text.lastIndexOf('\n', offset - 1) - 1 };

            const document = {
                getText: (range?: { start: { line: number; character: number }; end: { line: number; character: number } }) => {
                    if (!range) { return text; }
                    const startOffset = offsetAt(range.start);
                    const endOffset = offsetAt(range.end);
                    return text.slice(startOffset, endOffset);
                },
                offsetAt,
                getWordRangeAtPosition: (pos: { line: number; character: number }) => {
                    const wordOffset = offsetAt(pos);
                    let start = wordOffset;
                    let end = wordOffset;
                    while (start > 0 && /[A-Za-z0-9_.:-]/.test(text[start - 1])) { start--; }
                    while (end < text.length && /[A-Za-z0-9_.:-]/.test(text[end])) { end++; }
                    const startPos = positionAt(start);
                    const endPos = positionAt(end);
                    return { start: startPos, end: endPos };
                },
            };

            function offsetAt(pos: { line: number; character: number }): number {
                const lines = text.split('\n');
                let total = 0;
                for (let i = 0; i < pos.line; i++) {
                    total += lines[i].length + 1;
                }
                return total + pos.character;
            }

            function positionAt(value: number): { line: number; character: number } {
                const before = text.substring(0, value);
                const lines = before.split('\n');
                return { line: lines.length - 1, character: lines[lines.length - 1].length };
            }

            const provider = new ManifestDefinitionProvider(() => model);
            const location = provider.provideDefinition(document as any, position as any, {} as any) as any;

            assert.ok(location);
            assert.ok(location.uri.fsPath.endsWith('.xsd'));
            assert.equal(typeof location.position.line, 'number');
        } finally {
            (Module as unknown as { _load: Function })._load = originalLoad;
        }
    });

    it('detects attribute name context in multi-line tags', () => {
        const text = makeOpenManifest(`
  <Identity
    Name="Test"
    Publisher="CN=Test"
    `);
        const ctx = getXmlContext(text, text.length);

        assert.equal(ctx.type, 'attributeName');
        assert.equal(ctx.currentElement, 'Identity');
        assert.ok(ctx.existingAttributes?.includes('Name'));
        assert.ok(ctx.existingAttributes?.includes('Publisher'));
    });

    it('detects attribute value context in multi-line tags', () => {
        const text = makeOpenManifest(`
  <Identity
    Name="Test"
    Publisher="CN=Test"
    Version="1.0.0.0"
    ProcessorArchitecture="arm`);
        const ctx = getXmlContext(text, text.length);

        assert.equal(ctx.type, 'attributeValue');
        assert.equal(ctx.currentElement, 'Identity');
        assert.equal(ctx.currentAttribute, 'ProcessorArchitecture');
        assert.equal(ctx.partialText, 'arm');
    });

    it('returns enum completions from multi-line attribute value context', () => {
        const text = makeOpenManifest(`
  <Identity
    Name="Test"
    Publisher="CN=Test"
    Version="1.0.0.0"
    ProcessorArchitecture="`);
        const items = getManifestCompletions(model, text, text.length);

        assert.deepEqual(items.map(item => item.label), ['x86', 'x64', 'arm', 'arm64', 'x86a64', 'neutral']);
    });

    it('extracts namespace prefixes from single-quoted declarations', () => {
        const prefixes = extractDocumentPrefixes(`<Package xmlns='${FOUNDATION_NS}' xmlns:ux='${UAP_NS}' />`);
        assert.equal(prefixes.get(''), FOUNDATION_NS);
        assert.equal(prefixes.get('ux'), UAP_NS);
    });

    it('extracts namespace prefixes when whitespace surrounds the equals sign', () => {
        const prefixes = extractDocumentPrefixes(`<Package xmlns = "${FOUNDATION_NS}" xmlns:ux = "${UAP_NS}" />`);
        assert.equal(prefixes.get(''), FOUNDATION_NS);
        assert.equal(prefixes.get('ux'), UAP_NS);
    });
});
