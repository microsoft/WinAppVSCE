import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	findWorkspaceArtifacts,
	buildSignCommand,
	coordinateWorkspaceSignFileSelection,
	CERTIFICATE_GLOBS,
	createSignBrowseItem,
	createWorkspaceSignFileQuickPickItem,
	discoverSignFilesWithFallback,
	handoffSignFileDiscovery,
	runWithCancellation,
	runWithCancellationSource,
	WORKSPACE_ARTIFACT_MAX_RESULTS,
	WORKSPACE_ARTIFACT_QUICK_PICK_LIMIT,
	type CancellationTokenLike,
	type WorkspaceFileFinder
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

function createFinder(results: string[]): WorkspaceFileFinder {
	return async () => results;
}

class ControlledCancellationToken implements CancellationTokenLike {
	isCancellationRequested = false;
	disposeCount = 0;
	private readonly listeners = new Set<() => void>();

	onCancellationRequested(listener: () => void): { dispose(): void } {
		this.listeners.add(listener);
		return {
			dispose: () => {
				this.disposeCount++;
				this.listeners.delete(listener);
			}
		};
	}

	cancel(): void {
		this.isCancellationRequested = true;
		for (const listener of this.listeners) {
			listener();
		}
	}

	get listenerCount(): number {
		return this.listeners.size;
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

		const files = [
			path.join(tempDir, 'a.msix'),
			path.join(tempDir, 'b.msixbundle'),
			path.join(tempDir, 'c.appx'),
			path.join(tempDir, 'd.appxbundle')
		];
		const results = await findWorkspaceArtifacts(tempDir, createFinder(files), ARTIFACT_GLOBS);

		assert.deepEqual(
			results.paths.map(filePath => path.basename(filePath)).sort(),
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

		const results = await findWorkspaceArtifacts(tempDir, createFinder([older, newest, middle]), ARTIFACT_GLOBS);

		assert.deepEqual(results, {
			paths: [newest, middle, older],
			sourceTruncated: false,
			displayTruncated: false
		});
	});

