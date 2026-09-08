import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { glob } from 'glob';
import {
	findWorkspaceArtifacts as findWorkspaceArtifactsCore,
	findWorkspaceArtifactsByTier,
	buildSignCommand,
	createWorkspaceFileFinder,
	CERTIFICATE_GLOBS,
	EXECUTABLE_GLOBS,
	MAX_QUICKPICK_RESULTS,
	SIGNABLE_ARTIFACT_TIERS,
	type WorkspaceFileSearch
} from '../sign-utils';
import { ARTIFACT_GLOBS } from '../artifact-types';

function createTempDir(): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'winapp-sign-utils-')));
}

function removeTempDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

function createFile(filePath: string, mtimeMs?: number): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, '');
	if (mtimeMs !== undefined) {
		const time = new Date(mtimeMs);
		fs.utimesSync(filePath, time, time);
	}
}

const tempDirs: string[] = [];

function findWorkspaceArtifacts(
	workspacePath: string,
	patterns: string[] = ARTIFACT_GLOBS,
	signal?: AbortSignal,
	limit?: number
): Promise<string[]> {
	return findWorkspaceArtifactsCore(
		workspacePath,
		includePattern => glob(includePattern, { cwd: workspacePath, absolute: true, nodir: true }),
		patterns,
		signal,
		limit
	);
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		removeTempDir(dir);
	}
});

