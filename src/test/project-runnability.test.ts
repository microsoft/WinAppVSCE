import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
	ALWAYS_SKIP_DIRS,
	BUILD_OUTPUT_SKIP_DIRS,
	classifyProjectRunnability,
	isOfferableProject,
	PROJECT_SCAN_SKIP_DIRS,
	readProjectRunnability
} from '../project-detection';

function csproj(body: string): string {
	return `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>${body}</PropertyGroup></Project>`;
}

describe('classifyProjectRunnability', () => {
	it('classifies WinExe and Exe as runnable apps', () => {
		assert.strictEqual(classifyProjectRunnability(csproj('<OutputType>WinExe</OutputType>')), 'app');
		assert.strictEqual(classifyProjectRunnability(csproj('<OutputType>Exe</OutputType>')), 'app');
	});

	it('is case and whitespace insensitive', () => {
		assert.strictEqual(classifyProjectRunnability(csproj('<outputtype>  winexe  </outputtype>')), 'app');
	});

	it('classifies an explicit Library output as a library', () => {
		assert.strictEqual(classifyProjectRunnability(csproj('<OutputType>Library</OutputType>')), 'library');
	});

	it('classifies IsTestProject as a test project', () => {
		assert.strictEqual(classifyProjectRunnability(csproj('<IsTestProject>true</IsTestProject>')), 'test');
	});

	it('classifies a Microsoft.NET.Test.Sdk reference as a test project even without IsTestProject', () => {
		const content = '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>'
			+ '<PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />'
			+ '</ItemGroup></Project>';
		assert.strictEqual(classifyProjectRunnability(content), 'test');
	});

	it('treats a test project as a test project even when it declares an executable output', () => {
		const content = csproj('<OutputType>Exe</OutputType><IsTestProject>true</IsTestProject>');
		assert.strictEqual(classifyProjectRunnability(content), 'test');
	});

	// The CLI resolves OutputType through full MSBuild evaluation, so it can
	// come from an SDK default or Directory.Build.props. Guessing 'library'
	// here would hide real apps from the picker.
	it('reports unknown when OutputType is absent rather than assuming a library', () => {
		assert.strictEqual(classifyProjectRunnability(csproj('<TargetFramework>net8.0</TargetFramework>')), 'unknown');
	});

	it('reports unknown for an unrecognised OutputType', () => {
		assert.strictEqual(classifyProjectRunnability(csproj('<OutputType>Module</OutputType>')), 'unknown');
	});

	// Each of these passed the old regex scan, which could not tell markup
	// from text. The first two hid a runnable project; the third invented a
	// classification the project file never actually declared.
	it('ignores a commented-out Library output', () => {
		const content = csproj('<!-- <OutputType>Library</OutputType> --><TargetFramework>net8.0</TargetFramework>');
		assert.strictEqual(classifyProjectRunnability(content), 'unknown');
	});

	it('ignores a commented-out IsTestProject marker', () => {
		const content = csproj('<!-- <IsTestProject>true</IsTestProject> -->');
		assert.strictEqual(classifyProjectRunnability(content), 'unknown');
	});

	it('ignores an OutputType mentioned only in documentation text', () => {
		const content = csproj('<PropertyGroup><Description>Set &lt;OutputType&gt;Library&lt;/OutputType&gt; to build a DLL.</Description></PropertyGroup>');
		assert.strictEqual(classifyProjectRunnability(content), 'unknown');
	});

	// A conditioned OutputType is the "cannot tell without MSBuild" case, so
	// it must stay visible rather than being read as unconditional.
	it('does not read a conditioned OutputType as the effective value', () => {
		const content = csproj('<OutputType Condition="\'$(Configuration)\'==\'Debug\'">Library</OutputType>');
		assert.strictEqual(classifyProjectRunnability(content), 'unknown');
	});

	it('accepts a single-quoted Include on the test SDK reference', () => {
		const content = "<Project Sdk='Microsoft.NET.Sdk'><ItemGroup>"
			+ "<PackageReference Include='Microsoft.NET.Test.Sdk' Version='17.11.1' />"
			+ '</ItemGroup></Project>';
		assert.strictEqual(classifyProjectRunnability(content), 'test');
	});

	it('reports unknown for malformed XML rather than hiding the project', () => {
		assert.strictEqual(classifyProjectRunnability('<Project><OutputType>Library'), 'unknown');
	});
});

describe('isOfferableProject', () => {
	it('offers apps and unknowns', () => {
		assert.strictEqual(isOfferableProject('app'), true);
		assert.strictEqual(isOfferableProject('unknown'), true);
	});

	it('hides libraries and test projects', () => {
		assert.strictEqual(isOfferableProject('library'), false);
		assert.strictEqual(isOfferableProject('test'), false);
	});
});

describe('readProjectRunnability', () => {
	it('classifies a project file on disk', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runnability-'));
		try {
			const file = path.join(dir, 'App.csproj');
			fs.writeFileSync(file, csproj('<OutputType>WinExe</OutputType>'));
			assert.strictEqual(await readProjectRunnability(file), 'app');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('reports unknown for an unreadable path so discovery keeps the candidate', async () => {
		const missing = path.join(os.tmpdir(), 'does-not-exist-runnability', 'App.csproj');
		assert.strictEqual(await readProjectRunnability(missing), 'unknown');
	});
});

describe('skip directory lists', () => {
	it('shares the always-skip base with every scan', () => {
		for (const dir of ALWAYS_SKIP_DIRS) {
			assert.ok(BUILD_OUTPUT_SKIP_DIRS.has(dir), `${dir} missing from build output skips`);
		}
	});

	// Build output lives in bin/ and, for .NET 8+, artifacts/ — excluding them
	// would make build-output discovery find nothing.
	it('does not exclude build output directories from build output discovery', () => {
		const always: readonly string[] = ALWAYS_SKIP_DIRS;
		for (const dir of ['bin', 'artifacts', 'Debug', 'Release']) {
			assert.ok(!always.includes(dir), `${dir} must not be always-skipped`);
		}
	});

	// Apps with no project file reach folder mode only through the .exe scan,
	// and Electron/Rust put their output in exactly the directories that
	// .csproj discovery treats as build copies. The two lists must disagree
	// here, so assert both halves rather than just one.
	it('scans project-less output directories that project discovery skips', () => {
		for (const dir of ['dist', 'out', 'build', 'target']) {
			assert.ok(!BUILD_OUTPUT_SKIP_DIRS.has(dir), `${dir} must be scanned for executables`);
			assert.ok(PROJECT_SCAN_SKIP_DIRS.has(dir), `${dir} must be skipped when finding project files`);
		}
	});

	// Every Electron workspace vendors an electron.exe here. Scanning it would
	// bury the real app under framework binaries.
	it('never scans node_modules for executables', () => {
		assert.ok(BUILD_OUTPUT_SKIP_DIRS.has('node_modules'));
	});
});
