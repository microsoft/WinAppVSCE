/**
 * Unit tests for the XML context analyzer.
 *
 * Run: npx tsx --test src/test/xml-context.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getXmlContext, findParentPath, splitPrefixedName } from '../manifest-intellisense/xml-context';

describe('splitPrefixedName', () => {
    it('splits prefixed names', () => {
        const result = splitPrefixedName('uap:VisualElements');
        assert.equal(result.prefix, 'uap');
        assert.equal(result.localName, 'VisualElements');
    });

    it('handles unprefixed names', () => {
        const result = splitPrefixedName('Identity');
        assert.equal(result.prefix, '');
        assert.equal(result.localName, 'Identity');
    });
});

describe('findParentPath', () => {
    it('finds simple parent path', () => {
        const xml = '<Package><Identity Name="test">';
        const path = findParentPath(xml);
        assert.equal(path.length, 2);
        assert.equal(path[0].name, 'Package');
        assert.equal(path[1].name, 'Identity');
    });

    it('handles self-closing elements', () => {
        const xml = '<Package><Identity Name="test" /><Properties>';
        const path = findParentPath(xml);
        assert.equal(path.length, 2);
        assert.equal(path[0].name, 'Package');
        assert.equal(path[1].name, 'Properties');
    });

    it('handles closed elements', () => {
        const xml = '<Package><Identity Name="test" /><Properties><DisplayName>App</DisplayName>';
        const path = findParentPath(xml);
        assert.equal(path.length, 2);
        assert.equal(path[0].name, 'Package');
        assert.equal(path[1].name, 'Properties');
    });

    it('handles namespace prefixes', () => {
        const xml = '<Package><uap:VisualElements DisplayName="App">';
        const path = findParentPath(xml);
        assert.equal(path.length, 2);
        assert.equal(path[0].name, 'Package');
        assert.equal(path[1].name, 'VisualElements');
        assert.equal(path[1].prefix, 'uap');
    });

    it('ignores XML comments when building the parent stack', () => {
        const xml = '<Package><!-- <Applications> --><Properties>';
        const path = findParentPath(xml);
        assert.deepEqual(path.map(element => element.name), ['Package', 'Properties']);
    });
});

describe('getXmlContext', () => {
    const sampleManifest = `<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10">

  <Identity
    Name="TestApp"
    Publisher="CN=Test"
    Version="1.0.0.0" />

  <Properties>
    <DisplayName>Test App</DisplayName>
  </Properties>
</Package>`;

    it('detects element open context after <', () => {
        // Position after "  <" on the line with Identity
        const text = `<Package>\n  <`;
        const ctx = getXmlContext(text, text.length);
        assert.equal(ctx.type, 'elementOpen');
        assert.equal(ctx.parentElement, 'Package');
    });

    it('detects element open with partial name', () => {
        const text = `<Package>\n  <Iden`;
        const ctx = getXmlContext(text, text.length);
        assert.equal(ctx.type, 'elementOpen');
        assert.equal(ctx.partialText, 'Iden');
        assert.equal(ctx.parentElement, 'Package');
    });

    it('detects attribute name context', () => {
        const text = `<Package>\n  <Identity `;
        const ctx = getXmlContext(text, text.length);
        assert.equal(ctx.type, 'attributeName');
        assert.equal(ctx.currentElement, 'Identity');
    });

    it('detects attribute value context', () => {
        const text = `<Package>\n  <Identity Name="`;
        const ctx = getXmlContext(text, text.length);
        assert.equal(ctx.type, 'attributeValue');
        assert.equal(ctx.currentElement, 'Identity');
        assert.equal(ctx.currentAttribute, 'Name');
    });

    it('detects attribute value context with partial value', () => {
        const text = `<Package>\n  <Identity Name="Test`;
        const ctx = getXmlContext(text, text.length);
        assert.equal(ctx.type, 'attributeValue');
        assert.equal(ctx.currentAttribute, 'Name');
        assert.equal(ctx.partialText, 'Test');
    });

    it('detects attribute value context with spaces around =', () => {
        const text = `<Package>\n  <Identity Name = "Test`;
        const ctx = getXmlContext(text, text.length);
        assert.equal(ctx.type, 'attributeValue');
        assert.equal(ctx.currentAttribute, 'Name');
        assert.equal(ctx.partialText, 'Test');
    });

    it('detects attribute value context when earlier attribute values contain >', () => {
        const text = `<Package>\n  <Identity Name="A>B" Publisher="CN=Te`;
        const ctx = getXmlContext(text, text.length);
        assert.equal(ctx.type, 'attributeValue');
        assert.equal(ctx.currentAttribute, 'Publisher');
        assert.equal(ctx.partialText, 'CN=Te');
    });

    it('detects text context between tags', () => {
        const text = `<Package>\n  <Properties>\n    `;
        const ctx = getXmlContext(text, text.length);
        assert.equal(ctx.type, 'text');
        assert.equal(ctx.parentElement, 'Properties');
    });

    it('detects closing tag context', () => {
        const text = `<Package>\n  <Properties>\n  </`;
        const ctx = getXmlContext(text, text.length);
        assert.equal(ctx.type, 'closingTag');
    });

    it('handles namespace-prefixed elements', () => {
        const text = `<Package>\n  <Application>\n    <uap:VisualElements `;
        const ctx = getXmlContext(text, text.length);
        assert.equal(ctx.type, 'attributeName');
        assert.equal(ctx.currentElement, 'VisualElements');
        assert.equal(ctx.currentPrefix, 'uap');
    });

    it('lists existing attributes', () => {
        const text = `<Package>\n  <Identity Name="App" Publisher="CN=Test" `;
        const ctx = getXmlContext(text, text.length);
        assert.equal(ctx.type, 'attributeName');
        assert.ok(ctx.existingAttributes);
        assert.ok(ctx.existingAttributes.includes('Name'));
        assert.ok(ctx.existingAttributes.includes('Publisher'));
    });

    it('lists existing attributes when whitespace surrounds =', () => {
        const text = `<Package>\n  <Identity Name = "App" Publisher = "CN=Test" `;
        const ctx = getXmlContext(text, text.length);
        assert.equal(ctx.type, 'attributeName');
        assert.ok(ctx.existingAttributes?.includes('Name'));
        assert.ok(ctx.existingAttributes?.includes('Publisher'));
    });

    it('detects attribute name context when earlier attribute values contain >', () => {
        const text = `<Package>\n  <Identity Name="A>B" `;
        const ctx = getXmlContext(text, text.length);
        assert.equal(ctx.type, 'attributeName');
        assert.equal(ctx.currentElement, 'Identity');
        assert.ok(ctx.existingAttributes?.includes('Name'));
    });
});
