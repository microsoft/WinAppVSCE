import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	findWorkspaceArtifacts as findWorkspaceArtifactsCore,
	buildSignCommand,
	CERTIFICATE_EXTENSIONS,
	EXECUTABLE_EXTENSIONS,
	MAX_QUICKPICK_RESULTS,
	SIGNABLE_ARTIFACT_TIERS
} from '../sign-utils';
import { ARTIFACT_EXTENSIONS } from '../artifact-types';

/** Every artifact extension as one tier, so ordering is purely by mtime. */
const ARTIFACT_TIER: readonly (readonly string[])[] = [ARTIFACT_EXTENSIONS];
const EXECUTABLE_TIER: readonly (readonly string[])[] = [EXECUTABLE_EXTENSIONS];
const CERTIFICATE_TIER: readonly (readonly string[])[] = [CERTIFICATE_EXTENSIONS];

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
	tiers: readonly (readonly string[])[] = ARTIFACT_TIER,
	signal?: AbortSignal,
	limit?: number
): Promise<string[]> {
	return findWorkspaceArtifactsCore(workspacePath, { tiers, signal, limit });
}

/**
 * Record every directory the scan reads, so tests can prove that ignored
 * subtrees are pruned during traversal rather than filtered out afterwards.
 */
async function recordReadDirectories<T>(run: () => Promise<T>): Promise<{
	result: T;
	directories: string[];
}> {
	const target = fs.promises as { readdir: typeof fs.promises.readdir };
	const originalReaddir = target.readdir;
	const directories: string[] = [];

	target.readdir = ((dirPath: fs.PathLike, options: unknown) => {
		directories.push(String(dirPath));
		return (originalReaddir as (...args: unknown[]) => unknown)(dirPath, options);
	}) as typeof fs.promises.readdir;

	try {
		return { result: await run(), directories };
	} finally {
		target.readdir = originalReaddir;
	}
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

		const results = await findWorkspaceArtifacts(tempDir, ARTIFACT_TIER);

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

		const results = await findWorkspaceArtifacts(tempDir, ARTIFACT_TIER);

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
			const results = await findWorkspaceArtifacts(tempDir, ARTIFACT_TIER);
			assert.deepEqual(results, [stable, missing]);
		} finally {
			promisesFs.stat = originalStat;
		}
	});

	it('returns an empty array for an empty workspace', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);

		const results = await findWorkspaceArtifacts(tempDir, ARTIFACT_TIER);

		assert.deepEqual(results, []);
	});

	it('discovers files in subdirectories', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const nested = path.join(tempDir, 'artifacts', 'release', 'app.msix');
		createFile(nested);

		const results = await findWorkspaceArtifacts(tempDir, ARTIFACT_TIER);

		assert.deepEqual(results, [nested]);
	});

	it('excludes node_modules and .git directories', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const included = path.join(tempDir, 'out', 'app.msix');
		createFile(included);
		createFile(path.join(tempDir, 'node_modules', 'pkg', 'ignored.msix'));
		createFile(path.join(tempDir, '.git', 'objects', 'ignored.appx'));

		const results = await findWorkspaceArtifacts(tempDir, ARTIFACT_TIER);

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

		const results = await findWorkspaceArtifacts(tempDir, EXECUTABLE_TIER);

		assert.deepEqual(results.sort(), [executable, library].sort());
	});

	it('never reads inside ignored directories', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const included = path.join(tempDir, 'out', 'app.msix');
		createFile(included);
		createFile(path.join(tempDir, 'node_modules', 'pkg', 'nested', 'ignored.msix'));
		createFile(path.join(tempDir, '.git', 'objects', 'ignored.appx'));

		const { result, directories } = await recordReadDirectories(() =>
			findWorkspaceArtifacts(tempDir, ARTIFACT_TIER));

		assert.deepEqual(result, [included]);
		// Pruning happens during traversal: the ignored trees are never opened,
		// so their size cannot affect scan cost or crowd out real matches.
		assert.ok(!directories.some(dir => dir.includes('node_modules')));
		assert.ok(!directories.some(dir => dir.includes('.git')));
	});

	it('returns nothing for a zero or negative limit without touching the disk', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		createFile(path.join(tempDir, 'pkg.msix'));

		for (const limit of [0, -1]) {
			const { result, directories } = await recordReadDirectories(() =>
				findWorkspaceArtifacts(tempDir, ARTIFACT_TIER, undefined, limit));

			// A non-positive cap must mean "nothing", never an unbounded walk.
			assert.deepEqual(result, []);
			assert.deepEqual(directories, []);
		}
	});

	it('returns nothing when every match lives in an ignored directory', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		for (let i = 0; i < 8; i++) {
			createFile(path.join(tempDir, 'node_modules', 'pkg', `dep${i}.msix`));
		}

		// Discovery must accept an empty result rather than widen the search:
		// "Browse…" is the escape hatch, not a full workspace walk.
		const results = await findWorkspaceArtifacts(tempDir, ARTIFACT_TIER, undefined, 2);

		assert.deepEqual(results, []);
	});

	it('keeps scanning when a directory cannot be read', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const readable = path.join(tempDir, 'out', 'app.msix');
		createFile(readable);
		fs.mkdirSync(path.join(tempDir, 'locked'), { recursive: true });

		const target = fs.promises as { readdir: typeof fs.promises.readdir };
		const originalReaddir = target.readdir;
		target.readdir = ((dirPath: fs.PathLike, options: unknown) => {
			if (String(dirPath).endsWith('locked')) {
				return Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
			}
			return (originalReaddir as (...args: unknown[]) => unknown)(dirPath, options);
		}) as typeof fs.promises.readdir;

		try {
			// A permissions error on one folder must not abort the whole scan.
			assert.deepEqual(await findWorkspaceArtifacts(tempDir, ARTIFACT_TIER), [readable]);
		} finally {
			target.readdir = originalReaddir;
		}
	});

	it('returns only the newest results up to the limit', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const base = Date.now();
		for (let i = 0; i < 5; i++) {
			createFile(path.join(tempDir, `pkg${i}.msix`), base + i * 1000);
		}

		const results = await findWorkspaceArtifacts(tempDir, ARTIFACT_TIER, undefined, 3);

		assert.deepEqual(
			results.map(filePath => path.basename(filePath)),
			['pkg4.msix', 'pkg3.msix', 'pkg2.msix']
		);
	});

	it('orders newest-first across the whole tree, not just an early sample', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const base = Date.now();
		// Names ascend with mtime and are spread across nested folders, so
		// traversal order is not mtime order. Previously the search was capped
		// at a candidate pool and the true newest could be truncated away
		// before sorting; a full pruned walk makes the ordering exact.
		for (let i = 0; i < 12; i++) {
			createFile(
				path.join(tempDir, `dir${i}`, `pkg${String(i).padStart(2, '0')}.msix`),
				base + i * 1000
			);
		}

		const results = await findWorkspaceArtifacts(tempDir, ARTIFACT_TIER, undefined, 2);

		assert.deepEqual(
			results.map(filePath => path.basename(filePath)),
			['pkg11.msix', 'pkg10.msix']
		);
	});

	it('stops collecting once the candidate guard is hit', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		for (let i = 0; i < 20; i++) {
			createFile(path.join(tempDir, `pkg${i}.msix`));
		}

		const results = await findWorkspaceArtifactsCore(tempDir, {
			tiers: ARTIFACT_TIER,
			limit: MAX_QUICKPICK_RESULTS,
			maxCandidates: 3
		});

		// The guard bounds work in pathological trees; "Browse…" covers the rest.
		assert.equal(results.length, 3);
	});

	it('defaults to the QuickPick result limit', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		for (let i = 0; i < MAX_QUICKPICK_RESULTS + 4; i++) {
			createFile(path.join(tempDir, `pkg${i}.msix`), Date.now() + i * 1000);
		}

		const results = await findWorkspaceArtifacts(tempDir, ARTIFACT_TIER);

		assert.equal(results.length, MAX_QUICKPICK_RESULTS);
	});

	it('does not start discovery when already aborted', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		createFile(path.join(tempDir, 'pkg.msix'));
		const controller = new AbortController();
		controller.abort();

		const { result, directories } = await recordReadDirectories(() =>
			findWorkspaceArtifacts(tempDir, ARTIFACT_TIER, controller.signal));

		assert.deepEqual(result, []);
		assert.deepEqual(directories, []);
	});

	it('stops stat work after cancellation', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const controller = new AbortController();
		createFile(path.join(tempDir, 'first.msix'));
		createFile(path.join(tempDir, 'second.msix'));

		const promisesFs = fs.promises as { stat: typeof fs.promises.stat };
		const originalStat = promisesFs.stat;
		promisesFs.stat = (async (targetPath: fs.PathLike) => {
			controller.abort();
			return originalStat(targetPath);
		}) as typeof fs.promises.stat;

		try {
			const results = await findWorkspaceArtifacts(tempDir, ARTIFACT_TIER, controller.signal);
			assert.deepEqual(results, []);
		} finally {
			promisesFs.stat = originalStat;
		}
	});
});

