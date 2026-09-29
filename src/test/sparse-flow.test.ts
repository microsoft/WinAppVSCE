import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import {
	isSparseManifestXml,
	isIdentityOnlyInput,
	getPackInputRoot,
	buildSparseInitArgs,
	buildEmbedIdentityArgs,
	embedRewritesBinary,
	defaultSparseOutputDir,
	getSparseManifestPath,
	SPARSE_OUTPUT_FOLDER,
	PackInput
} from '../sparse-flow';

describe('isSparseManifestXml', () => {
	it('detects the element with the conventional uap10 prefix', () => {
		const xml =
			'<Package><Properties>' +
			'<uap10:AllowExternalContent>true</uap10:AllowExternalContent>' +
			'</Properties></Package>';

		assert.equal(isSparseManifestXml(xml), true);
	});

	it('detects the element with no namespace prefix', () => {
		assert.equal(
			isSparseManifestXml('<AllowExternalContent>true</AllowExternalContent>'),
			true
		);
	});

	it('detects the element with an arbitrary namespace prefix', () => {
		assert.equal(
			isSparseManifestXml('<uap13:AllowExternalContent>true</uap13:AllowExternalContent>'),
			true
		);
	});

	it('tolerates whitespace around the value', () => {
		assert.equal(
			isSparseManifestXml('<uap10:AllowExternalContent>  true  </uap10:AllowExternalContent>'),
			true
		);
	});

	it('is case-insensitive on the value', () => {
		assert.equal(
			isSparseManifestXml('<uap10:AllowExternalContent>TRUE</uap10:AllowExternalContent>'),
			true
		);
	});

	it('rejects an explicit false value', () => {
		assert.equal(
			isSparseManifestXml('<uap10:AllowExternalContent>false</uap10:AllowExternalContent>'),
			false
		);
	});

	it('rejects a full packaged manifest with no such element', () => {
		const xml =
			'<Package><Identity Name="MyApp" /><Properties>' +
			'<DisplayName>My App</DisplayName>' +
			'</Properties></Package>';

		assert.equal(isSparseManifestXml(xml), false);
	});

	it('rejects empty and malformed input without throwing', () => {
		assert.equal(isSparseManifestXml(''), false);
		assert.equal(isSparseManifestXml('<Package'), false);
		assert.equal(isSparseManifestXml('not xml at all'), false);
		assert.equal(isSparseManifestXml('<AllowExternalContent>'), false);
	});

	it('does not match a similarly named element', () => {
		assert.equal(
			isSparseManifestXml('<DisallowExternalContentFoo>true</DisallowExternalContentFoo>'),
			false
		);
	});

	it('completes promptly on a pathological input (ReDoS guard)', () => {
		// Many near-matches that force the prefix alternation to retry.
		const malicious = '<'.repeat(10000) + 'a:AllowExternalContent';
		const start = Date.now();
		isSparseManifestXml(malicious);
		const elapsed = Date.now() - start;
		assert.ok(elapsed < 1000, `Took ${elapsed}ms — possible ReDoS`);
	});
});

describe('buildSparseInitArgs', () => {
	it('builds the documented sparse init invocation', () => {
		assert.deepEqual(
			buildSparseInitArgs({ exePath: 'C:\\app\\MyApp.exe', outputDir: 'C:\\repo\\sparse' }),
			[
				'init',
				'--exe',
				'C:\\app\\MyApp.exe',
				'--sparse',
				'--use-defaults',
				'--output-dir',
				'C:\\repo\\sparse'
			]
		);
	});

	it('appends --force only when overwriting', () => {
		const withForce = buildSparseInitArgs({
			exePath: 'C:\\app\\MyApp.exe',
			outputDir: 'C:\\repo\\sparse',
			force: true
		});
		assert.ok(withForce.includes('--force'));

		const withoutForce = buildSparseInitArgs({
			exePath: 'C:\\app\\MyApp.exe',
			outputDir: 'C:\\repo\\sparse',
			force: false
		});
		assert.ok(!withoutForce.includes('--force'));
	});

	it('never passes --name or --publisher (the CLI infers them from the exe)', () => {
		const args = buildSparseInitArgs({
			exePath: 'C:\\app\\MyApp.exe',
			outputDir: 'C:\\repo\\sparse',
			force: true
		});

		assert.ok(!args.includes('--name'));
		assert.ok(!args.includes('--publisher'));
	});

	it('does not pass a positional directory (sparse init ignores it)', () => {
		const args = buildSparseInitArgs({ exePath: 'C:\\app\\MyApp.exe', outputDir: 'C:\\repo\\sparse' });

		// The only bare (non-flag, non-flag-value) token must be the verb.
		assert.equal(args[0], 'init');
		assert.equal(args[1], '--exe');
	});

	it('keeps paths as single argv entries so spaces need no escaping', () => {
		const args = buildSparseInitArgs({
			exePath: 'C:\\My Apps\\My App.exe',
			outputDir: 'C:\\My Repo\\sparse'
		});

		assert.ok(args.includes('C:\\My Apps\\My App.exe'));
		assert.ok(args.includes('C:\\My Repo\\sparse'));
	});
});