describe('findWorkspaceArtifacts', () => {
	it('discovers .msix, .msixbundle, .appx, and .appxbundle files', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		createFile(path.join(tempDir, 'a.msix'));
		createFile(path.join(tempDir, 'b.msixbundle'));
		createFile(path.join(tempDir, 'c.appx'));
		createFile(path.join(tempDir, 'd.appxbundle'));

		const results = await findWorkspaceArtifacts(tempDir, ARTIFACT_GLOBS);

		assert.deepEqual(
			results.map(filePath => path.basename(filePath)).sort(),
			['a.msix', 'b.msixbundle', 'c.appx', 'd.appxbundle']
		);
	});

	it('sorts artifacts by newest mtime first', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const older = path.join(tempDir, 'older.msix');
		const newest = path.join(tempDir, 'newest.msixbundle');
		const middle = path.join(tempDir, 'middle.appx');
		createFile(older, 1_700_000_000_000);
		createFile(newest, 1_700_000_000_200);
		createFile(middle, 1_700_000_000_100);

		const results = await findWorkspaceArtifacts(tempDir, ARTIFACT_GLOBS);

		assert.deepEqual(results, [newest, middle, older]);
	});

	it('tolerates stat failures by pushing those files to the end', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const stable = path.join(tempDir, 'stable.msix');
		const missing = path.join(tempDir, 'missing.appx');
		createFile(stable, 1_700_000_000_100);
		createFile(missing, 1_700_000_000_200);

		const promisesFs = fs.promises as { stat: typeof fs.promises.stat };
		const originalStat = promisesFs.stat;
		promisesFs.stat = (async (targetPath: fs.PathLike) => {
			if (path.resolve(String(targetPath)) === missing) {
				throw new Error('ENOENT');
			}
			return originalStat(targetPath);
		}) as typeof fs.promises.stat;

		try {
			const results = await findWorkspaceArtifacts(tempDir, ARTIFACT_GLOBS);
			assert.deepEqual(results, [stable, missing]);
		} finally {
			promisesFs.stat = originalStat;
		}
	});

	it('returns an empty array for an empty workspace', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);

		const results = await findWorkspaceArtifacts(tempDir, ARTIFACT_GLOBS);

		assert.deepEqual(results, []);
	});

	it('discovers files in subdirectories', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const nested = path.join(tempDir, 'artifacts', 'release', 'app.msix');
		createFile(nested);

		const results = await findWorkspaceArtifacts(tempDir, ARTIFACT_GLOBS);

		assert.deepEqual(results, [nested]);
	});

	it('excludes node_modules and .git directories', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const included = path.join(tempDir, 'out', 'app.msix');
		createFile(included);
		createFile(path.join(tempDir, 'node_modules', 'pkg', 'ignored.msix'));
		createFile(path.join(tempDir, '.git', 'objects', 'ignored.appx'));

		const results = await findWorkspaceArtifacts(tempDir, ARTIFACT_GLOBS);

		assert.deepEqual(results, [included]);
	});

	it('discovers executable and library files outside excluded directories', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const executable = path.join(tempDir, 'bin', 'app.exe');
		const library = path.join(tempDir, 'bin', 'app.dll');
		createFile(executable);
		createFile(library);
		createFile(path.join(tempDir, 'node_modules', 'pkg', 'ignored.dll'));
		createFile(path.join(tempDir, '.git', 'ignored.exe'));

		const results = await findWorkspaceArtifacts(tempDir, EXECUTABLE_GLOBS);

		assert.deepEqual(results.sort(), [executable, library].sort());
	});

	it('searches all requested extensions in one call', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		let receivedPattern: string | undefined;
		let calls = 0;

		await findWorkspaceArtifactsCore(
			tempDir,
			async includePattern => {
				calls++;
				receivedPattern = includePattern;
				return [];
			},
			ARTIFACT_GLOBS
		);

		assert.equal(calls, 1);
		assert.equal(receivedPattern, `{${ARTIFACT_GLOBS.join(',')}}`);
	});

	it('bounds discovery without asking the finder to apply excludes', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		let received: WorkspaceFileSearch | undefined;

		await findWorkspaceArtifactsCore(
			tempDir,
			async (_includePattern, search) => {
				received = search;
				return [];
			},
			ARTIFACT_GLOBS,
			undefined,
			MAX_QUICKPICK_RESULTS
		);

		// Excludes are applied after the search: passing one to the VS Code
		// finder would also re-enable the user's `files.exclude` setting.
		assert.deepEqual(Object.keys(received ?? {}).sort(), ['maxResults', 'signal']);
		assert.ok(received?.maxResults !== undefined);
		assert.ok(received.maxResults > MAX_QUICKPICK_RESULTS);
		assert.ok(received.maxResults <= MAX_QUICKPICK_RESULTS * 4);
	});

	it('returns nothing for a zero or negative limit', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		createFile(path.join(tempDir, 'pkg.msix'));
		let calls = 0;
		const countingFinder = async () => {
			calls++;
			return [path.join(tempDir, 'pkg.msix')];
		};

		for (const limit of [0, -1]) {
			const results = await findWorkspaceArtifactsCore(
				tempDir,
				countingFinder,
				ARTIFACT_GLOBS,
				undefined,
				limit
			);
			// A non-positive cap must mean "nothing", never an unbounded walk.
			assert.deepEqual(results, []);
		}

		assert.equal(calls, 0);
	});

	it('retries unbounded when ignored paths saturate the candidate pool', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const real = path.join(tempDir, 'real.msix');
		createFile(real);
		const ignored = Array.from({ length: 8 }, (_, index) =>
			path.join(tempDir, 'node_modules', 'pkg', `dep${index}.msix`));
		for (const filePath of ignored) {
			createFile(filePath);
		}
		const requestedLimits: Array<number | undefined> = [];

		const results = await findWorkspaceArtifactsCore(
			tempDir,
			async (_includePattern, search) => {
				requestedLimits.push(search.maxResults);
				// A capped search returns only ignored matches; unbounded finds the real one.
				return search.maxResults === undefined ? [...ignored, real] : ignored.slice(0, search.maxResults);
			},
			ARTIFACT_GLOBS,
			undefined,
			2
		);

		assert.deepEqual(requestedLimits, [8, undefined]);
		assert.deepEqual(results, [real]);
	});

	it('does not run the unbounded retry after cancellation', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const ignored = Array.from({ length: 8 }, (_, index) =>
			path.join(tempDir, 'node_modules', 'pkg', `dep${index}.msix`));
		for (const filePath of ignored) {
			createFile(filePath);
		}
		const controller = new AbortController();
		const requestedLimits: Array<number | undefined> = [];

		const results = await findWorkspaceArtifactsCore(
			tempDir,
			async (_includePattern, search) => {
				requestedLimits.push(search.maxResults);
				// Saturate the pool with ignored paths, then cancel before the retry.
				controller.abort();
				return ignored;
			},
			ARTIFACT_GLOBS,
			controller.signal,
			2
		);

		assert.deepEqual(requestedLimits, [8]);
		assert.deepEqual(results, []);
	});

	it('does not retry when the candidate pool was not saturated', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const real = path.join(tempDir, 'real.msix');
		createFile(real);
		let calls = 0;

		const results = await findWorkspaceArtifactsCore(
			tempDir,
			async () => {
				calls++;
				return [real];
			},
			ARTIFACT_GLOBS,
			undefined,
			2
		);

		assert.equal(calls, 1);
		assert.deepEqual(results, [real]);
	});

	it('returns only the newest results up to the limit', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const base = Date.now();
		for (let i = 0; i < 5; i++) {
			createFile(path.join(tempDir, `pkg${i}.msix`), base + i * 1000);
		}

		const results = await findWorkspaceArtifacts(tempDir, ARTIFACT_GLOBS, undefined, 3);

		assert.deepEqual(
			results.map(filePath => path.basename(filePath)),
			['pkg4.msix', 'pkg3.msix', 'pkg2.msix']
		);
	});

	it('defaults to the QuickPick result limit', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		for (let i = 0; i < MAX_QUICKPICK_RESULTS + 4; i++) {
			createFile(path.join(tempDir, `pkg${i}.msix`), Date.now() + i * 1000);
		}

		const results = await findWorkspaceArtifacts(tempDir, ARTIFACT_GLOBS);

		assert.equal(results.length, MAX_QUICKPICK_RESULTS);
	});

	it('does not start discovery when already aborted', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const controller = new AbortController();
		controller.abort();
		let called = false;

		const results = await findWorkspaceArtifactsCore(
			tempDir,
			async () => {
				called = true;
				return [];
			},
			ARTIFACT_GLOBS,
			controller.signal
		);

		assert.deepEqual(results, []);
		assert.equal(called, false);
	});

	it('stops an in-progress workspace search when aborted', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const controller = new AbortController();
		const search = findWorkspaceArtifactsCore(
			tempDir,
			(_includePattern, search) => new Promise((_resolve, reject) => {
				search.signal?.addEventListener('abort', () => {
					reject(Object.assign(new Error('Cancelled'), { name: 'Canceled' }));
				}, { once: true });
			}),
			ARTIFACT_GLOBS,
			controller.signal
		);

		controller.abort();

		assert.deepEqual(await search, []);
	});

	it('stops stat work after cancellation', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const controller = new AbortController();
		const first = path.join(tempDir, 'first.msix');
		const second = path.join(tempDir, 'second.msix');
		createFile(first);
		createFile(second);
		const promisesFs = fs.promises as { stat: typeof fs.promises.stat };
		const originalStat = promisesFs.stat;
		let statCalls = 0;
		promisesFs.stat = (async (targetPath: fs.PathLike) => {
			statCalls++;
			controller.abort();
			return originalStat(targetPath);
		}) as typeof fs.promises.stat;

		try {
			const results = await findWorkspaceArtifactsCore(
				tempDir,
				async () => [first, second],
				ARTIFACT_GLOBS,
				controller.signal
			);
			assert.deepEqual(results, []);
			assert.equal(statCalls, 1);
		} finally {
			promisesFs.stat = originalStat;
		}
	});

	it('propagates non-cancellation search errors', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);

		await assert.rejects(
			findWorkspaceArtifactsCore(
				tempDir,
				async () => { throw new Error('search failed'); },
				ARTIFACT_GLOBS
			),
			/search failed/
		);
	});
});