	it('does not report display truncation for exactly 100 valid candidates', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const files = Array.from(
			{ length: WORKSPACE_ARTIFACT_QUICK_PICK_LIMIT },
			(_, index) => path.join(tempDir, `${index}.msix`)
		);
		for (const [index, file] of files.entries()) {
			createFile(file, 1_700_000_000_000 + index);
		}

		const results = await findWorkspaceArtifacts(tempDir, createFinder(files), ARTIFACT_GLOBS);

		assert.equal(results.paths.length, WORKSPACE_ARTIFACT_QUICK_PICK_LIMIT);
		assert.equal(results.paths[0], files.at(-1));
		assert.equal(results.paths.at(-1), files[0]);
		assert.equal(results.sourceTruncated, false);
		assert.equal(results.displayTruncated, false);
	});

	it('reports display truncation for exactly 101 valid candidates and keeps the newest 100', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const files = Array.from(
			{ length: WORKSPACE_ARTIFACT_QUICK_PICK_LIMIT + 1 },
			(_, index) => path.join(tempDir, `${index}.msix`)
		);
		for (const [index, file] of files.entries()) {
			createFile(file, 1_700_000_000_000 + index);
		}
		const newest = files.at(-1)!;

		const results = await findWorkspaceArtifacts(tempDir, createFinder(files), ARTIFACT_GLOBS);

		assert.equal(results.paths.length, WORKSPACE_ARTIFACT_QUICK_PICK_LIMIT);
		assert.equal(results.paths[0], newest);
		assert.ok(results.paths.includes(newest));
		assert.equal(results.sourceTruncated, false);
		assert.equal(results.displayTruncated, true);
	});

	it('does not report source truncation for exactly 500 source candidates', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const files = Array.from(
			{ length: WORKSPACE_ARTIFACT_MAX_RESULTS },
			(_, index) => path.join(tempDir, `${index}.msix`)
		);
		for (const [index, file] of files.entries()) {
			createFile(file, 1_700_000_000_000 + index);
		}

		const result = await findWorkspaceArtifacts(tempDir, createFinder(files), ARTIFACT_GLOBS);

		assert.equal(result.sourceTruncated, false);
		assert.equal(result.displayTruncated, true);
		assert.equal(result.paths.length, WORKSPACE_ARTIFACT_QUICK_PICK_LIMIT);
		assert.equal(result.paths[0], files[WORKSPACE_ARTIFACT_MAX_RESULTS - 1]);
		assert.equal(result.paths.at(-1), files[WORKSPACE_ARTIFACT_MAX_RESULTS - WORKSPACE_ARTIFACT_QUICK_PICK_LIMIT]);
	});

	it('requests one extra candidate and reports truncation for exactly 501 source candidates while processing only 500', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const files = Array.from(
			{ length: WORKSPACE_ARTIFACT_MAX_RESULTS + 1 },
			(_, index) => path.join(tempDir, `${index}.msix`)
		);
		for (const [index, file] of files.entries()) {
			createFile(file, 1_700_000_000_000 + index);
		}

		const result = await findWorkspaceArtifacts(tempDir, createFinder(files), ARTIFACT_GLOBS);

		assert.equal(result.sourceTruncated, true);
		assert.equal(result.displayTruncated, true);
		assert.equal(result.paths.length, WORKSPACE_ARTIFACT_QUICK_PICK_LIMIT);
		assert.ok(!result.paths.includes(files.at(-1)!));
		assert.equal(result.paths[0], files[WORKSPACE_ARTIFACT_MAX_RESULTS - 1]);
	});

	it('warns before manual selection when all 501 source candidates are post-filtered', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const files = Array.from(
			{ length: WORKSPACE_ARTIFACT_MAX_RESULTS + 1 },
			(_, index) => path.join(tempDir, 'node_modules', `${index}.msix`)
		);

		const discovery = await findWorkspaceArtifacts(tempDir, createFinder(files), ARTIFACT_GLOBS);

		assert.deepEqual(discovery, {
			paths: [],
			sourceTruncated: true,
			displayTruncated: false
		});

		let warning = '';
		let manualCalls = 0;
		const result = await handoffSignFileDiscovery(
			{ cancelled: false, result: discovery },
			async () => {
				manualCalls++;
				return 'C:\\manual\\app.msix';
			},
			{
				searchContext: 'signable artifacts',
				showWarning: async message => {
					warning = message;
					return 'Browse…';
				}
			}
		);
		assert.match(warning, /first 500 workspace matches/i);
		assert.match(warning, /signable artifacts/i);
		assert.match(warning, /additional matching files may still exist/i);
		assert.equal(result, 'C:\\manual\\app.msix');
		assert.equal(manualCalls, 1);
	});

	it('offers a clearly labeled Browse path when valid paths remain after source truncation', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const excluded = Array.from(
			{ length: WORKSPACE_ARTIFACT_MAX_RESULTS - 2 },
			(_, index) => path.join(tempDir, 'node_modules', `${index}.msix`)
		);
		const valid = [
			path.join(tempDir, 'output', 'app.msix'),
			path.join(tempDir, 'output', 'app.appx')
		];
		const uninspected = path.join(tempDir, 'output', 'uninspected.msix');
		for (const file of valid) {
			createFile(file);
		}

		const discovery = await findWorkspaceArtifacts(
			tempDir,
			createFinder([...excluded, ...valid, uninspected]),
			ARTIFACT_GLOBS
		);

		assert.deepEqual(discovery, {
			paths: valid,
			sourceTruncated: true,
			displayTruncated: false
		});
		const browseItem = createSignBrowseItem(discovery);
		assert.match(browseItem.label, /browse/i);
		assert.match(browseItem.label, /additional files may exist/i);
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
			const results = await findWorkspaceArtifacts(tempDir, createFinder([stable, missing]), ARTIFACT_GLOBS);
			assert.deepEqual(results, {
				paths: [stable, missing],
				sourceTruncated: false,
				displayTruncated: false
			});
		} finally {
			promisesFs.stat = originalStat;
		}
	});

	it('returns an empty array for an empty workspace', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);

		const results = await findWorkspaceArtifacts(tempDir, createFinder([]), ARTIFACT_GLOBS);

		assert.deepEqual(results, { paths: [], sourceTruncated: false, displayTruncated: false });
	});

	it('discovers files in subdirectories', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const nested = path.join(tempDir, 'artifacts', 'release', 'app.msix');
		createFile(nested);

		const results = await findWorkspaceArtifacts(tempDir, createFinder([nested]), ARTIFACT_GLOBS);

		assert.deepEqual(results, {
			paths: [nested],
			sourceTruncated: false,
			displayTruncated: false
		});
	});

	it('uses one brace-pattern search', async () => {
		let callCount = 0;
		const finder: WorkspaceFileFinder = async (includePattern, _signal, maxResults) => {
			callCount++;
			assert.equal(includePattern, '{**/*.msix,**/*.msixbundle,**/*.appx,**/*.appxbundle}');
			assert.equal(maxResults, WORKSPACE_ARTIFACT_MAX_RESULTS + 1);
			return [];
		};

		await findWorkspaceArtifacts('C:\\workspace', finder, ARTIFACT_GLOBS);

		assert.equal(callCount, 1);
	});

	it('filters ignored matches before capping results for the QuickPick', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const ignored = Array.from(
			{ length: WORKSPACE_ARTIFACT_QUICK_PICK_LIMIT },
			(_, index) => path.join(tempDir, 'node_modules', `${index}.msix`)
		);
		const valid = Array.from(
			{ length: WORKSPACE_ARTIFACT_QUICK_PICK_LIMIT + 1 },
			(_, index) => path.join(tempDir, 'output', `${index}.msix`)
		);
		for (const file of [...ignored, ...valid]) {
			createFile(file);
		}

		const results = await findWorkspaceArtifacts(
			tempDir,
			createFinder([...ignored, ...valid]),
			ARTIFACT_GLOBS
		);

		assert.equal(results.paths.length, WORKSPACE_ARTIFACT_QUICK_PICK_LIMIT);
		assert.ok(results.paths.every(file => file.includes(`${path.sep}output${path.sep}`)));
		assert.equal(results.sourceTruncated, false);
		assert.equal(results.displayTruncated, true);
	});

	it('excludes node_modules and .git results without applying user file exclusions', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const included = path.join(tempDir, 'AppPackages', 'app.msix');
		const dependency = path.join(tempDir, 'node_modules', 'pkg', 'ignored.msix');
		const repositoryMetadata = path.join(tempDir, 'vendor', '.git', 'objects', 'ignored.appx');
		createFile(included);
		createFile(dependency);
		createFile(repositoryMetadata);

		const results = await findWorkspaceArtifacts(
			tempDir,
			createFinder([included, dependency, repositoryMetadata]),
			ARTIFACT_GLOBS
		);

		assert.deepEqual(results, {
			paths: [included],
			sourceTruncated: false,
			displayTruncated: false
		});
	});

	it('excludes mixed-case node_modules and .git segments on Windows', {
		skip: process.platform !== 'win32'
	}, async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const included = path.join(tempDir, 'output', 'app.msix');
		const dependency = path.join(tempDir, 'NODE_MODULES', 'pkg', 'ignored.msix');
		const repositoryMetadata = path.join(tempDir, 'vendor', '.GIT', 'objects', 'ignored.appx');
		createFile(included);
		createFile(dependency);
		createFile(repositoryMetadata);

		const results = await findWorkspaceArtifacts(
			tempDir,
			createFinder([included, dependency, repositoryMetadata]),
			ARTIFACT_GLOBS
		);

		assert.deepEqual(results, {
			paths: [included],
			sourceTruncated: false,
			displayTruncated: false
		});
	});

	it('does not start discovery when already aborted', async () => {
		const controller = new AbortController();
		controller.abort();
		let called = false;

		const results = await findWorkspaceArtifacts('C:\\workspace', async () => {
			called = true;
			return [];
		}, ARTIFACT_GLOBS, controller.signal);

		assert.deepEqual(results, { paths: [], sourceTruncated: false, displayTruncated: false });
		assert.equal(called, false);
	});

	for (const cancellationErrorName of ['AbortError', 'Canceled', 'CancellationError']) {
		it(`stops an in-progress discovery for ${cancellationErrorName}`, async () => {
			const controller = new AbortController();
			const finder: WorkspaceFileFinder = async (_include, signal) =>
				new Promise((_resolve, reject) => {
					signal?.addEventListener('abort', () => {
						const error = new Error('The operation was aborted');
						error.name = cancellationErrorName;
						reject(error);
					}, { once: true });
				});

			const discovery = findWorkspaceArtifacts('C:\\workspace', finder, ARTIFACT_GLOBS, controller.signal);
			controller.abort();

			assert.deepEqual(await discovery, {
				paths: [],
				sourceTruncated: false,
				displayTruncated: false
			});
		});
	}

	it('stops stat collection between batches when aborted', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const files = Array.from({ length: 101 }, (_, index) => path.join(tempDir, `${index}.msix`));
		for (const file of files) {
			createFile(file);
		}

		const controller = new AbortController();
		const promisesFs = fs.promises as { stat: typeof fs.promises.stat };
		const originalStat = promisesFs.stat;
		let statCalls = 0;
		promisesFs.stat = (async (targetPath: fs.PathLike) => {
			statCalls++;
			const result = await originalStat(targetPath);
			controller.abort();
			return result;
		}) as typeof fs.promises.stat;

		try {
			const results = await findWorkspaceArtifacts(
				tempDir,
				createFinder(files),
				ARTIFACT_GLOBS,
				controller.signal
			);
			assert.deepEqual(results, { paths: [], sourceTruncated: false, displayTruncated: false });
			assert.equal(statCalls, 100);
		} finally {
			promisesFs.stat = originalStat;
		}
	});

	it('propagates non-abort discovery errors', async () => {
		const expected = new Error('search failed');

		await assert.rejects(
			findWorkspaceArtifacts('C:\\workspace', async () => { throw expected; }, ARTIFACT_GLOBS),
			expected
		);
	});

	it('propagates an ordinary error raised after cancellation', async () => {
		const controller = new AbortController();
		const expected = new Error('search failed during cancellation');
		const finder: WorkspaceFileFinder = async (_include, signal) =>
			new Promise((_resolve, reject) => {
				signal?.addEventListener('abort', () => reject(expected), { once: true });
			});

		const discovery = findWorkspaceArtifacts('C:\\workspace', finder, ARTIFACT_GLOBS, controller.signal);
		controller.abort();

		await assert.rejects(discovery, expected);
	});

	for (const cancellationErrorName of ['AbortError', 'Canceled', 'CancellationError']) {
		it(`propagates ${cancellationErrorName} when the signal is not aborted`, async () => {
			const expected = new Error('not actually cancelled');
			expected.name = cancellationErrorName;

			await assert.rejects(
				findWorkspaceArtifacts('C:\\workspace', async () => { throw expected; }, ARTIFACT_GLOBS),
				expected
			);
		});
	}
});

