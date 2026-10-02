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
	isProjectMarker,
	findProjectRootIn,
	chooseSparseManifest,
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
	it('omits --manifest when none is supplied, leaving the CLI to search', () => {
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

describe('chooseSparseManifest', () => {
	const expectedPath = 'C:\\repo\\src\\App\\sparse\\appxmanifest.xml';

	it('prefers the location sparse init writes to', () => {
		assert.equal(
			chooseSparseManifest({
				expectedPath,
				expectedExists: true,
				discovered: ['C:\\repo\\other\\appxmanifest.xml']
			}),
			expectedPath
		);
	});

	it('falls back to a single unambiguous workspace match', () => {
		assert.equal(
			chooseSparseManifest({
				expectedPath,
				expectedExists: false,
				discovered: ['C:\\repo\\moved\\appxmanifest.xml']
			}),
			'C:\\repo\\moved\\appxmanifest.xml'
		);
	});

	it('defers to the CLI when several manifests match', () => {
		assert.equal(
			chooseSparseManifest({
				expectedPath,
				expectedExists: false,
				discovered: ['C:\\repo\\a\\appxmanifest.xml', 'C:\\repo\\b\\appxmanifest.xml']
			}),
			undefined
		);
	});

	it('defers to the CLI when nothing is found', () => {
		assert.equal(
			chooseSparseManifest({ expectedPath, expectedExists: false, discovered: [] }),
			undefined
		);
		assert.equal(
			chooseSparseManifest({ expectedPath, expectedExists: false }),
			undefined
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

		assert.equal(resolved, initManifest);
		assert.deepEqual(
			buildEmbedIdentityArgs({ target: exe, manifestPath: resolved }),
			['embed-identity', exe, '--manifest', initManifest]
		);
	});

	it('round-trips: init --output-dir and embed --manifest agree', () => {
		const initArgs = buildSparseInitArgs({ exePath: exe, outputDir: initOutputDir });
		const outputDir = initArgs[initArgs.indexOf('--output-dir') + 1];

		const embedArgs = buildEmbedIdentityArgs({
			target: exe,
			manifestPath: chooseSparseManifest({
				expectedPath: getSparseManifestPath(outputDir),
				expectedExists: true
			})
		});
		const manifest = embedArgs[embedArgs.indexOf('--manifest') + 1];

		assert.equal(path.dirname(manifest), outputDir);
	});
});
