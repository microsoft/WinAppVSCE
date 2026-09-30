import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
	classifyRunTargetEntries,
	classifyRunTargetFile,
	dedupeSolutionMembers,
	filterOfferableCandidates,
	filterOfferableProjects,
	findOwningRoot,
	isContainedIn,
	isProjectMode,
	parseSolutionProjectPaths,
	readDirectoryProjectPaths,
	sortRunTargets,
	type RunTargetCandidate,
	type WorkspaceRoot
} from '../run-target';

const rootA: WorkspaceRoot = { name: 'AppA', path: path.resolve('C:/ws/AppA') };
const rootB: WorkspaceRoot = { name: 'AppB', path: path.resolve('C:/ws/AppB') };

function candidate(kind: RunTargetCandidate['kind'], p: string, root = rootA): RunTargetCandidate {
	return { kind, path: path.resolve(p), root };
}

describe('classifyRunTargetFile', () => {
	it('recognizes project files', () => {
		assert.strictEqual(classifyRunTargetFile('C:/ws/MyApp.csproj'), 'project');
	});

	it('recognizes both solution formats', () => {
		assert.strictEqual(classifyRunTargetFile('C:/ws/MyApp.sln'), 'solution');
		assert.strictEqual(classifyRunTargetFile('C:/ws/MyApp.slnx'), 'solution');
	});

	it('is case-insensitive', () => {
		assert.strictEqual(classifyRunTargetFile('C:/ws/MyApp.CSPROJ'), 'project');
		assert.strictEqual(classifyRunTargetFile('C:/ws/MyApp.SLN'), 'solution');
	});

	it('returns undefined for anything else', () => {
		assert.strictEqual(classifyRunTargetFile('C:/ws/bin/Debug/MyApp.exe'), undefined);
		assert.strictEqual(classifyRunTargetFile('C:/ws/bin/Debug'), undefined);
	});
});

describe('classifyRunTargetEntries', () => {
	it('prefers a solution over a project', () => {
		assert.strictEqual(classifyRunTargetEntries(['MyApp.csproj', 'MyApp.sln']), 'solution');
	});

	it('prefers a project over loose executables', () => {
		assert.strictEqual(classifyRunTargetEntries(['MyApp.csproj', 'MyApp.exe']), 'project');
	});

	it('falls back to folder mode for executables only', () => {
		assert.strictEqual(classifyRunTargetEntries(['MyApp.exe', 'MyApp.dll']), 'folder');
	});

	it('reports unknown when nothing is recognizable', () => {
		assert.strictEqual(classifyRunTargetEntries(['readme.md', 'src']), 'unknown');
		assert.strictEqual(classifyRunTargetEntries([]), 'unknown');
	});
});

describe('isProjectMode', () => {
	it('covers projects and solutions only', () => {
		assert.ok(isProjectMode('project'));
		assert.ok(isProjectMode('solution'));
		assert.ok(!isProjectMode('folder'));
		assert.ok(!isProjectMode('unknown'));
	});
});

describe('parseSolutionProjectPaths (.sln)', () => {
	const sln = [
		'Microsoft Visual Studio Solution File, Format Version 12.00',
		'Project("{FAE04EC0-0301-11D1-9B3E-00C04FC6595F}") = "MyApp", "src\\MyApp\\MyApp.csproj", "{11111111-1111-1111-1111-111111111111}"',
		'EndProject',
		'Project("{FAE04EC0-0301-11D1-9B3E-00C04FC6595F}") = "MyApp.Tests", "tests\\MyApp.Tests\\MyApp.Tests.csproj", "{22222222-2222-2222-2222-222222222222}"',
		'EndProject',
		'Project("{2150E333-8FDC-42A3-9474-1A3956D46DE8}") = "Solution Items", "Solution Items", "{33333333-3333-3333-3333-333333333333}"',
		'EndProject'
	].join('\r\n');

	it('extracts project paths', () => {
		const result = parseSolutionProjectPaths(sln, 'C:/ws/MyApp.sln');
		assert.deepStrictEqual(result, ['src\\MyApp\\MyApp.csproj', 'tests\\MyApp.Tests\\MyApp.Tests.csproj']);
	});

	it('excludes solution folders, which share the Project( syntax', () => {
		const result = parseSolutionProjectPaths(sln, 'C:/ws/MyApp.sln');
		assert.ok(!result.some(p => p.includes('Solution Items')));
	});

	it('returns an empty array for content with no projects', () => {
		assert.deepStrictEqual(parseSolutionProjectPaths('Global\r\nEndGlobal', 'C:/ws/MyApp.sln'), []);
	});
});