describe('runWithCancellation', () => {
	it('returns a successful operation result and disposes the listener', async () => {
		const token = new ControlledCancellationToken();

		const result = await runWithCancellation(token, async signal => {
			assert.equal(signal.aborted, false);
			return 'found';
		});

		assert.deepEqual(result, { cancelled: false, value: 'found' });
		assert.equal(token.listenerCount, 0);
		assert.equal(token.disposeCount, 1);
	});

	it('propagates an operation rejection and disposes the listener', async () => {
		const token = new ControlledCancellationToken();
		const expected = new Error('discovery failed');

		await assert.rejects(
			runWithCancellation(token, async () => { throw expected; }),
			expected
		);
		assert.equal(token.listenerCount, 0);
		assert.equal(token.disposeCount, 1);
	});

	it('propagates an ordinary rejection after cancellation and disposes the listener', async () => {
		const token = new ControlledCancellationToken();
		const expected = new Error('discovery failed during cancellation');
		const operation = runWithCancellation(token, signal =>
			new Promise<never>((_resolve, reject) => {
				signal.addEventListener('abort', () => reject(expected), { once: true });
			})
		);

		token.cancel();

		await assert.rejects(operation, expected);
		assert.equal(token.listenerCount, 0);
		assert.equal(token.disposeCount, 1);
	});

	it('does not start the operation for a pre-cancelled token and disposes the listener', async () => {
		const token = new ControlledCancellationToken();
		token.cancel();
		let operationCalled = false;

		const result = await runWithCancellation(token, async () => {
			operationCalled = true;
			return ['unexpected'];
		});

		assert.deepEqual(result, { cancelled: true, value: undefined });
		assert.equal(operationCalled, false);
		assert.equal(token.listenerCount, 0);
		assert.equal(token.disposeCount, 1);
	});

	it('aborts an in-progress finder and disposes the listener', async () => {
		const token = new ControlledCancellationToken();
		let finderObservedAbort = false;
		const finder: WorkspaceFileFinder = async (_include, signal) =>
			new Promise((_resolve, reject) => {
				signal?.addEventListener('abort', () => {
					finderObservedAbort = true;
					const error = new Error('cancelled');
					error.name = 'Canceled';
					reject(error);
				}, { once: true });
			});

		const discovery = runWithCancellation(token, signal =>
			findWorkspaceArtifacts('C:\\workspace', finder, ARTIFACT_GLOBS, signal)
		);
		token.cancel();
		const result = await discovery;

		assert.equal(result.cancelled, true);
		assert.deepEqual(result.value, {
			paths: [],
			sourceTruncated: false,
			displayTruncated: false
		});
		assert.equal(finderObservedAbort, true);
		assert.equal(token.listenerCount, 0);
		assert.equal(token.disposeCount, 1);
	});

	it('returns a resolved value as cancelled when cancellation wins the race', async () => {
		const token = new ControlledCancellationToken();
		let resolveOperation!: (value: string) => void;
		const operation = runWithCancellation(
			token,
			() => new Promise<string>(resolve => { resolveOperation = resolve; })
		);

		token.cancel();
		resolveOperation('late value');

		assert.deepEqual(await operation, { cancelled: true, value: 'late value' });
		assert.equal(token.listenerCount, 0);
		assert.equal(token.disposeCount, 1);
	});
});

