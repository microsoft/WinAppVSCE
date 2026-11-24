import { test } from 'node:test';
import * as assert from 'node:assert';
import { NdjsonFramer, NdjsonParseError, encodeNdjson, MAX_LINE_BYTES } from '../devtools/ndjson';

test('emits one value per complete line', () => {
    const framer = new NdjsonFramer();
    const messages = framer.push('{"id":1}\n{"id":2}\n');

    assert.deepStrictEqual(messages, [{ id: 1 }, { id: 2 }]);
    assert.strictEqual(framer.pending, 0);
});

test('withholds a partial line until its newline arrives', () => {
    const framer = new NdjsonFramer();

    assert.deepStrictEqual(framer.push('{"id":'), []);
    assert.ok(framer.pending > 0, 'partial line should stay buffered');
    assert.deepStrictEqual(framer.push('1}\n'), [{ id: 1 }]);
});

test('reassembles a multi-byte character split across chunks', () => {
    const framer = new NdjsonFramer();
    // U+1F680 encodes to four bytes; splitting mid-character would corrupt it
    // if the decoder did not hold back the continuation bytes.
    const payload = Buffer.from('{"name":"\u{1F680}"}\n', 'utf8');
    const splitAt = payload.indexOf(0xf0) + 2;

    assert.deepStrictEqual(framer.push(payload.subarray(0, splitAt)), []);
    assert.deepStrictEqual(framer.push(payload.subarray(splitAt)), [{ name: '\u{1F680}' }]);
});

test('tolerates CRLF line endings', () => {
    const framer = new NdjsonFramer();
    assert.deepStrictEqual(framer.push('{"id":1}\r\n'), [{ id: 1 }]);
});

test('skips blank and whitespace-only lines', () => {
    const framer = new NdjsonFramer();
    assert.deepStrictEqual(framer.push('\n   \n{"id":1}\n\n'), [{ id: 1 }]);
});

test('throws on malformed JSON rather than dropping the line', () => {
    const framer = new NdjsonFramer();
    assert.throws(() => framer.push('not json\n'), NdjsonParseError);
});

test('throws once the buffer exceeds the oversize guard', () => {
    const framer = new NdjsonFramer();
    assert.throws(() => framer.push('x'.repeat(MAX_LINE_BYTES + 1)), NdjsonParseError);
    // The guard must also clear the buffer so a dropped connection does not
    // leave tens of megabytes retained.
    assert.strictEqual(framer.pending, 0);
});

test('reset discards buffered input', () => {
    const framer = new NdjsonFramer();
    framer.push('{"id":');
    framer.reset();
    assert.strictEqual(framer.pending, 0);
});

test('encodeNdjson terminates each message with a single newline', () => {
    const line = encodeNdjson({ id: 1, method: 'DevTools.ping' });

    assert.ok(line.endsWith('\n'));
    assert.strictEqual(line.indexOf('\n'), line.length - 1);
    assert.deepStrictEqual(JSON.parse(line.trim()), { id: 1, method: 'DevTools.ping' });
});

test('round-trips an encoded message through the framer', () => {
    const framer = new NdjsonFramer();
    const message = { jsonrpc: '2.0', id: 7, result: { nodes: [] } };

    assert.deepStrictEqual(framer.push(Buffer.from(encodeNdjson(message), 'utf8')), [message]);
});
