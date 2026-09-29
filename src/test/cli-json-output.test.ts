import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonObject } from '../winapp-cli-utils';

describe('extractJsonObject', () => {
	it('parses output that is nothing but the payload', () => {
		assert.deepEqual(extractJsonObject('{"Created":true}'), { Created: true });
	});

	it('ignores progress text printed before and after the payload', () => {
		const output = 'Installing template pack...\n{"Created":true}\nDone.\n';
		assert.deepEqual(extractJsonObject(output), { Created: true });
	});

	it('keeps the outermost object when the payload nests braces', () => {
		const output = 'note\n{"Templates":[{"ShortName":"winui"}]}\n';
		assert.deepEqual(extractJsonObject(output), {
			Templates: [{ ShortName: 'winui' }]
		});
	});

	it('returns undefined for output holding no complete object', () => {
		// parseProcessIdFromJson calls this on a growing stdout buffer, so a
		// half-arrived payload has to come back undefined rather than throw.
		assert.equal(extractJsonObject('{"processId":'), undefined);
		assert.equal(extractJsonObject('{"a":{"b":1}'), undefined);
		assert.equal(extractJsonObject('no json here'), undefined);
		assert.equal(extractJsonObject(''), undefined);
	});

	it('extracts the first embedded object when the payload is an array', () => {
		// The scan starts at the first '{', so an array wrapper is stepped into
		// rather than rejected. No winapp command emits a top-level array today.
		assert.deepEqual(extractJsonObject('[{"a":1}]'), { a: 1 });
	});

	it('skips brace-wrapped prose printed before the payload', () => {
		// A '{' in progress text used to anchor the scan and lose the payload.
		assert.deepEqual(extractJsonObject('warning {x} skipped\n{"Created":true}'), { Created: true });
		assert.deepEqual(extractJsonObject('{not json}\n{"Created":true}'), { Created: true });
	});

	it('ignores braces and quotes inside JSON string values', () => {
		assert.deepEqual(extractJsonObject('{"Error":"bad } name"}'), { Error: 'bad } name' });
		assert.deepEqual(extractJsonObject('{"Error":"a {b} c"}\nDone.'), { Error: 'a {b} c' });
		assert.deepEqual(extractJsonObject('{"Path":"C:\\\\dir\\\\"}'), { Path: 'C:\\dir\\' });
	});

	it('is not confused by unbalanced quotes in surrounding prose', () => {
		assert.deepEqual(extractJsonObject('say "hi\n{"Created":true}'), { Created: true });
	});

	it('scans a large unterminated payload in linear time', () => {
		// parseProcessIdFromJson runs on every stdout chunk, so a half-arrived
		// payload must not trigger a re-parse per '}' (quadratic, seconds-long).
		const partial = '{"items":[' + Array.from({ length: 4000 }, (_, i) => `{"id":${i}}`).join(',');
		const started = Date.now();
		assert.equal(extractJsonObject(partial), undefined);
		assert.ok(Date.now() - started < 250, 'extractJsonObject should stay linear on partial input');
	});
});
