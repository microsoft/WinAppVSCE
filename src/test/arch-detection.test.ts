import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	detectArchFromPath,
	checkSelfContainedArchMismatch,
	buildArchMismatchWarning,
	getMachineArch
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

	it('detects x64 from a versioned win10-x64 RID segment', () => {
		assert.equal(detectArchFromPath('C:\\proj\\bin\\Debug\\net8.0-windows\\win10-x64'), 'x64');
	});

	it('detects arm64 from a versioned win10-arm64 RID segment', () => {
		assert.equal(detectArchFromPath('C:\\proj\\bin\\Release\\net8.0-windows\\win10-arm64'), 'arm64');
	});

	it('detects x86 from a versioned win11-x86 RID segment', () => {
		assert.equal(detectArchFromPath('C:\\proj\\bin\\Debug\\net8.0-windows\\win11-x86'), 'x86');
	});

	it('detects x64 from a dotted versioned RID segment', () => {
		assert.equal(detectArchFromPath('C:\\proj\\bin\\Debug\\net8.0-windows\\win10.0.22621-x64'), 'x64');
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

describe('getMachineArch', () => {
	it('maps x86_64 to x64', () => {
		assert.equal(getMachineArch('x86_64'), 'x64');
	});

	it('maps aarch64 to arm64', () => {
		assert.equal(getMachineArch('aarch64'), 'arm64');
	});

	it('maps i686 to x86', () => {
		assert.equal(getMachineArch('i686'), 'x86');
	});

	it('returns undefined for unknown architectures', () => {
		assert.equal(getMachineArch('unknown'), undefined);
	});

	it('returns a defined value on the current machine', () => {
		assert.notEqual(getMachineArch(), undefined);
	});
});