describe('createWorkspaceFileFinder', () => {
	it('never passes an exclude pattern to the underlying finder', async () => {
		const excludes: unknown[] = [];
		const finder = createWorkspaceFileFinder(
			includePattern => includePattern,
			async (_include, exclude, _maxResults) => {
				excludes.push(exclude);
				return ['C:\\ws\\AppPackages\\App.msix'];
			},
			uri => uri
		);

		await finder('**/*.msix', { maxResults: 40 });
		await finder('**/*.exe', { maxResults: undefined });

		// A glob here would make VS Code also apply the user's `files.exclude`,
		// which hides their own package output and empties the sign picker.
		assert.deepEqual(excludes, [null, null]);
	});

	it('forwards the include pattern and result cap, and maps matches to paths', async () => {
		const calls: Array<{ include: string; maxResults: number | undefined }> = [];
		const finder = createWorkspaceFileFinder(
			includePattern => `rel:${includePattern}`,
			async (include, _exclude, maxResults) => {
				calls.push({ include, maxResults });
				return [{ fsPath: 'C:\\ws\\App.msix' }];
			},
			uri => uri.fsPath
		);

		const results = await finder('**/*.msix', { maxResults: 40 });

		assert.deepEqual(calls, [{ include: 'rel:**/*.msix', maxResults: 40 }]);
		assert.deepEqual(results, ['C:\\ws\\App.msix']);
	});
});