describe('findWorkspaceArtifacts tier ordering', () => {
	function findByTier(
		workspacePath: string,
		tiers: readonly (readonly string[])[] = SIGNABLE_ARTIFACT_TIERS,
		signal?: AbortSignal,
		limit?: number
	): Promise<string[]> {
		return findWorkspaceArtifactsCore(workspacePath, { tiers, signal, limit });
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

	it('does not stat lower tiers once the limit is reached', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		createFile(path.join(tempDir, 'a.msix'));
		createFile(path.join(tempDir, 'b.msix'));
		const executable = path.join(tempDir, 'app.exe');
		createFile(executable);

		const promisesFs = fs.promises as { stat: typeof fs.promises.stat };
		const originalStat = promisesFs.stat;
		const statted: string[] = [];
		promisesFs.stat = (async (targetPath: fs.PathLike) => {
			statted.push(String(targetPath));
			return originalStat(targetPath);
		}) as typeof fs.promises.stat;

		try {
			const results = await findByTier(tempDir, SIGNABLE_ARTIFACT_TIERS, undefined, 2);

			assert.equal(results.length, 2);
			// The MSIX tier filled every slot, so the executable bucket is
			// collected during the single walk but never ordered.
			assert.ok(!statted.includes(executable));
		} finally {
			promisesFs.stat = originalStat;
		}
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

	it('fills remaining slots from lower tiers without exceeding the limit', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		createFile(path.join(tempDir, 'a.msix'));
		createFile(path.join(tempDir, 'legacy.appx'));
		createFile(path.join(tempDir, 'app.exe'));
		createFile(path.join(tempDir, 'app.dll'));

		const results = await findByTier(tempDir, SIGNABLE_ARTIFACT_TIERS, undefined, 3);

		assert.equal(results.length, 3);
		assert.deepEqual(
			results.slice(0, 2).map(filePath => path.basename(filePath)),
			['a.msix', 'legacy.appx']
		);
	});

	it('lists a file once even when tiers overlap', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const duplicate = path.join(tempDir, 'a.msix');
		createFile(duplicate);

		// An extension mapped twice resolves to its last tier, never both.
		const results = await findByTier(tempDir, [['msix'], ['msix']], undefined, 5);

		assert.deepEqual(results, [duplicate]);
	});

	it('returns nothing when cancelled mid-scan', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		createFile(path.join(tempDir, 'a.msix'));
		const controller = new AbortController();

		const promisesFs = fs.promises as { stat: typeof fs.promises.stat };
		const originalStat = promisesFs.stat;
		promisesFs.stat = (async (targetPath: fs.PathLike) => {
			controller.abort();
			return originalStat(targetPath);
		}) as typeof fs.promises.stat;

		try {
			assert.deepEqual(await findByTier(tempDir, SIGNABLE_ARTIFACT_TIERS, controller.signal), []);
		} finally {
			promisesFs.stat = originalStat;
		}
	});
});

describe('findWorkspaceArtifacts for certificates', () => {
	it('discovers .pfx certificate files', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		createFile(path.join(tempDir, 'devcert.pfx'));
		createFile(path.join(tempDir, 'certs', 'prod.pfx'));

		const results = await findWorkspaceArtifacts(tempDir, CERTIFICATE_TIER);

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

		const results = await findWorkspaceArtifacts(tempDir, CERTIFICATE_TIER);

		assert.deepEqual(results, []);
	});

	it('excludes node_modules certificates', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const included = path.join(tempDir, 'devcert.pfx');
		createFile(included);
		createFile(path.join(tempDir, 'node_modules', 'pkg', 'test.pfx'));

		const results = await findWorkspaceArtifacts(tempDir, CERTIFICATE_TIER);

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