describe('runWithCancellationSource', () => {
	function createTrackedSignal(): {
		controller: AbortController;
		addCount: () => number;
		removeCount: () => number;
	} {
		const controller = new AbortController();
		let adds = 0;
		let removes = 0;
		const signal = controller.signal;
		const originalAdd = signal.addEventListener.bind(signal);
		const originalRemove = signal.removeEventListener.bind(signal);
		signal.addEventListener = ((...args: Parameters<AbortSignal['addEventListener']>) => {
			adds++;
			return originalAdd(...args);
		}) as AbortSignal['addEventListener'];
		signal.removeEventListener = ((...args: Parameters<AbortSignal['removeEventListener']>) => {
			removes++;
			return originalRemove(...args);
		}) as AbortSignal['removeEventListener'];
		return { controller, addCount: () => adds, removeCount: () => removes };
	}

	it('hands off the token and disposes the source and abort listener on success', async () => {
		const tracked = createTrackedSignal();
		let disposed = 0;
		const token = { id: 'token' };

		const result = await runWithCancellationSource(
			tracked.controller.signal,
			() => ({ token, cancel() {}, dispose() { disposed++; } }),
			async receivedToken => {
				assert.equal(receivedToken, token);
				return ['found'];
			}
		);

		assert.deepEqual(result, ['found']);
		assert.equal(disposed, 1);
		assert.equal(tracked.addCount(), 1);
		assert.equal(tracked.removeCount(), 1);
	});

	it('propagates rejection while cleaning up exactly once', async () => {
		const tracked = createTrackedSignal();
		const expected = new Error('find failed');
		let disposed = 0;

		await assert.rejects(
			runWithCancellationSource(
				tracked.controller.signal,
				() => ({ token: {}, cancel() {}, dispose() { disposed++; } }),
				async () => { throw expected; }
			),
			expected
		);
		assert.equal(disposed, 1);
		assert.equal(tracked.removeCount(), 1);
	});

	it('propagates abort to the source and removes the listener', async () => {
		const tracked = createTrackedSignal();
		let cancelled = 0;
		let disposed = 0;
		let finish!: () => void;
		const pending = runWithCancellationSource(
			tracked.controller.signal,
			() => ({ token: {}, cancel() { cancelled++; }, dispose() { disposed++; } }),
			() => new Promise<void>(resolve => { finish = resolve; })
		);

		tracked.controller.abort();
		finish();
		await pending;

		assert.equal(cancelled, 1);
		assert.equal(disposed, 1);
		assert.equal(tracked.removeCount(), 1);
	});

	it('cancels a pre-aborted source without installing a listener', async () => {
		const tracked = createTrackedSignal();
		tracked.controller.abort();
		let cancelled = 0;
		let disposed = 0;

		await runWithCancellationSource(
			tracked.controller.signal,
			() => ({ token: {}, cancel() { cancelled++; }, dispose() { disposed++; } }),
			async () => undefined
		);

		assert.equal(cancelled, 1);
		assert.equal(disposed, 1);
		assert.equal(tracked.addCount(), 0);
		assert.equal(tracked.removeCount(), 0);
	});
});