describe('findWorkspaceArtifactsByTier', () => {
	function findByTier(
		workspacePath: string,
		tiers: string[][] = SIGNABLE_ARTIFACT_TIERS,
		signal?: AbortSignal,
		limit?: number
	): Promise<string[]> {
		return findWorkspaceArtifactsByTier(
			workspacePath,
			includePattern => glob(includePattern, { cwd: workspacePath, absolute: true, nodir: true }),
			tiers,
			signal,
			limit
		);
	}

	it('ranks MSIX packages above APPX packages and executables', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const old = Date.now() - 60_000;
		createFile(path.join(tempDir, 'pkg.msix'), old);
		// Newer, but lower-priority tiers must still rank below the MSIX.
		createFile(path.join(tempDir, 'legacy.appx'), Date.now());
		createFile(path.join(tempDir, 'app.exe'), Date.now());

		const results = await findByTier(tempDir);

		assert.deepEqual(
			results.map(filePath => path.basename(filePath)),
			['pkg.msix', 'legacy.appx', 'app.exe']
		);
	});

	it('does not search lower tiers once the limit is reached', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const searched: string[] = [];

		const results = await findWorkspaceArtifactsByTier(
			tempDir,
			async includePattern => {
				searched.push(includePattern);
				return [path.join(tempDir, 'a.msix'), path.join(tempDir, 'b.msix')];
			},
			SIGNABLE_ARTIFACT_TIERS,
			undefined,
			2
		);

		assert.equal(searched.length, 1);
		assert.equal(results.length, 2);
	});

	it('falls through to lower tiers when higher tiers leave slots open', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		createFile(path.join(tempDir, 'app.exe'));
		createFile(path.join(tempDir, 'app.dll'));

		const results = await findByTier(tempDir);

		assert.deepEqual(
			results.map(filePath => path.basename(filePath)).sort(),
			['app.dll', 'app.exe']
		);
	});

	it('shrinks the per-tier limit by what earlier tiers already found', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const requestedLimits: Array<number | undefined> = [];

		await findWorkspaceArtifactsByTier(
			tempDir,
			async (includePattern, search) => {
				requestedLimits.push(search.maxResults);
				return includePattern.includes('msix') ? [path.join(tempDir, 'a.msix')] : [];
			},
			SIGNABLE_ARTIFACT_TIERS,
			undefined,
			4
		);

		// Tier 1 asks for 4 slots' worth, later tiers only for the remaining 3.
		assert.equal(requestedLimits.length, 3);
		assert.ok(requestedLimits[0]! > requestedLimits[1]!);
		assert.equal(requestedLimits[1], requestedLimits[2]);
	});

	it('de-duplicates files matched by more than one tier', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const duplicate = path.join(tempDir, 'a.msix');

		const results = await findWorkspaceArtifactsByTier(
			tempDir,
			async () => [duplicate],
			[['**/*.msix'], ['**/*.msix']],
			undefined,
			5
		);

		assert.deepEqual(results, [duplicate]);
	});

	it('returns nothing when cancelled mid-search', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const controller = new AbortController();

		const results = await findWorkspaceArtifactsByTier(
			tempDir,
			async () => {
				controller.abort();
				return [path.join(tempDir, 'a.msix')];
			},
			SIGNABLE_ARTIFACT_TIERS,
			controller.signal
		);

		assert.deepEqual(results, []);
	});
});

describe('findWorkspaceArtifacts with CERTIFICATE_GLOBS', () => {
	it('discovers .pfx certificate files', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		createFile(path.join(tempDir, 'devcert.pfx'));
		createFile(path.join(tempDir, 'certs', 'prod.pfx'));

		const results = await findWorkspaceArtifacts(tempDir, CERTIFICATE_GLOBS);

		assert.deepEqual(
			results.map(filePath => path.basename(filePath)).sort(),
			['devcert.pfx', 'prod.pfx']
		);
	});

	it('does not discover non-pfx files', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		createFile(path.join(tempDir, 'app.msix'));
		createFile(path.join(tempDir, 'cert.pem'));

		const results = await findWorkspaceArtifacts(tempDir, CERTIFICATE_GLOBS);

		assert.deepEqual(results, []);
	});

	it('excludes node_modules certificates', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const included = path.join(tempDir, 'devcert.pfx');
		createFile(included);
		createFile(path.join(tempDir, 'node_modules', 'pkg', 'test.pfx'));

		const results = await findWorkspaceArtifacts(tempDir, CERTIFICATE_GLOBS);

		assert.deepEqual(results, [included]);
	});
});

describe('buildSignCommand', () => {
	it('produces positional arguments: sign <file> <cert>', () => {
		const result = buildSignCommand('C:\\out\\app.msix', 'C:\\certs\\dev.pfx');
		assert.equal(result, "sign 'C:\\out\\app.msix' 'C:\\certs\\dev.pfx'");
	});

	it('does not use --cert flag', () => {
		const result = buildSignCommand('app.msix', 'cert.pfx');
		assert.ok(!result.includes('--cert'), `Expected no --cert flag, got: ${result}`);
	});

	it('escapes paths containing single quotes', () => {
		const result = buildSignCommand("C:\\O'Brien\\app.msix", 'cert.pfx');
		assert.ok(result.includes('sign'), 'Command should start with sign');
		assert.ok(result.includes("O''Brien"), 'Single quote in path should be escaped');
	});

	it('handles paths with spaces', () => {
		const result = buildSignCommand('C:\\My Apps\\app.msix', 'C:\\My Certs\\dev.pfx');
		assert.ok(result.includes('My Apps'), 'Space in file path should be preserved');
		assert.ok(result.includes('My Certs'), 'Space in cert path should be preserved');
	});
});
