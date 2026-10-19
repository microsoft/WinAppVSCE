import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import {
	isSparseManifestXml,
	decodeManifestXml,
	buildSparseInitArgs,
	buildSparsePackArgs,
	buildEmbedIdentityArgs,
	planSparseInitCommand,
	planEmbedIdentityCommand,
	embedRewritesBinary,
	defaultSparseOutputDir,
	getSparseManifestPath,
	isProjectMarker,
	findProjectRootIn,
	findOwningWorkspacePath,
	chooseSparseManifest,
	SPARSE_OUTPUT_FOLDER
} from '../sparse-flow';

describe('decodeManifestXml', () => {
	const xml = '<?xml version="1.0"?><Package />';

	it('decodes UTF-8 with or without a byte-order mark', () => {
		assert.equal(decodeManifestXml(Buffer.from(xml, 'utf8')), xml);
		assert.equal(
			decodeManifestXml(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(xml, 'utf8')])),
			xml
		);
	});

	it('decodes UTF-16LE with a byte-order mark', () => {
		assert.equal(
			decodeManifestXml(Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(xml, 'utf16le')])),
			xml
		);
	});

	it('decodes UTF-16LE without a byte-order mark', () => {
		assert.equal(decodeManifestXml(Buffer.from(xml, 'utf16le')), xml);
	});

	it('decodes UTF-16BE with a byte-order mark', () => {
		const bigEndian = Buffer.from(Buffer.from(xml, 'utf16le')).swap16();
		assert.equal(
			decodeManifestXml(Buffer.concat([Buffer.from([0xFE, 0xFF]), bigEndian])),
			xml
		);
	});

	it('decodes UTF-16BE without a byte-order mark', () => {
		const bigEndian = Buffer.from(Buffer.from(xml, 'utf16le')).swap16();
		assert.equal(decodeManifestXml(bigEndian), xml);
	});

	it('rejects an odd-length UTF-16BE payload', () => {
		assert.equal(decodeManifestXml(Buffer.from([0xFE, 0xFF, 0x00])), '');
	});

	it('rejects an odd-length BOM-less UTF-16BE payload', () => {
		assert.equal(decodeManifestXml(Buffer.from([0x00, 0x3C, 0x00])), '');
	});
});