describe('discoverSignFilesWithFallback', () => {
	for (const [context, pathName] of [
		['signable artifacts', 'app.msix'],
		['signing certificates', 'dev.pfx']
	] as const) {
		it(`hands off discovered ${context}`, async () => {
			const value = {
				paths: [`C:\\out\\${pathName}`],
				sourceTruncated: false,
				displayTruncated: false
			};
			const result = await discoverSignFilesWithFallback(
				context,
				async () => ({ cancelled: false, value }),
				async () => { throw new Error('warning should not be shown'); }
			);
			assert.deepEqual(result, { cancelled: false, result: value });
		});
	}

	it('preserves truncation metadata from workspace discovery', async () => {
		const value = {
			paths: ['C:\\out\\app.msix'],
			sourceTruncated: true,
			displayTruncated: false
		};

		const result = await discoverSignFilesWithFallback(
			'signable artifacts',
			async () => ({ cancelled: false, value }),
			async () => { throw new Error('warning should not be shown'); }
		);

		assert.deepEqual(result, { cancelled: false, result: value });
	});

	it('includes failure context and requests Browse when selected', async () => {
		let warning = '';
		const result = await discoverSignFilesWithFallback(
			'signable artifacts',
			async () => { throw new Error('search unavailable'); },
			async message => {
				warning = message;
				return 'Browse…';
			}
		);

		assert.match(warning, /signable artifacts: search unavailable/);
		assert.deepEqual(result, { cancelled: false, browseRequested: true });
	});

	it('does not request Browse when the warning is dismissed', async () => {
		const result = await discoverSignFilesWithFallback(
			'signing certificates',
			async () => { throw new Error('search unavailable'); },
			async () => undefined
		);
		assert.deepEqual(result, { cancelled: false, browseRequested: false });
	});

	it('bypasses the warning when discovery is cancelled', async () => {
		let warningShown = false;
		const result = await discoverSignFilesWithFallback(
			'signable artifacts',
			async () => ({
				cancelled: true,
				value: { paths: [], sourceTruncated: false, displayTruncated: false }
			}),
			async () => {
				warningShown = true;
				return 'Browse…';
			}
		);
		assert.deepEqual(result, {
			cancelled: true,
			result: { paths: [], sourceTruncated: false, displayTruncated: false }
		});
		assert.equal(warningShown, false);
	});
});

