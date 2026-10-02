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
	readSolutionProjectPaths,
	readTargetProjects,
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

	// `.slnx` is XML, and these three shapes are all legal in it. The previous
	// double-quote-only pattern missed the first two and invented the third.
	it('reads a single-quoted Path attribute', () => {
		const content = "<Solution><Project Path='src/MyApp/MyApp.csproj' /></Solution>";
		assert.deepStrictEqual(
			parseSolutionProjectPaths(content, 'C:/ws/MyApp.slnx'),
			['src/MyApp/MyApp.csproj']
		);
	});

	it('decodes escaped entities in a path', () => {
		const content = '<Solution><Project Path="src/A&amp;B/A&amp;B.csproj" /></Solution>';
		assert.deepStrictEqual(
			parseSolutionProjectPaths(content, 'C:/ws/MyApp.slnx'),
			['src/A&B/A&B.csproj']
		);
	});

	it('ignores a commented-out member', () => {
		const content = [
			'<Solution>',
			'  <Project Path="src/MyApp/MyApp.csproj" />',
			'  <!-- <Project Path="src/Removed/Removed.csproj" /> -->',
			'</Solution>'
		].join('\n');
		assert.deepStrictEqual(
			parseSolutionProjectPaths(content, 'C:/ws/MyApp.slnx'),
			['src/MyApp/MyApp.csproj']
		);
	});

	it('returns nothing for malformed XML instead of guessing', () => {
		const content = '<Solution><Project Path="src/MyApp/MyApp.csproj"';
		assert.deepStrictEqual(parseSolutionProjectPaths(content, 'C:/ws/MyApp.slnx'), []);
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

describe('readSolutionProjectPaths containment', () => {
	function writeSolution(dir: string, members: string[]): string {
		const body = members
			.map((member, index) =>
				`Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "P${index}", ` +
				`"${member}", "{00000000-0000-0000-0000-00000000000${index}}"\r\nEndProject`)
			.join('\r\n');
		const solutionPath = path.join(dir, 'App.sln');
		fs.writeFileSync(solutionPath, body);
		return solutionPath;
	}

	it('keeps a member that really lives inside the solution directory', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sln-contain-'));
		try {
			fs.mkdirSync(path.join(dir, 'App'));
			fs.writeFileSync(path.join(dir, 'App', 'App.csproj'), '<Project />');
			const solutionPath = writeSolution(dir, ['App\\App.csproj']);
			const result = await readSolutionProjectPaths(solutionPath);
			assert.deepStrictEqual(result, [path.join(dir, 'App', 'App.csproj')]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('drops a member reached through .. traversal', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sln-traverse-'));
		try {
			const solutionPath = writeSolution(dir, ['..\\Outside\\Outside.csproj']);
			assert.deepStrictEqual(await readSolutionProjectPaths(solutionPath), []);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	// The lexical check alone passes this: "link\Outside.csproj" contains no
	// `..`, so nothing in the string reveals that `link` redirects out of the
	// solution directory. Only resolving the reparse point catches it.
	it('drops a member whose path crosses a junction out of the solution directory', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sln-junction-'));
		const solutionDir = path.join(root, 'sln');
		const outside = path.join(root, 'outside');
		fs.mkdirSync(solutionDir);
		fs.mkdirSync(outside);
		fs.writeFileSync(path.join(outside, 'Outside.csproj'), '<Project />');

		const link = path.join(solutionDir, 'link');
		try {
			fs.symlinkSync(outside, link, 'junction');
		} catch {
			// Junction creation can be unavailable; the lexical cases above
			// still cover the rule, so skip rather than fail the suite.
			fs.rmSync(root, { recursive: true, force: true });
			return;
		}

		try {
			const solutionPath = writeSolution(solutionDir, ['link\\Outside.csproj']);
			assert.deepStrictEqual(await readSolutionProjectPaths(solutionPath), []);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
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

	// An empty result is the confident case: every candidate explicitly
	// declared itself a library or test project.
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

	// Filter directory candidates because the CLI's ambiguity list includes
	// libraries that `--project <library>` cannot run.
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

/** Directory targets reach this path only through Browse…, not .sln selection. */
describe('readTargetProjects for a directory', () => {
	async function withLayout(
		files: Record<string, string>,
		run: (dir: string) => Promise<void>
	): Promise<void> {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'target-projects-'));
		try {
			for (const [name, contents] of Object.entries(files)) {
				const full = path.join(dir, name);
				fs.mkdirSync(path.dirname(full), { recursive: true });
				fs.writeFileSync(full, contents);
			}
			await run(dir);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}

	function slnx(...members: string[]): string {
		const entries = members.map(m => `  <Project Path="${m}" />`).join('\n');
		return `<Solution>\n${entries}\n</Solution>\n`;
	}

	const app = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>WinExe</OutputType></PropertyGroup></Project>';

	it('reads the members of a solution one level down', async () => {
		await withLayout(
			{
				'All.slnx': slnx('src/AppOne/AppOne.csproj', 'src/AppTwo/AppTwo.csproj'),
				'src/AppOne/AppOne.csproj': app,
				'src/AppTwo/AppTwo.csproj': app
			},
			async dir => {
				const result = await readTargetProjects({
					kind: 'solution',
					path: dir,
					root: { name: 'ws', path: dir }
				});
				assert.deepStrictEqual(
					result.projects.map(p => path.basename(p)).sort(),
					['AppOne.csproj', 'AppTwo.csproj']
				);
				assert.strictEqual(result.containerPath, dir);
			}
		);
	});

	// winapp 0.7.0 handed a directory holding both reports on the solution.
	it('prefers the solution over a sibling top-level project', async () => {
		await withLayout(
			{
				'All.slnx': slnx('src/AppOne/AppOne.csproj', 'src/AppTwo/AppTwo.csproj'),
				'src/AppOne/AppOne.csproj': app,
				'src/AppTwo/AppTwo.csproj': app,
				'Top.csproj': app
			},
			async dir => {
				const result = await readTargetProjects({
					kind: 'solution',
					path: dir,
					root: { name: 'ws', path: dir }
				});
				assert.deepStrictEqual(
					result.projects.map(p => path.basename(p)).sort(),
					['AppOne.csproj', 'AppTwo.csproj']
				);
			}
		);
	});

	// Which of several solutions wins is the CLI's call, and it names the
	// ambiguity precisely. Prompting here would mean guessing first.
	it('offers nothing when the directory holds more than one solution', async () => {
		await withLayout(
			{
				'One.slnx': slnx('src/AppOne/AppOne.csproj'),
				'Two.slnx': slnx('src/AppTwo/AppTwo.csproj'),
				'src/AppOne/AppOne.csproj': app,
				'src/AppTwo/AppTwo.csproj': app
			},
			async dir => {
				const result = await readTargetProjects({
					kind: 'solution',
					path: dir,
					root: { name: 'ws', path: dir }
				});
				assert.deepStrictEqual(result.projects, []);
			}
		);
	});

	it('falls back to top-level projects when there is no solution', async () => {
		await withLayout({ 'AppOne.csproj': app, 'AppTwo.csproj': app }, async dir => {
			const result = await readTargetProjects({
				kind: 'project',
				path: dir,
				root: { name: 'ws', path: dir }
			});
			assert.deepStrictEqual(
				result.projects.map(p => path.basename(p)).sort(),
				['AppOne.csproj', 'AppTwo.csproj']
			);
		});
	});

	// A folder target is not project mode at all, so nothing is read.
	it('offers nothing for a folder target', async () => {
		await withLayout({ 'App.exe': '' }, async dir => {
			const result = await readTargetProjects({
				kind: 'folder',
				path: dir,
				root: { name: 'ws', path: dir }
			});
			assert.deepStrictEqual(result.projects, []);
		});
	});
});