/**
 * Integration tests for AppxManifest IntelliSense logic.
 *
 * Run: npx tsx --test src/test/intellisense-integration.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { getXmlContext } from '../manifest-intellisense/xml-context';
import {
    extractDocumentPrefixes,
    findManifestElement,
    findSchemaElementExact,
    formatManifestHoverMarkdown,
    getAttributeCompletions,
    getAttributeValueCompletions,
    getChildCompletions,
    getManifestCompletions,
    getManifestHover,
    validateManifestText,
} from '../manifest-intellisense/intellisense-logic';
import { loadSchemaModel } from '../manifest-intellisense/xsd-parser';
import { MANIFEST_NAMESPACES } from '../manifest-intellisense/schema-model';

const SCHEMAS_DIR = path.join(__dirname, '..', '..', 'schemas');
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

describe('manifest diagnostics logic', () => {
    // TODO(M4, M5): Add VS Code extension-host tests for command wiring plus settings/lifecycle behavior.
    // Pure logic tests in this file cover the core IntelliSense and diagnostics behavior for now.
    it('returns no diagnostics for a valid minimal manifest', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" />`));
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

    it('skips unknown elements instead of producing false positives', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Applications>
    <Application Id="App">
      <VisualElements />
    </Application>
  </Applications>
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" />`));

        assert.equal(diagnostics.length, 0);
    });

    it('findSchemaElementExact only matches exact namespaces', () => {
        assert.ok(findSchemaElementExact(model, 'VisualElements', UAP_NS));
        assert.equal(findSchemaElementExact(model, 'VisualElements', FOUNDATION_NS), undefined);
    });

    it('flags Identity Name with spaces as invalid pattern', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="Invalid Name With Spaces" Publisher="CN=Test" Version="1.0.0.0" />`));

        assert.ok(diagnostics.some(d => d.message.includes("'Name'") && d.message.includes('does not match')),
            'Name with spaces should violate pattern constraint');
    });

    it('flags Identity Version with wrong format as invalid pattern', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="TestApp" Publisher="CN=Test" Version="not.a.version" />`));

        assert.ok(diagnostics.some(d => d.message.includes("'Version'") && d.message.includes('does not match')),
            'Version with invalid format should violate pattern constraint');
    });

    it('does not flag valid Identity Name and Version as pattern violations', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Identity Name="ValidName.App" Publisher="CN=Test" Version="1.2.3.4" />`));

        assert.ok(!diagnostics.some(d => d.message.includes('does not match')),
            'Valid Name and Version should not trigger pattern violations');
    });

    it('skips diagnostics for qualified attributes until namespace-aware lookup is implemented', () => {
        const diagnostics = validateManifestText(model, makeManifest(`
  <Applications>
    <Application Id="App" uap10:TrustLevel="not-a-real-value" />
  </Applications>`, ` xmlns:uap10="${MANIFEST_NAMESPACES['uap10']}"`));

        assert.ok(!diagnostics.some(diagnostic => diagnostic.message.includes('TrustLevel')));
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
        const nameDiag = diagnostics.find(d => d.message.includes("'Name'") && d.message.includes('does not match'));
        assert.ok(nameDiag, 'Should produce Name pattern diagnostic');

        // The diagnostic should point to the value "Bad Name", not the element start
        const lines = text.split('\n');
        const identityLine = lines.findIndex(l => l.includes('Identity'));
        assert.equal(nameDiag.line, identityLine, 'Diagnostic should be on the Identity line');
        assert.ok(nameDiag.col > 0, 'Diagnostic column should be within the attribute value');
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
});
