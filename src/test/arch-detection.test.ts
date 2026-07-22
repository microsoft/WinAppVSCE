import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	detectArchFromPath,
	checkSelfContainedArchMismatch,
	buildArchMismatchWarning,
	buildArchChoices,
	parseArchChoice
} from '../arch-detection';

describe('detectArchFromPath', () => {
	it('detects x64 from a win-x64 RID segment', () => {
		assert.equal(detectArchFromPath('C:\\proj\\bin\\Debug\\net8.0-windows\\win-x64'), 'x64');
	});

	it('detects arm64 from a win-arm64 RID segment', () => {
		assert.equal(detectArchFromPath('C:\\proj\\bin\\Release\\net8.0-windows\\win-arm64'), 'arm64');
	});

	it('detects x86 from a win-x86 RID segment', () => {
		assert.equal(detectArchFromPath('C:\\proj\\bin\\Debug\\net8.0-windows\\win-x86'), 'x86');
	});

	it('detects x64 from a bare x64 folder name', () => {
		assert.equal(detectArchFromPath('C:\\proj\\publish\\x64'), 'x64');
	});

	it('detects arm64 from a bare arm64 folder name', () => {
		assert.equal(detectArchFromPath('C:\\proj\\publish\\arm64'), 'arm64');
	});

	it('detects architecture from a forward-slash path', () => {
		assert.equal(detectArchFromPath('C:/proj/bin/Debug/net8.0-windows/win-arm64'), 'arm64');
	});

	it('prefers the deepest (rightmost) matching segment', () => {
		// In a path like publish/x64/win-arm64, the deepest match (win-arm64) wins
		assert.equal(detectArchFromPath('C:\\proj\\publish\\x64\\win-arm64'), 'arm64');
	});

	it('is case-insensitive', () => {
		assert.equal(detectArchFromPath('C:\\proj\\bin\\Win-X64'), 'x64');
		assert.equal(detectArchFromPath('C:\\proj\\bin\\ARM64'), 'arm64');
	});

	it('returns undefined when no architecture segment exists', () => {
		assert.equal(detectArchFromPath('C:\\proj\\bin\\Debug\\net8.0-windows'), undefined);
	});

	it('returns undefined for an empty path', () => {
		assert.equal(detectArchFromPath(''), undefined);
	});

	it('does not false-positive on partial matches', () => {
		// "x64-tools" should not match as x64
		assert.equal(detectArchFromPath('C:\\proj\\x64-tools\\output'), undefined);
	});
});

describe('checkSelfContainedArchMismatch', () => {
	it('returns no mismatch when architectures match', () => {
		const result = checkSelfContainedArchMismatch('x64', 'x64');
		assert.equal(result.mismatch, false);
	});

	it('returns mismatch when build is x64 but machine is arm64', () => {
		const result = checkSelfContainedArchMismatch('x64', 'arm64');
		assert.equal(result.mismatch, true);
		if (result.mismatch) {
			assert.equal(result.buildArch, 'x64');
			assert.equal(result.machineArch, 'arm64');
		}
	});

	it('returns mismatch when build is arm64 but machine is x64', () => {
		const result = checkSelfContainedArchMismatch('arm64', 'x64');
		assert.equal(result.mismatch, true);
		if (result.mismatch) {
			assert.equal(result.buildArch, 'arm64');
			assert.equal(result.machineArch, 'x64');
		}
	});

	it('returns no mismatch when buildArch is undefined', () => {
		const result = checkSelfContainedArchMismatch(undefined, 'x64');
		assert.equal(result.mismatch, false);
	});

	it('returns no mismatch when machineArch is undefined', () => {
		const result = checkSelfContainedArchMismatch('x64', undefined);
		assert.equal(result.mismatch, false);
	});
});

describe('buildArchMismatchWarning', () => {
	it('includes both architectures in the message', () => {
		const msg = buildArchMismatchWarning('x64', 'arm64');
		assert.ok(msg.includes('x64'));
		assert.ok(msg.includes('arm64'));
		assert.ok(msg.includes('mismatch'));
	});
});

describe('buildArchChoices', () => {
	it('puts detected arch first with annotation', () => {
		const choices = buildArchChoices('arm64');
		assert.equal(choices[0], 'arm64 (detected)');
		assert.ok(choices.includes('x64'));
		assert.ok(choices.includes('x86'));
		assert.equal(choices.length, 3);
	});

	it('returns all architectures unannotated when none is detected', () => {
		const choices = buildArchChoices(undefined);
		assert.deepEqual(choices, ['arm64', 'x64', 'x86']);
	});

	it('does not duplicate the detected architecture', () => {
		const choices = buildArchChoices('x64');
		const x64Count = choices.filter((c) => c.startsWith('x64')).length;
		assert.equal(x64Count, 1);
	});
});

describe('parseArchChoice', () => {
	it('parses a plain architecture label', () => {
		assert.equal(parseArchChoice('x64'), 'x64');
		assert.equal(parseArchChoice('arm64'), 'arm64');
		assert.equal(parseArchChoice('x86'), 'x86');
	});

	it('strips the (detected) annotation', () => {
		assert.equal(parseArchChoice('arm64 (detected)'), 'arm64');
		assert.equal(parseArchChoice('x64 (detected)'), 'x64');
	});

	it('returns undefined for unrecognised values', () => {
		assert.equal(parseArchChoice('unknown'), undefined);
	});
});
