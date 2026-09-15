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
});
