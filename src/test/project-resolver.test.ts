/**
 * Unit tests for resolveProjectDirectory (src/project-resolver.ts).
 *
 * Verifies the project-resolution logic that every project-context WinApp
 * command relies on: appDirectories handling, workspace-root detection, the
 * automatic scan, and user-cancellation. Dependencies on the VS Code API are
 * injected as fakes so the logic runs outside the extension host.
 *
 * Run: npx tsx --test src/test/project-resolver.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	resolveProjectDirectory,
	ProjectResolverDeps,
	ProjectQuickPickItem
} from '../project-resolver';
import { DetectedProject } from '../project-detection';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createTempDir(): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'winapp-resolver-')));
}

function removeTempDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

/** Writes an executable (.NET) csproj so detectProjectAt recognizes a root project. */
function writeExecutableCsproj(dir: string, name = 'App.csproj'): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, name),
		'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType></PropertyGroup></Project>'
	);
}

function makeProject(directory: string, type: DetectedProject['type'] = '.NET'): DetectedProject {
	return { type, directory, displayPath: '.', projectFileName: 'App.csproj' };
}

interface FakeCalls {
	warnings: string[];
	pickInvocations: { items: ProjectQuickPickItem[]; placeHolder: string }[];
	scanInvocations: string[];
}

/**
 * Builds a deps object with sensible defaults plus call recording.
 * Override any field via `overrides`.
 */
function makeDeps(
	overrides: Partial<ProjectResolverDeps>,
	calls: FakeCalls
): ProjectResolverDeps {
	return {
		getAppDirectories: () => [],
		showWarning: (message) => { calls.warnings.push(message); },
		pickDirectory: async (items, placeHolder) => {
			calls.pickInvocations.push({ items, placeHolder });
			return undefined;
		},
		scanProjects: async (root) => {
			calls.scanInvocations.push(root);
			return [];
		},
		...overrides
	};
}