describe('parseSolutionProjectPaths (.slnx)', () => {
	const slnx = [
		'<Solution>',
		'  <Folder Name="/src/">',
		'    <Project Path="src/MyApp/MyApp.csproj" />',
		'    <Project Path="src/Other/Other.csproj" Type="C#" />',
		'  </Folder>',
		'</Solution>'
	].join('\n');

	it('extracts project paths from XML', () => {
		const result = parseSolutionProjectPaths(slnx, 'C:/ws/MyApp.slnx');
		assert.deepStrictEqual(result, ['src/MyApp/MyApp.csproj', 'src/Other/Other.csproj']);
	});

	it('ignores non-project elements', () => {
		const result = parseSolutionProjectPaths(slnx, 'C:/ws/MyApp.slnx');
		assert.ok(!result.some(p => p.includes('src/')  && p.endsWith('/')));
	});
});

describe('dedupeSolutionMembers', () => {
	it('drops projects already covered by a solution', () => {
		const solution = candidate('solution', 'C:/ws/AppA/MyApp.sln');
		const member = candidate('project', 'C:/ws/AppA/src/MyApp/MyApp.csproj');
		const loose = candidate('project', 'C:/ws/AppA/tools/Tool/Tool.csproj');

		const result = dedupeSolutionMembers(
			[solution, member, loose],
			new Map([[solution.path, [member.path]]])
		);

		assert.deepStrictEqual(result.map(c => c.path), [solution.path, loose.path]);
	});

	it('compares paths case-insensitively and across separators', () => {
		const solution = candidate('solution', 'C:/ws/AppA/MyApp.sln');
		const member = candidate('project', 'C:/ws/AppA/src/MyApp/MyApp.csproj');

		const result = dedupeSolutionMembers(
			[solution, member],
			new Map([[solution.path, [path.resolve('c:/WS/appa/SRC/myapp/MyApp.csproj')]]])
		);

		assert.deepStrictEqual(result.map(c => c.path), [solution.path]);
	});

	it('never drops build output folders', () => {
		const solution = candidate('solution', 'C:/ws/AppA/MyApp.sln');
		const folder = candidate('folder', 'C:/ws/AppA/src/MyApp/bin/Debug');

		const result = dedupeSolutionMembers(
			[solution, folder],
			new Map([[solution.path, [path.resolve('C:/ws/AppA/src/MyApp/bin/Debug')]]])
		);

		assert.strictEqual(result.length, 2);
	});

	it('returns everything when there are no solutions', () => {
		const items = [candidate('project', 'C:/ws/AppA/a.csproj'), candidate('folder', 'C:/ws/AppA/bin')];
		assert.deepStrictEqual(dedupeSolutionMembers(items, new Map()).length, 2);
	});
});

describe('sortRunTargets', () => {
	it('ranks solutions, then projects, then folders', () => {
		const result = sortRunTargets([
			candidate('folder', 'C:/ws/AppA/bin'),
			candidate('project', 'C:/ws/AppA/a.csproj'),
			candidate('solution', 'C:/ws/AppA/a.sln')
		]);
		assert.deepStrictEqual(result.map(c => c.kind), ['solution', 'project', 'folder']);
	});

	it('puts the preferred root first, ahead of kind', () => {
		const result = sortRunTargets(
			[
				candidate('solution', 'C:/ws/AppA/a.sln', rootA),
				candidate('folder', 'C:/ws/AppB/bin', rootB)
			],
			rootB.path
		);
		assert.strictEqual(result[0].root.name, 'AppB');
	});

	it('does not mutate its input', () => {
		const input = [candidate('folder', 'C:/ws/AppA/bin'), candidate('solution', 'C:/ws/AppA/a.sln')];
		sortRunTargets(input);
		assert.strictEqual(input[0].kind, 'folder');
	});
});

