import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	ARTIFACT_EXTENSIONS_NO_DOT,
	ARTIFACT_EXTENSIONS,
	ARTIFACT_GLOBS,
	ARTIFACT_DIALOG_FILTER,
	isArtifactPath,
	stripArtifactExtension,
	artifactExtensionPattern
} from '../artifact-types';

describe('ARTIFACT_EXTENSIONS_NO_DOT', () => {
	it('contains the four known artifact types', () => {
		assert.deepEqual([...ARTIFACT_EXTENSIONS_NO_DOT], ['msix', 'msixbundle', 'appx', 'appxbundle']);
	});
});

describe('ARTIFACT_EXTENSIONS', () => {
	it('prepends a dot to each extension', () => {
		for (const ext of ARTIFACT_EXTENSIONS) {
			assert.ok(ext.startsWith('.'), `Expected "${ext}" to start with a dot`);
		}
		assert.equal(ARTIFACT_EXTENSIONS.length, ARTIFACT_EXTENSIONS_NO_DOT.length);
	});
});

describe('ARTIFACT_GLOBS', () => {
	it('produces recursive glob patterns for each extension', () => {
		for (const glob of ARTIFACT_GLOBS) {
			assert.ok(glob.startsWith('**/'), `Expected "${glob}" to start with "**/"`);
		}
		assert.equal(ARTIFACT_GLOBS.length, ARTIFACT_EXTENSIONS_NO_DOT.length);
	});
});

describe('ARTIFACT_DIALOG_FILTER', () => {
	it('exposes an MSIX Packages filter with all extensions', () => {
		assert.ok('MSIX Packages' in ARTIFACT_DIALOG_FILTER);
		assert.deepEqual(ARTIFACT_DIALOG_FILTER['MSIX Packages'], [...ARTIFACT_EXTENSIONS_NO_DOT]);
	});
});

describe('isArtifactPath', () => {
	it('returns true for each known extension', () => {
		assert.ok(isArtifactPath('C:\\out\\app.msix'));
		assert.ok(isArtifactPath('C:\\out\\app.msixbundle'));
		assert.ok(isArtifactPath('C:\\out\\app.appx'));
		assert.ok(isArtifactPath('C:\\out\\app.appxbundle'));
	});

	it('is case-insensitive', () => {
		assert.ok(isArtifactPath('C:\\out\\app.MSIX'));
		assert.ok(isArtifactPath('C:\\out\\app.MsIxBundle'));
	});

	it('returns false for non-artifact extensions', () => {
		assert.ok(!isArtifactPath('C:\\out\\app.exe'));
		assert.ok(!isArtifactPath('C:\\out\\app.dll'));
		assert.ok(!isArtifactPath('C:\\out\\app.txt'));
	});

	it('returns false for empty string', () => {
		assert.ok(!isArtifactPath(''));
	});
});

describe('stripArtifactExtension', () => {
	it('removes a known artifact extension', () => {
		assert.equal(stripArtifactExtension('App_1.0_x64.msix'), 'App_1.0_x64');
	});

	it('removes .msixbundle before .msix would match', () => {
		assert.equal(stripArtifactExtension('App_1.0.msixbundle'), 'App_1.0');
	});

	it('is case-insensitive', () => {
		assert.equal(stripArtifactExtension('App_1.0_x64.APPX'), 'App_1.0_x64');
	});

	it('returns the input unchanged for non-artifact extensions', () => {
		assert.equal(stripArtifactExtension('app.exe'), 'app.exe');
	});

	it('returns the input unchanged for empty string', () => {
		assert.equal(stripArtifactExtension(''), '');
	});
});

describe('artifactExtensionPattern', () => {
	it('returns a RegExp that matches artifact extensions', () => {
		const re = artifactExtensionPattern();
		assert.ok(re.test('app.msix'));
		assert.ok(re.test('app.msixbundle'));
		assert.ok(re.test('app.appx'));
		assert.ok(re.test('app.appxbundle'));
	});

	it('does not match non-artifact extensions', () => {
		const re = artifactExtensionPattern();
		assert.ok(!re.test('app.exe'));
		assert.ok(!re.test('app.txt'));
	});
});
