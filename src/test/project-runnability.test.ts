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

	// `ClassifyRunnableStatic` in the CLI requires Exe/WinExe, so a project
	// whose OutputType is absent is not something the CLI will run from a
	// directory scan either. Calling it `unknown` here put `dotnet new
	// classlib` in the picker — and auto-ran it when it was the only
	// candidate. Browse still reaches a project that gets its OutputType from
	// an import.
	it('reports library when no OutputType is declared at all', () => {
		assert.strictEqual(classifyProjectRunnability(csproj('<TargetFramework>net8.0</TargetFramework>')), 'library');
	});

	it('reports unknown for an unrecognised OutputType', () => {
		assert.strictEqual(classifyProjectRunnability(csproj('<OutputType>Module</OutputType>')), 'unknown');
	});

	// Each of these passed the old regex scan, which could not tell markup
	// from text. Every fixture declares a real Exe output, so reading the
	// commented-out or prose markup would flip the result away from 'app'.
	it('ignores a commented-out Library output', () => {
		const content = csproj('<OutputType>Exe</OutputType><!-- <OutputType>Library</OutputType> -->');
		assert.strictEqual(classifyProjectRunnability(content), 'app');
	});

	it('ignores a commented-out IsTestProject marker', () => {
		const content = csproj('<OutputType>Exe</OutputType><!-- <IsTestProject>true</IsTestProject> -->');
		assert.strictEqual(classifyProjectRunnability(content), 'app');
	});

	it('ignores an OutputType mentioned only in documentation text', () => {
		const content = csproj('<OutputType>Exe</OutputType><Description>Set &lt;OutputType&gt;Library&lt;/OutputType&gt; to build a DLL.</Description>');
		assert.strictEqual(classifyProjectRunnability(content), 'app');
	});

	// A conditioned OutputType is the "cannot tell without MSBuild" case, so
	// it must stay visible rather than being read as unconditional. It is also
	// why an absent OutputType and an inactive one are not the same thing.
	it('does not read a conditioned OutputType as the effective value', () => {
		const content = csproj('<OutputType Condition="\'$(Configuration)\'==\'Debug\'">Library</OutputType>');
		assert.strictEqual(classifyProjectRunnability(content), 'unknown');
	});

	it('takes the last unconditional OutputType, as MSBuild does', () => {
		const content = '<Project Sdk="Microsoft.NET.Sdk">'
			+ '<PropertyGroup><OutputType>Library</OutputType></PropertyGroup>'
			+ '<PropertyGroup><OutputType>WinExe</OutputType></PropertyGroup>'
			+ '</Project>';
		assert.strictEqual(classifyProjectRunnability(content), 'app');
	});

	it('classifies the MSTest project SDK as a test project', () => {
		// `dotnet new mstest` emits this and no package references at all.
		assert.strictEqual(classifyProjectRunnability('<Project Sdk="MSTest.Sdk/3.6.4"></Project>'), 'test');
	});

	it('classifies the TestContainer project capability as a test project', () => {
		const content = '<Project Sdk="Microsoft.NET.Sdk">'
			+ '<PropertyGroup><OutputType>WinExe</OutputType></PropertyGroup>'
			+ '<ItemGroup><ProjectCapability Include="TestContainer" /></ItemGroup>'
			+ '</Project>';
		assert.strictEqual(classifyProjectRunnability(content), 'test');
	});

	it('classifies xunit, nunit and mstest package references as test projects', () => {
		for (const id of ['xunit.v3', 'NUnit', 'MSTest.TestFramework', 'Microsoft.TestPlatform.TestHost']) {
			const content = '<Project Sdk="Microsoft.NET.Sdk">'
				+ '<PropertyGroup><OutputType>Exe</OutputType></PropertyGroup>'
				+ `<ItemGroup><PackageReference Include="${id}" Version="1.0.0" /></ItemGroup>`
				+ '</Project>';
			assert.strictEqual(classifyProjectRunnability(content), 'test', id);
		}
	});

	it('ignores a conditioned test package reference', () => {
		// Only MSBuild knows whether the condition is active, and assuming it
		// is would drop a real app from the picker.
		const content = '<Project Sdk="Microsoft.NET.Sdk">'
			+ '<PropertyGroup><OutputType>WinExe</OutputType></PropertyGroup>'
			+ '<ItemGroup Condition="\'$(Configuration)\'==\'Debug\'">'
			+ '<PackageReference Include="xunit" Version="2.9.0" /></ItemGroup>'
			+ '</Project>';
		assert.strictEqual(classifyProjectRunnability(content), 'app');
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