describe('findOwningRoot', () => {	it('finds the containing root', () => {
		const result = findOwningRoot([rootA, rootB], path.resolve('C:/ws/AppB/src/Program.cs'));
		assert.strictEqual(result?.name, 'AppB');
	});

	it('prefers the deepest root when they nest', () => {
		const outer: WorkspaceRoot = { name: 'ws', path: path.resolve('C:/ws') };
		const result = findOwningRoot([outer, rootA], path.resolve('C:/ws/AppA/src/Program.cs'));
		assert.strictEqual(result?.name, 'AppA');
	});

	it('returns undefined for files outside every root', () => {
		assert.strictEqual(findOwningRoot([rootA], path.resolve('C:/elsewhere/x.cs')), undefined);
	});

	it('returns undefined when there is no file', () => {
		assert.strictEqual(findOwningRoot([rootA], undefined), undefined);
	});
});

describe('readDirectoryProjectPaths', () => {
	// Awaits the callback before cleaning up. A sync `finally` would delete the
	// directory while an async body was still reading it, and the assertion
	// failure would then surface outside the test rather than failing it.
	async function withTempDir(entries: string[], run: (dir: string) => Promise<void>): Promise<void> {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-target-dir-'));
		try {
			for (const entry of entries) {
				const full = path.join(dir, entry);
				fs.mkdirSync(path.dirname(full), { recursive: true });
				fs.writeFileSync(full, '');
			}
			await run(dir);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}

	it('returns every project at the top level', async () => {
		await withTempDir(['AppOne.csproj', 'AppTwo.csproj', 'readme.md'], async dir => {
			const found = (await readDirectoryProjectPaths(dir)).map(p => path.basename(p));
			assert.deepStrictEqual(found, ['AppOne.csproj', 'AppTwo.csproj']);
		});
	});

	it('ignores projects nested below the top level, matching the CLI', async () => {
		await withTempDir(['AppOne.csproj', path.join('nested', 'Deep.csproj')], async dir => {
			const found = (await readDirectoryProjectPaths(dir)).map(p => path.basename(p));
			assert.deepStrictEqual(found, ['AppOne.csproj']);
		});
	});

	it('returns an empty array for an unreadable directory', async () => {
		const missing = path.join(os.tmpdir(), 'run-target-does-not-exist-12345');
		assert.deepStrictEqual(await readDirectoryProjectPaths(missing), []);
	});
});

describe('isContainedIn', () => {
	it('accepts a project nested under the container', () => {
		assert.strictEqual(isContainedIn('C:/ws', 'C:/ws/src/App.csproj'), true);
	});

	it('accepts the container itself', () => {
		assert.strictEqual(isContainedIn('C:/ws', 'C:/ws'), true);
	});

	// A .sln can legally reference `..\Other\Other.csproj`. Those members are
	// real, but the extension only shows paths relative to the container, so a
	// sibling would render as a confusing `..\..` string.
	it('rejects a sibling directory reached through ..', () => {
		assert.strictEqual(isContainedIn('C:/ws/App', 'C:/ws/Other/Other.csproj'), false);
	});

	it('rejects a path that only shares a name prefix', () => {
		assert.strictEqual(isContainedIn('C:/ws/App', 'C:/ws/AppOther/Other.csproj'), false);
	});
});

describe('filterOfferableProjects', () => {
	async function withProjects(
		files: Record<string, string>,
		run: (dir: string, paths: string[]) => Promise<void>
	): Promise<void> {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerable-'));
		try {
			const paths: string[] = [];
			for (const [name, content] of Object.entries(files)) {
				const full = path.join(dir, name);
				fs.writeFileSync(full, content);
				paths.push(full);
			}
			await run(dir, paths);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}

	const app = '<Project><PropertyGroup><OutputType>WinExe</OutputType></PropertyGroup></Project>';
	const library = '<Project><PropertyGroup><OutputType>Library</OutputType></PropertyGroup></Project>';
	const tests = '<Project><PropertyGroup><IsTestProject>true</IsTestProject></PropertyGroup></Project>';

	it('drops libraries and test projects', async () => {
		await withProjects({ 'App.csproj': app, 'Core.csproj': library, 'Tests.csproj': tests }, async (_dir, paths) => {
			const kept = (await filterOfferableProjects(paths)).map(p => path.basename(p));
			assert.deepStrictEqual(kept, ['App.csproj']);
		});
	});

	// Anything the heuristic is unsure about classifies as `unknown` and
	// survives, so an empty result is the *confident* case: every candidate
	// explicitly declared itself a library or a test project. Returning them
	// anyway would only invite the user to pick one and hit the CLI's "is not
	// a runnable project". Callers route this to a path that can succeed.
	it('returns nothing when every candidate is explicitly unrunnable', async () => {
		await withProjects({ 'Core.csproj': library, 'Tests.csproj': tests }, async (_dir, paths) => {
			assert.deepStrictEqual(await filterOfferableProjects(paths), []);
		});
	});

	// The counterweight to the rule above: an inherited or conditional
	// OutputType must never make a real app disappear.
	it('keeps a project whose OutputType is not stated in the file', async () => {
		const inherited = '<Project><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>';
		await withProjects({ 'Core.csproj': library, 'Mystery.csproj': inherited }, async (_dir, paths) => {
			const kept = (await filterOfferableProjects(paths)).map(p => path.basename(p));
			assert.deepStrictEqual(kept, ['Mystery.csproj']);
		});
	});

	it('keeps an unreadable candidate rather than hiding it', async () => {
		const missing = path.join(os.tmpdir(), 'never-created-offerable', 'Core.csproj');
		assert.deepStrictEqual(await filterOfferableProjects([missing]), [missing]);
	});

	// A lone library gets no exemption. Keeping it would let the picker
	// auto-select it and run straight into the CLI's folder-mode fallback,
	// which reports "Manifest file not found" and never mentions the library.
	it('drops a lone library', async () => {
		await withProjects({ 'Core.csproj': library }, async (_dir, paths) => {
			assert.deepStrictEqual(await filterOfferableProjects(paths), []);
		});
	});

	// A directory holding two apps and a library is the case where the CLI's
	// own ambiguity message is unfiltered: it lists the library as a candidate
	// even though `--project <library>` then fails with "is not a runnable
	// project". Filtering here gives the user a better list than the CLI's.
	it('offers only the apps when a directory holds two apps and a library', async () => {
		await withProjects(
			{ 'Alpha.csproj': app, 'Beta.csproj': app, 'CoreLib.csproj': library },
			async (_dir, paths) => {
				const kept = (await filterOfferableProjects(paths)).map(p => path.basename(p)).sort();
				assert.deepStrictEqual(kept, ['Alpha.csproj', 'Beta.csproj']);
			}
		);
	});
});

describe('filterOfferableCandidates', () => {
	it('never filters solutions or build output folders', async () => {
		const candidates = [
			candidate('solution', 'C:/ws/App.sln'),
			candidate('folder', 'C:/ws/bin/Debug')
		];
		assert.deepStrictEqual(await filterOfferableCandidates(candidates), candidates);
	});

	async function withCandidateDir(
		files: Record<string, string>,
		run: (dir: string) => Promise<void>
	): Promise<void> {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerable-cand-'));
		try {
			for (const [name, content] of Object.entries(files)) {
				fs.writeFileSync(path.join(dir, name), content);
			}
			await run(dir);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}

	const library = '<Project><PropertyGroup><OutputType>Library</OutputType></PropertyGroup></Project>';

	// Folder mode is how `winapp run <build output folder>` works, and it has
	// to stay reachable in a workspace whose only projects are libraries.
	it('keeps a build output folder when every project is dropped', async () => {
		await withCandidateDir({ 'Core.csproj': library }, async dir => {
			const folder = candidate('folder', path.join(dir, 'bin', 'Debug'));
			const result = await filterOfferableCandidates([
				candidate('project', path.join(dir, 'Core.csproj')),
				folder
			]);
			assert.deepStrictEqual(result, [folder]);
		});
	});

	// A lone project is filtered like any other, so a single-library workspace
	// cannot auto-select that library.
	it('drops a lone library project', async () => {
		await withCandidateDir({ 'Core.csproj': library }, async dir => {
			const result = await filterOfferableCandidates([
				candidate('project', path.join(dir, 'Core.csproj'))
			]);
			assert.deepStrictEqual(result, []);
		});
	});
});