describe('handoffSignFileDiscovery', () => {
	it('invokes manual selection once for a direct empty discovery and returns its result', async () => {
		let calls = 0;
		const result = await handoffSignFileDiscovery(
			{
				cancelled: false,
				result: { paths: [], sourceTruncated: false, displayTruncated: false }
			},
			async () => {
				calls++;
				return 'C:\\manual\\app.msix';
			}
		);

		assert.equal(result, 'C:\\manual\\app.msix');
		assert.equal(calls, 1);
	});

	it('does not invoke manual selection when a truncated empty discovery warning is dismissed', async () => {
		let calls = 0;
		let warning = '';
		const result = await handoffSignFileDiscovery(
			{
				cancelled: false,
				result: { paths: [], sourceTruncated: true, displayTruncated: false }
			},
			async () => {
				calls++;
				return 'unexpected';
			},
			{
				searchContext: 'signing certificates',
				showWarning: async message => {
					warning = message;
					return undefined;
				}
			}
		);

		assert.equal(result, undefined);
		assert.equal(calls, 0);
		assert.match(warning, /first 500 workspace matches/i);
		assert.match(warning, /signing certificates/i);
	});

	for (const [kind, manualPath] of [
		['artifact', 'C:\\manual\\app.msix'],
		['certificate', 'C:\\manual\\cert.pfx']
	] as const) {
		it(`invokes the ${kind} manual selector once when Browse was requested`, async () => {
			let calls = 0;
			const result = await handoffSignFileDiscovery(
				{ cancelled: false, browseRequested: true },
				async () => {
					calls++;
					return manualPath;
				}
			);

			assert.equal(result, manualPath);
			assert.equal(calls, 1);
		});
	}

	for (const discovery of [
		{
			cancelled: true,
			result: { paths: [], sourceTruncated: false, displayTruncated: false }
		},
		{ cancelled: false, browseRequested: false }
	]) {
		it(`does not invoke manual selection for ${discovery.cancelled ? 'cancellation' : 'dismissal'}`, async () => {
			let calls = 0;
			const result = await handoffSignFileDiscovery(discovery, async () => {
				calls++;
				return 'unexpected';
			});

			assert.equal(result, undefined);
			assert.equal(calls, 0);
		});
	}

	it('continues with normal discovered paths without invoking manual selection', async () => {
		const discovered = {
			paths: ['C:\\out\\app.msix'],
			sourceTruncated: true,
			displayTruncated: false
		};
		let calls = 0;

		const result = await handoffSignFileDiscovery(
			{ cancelled: false, result: discovered },
			async () => {
				calls++;
				return 'unexpected';
			}
		);

		assert.equal(result, discovered);
		assert.equal(calls, 0);
	});
});