describe('isSparseManifestXml', () => {
	it('detects the element with the conventional uap10 prefix', () => {
		const xml =
			'<Package xmlns:uap10="urn:test"><Properties>' +
			'<uap10:AllowExternalContent>true</uap10:AllowExternalContent>' +
			'</Properties></Package>';

		assert.equal(isSparseManifestXml(xml), true);
	});

	it('accepts a UTF-8 byte-order mark before the manifest', () => {
		const xml =
			'\uFEFF<?xml version="1.0" encoding="utf-8"?>' +
			'<Package xmlns:uap10="urn:test"><Properties>' +
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
			isSparseManifestXml(
				'<Package xmlns:uap13="urn:test">' +
				'<uap13:AllowExternalContent>true</uap13:AllowExternalContent>' +
				'</Package>'
			),
			true
		);
	});

	it('tolerates whitespace around the value', () => {
		assert.equal(
			isSparseManifestXml(
				'<Package xmlns:uap10="urn:test">' +
				'<uap10:AllowExternalContent>  true  </uap10:AllowExternalContent>' +
				'</Package>'
			),
			true
		);
	});

	it('is case-insensitive on the value', () => {
		assert.equal(
			isSparseManifestXml(
				'<Package xmlns:uap10="urn:test">' +
				'<uap10:AllowExternalContent>TRUE</uap10:AllowExternalContent>' +
				'</Package>'
			),
			true
		);
	});

	it('rejects an explicit false value', () => {
		assert.equal(
			isSparseManifestXml(
				'<Package xmlns:uap10="urn:test">' +
				'<uap10:AllowExternalContent>false</uap10:AllowExternalContent>' +
				'</Package>'
			),
			false
		);
	});

	it('ignores the marker when it appears only inside a comment', () => {
		assert.equal(
			isSparseManifestXml(
				'<Package><!-- <uap10:AllowExternalContent>true</uap10:AllowExternalContent> --></Package>'
			),
			false
		);
	});

	it('rejects malformed XML even when it contains the marker text', () => {
		assert.equal(
			isSparseManifestXml(
				'<Package><AllowExternalContent>true</AllowExternalContent></NotPackage>'
			),
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

describe('buildSparsePackArgs', () => {
	it('packages the selected manifest as a single input', () => {
		assert.deepEqual(
			buildSparsePackArgs({ manifestPath: 'C:\\repo\\sparse\\appxmanifest.xml' }),
			['pack', 'C:\\repo\\sparse\\appxmanifest.xml']
		);
	});

	it('can generate a development certificate without attempting a machine-store install', () => {
		assert.deepEqual(
			buildSparsePackArgs({
				manifestPath: 'C:\\repo\\sparse\\appxmanifest.xml',
				generateCertificate: true
			}),
			[
				'pack',
				'C:\\repo\\sparse\\appxmanifest.xml',
				'--generate-cert'
			]
		);
	});
});

describe('buildEmbedIdentityArgs', () => {
	it('omits --manifest when none is supplied, leaving the CLI to search', () => {
		assert.deepEqual(
			buildEmbedIdentityArgs({ target: 'C:\\app\\MyApp.exe' }),
			['embed-identity', 'C:\\app\\MyApp.exe']
		);
	});

	describe('sparse command dispatch plans', () => {
		it('dispatches sparse init from the owning workspace with explicit output', () => {
			assert.deepEqual(
				planSparseInitCommand({
					exePath: 'C:\\repo\\App\\bin\\App.exe',
					outputDir: 'C:\\repo\\App\\sparse',
					workspacePath: 'C:\\repo',
					force: true
				}),
				{
					args: [
						'init',
						'--exe',
						'C:\\repo\\App\\bin\\App.exe',
						'--sparse',
						'--use-defaults',
						'--output-dir',
						'C:\\repo\\App\\sparse',
						'--force'
					],
					cwd: 'C:\\repo'
				}
			);
		});

		it('requires and dispatches the resolved manifest for embed identity', () => {
			assert.deepEqual(
				planEmbedIdentityCommand({
					target: 'C:\\repo\\App\\bin\\App.exe',
					manifestPath: 'C:\\repo\\App\\sparse\\appxmanifest.xml',
					workspacePath: 'C:\\repo'
				}),
				{
					args: [
						'embed-identity',
						'C:\\repo\\App\\bin\\App.exe',
						'--manifest',
						'C:\\repo\\App\\sparse\\appxmanifest.xml'
					],
					cwd: 'C:\\repo'
				}
			);
		});

		it('uses the target directory as cwd outside the workspace', () => {
			assert.equal(
				planEmbedIdentityCommand({
					target: 'D:\\outside\\App.exe',
					manifestPath: 'D:\\identity\\appxmanifest.xml'
				}).cwd,
				'D:\\outside'
			);
		});
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

	it('uses an external executable directory as the sparse output anchor', () => {
		assert.equal(
			defaultSparseOutputDir('D:\\outside\\bin'),
			path.join('D:\\outside\\bin', SPARSE_OUTPUT_FOLDER)
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

describe('isProjectMarker', () => {
	it('recognises the supported project markers', () => {
		for (const entry of [
			'App.csproj',
			'App.vcxproj',
			'Cargo.toml',
			'package.json',
			'CMakeLists.txt',
			'pubspec.yaml'
		]) {
			assert.equal(isProjectMarker(entry), true, entry);
		}
	});

	it('is case-insensitive', () => {
		assert.equal(isProjectMarker('APP.CSPROJ'), true);
		assert.equal(isProjectMarker('cargo.TOML'), true);
	});

	it('rejects unrelated entries', () => {
		for (const entry of ['App.exe', 'readme.md', 'bin', 'packages.config', 'App.csproj.user']) {
			assert.equal(isProjectMarker(entry), false, entry);
		}
	});
});

describe('findProjectRootIn', () => {
	// Directory listings keyed by path; anything absent is "unreadable".
	function reader(tree: Record<string, string[]>) {
		return (dir: string) => {
			const entries = tree[dir];
			if (!entries) {
				throw new Error(`ENOENT: ${dir}`);
			}
			return entries;
		};
	}

	it('anchors on the nearest project root above the executable', () => {
		const root = findProjectRootIn(
			'C:\\repo',
			'C:\\repo\\src\\App\\bin\\x64\\Debug\\net8.0\\win-x64\\App.exe',
			reader({
				'C:\\repo\\src\\App\\bin\\x64\\Debug\\net8.0\\win-x64': ['App.exe', 'App.dll'],
				'C:\\repo\\src\\App\\bin\\x64\\Debug\\net8.0': ['win-x64'],
				'C:\\repo\\src\\App\\bin\\x64\\Debug': ['net8.0'],
				'C:\\repo\\src\\App\\bin\\x64': ['Debug'],
				'C:\\repo\\src\\App\\bin': ['x64'],
				'C:\\repo\\src\\App': ['App.csproj', 'bin', 'Program.cs'],
				'C:\\repo\\src': ['App'],
				'C:\\repo': ['src', 'README.md']
			})
		);

		assert.equal(root, 'C:\\repo\\src\\App');
	});

	it('picks the innermost project in a monorepo, not an outer one', () => {
		const root = findProjectRootIn(
			'C:\\repo',
			'C:\\repo\\apps\\Inner\\bin\\App.exe',
			reader({
				'C:\\repo\\apps\\Inner\\bin': ['App.exe'],
				'C:\\repo\\apps\\Inner': ['Inner.csproj'],
				'C:\\repo\\apps': ['package.json', 'Inner'],
				'C:\\repo': ['apps']
			})
		);

		assert.equal(root, 'C:\\repo\\apps\\Inner');
	});

	it('returns undefined when the workspace root itself holds the only marker', () => {
		// The walk stops *before* the workspace root, so the caller falls back
		// to it rather than this function returning it.
		const root = findProjectRootIn(
			'C:\\repo',
			'C:\\repo\\bin\\App.exe',
			reader({
				'C:\\repo\\bin': ['App.exe'],
				'C:\\repo': ['App.csproj', 'bin']
			})
		);

		assert.equal(root, undefined);
		assert.equal(defaultSparseOutputDir('C:\\repo', root), path.join('C:\\repo', SPARSE_OUTPUT_FOLDER));
	});

	it('keeps walking past directories it cannot read', () => {
		const root = findProjectRootIn(
			'C:\\repo',
			'C:\\repo\\src\\App\\bin\\App.exe',
			reader({
				// 'C:\\repo\\src\\App\\bin' deliberately absent → throws.
				'C:\\repo\\src\\App': ['App.csproj'],
				'C:\\repo\\src': ['App'],
				'C:\\repo': ['src']
			})
		);

		assert.equal(root, 'C:\\repo\\src\\App');
	});

	it('returns undefined when no marker exists anywhere below the workspace', () => {
		const root = findProjectRootIn(
			'C:\\repo',
			'C:\\repo\\a\\b\\App.exe',
			reader({
				'C:\\repo\\a\\b': ['App.exe'],
				'C:\\repo\\a': ['b'],
				'C:\\repo': ['a']
			})
		);

		assert.equal(root, undefined);
	});

	it('never escapes into a sibling directory sharing a name prefix', () => {
		// Guards a prefix-matching bug: 'C:\repo-other'.startsWith('C:\repo')
		// is true, so a naive check would walk into an unrelated project.
		const root = findProjectRootIn(
			'C:\\repo',
			'C:\\repo-other\\src\\App.exe',
			reader({
				'C:\\repo-other\\src': ['App.csproj', 'App.exe'],
				'C:\\repo-other': ['src']
			})
		);

		assert.equal(root, undefined);
	});

	it('returns undefined for an executable outside the workspace entirely', () => {
		const root = findProjectRootIn(
			'C:\\repo',
			'D:\\elsewhere\\App\\App.exe',
			reader({ 'D:\\elsewhere\\App': ['App.csproj'] })
		);

		assert.equal(root, undefined);
	});
});

describe('findOwningWorkspacePath', () => {
	it('uses the workspace root that contains the selected target', () => {
		assert.equal(
			findOwningWorkspacePath(
				'C:\\repo\\AppB\\bin\\AppB.exe',
				['C:\\repo\\AppA', 'C:\\repo\\AppB']
			),
			'C:\\repo\\AppB'
		);
	});

	it('uses the most specific root when workspace folders are nested', () => {
		assert.equal(
			findOwningWorkspacePath(
				'C:\\repo\\apps\\AppB\\bin\\AppB.exe',
				['C:\\repo', 'C:\\repo\\apps\\AppB']
			),
			'C:\\repo\\apps\\AppB'
		);
	});

	it('does not match a sibling directory that shares a prefix', () => {
		assert.equal(
			findOwningWorkspacePath(
				'C:\\repo-other\\App.exe',
				['C:\\repo']
			),
			undefined
		);
	});

	it('returns undefined for a target outside every workspace root', () => {
		assert.equal(
			findOwningWorkspacePath(
				'D:\\outside\\App.exe',
				['C:\\repo\\AppA', 'C:\\repo\\AppB']
			),
			undefined
		);
	});
});

describe('chooseSparseManifest', () => {
	const expectedPath = 'C:\\repo\\src\\App\\sparse\\appxmanifest.xml';

	it('prefers the location sparse init writes to', () => {
		assert.deepEqual(
			chooseSparseManifest({
				expectedPath,
				expectedExists: true,
				discovered: ['C:\\repo\\other\\appxmanifest.xml']
			}),
			{ kind: 'resolved', path: expectedPath }
		);
	});

	it('never adopts a single workspace match on its own', () => {
		// Embedding rewrites the binary in place, so the one manifest that
		// happened to turn up in a scan must not decide the identity — it may
		// belong to an entirely unrelated project.
		assert.deepEqual(
			chooseSparseManifest({
				expectedPath,
				expectedExists: false,
				discovered: ['C:\\repo\\unrelated\\appxmanifest.xml']
			}),
			{ kind: 'ask', candidates: ['C:\\repo\\unrelated\\appxmanifest.xml'] }
		);
	});

	it('offers every candidate when several manifests match', () => {
		const discovered = ['C:\\repo\\a\\appxmanifest.xml', 'C:\\repo\\b\\appxmanifest.xml'];

		assert.deepEqual(
			chooseSparseManifest({ expectedPath, expectedExists: false, discovered }),
			{ kind: 'ask', candidates: discovered }
		);
	});

	it('asks with no candidates when nothing is found', () => {
		assert.deepEqual(
			chooseSparseManifest({ expectedPath, expectedExists: false, discovered: [] }),
			{ kind: 'ask', candidates: [] }
		);
		assert.deepEqual(
			chooseSparseManifest({ expectedPath, expectedExists: false }),
			{ kind: 'ask', candidates: [] }
		);
	});
});

describe('embed-identity manifest resolution (regression)', () => {
	// Reproduces the layout that broke the three-step workflow: the CLI's own
	// fallback searches `sparse/` beside the *exe* and then the cwd, but init
	// anchors output on the *project root*. For any project building into
	// `bin/`, those never coincide — so `--manifest` must be passed.
	const workspace = 'C:\\repo';
	const exe = 'C:\\repo\\src\\App\\bin\\x64\\Debug\\net8.0\\win-x64\\App.exe';
	const projectRoot = 'C:\\repo\\src\\App';

	const initOutputDir = defaultSparseOutputDir(workspace, projectRoot);
	const initManifest = getSparseManifestPath(initOutputDir);

	it('writes the manifest somewhere the CLI would not have looked', () => {
		const besideExe = getSparseManifestPath(
			path.join(path.dirname(exe), SPARSE_OUTPUT_FOLDER)
		);
		const inWorkspaceRoot = getSparseManifestPath(
			path.join(workspace, SPARSE_OUTPUT_FOLDER)
		);

		assert.equal(initManifest, path.join(projectRoot, 'sparse', 'appxmanifest.xml'));
		assert.notEqual(initManifest, besideExe);
		assert.notEqual(initManifest, inWorkspaceRoot);
	});

	it('passes the init output location through to embed-identity', () => {
		const resolved = chooseSparseManifest({
			expectedPath: initManifest,
			expectedExists: true
		});

		assert.deepEqual(resolved, { kind: 'resolved', path: initManifest });
		assert.deepEqual(
			buildEmbedIdentityArgs({ target: exe, manifestPath: initManifest }),
			['embed-identity', exe, '--manifest', initManifest]
		);
	});

	it('round-trips: init --output-dir and embed --manifest agree', () => {
		const initArgs = buildSparseInitArgs({ exePath: exe, outputDir: initOutputDir });
		const outputDir = initArgs[initArgs.indexOf('--output-dir') + 1];

		const resolved = chooseSparseManifest({
			expectedPath: getSparseManifestPath(outputDir),
			expectedExists: true
		});
		assert.equal(resolved.kind, 'resolved');

		const embedArgs = buildEmbedIdentityArgs({
			target: exe,
			manifestPath: resolved.kind === 'resolved' ? resolved.path : undefined
		});
		const manifest = embedArgs[embedArgs.indexOf('--manifest') + 1];

		assert.equal(path.dirname(manifest), outputDir);
	});
});
