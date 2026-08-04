import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	findWorkspaceArtifacts,
	buildSignCommand,
	CERTIFICATE_GLOBS,
	discoverSignableFiles,
	discoverSignableFilesWithCancellation
} from '../sign-utils';
import { ARTIFACT_GLOBS } from '../artifact-types';
import type { CancellationTokenLike, DisposableLike } from '../cancellation';
import { discoverBuildOutputFiles } from '../project-detection';

class TestCancellationToken implements CancellationTokenLike {
	isCancellationRequested = false;
	disposed = false;
	private listener: (() => void) | undefined;

	onCancellationRequested(listener: () => void): DisposableLike {
		this.listener = listener;
		return {
			dispose: () => {
				this.disposed = true;
				this.listener = undefined;
			}
		};
	}

	cancel(): void {
		this.isCancellationRequested = true;
		this.listener?.();
	}
}

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

	it('does not scan when cancellation was already requested', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		createFile(path.join(tempDir, 'app.msix'));

		const results = await findWorkspaceArtifacts(
			tempDir,
			ARTIFACT_GLOBS,
			AbortSignal.abort()
		);

		assert.deepEqual(results, []);
	});

	it('interrupts an active glob when aborted', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		createFile(path.join(tempDir, 'app.msix'));
		const abortController = new AbortController();

		const pendingResults = findWorkspaceArtifacts(tempDir, ARTIFACT_GLOBS, abortController.signal);
		abortController.abort();

		assert.deepEqual(await pendingResults, []);
	});

	it('does not launch additional stat work after an abort', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		createFile(path.join(tempDir, 'first.msix'));
		createFile(path.join(tempDir, 'second.msix'));
		const abortController = new AbortController();
		const promisesFs = fs.promises as { stat: typeof fs.promises.stat };
		const originalStat = promisesFs.stat;
		let statCalls = 0;
		promisesFs.stat = (async (targetPath: fs.PathLike) => {
			statCalls++;
			abortController.abort();
			return originalStat(targetPath);
		}) as typeof fs.promises.stat;

		try {
			const results = await findWorkspaceArtifacts(tempDir, ARTIFACT_GLOBS, abortController.signal);
			assert.deepEqual(results, []);
			assert.equal(statCalls, 1);
		} finally {
			promisesFs.stat = originalStat;
		}
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

describe('discoverSignableFiles', () => {
	it('skips binary discovery when packages fill all 10 slots', async () => {
		const packages = Array.from({ length: 12 }, (_, index) => `package-${index}.msix`);
		let binaryDiscoveryCalled = false;

		const results = await discoverSignableFiles(packages, async () => {
			binaryDiscoveryCalled = true;
			return ['app.exe'];
		}, async () => {
			binaryDiscoveryCalled = true;
			return ['app.dll'];
		});

		assert.equal(binaryDiscoveryCalled, false);
		assert.deepEqual(results, { packagePaths: packages.slice(0, 10), binaryPaths: [] });
	});

	it('merges executable and library candidates before applying the remaining cap', async () => {
		const packages = ['package.msix', 'bundle.msixbundle'];
		const executables = ['primary.exe', 'secondary.exe'];
		const libraries = Array.from({ length: 10 }, (_, index) => `dependency-${index}.dll`);

		const results = await discoverSignableFiles(packages, async maxResults => {
			assert.equal(maxResults, 8);
			return executables;
		}, async maxResults => {
			assert.equal(maxResults, 8);
			return libraries;
		}, 10, (paths, maxResults) => [
			'dependency-0.dll',
			...paths.filter(filePath => filePath.endsWith('.exe')),
			...paths.filter(filePath => filePath.endsWith('.dll') && filePath !== 'dependency-0.dll')
		].slice(0, maxResults));

		assert.deepEqual(results.packagePaths, packages);
		assert.deepEqual(results.binaryPaths, [
			'dependency-0.dll',
			...executables,
			...libraries.slice(1, 6)
		]);
	});

	it('queries bounded candidates for both extensions when executables fill the remaining slots', async () => {
		let libraryDiscoveryLimit: number | undefined;

		const results = await discoverSignableFiles(
			['package.msix'],
			async maxResults => Array.from({ length: maxResults }, (_, index) => `app-${index}.exe`),
			async maxResults => {
				libraryDiscoveryLimit = maxResults;
				return ['dependency.dll'];
			},
			10,
			(paths, maxResults) => paths.slice(0, maxResults)
		);

		assert.equal(libraryDiscoveryLimit, 9);
		assert.equal(results.binaryPaths.length, 9);
		assert.ok(results.binaryPaths.every(filePath => filePath.endsWith('.exe')));
	});

	it('preserves DLL-only discovery', async () => {
		const results = await discoverSignableFiles(
			[],
			async () => [],
			async maxResults => {
				assert.equal(maxResults, 10);
				return ['library.dll'];
			}
		);

		assert.deepEqual(results.binaryPaths, ['library.dll']);
	});

	it('suppresses binary discovery after cancellation during package discovery', async () => {
		const token = new TestCancellationToken();
		let executableDiscoveryCalled = false;
		let libraryDiscoveryCalled = false;

		const result = await discoverSignableFilesWithCancellation(
			token,
			async signal => {
				assert.equal(signal.aborted, false);
				token.cancel();
				assert.equal(signal.aborted, true);
				return ['package.msix'];
			},
			async () => {
				executableDiscoveryCalled = true;
				return ['app.exe'];
			},
			async () => {
				libraryDiscoveryCalled = true;
				return ['dependency.dll'];
			}
		);

		assert.deepEqual(result, { cancelled: true, value: undefined });
		assert.equal(executableDiscoveryCalled, false);
		assert.equal(libraryDiscoveryCalled, false);
		assert.equal(token.disposed, true);
	});

	it('skips library discovery after deterministic cancellation during executable discovery', async () => {
		const token = new TestCancellationToken();
		let libraryDiscoveryCalled = false;
		let fallbackDiscoveryCalled = false;
		let rankingCalled = false;
		const workspacePath = process.platform === 'win32' ? 'C:\\workspace' : '/workspace';

		const result = await discoverSignableFilesWithCancellation(
			token,
			async () => [],
			async maxResults => discoverBuildOutputFiles(
				workspacePath,
				'exe',
				maxResults,
				async (_includeGlob, _scanLimit) => {
					if (!token.isCancellationRequested) {
						token.cancel();
						return [path.join(workspacePath, 'bin', 'app.exe')];
					}
					fallbackDiscoveryCalled = true;
					return [path.join(workspacePath, 'fallback', 'app.exe')];
				},
				() => token.isCancellationRequested
			),
			async () => {
				libraryDiscoveryCalled = true;
				return ['fallback.dll'];
			},
			paths => {
				rankingCalled = true;
				return paths;
			}
		);

		assert.deepEqual(result, { cancelled: true, value: undefined });
		assert.equal(libraryDiscoveryCalled, false);
		assert.equal(fallbackDiscoveryCalled, false);
		assert.equal(rankingCalled, false);
		assert.equal(token.disposed, true);
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