function emptyCalls(): FakeCalls {
	return { warnings: [], pickInvocations: [], scanInvocations: [] };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('resolveProjectDirectory', () => {
	describe('appDirectories setting', () => {
		it('auto-selects the directory when exactly one entry is configured', async () => {
			const ws = createTempDir();
			try {
				const calls = emptyCalls();
				const deps = makeDeps({ getAppDirectories: () => ['apps/my-app'] }, calls);

				const result = await resolveProjectDirectory(ws, deps);

				assert.equal(result, path.resolve(ws, 'apps/my-app'));
				// No scanning or prompting should occur.
				assert.equal(calls.scanInvocations.length, 0);
				assert.equal(calls.pickInvocations.length, 0);
			} finally {
				removeTempDir(ws);
			}
		});

		it('prompts the user when multiple entries are configured', async () => {
			const ws = createTempDir();
			try {
				const calls = emptyCalls();
				const chosen = path.resolve(ws, 'apps/shell');
				const deps = makeDeps({
					getAppDirectories: () => ['apps/my-app', 'apps/shell'],
					pickDirectory: async (items, placeHolder) => {
						calls.pickInvocations.push({ items, placeHolder });
						return chosen;
					}
				}, calls);

				const result = await resolveProjectDirectory(ws, deps);

				assert.equal(result, chosen);
				assert.equal(calls.pickInvocations.length, 1);
				assert.equal(calls.pickInvocations[0].items.length, 2);
				assert.equal(calls.scanInvocations.length, 0);
			} finally {
				removeTempDir(ws);
			}
		});

		it('returns undefined when the user cancels the multi-entry prompt', async () => {
			const ws = createTempDir();
			try {
				const calls = emptyCalls();
				const deps = makeDeps({
					getAppDirectories: () => ['apps/a', 'apps/b']
					// default pickDirectory returns undefined (cancel)
				}, calls);

				const result = await resolveProjectDirectory(ws, deps);

				assert.equal(result, undefined);
				assert.equal(calls.pickInvocations.length, 1);
			} finally {
				removeTempDir(ws);
			}
		});

		it('warns and falls through to detection when all entries are outside the workspace', async () => {
			const ws = createTempDir();
			try {
				writeExecutableCsproj(ws); // root project exists
				const calls = emptyCalls();
				const deps = makeDeps({
					getAppDirectories: () => ['../outside', path.resolve(os.tmpdir(), 'elsewhere')]
				}, calls);

				const result = await resolveProjectDirectory(ws, deps);

				// Falls back to the root-project branch.
				assert.equal(result, ws);
				assert.equal(calls.warnings.length, 1);
				assert.match(calls.warnings[0], /outside the workspace/i);
			} finally {
				removeTempDir(ws);
			}
		});

		it('warns and uses the sole valid entry when some entries are outside the workspace', async () => {
			const ws = createTempDir();
			try {
				const calls = emptyCalls();
				// One in-workspace entry, one outside.
				const deps = makeDeps({
					getAppDirectories: () => ['apps/my-app', '../outside']
				}, calls);

				const result = await resolveProjectDirectory(ws, deps);

				assert.equal(result, path.resolve(ws, 'apps/my-app'));
				// The dropped entry must surface a warning rather than silently retargeting.
				assert.equal(calls.warnings.length, 1);
				assert.match(calls.warnings[0], /1 winapp\.appDirectories entry .*ignored/i);
				// A single valid entry is auto-selected — no prompt.
				assert.equal(calls.pickInvocations.length, 0);
			} finally {
				removeTempDir(ws);
			}
		});

		it('warns and prompts among the remaining valid entries when some are outside', async () => {
			const ws = createTempDir();
			try {
				const calls = emptyCalls();
				const chosen = path.resolve(ws, 'apps/b');
				const deps = makeDeps({
					getAppDirectories: () => ['apps/a', 'apps/b', '../outside'],
					pickDirectory: async (items, placeHolder) => {
						calls.pickInvocations.push({ items, placeHolder });
						return chosen;
					}
				}, calls);

				const result = await resolveProjectDirectory(ws, deps);

				assert.equal(result, chosen);
				assert.equal(calls.warnings.length, 1);
				assert.match(calls.warnings[0], /1 winapp\.appDirectories entry .*ignored/i);
				// Only the two valid entries are offered.
				assert.equal(calls.pickInvocations.length, 1);
				assert.equal(calls.pickInvocations[0].items.length, 2);
			} finally {
				removeTempDir(ws);
			}
		});

		it('rejects a junction inside the workspace that targets a directory outside it', async () => {
			const ws = createTempDir();
			const outside = createTempDir();
			try {
				const link = path.join(ws, 'linked-app');
				try {
					// Windows directory junctions do not require elevation.
					fs.symlinkSync(outside, link, 'junction');
				} catch {
					// Environment cannot create the link — nothing to assert.
					return;
				}

				const calls = emptyCalls();
				const deps = makeDeps({ getAppDirectories: () => ['linked-app'] }, calls);

				const result = await resolveProjectDirectory(ws, deps);

				// The junction escapes the workspace, so it is ignored and we fall
				// through to the scan, which finds nothing → workspace root.
				assert.equal(result, ws);
				assert.equal(calls.warnings.length, 1);
				assert.match(calls.warnings[0], /outside the workspace/i);
			} finally {
				removeTempDir(ws);
				removeTempDir(outside);
			}
		});
	});

	describe('workspace-root project', () => {
		it('uses the workspace root directly when a project exists there', async () => {
			const ws = createTempDir();
			try {
				writeExecutableCsproj(ws);
				const calls = emptyCalls();
				const deps = makeDeps({}, calls);

				const result = await resolveProjectDirectory(ws, deps);

				assert.equal(result, ws);
				// Should not scan when a root project is present.
				assert.equal(calls.scanInvocations.length, 0);
				assert.equal(calls.pickInvocations.length, 0);
			} finally {
				removeTempDir(ws);
			}
		});
	});

	describe('automatic scan', () => {
		it('falls back to the workspace root when no projects are found', async () => {
			const ws = createTempDir(); // empty, no root project
			try {
				const calls = emptyCalls();
				const deps = makeDeps({ scanProjects: async (root) => { calls.scanInvocations.push(root); return []; } }, calls);

				const result = await resolveProjectDirectory(ws, deps);

				assert.equal(result, ws);
				assert.equal(calls.scanInvocations.length, 1);
				assert.equal(calls.pickInvocations.length, 0);
			} finally {
				removeTempDir(ws);
			}
		});

		it('auto-selects the single scanned project without prompting', async () => {
			const ws = createTempDir();
			try {
				const projectDir = path.join(ws, 'src', 'MyApp');
				const calls = emptyCalls();
				const deps = makeDeps({
					scanProjects: async (root) => { calls.scanInvocations.push(root); return [makeProject(projectDir)]; }
				}, calls);

				const result = await resolveProjectDirectory(ws, deps);

				assert.equal(result, projectDir);
				assert.equal(calls.pickInvocations.length, 0);
			} finally {
				removeTempDir(ws);
			}
		});

		it('prompts the user when multiple projects are scanned', async () => {
			const ws = createTempDir();
			try {
				const a = path.join(ws, 'apps', 'a');
				const b = path.join(ws, 'apps', 'b');
				const calls = emptyCalls();
				const deps = makeDeps({
					scanProjects: async () => [makeProject(a, '.NET'), makeProject(b, 'Rust')],
					pickDirectory: async (items, placeHolder) => {
						calls.pickInvocations.push({ items, placeHolder });
						return b;
					}
				}, calls);

				const result = await resolveProjectDirectory(ws, deps);

				assert.equal(result, b);
				assert.equal(calls.pickInvocations.length, 1);
				assert.equal(calls.pickInvocations[0].items.length, 2);
			} finally {
				removeTempDir(ws);
			}
		});

		it('returns undefined when the user cancels the multi-project prompt', async () => {
			const ws = createTempDir();
			try {
				const calls = emptyCalls();
				const deps = makeDeps({
					scanProjects: async () => [
						makeProject(path.join(ws, 'a')),
						makeProject(path.join(ws, 'b'))
					]
					// default pickDirectory returns undefined
				}, calls);

				const result = await resolveProjectDirectory(ws, deps);

				assert.equal(result, undefined);
			} finally {
				removeTempDir(ws);
			}
		});

		it('uses the "search stopped" placeholder when the scan hits the project limit', async () => {
			const ws = createTempDir();
			try {
				const calls = emptyCalls();
				const many = Array.from({ length: 10 }, (_, i) => makeProject(path.join(ws, `p${i}`)));
				const deps = makeDeps({
					scanProjects: async () => many,
					pickDirectory: async (items, placeHolder) => {
						calls.pickInvocations.push({ items, placeHolder });
						return many[0].directory;
					}
				}, calls);

				await resolveProjectDirectory(ws, deps);

				assert.equal(calls.pickInvocations.length, 1);
				assert.match(calls.pickInvocations[0].placeHolder, /Search stopped/i);
			} finally {
				removeTempDir(ws);
			}
		});
	});
});
