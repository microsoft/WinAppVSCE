import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { applyFlushedChanges, documentParses } from '../manifest-editor/flush-changes';
import { FlushedChange } from '../manifest-editor/manifest-types';

const FIXTURE = path.resolve(__dirname, 'fixtures', 'winui-gallery.appxmanifest');
const manifestXml = fs.readFileSync(FIXTURE, 'utf-8');

test('documentParses accepts valid XML and rejects broken XML', () => {
    assert.strictEqual(documentParses(manifestXml), true);
    assert.strictEqual(documentParses(manifestXml.replace('</Package>', '<Unclosed>')), false);
});

test('a flushed field change is applied to the manifest', () => {
    const changes: FlushedChange[] = [
        { kind: 'field', section: 'identity', field: 'name', value: 'Flushed.Name', index: 0 },
    ];
    const { text, failed } = applyFlushedChanges(manifestXml, changes);
    assert.deepStrictEqual(failed, []);
    assert.ok(text.includes('Flushed.Name'), 'the flushed value should reach the document');
});

test('unparseable text is returned untouched instead of being rewritten', () => {
    // A save made while the XML is broken must persist what the user typed. Rewriting from a
    // document we could not parse would serialise valid XML over their in-progress edit.
    const broken = manifestXml.replace('</Package>', '<Unclosed>');
    const changes: FlushedChange[] = [
        { kind: 'field', section: 'identity', field: 'name', value: 'Should.Not.Apply', index: 0 },
    ];
    const { text, failed } = applyFlushedChanges(broken, changes);
    assert.strictEqual(text, broken, 'broken XML must come back byte-identical');
    assert.ok(!text.includes('Should.Not.Apply'));
    assert.deepStrictEqual(failed, []);
});

test('one failing change does not discard the rest of the queue', () => {
    // A malformed change (no fieldPath) makes updateExtensionField throw. The healthy change
    // queued behind it must still reach the document.
    const changes: FlushedChange[] = [
        { kind: 'extField', appIndex: 0, extIndex: 0, fieldPath: undefined as never, value: 'nope' },
        { kind: 'field', section: 'identity', field: 'name', value: 'Survives.Failure', index: 0 },
    ];
    const { text, failed } = applyFlushedChanges(manifestXml, changes);
    assert.ok(text.includes('Survives.Failure'), 'the healthy change must still be applied');
    assert.strictEqual(failed.length, 1, 'only the malformed change should be reported');
    assert.ok(failed[0].startsWith('extension field'), 'the failure should name the change that threw');
});

test('an empty queue leaves the document unchanged', () => {
    const { text, failed } = applyFlushedChanges(manifestXml, []);
    assert.strictEqual(text, manifestXml);
    assert.deepStrictEqual(failed, []);
});

test('mixed field and extension-field changes are all applied', () => {
    const changes: FlushedChange[] = [
        { kind: 'field', section: 'identity', field: 'name', value: 'Mixed.Name', index: 0 },
        { kind: 'field', section: 'properties', field: 'displayName', value: 'Mixed Display', index: 0 },
    ];
    const { text, failed } = applyFlushedChanges(manifestXml, changes);
    assert.deepStrictEqual(failed, []);
    assert.ok(text.includes('Mixed.Name'));
    assert.ok(text.includes('Mixed Display'));
});