describe('coordinateWorkspaceSignFileSelection', () => {
	it('shows discovered workspace items plus a partial-results Browse option', async () => {
		const discovery = {
			cancelled: false,
			result: {
				paths: ['C:\\workspace\\output\\app.msix'],
				sourceTruncated: true,
				displayTruncated: false
			}
		};
		let warningShown = false;
		let manualCalls = 0;
		let quickPickItems: Array<{ label: string; description?: string; detail: string }> = [];

		const result = await coordinateWorkspaceSignFileSelection('C:\\workspace', discovery, {
			searchContext: 'signable artifacts',
			placeHolder: 'Select a package to sign',
			selectManualFile: async () => {
				manualCalls++;
				return 'C:\\manual\\fallback.msix';
			},
			showWarning: async () => {
				warningShown = true;
				return 'Browse…';
			},
			showQuickPick: async items => {
				quickPickItems = [...items];
				return items[1];
			}
		});

		assert.equal(result, 'C:\\manual\\fallback.msix');
		assert.equal(warningShown, false);
		assert.equal(manualCalls, 1);
		assert.deepEqual(quickPickItems[0], createWorkspaceSignFileQuickPickItem('C:\\workspace', 'C:\\workspace\\output\\app.msix'));
		assert.match(quickPickItems[1].label, /browse/i);
		assert.match(quickPickItems[1].detail, /first 500 workspace matches/i);
		assert.match(quickPickItems[1].detail, /browse to choose a different file manually/i);
	});

	it('surfaces an explicit warning before manual Browse when bounded discovery yields no displayable paths', async () => {
		let warning = '';
		let quickPickCalls = 0;
		let manualCalls = 0;

		const result = await coordinateWorkspaceSignFileSelection('C:\\workspace', {
			cancelled: false,
			result: {
				paths: [],
				sourceTruncated: true,
				displayTruncated: false
			}
		}, {
			searchContext: 'signable artifacts',
			placeHolder: 'Select a package to sign',
			selectManualFile: async () => {
				manualCalls++;
				return 'C:\\manual\\bounded.msix';
			},
			showWarning: async message => {
				warning = message;
				return 'Browse…';
			},
			showQuickPick: async () => {
				quickPickCalls++;
				return undefined;
			}
		});

		assert.equal(result, 'C:\\manual\\bounded.msix');
		assert.equal(quickPickCalls, 0);
		assert.equal(manualCalls, 1);
		assert.match(warning, /first 500 workspace matches/i);
		assert.match(warning, /signable artifacts/i);
		assert.match(warning, /additional matching files may still exist/i);
	});
});