describe('buildEmbedIdentityArgs', () => {
	it('omits --manifest so the CLI uses its own sparse/ search', () => {
		assert.deepEqual(
			buildEmbedIdentityArgs({ target: 'C:\\app\\MyApp.exe' }),
			['embed-identity', 'C:\\app\\MyApp.exe']
		);
	});

	it('passes --manifest when one is supplied', () => {
		assert.deepEqual(
			buildEmbedIdentityArgs({
				target: 'C:\\app\\MyApp.exe',
				manifestPath: 'C:\\repo\\sparse\\appxmanifest.xml'
			}),
			['embed-identity', 'C:\\app\\MyApp.exe', '--manifest', 'C:\\repo\\sparse\\appxmanifest.xml']
		);
	});
});

describe('embedRewritesBinary', () => {
	it('is true for an exe target (mt.exe rewrites it in place)', () => {
		assert.equal(embedRewritesBinary('C:\\app\\MyApp.exe'), true);
	});

	it('is case-insensitive on the extension', () => {
		assert.equal(embedRewritesBinary('C:\\app\\MyApp.EXE'), true);
	});

	it('is false for side-by-side manifest targets', () => {
		assert.equal(embedRewritesBinary('C:\\app\\app.manifest'), false);
		assert.equal(embedRewritesBinary('C:\\app\\app.xml'), false);
	});

	it('is false for an extensionless path', () => {
		assert.equal(embedRewritesBinary('C:\\app\\MyApp'), false);
	});

	it('does not match a name that merely contains .exe', () => {
		assert.equal(embedRewritesBinary('C:\\app\\MyApp.exe.manifest'), false);
	});
});

describe('pack input classification', () => {
	const folder: PackInput = { kind: 'folder', path: 'C:\\repo\\bin\\Release' };
	const manifest: PackInput = { kind: 'sparseManifest', path: 'C:\\repo\\sparse\\appxmanifest.xml' };

	it('treats only a sparse manifest as identity-only', () => {
		assert.equal(isIdentityOnlyInput(folder), false);
		assert.equal(isIdentityOnlyInput(manifest), true);
	});

	it('uses the folder itself as the containment root', () => {
		assert.equal(getPackInputRoot(folder), 'C:\\repo\\bin\\Release');
	});

	it('uses the containing directory as the root for a manifest file', () => {
		assert.equal(getPackInputRoot(manifest), path.dirname('C:\\repo\\sparse\\appxmanifest.xml'));
	});
});

describe('defaultSparseOutputDir', () => {
	it('defaults to a sparse folder at the workspace root', () => {
		assert.equal(
			defaultSparseOutputDir('C:\\repo'),
			path.join('C:\\repo', SPARSE_OUTPUT_FOLDER)
		);
	});

	it('anchors on the project root when one is supplied', () => {
		assert.equal(
			defaultSparseOutputDir('C:\\repo', 'C:\\repo\\src\\MyApp'),
			path.join('C:\\repo\\src\\MyApp', SPARSE_OUTPUT_FOLDER)
		);
	});

	it('falls back to the workspace root for an empty project root', () => {
		assert.equal(
			defaultSparseOutputDir('C:\\repo', ''),
			path.join('C:\\repo', SPARSE_OUTPUT_FOLDER)
		);
	});
});

describe('getSparseManifestPath', () => {
	it('points at appxmanifest.xml inside the output directory', () => {
		assert.equal(
			getSparseManifestPath('C:\\repo\\sparse'),
			path.join('C:\\repo\\sparse', 'appxmanifest.xml')
		);
	});
});