describe('createSignBrowseItem', () => {
	it('discloses when source discovery and the displayed list are truncated', () => {
		const item = createSignBrowseItem({ sourceTruncated: true, displayTruncated: true });

		assert.match(item.label, /more files available/i);
		assert.match(item.detail, /newest 100 of the first 500/i);
		assert.match(item.detail, /additional workspace matches may exist/i);
		assert.match(item.detail, /browse to choose a different file manually/i);
	});

	it('discloses when only the displayed list is truncated', () => {
		const item = createSignBrowseItem({ sourceTruncated: false, displayTruncated: true });

		assert.match(item.label, /more files available/i);
		assert.match(item.detail, /newest 100 matching files/i);
		assert.match(item.detail, /browse to choose a different file manually/i);
	});

	it('discloses when only source discovery is truncated', () => {
		const item = createSignBrowseItem({ sourceTruncated: true, displayTruncated: false });

		assert.match(item.label, /additional files may exist/i);
		assert.match(item.detail, /first 500 workspace matches/i);
		assert.match(item.detail, /browse to choose a different file manually/i);
	});

	it('uses the normal Browse wording for complete discovery', () => {
		assert.deepEqual(
			createSignBrowseItem({ sourceTruncated: false, displayTruncated: false }),
			{ label: '$(folder-opened) Browse…', detail: 'Open a file picker' }
		);
	});
});

describe('findWorkspaceArtifacts with CERTIFICATE_GLOBS', () => {
	it('discovers .pfx certificate files', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		createFile(path.join(tempDir, 'devcert.pfx'));
		createFile(path.join(tempDir, 'certs', 'prod.pfx'));

		const results = await findWorkspaceArtifacts(
			tempDir,
			createFinder([path.join(tempDir, 'devcert.pfx'), path.join(tempDir, 'certs', 'prod.pfx')]),
			CERTIFICATE_GLOBS
		);

		assert.deepEqual(
			results.paths.map(filePath => path.basename(filePath)).sort(),
			['devcert.pfx', 'prod.pfx']
		);
	});

	it('does not discover non-pfx files', async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		createFile(path.join(tempDir, 'app.msix'));
		createFile(path.join(tempDir, 'cert.pem'));

		const results = await findWorkspaceArtifacts(tempDir, createFinder([]), CERTIFICATE_GLOBS);

		assert.deepEqual(results, { paths: [], sourceTruncated: false, displayTruncated: false });
	});

	it('uses the certificate glob without a brace wrapper', async () => {
		const finder: WorkspaceFileFinder = async (includePattern) => {
			assert.equal(includePattern, '**/*.pfx');
			return [];
		};

		assert.deepEqual(
			await findWorkspaceArtifacts('C:\\workspace', finder, CERTIFICATE_GLOBS),
			{ paths: [], sourceTruncated: false, displayTruncated: false }
		);
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
