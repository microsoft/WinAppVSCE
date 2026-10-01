import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
	DEBUGGER_CHOICE_LABELS,
	chooseInstalledDebuggerType,
	getDebuggerExtensionRequirement,
	getDebuggerTypeFromChoice,
	validateRunInput
} from '../debugger-resolver';

describe('debugger resolver helpers', () => {
	describe('getDebuggerExtensionRequirement', () => {
		it('returns the extension requirement for known extension-backed debugger types', () => {
			assert.deepEqual(getDebuggerExtensionRequirement('coreclr'), {
				id: 'ms-dotnettools.csharp',
				name: 'C# (ms-dotnettools.csharp)'
			});
			assert.deepEqual(getDebuggerExtensionRequirement('cppvsdbg'), {
				id: 'ms-vscode.cpptools',
				name: 'C/C++ (ms-vscode.cpptools)'
			});
		});

		it('returns undefined for debugger types with no extension requirement or unknown types', () => {
			assert.equal(getDebuggerExtensionRequirement('node'), undefined);
			assert.equal(getDebuggerExtensionRequirement('unknown'), undefined);
		});
	});

	describe('chooseInstalledDebuggerType', () => {
		it('reuses coreclr first when both supported debugger extensions are installed', () => {
			const result = chooseInstalledDebuggerType([
				'ms-vscode.cpptools',
				'ms-dotnettools.csharp'
			]);

			assert.equal(result, 'coreclr');
		});

		it('reuses cppvsdbg when only the C/C++ extension is installed', () => {
			assert.equal(chooseInstalledDebuggerType(['ms-vscode.cpptools']), 'cppvsdbg');
		});

		it('matches installed extension IDs case-insensitively', () => {
			assert.equal(chooseInstalledDebuggerType(['MS-DOTNETTOOLS.CSHARP']), 'coreclr');
		});

		it('returns undefined when no supported debugger extension is installed', () => {
			assert.equal(chooseInstalledDebuggerType(['publisher.other-extension']), undefined);
			assert.equal(chooseInstalledDebuggerType([]), undefined);
		});
	});

	describe('getDebuggerTypeFromChoice', () => {
		it('maps install choices to debugger types', () => {
			assert.equal(getDebuggerTypeFromChoice(DEBUGGER_CHOICE_LABELS.installCsharp), 'coreclr');
			assert.equal(getDebuggerTypeFromChoice(DEBUGGER_CHOICE_LABELS.installCpp), 'cppvsdbg');
		});

		it('maps the Node/Electron built-in choice without requiring installation', () => {
			assert.equal(getDebuggerTypeFromChoice(DEBUGGER_CHOICE_LABELS.useNode), 'node');
		});

		it('returns undefined when the modal is cancelled or returns an unknown label', () => {
			assert.equal(getDebuggerTypeFromChoice(undefined), undefined);
			assert.equal(getDebuggerTypeFromChoice('Cancel'), undefined);
		});
	});
});

describe('validateRunInput (folder mode)', () => {
	let tmpDir: string;
	let validDir: string;
	let emptyDir: string;
	let aFile: string;

	before(async () => {
		tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'inputfolder-test-'));
		validDir = path.join(tmpDir, 'with-exe');
		emptyDir = path.join(tmpDir, 'no-exe');
		await fs.promises.mkdir(validDir);
		await fs.promises.mkdir(emptyDir);
		await fs.promises.writeFile(path.join(validDir, 'MyApp.exe'), '');
		aFile = path.join(tmpDir, 'not-a-dir.txt');
		await fs.promises.writeFile(aFile, 'hello');
	});

	after(async () => {
		await fs.promises.rm(tmpDir, { recursive: true, force: true });
	});

	it('returns valid for a directory containing an .exe file', async () => {
		const result = await validateRunInput(validDir, tmpDir, 'folder');
		assert.equal(result.valid, true);
	});

	it('returns not-found when the path does not exist', async () => {
		const result = await validateRunInput('C:\\does\\not\\exist', tmpDir, 'folder');
		assert.equal(result.valid, false);
		if (!result.valid) {
			assert.equal(result.reason, 'not-found');
			assert.equal(
				result.message,
				'The configured "input" path does not exist: C:\\does\\not\\exist. '
					+ 'Build your project first, or update "input" in launch.json to point to your build output directory.'
			);
		}
	});

	it('returns not-directory when the path is a file', async () => {
		const result = await validateRunInput(aFile, tmpDir, 'folder');
		assert.equal(result.valid, false);
		if (!result.valid) {
			assert.equal(result.reason, 'not-directory');
			assert.equal(
				result.message,
				`The configured "input" is not a directory or a project file: ${aFile}. `
					+ 'Update "input" in launch.json to point to a project, a solution, or the folder containing your built application.'
			);
		}
	});

	it('returns no-exe when the directory has no .exe files', async () => {
		const result = await validateRunInput(emptyDir, tmpDir, 'folder');
		assert.equal(result.valid, false);
		if (!result.valid) {
			assert.equal(result.reason, 'no-exe');
			assert.equal(
				result.message,
				`The configured "input" does not contain any .exe files: ${emptyDir}. `
					+ 'Build your project first, or update "input" in launch.json to point to a project file or the folder containing your built application.'
			);
		}
	});

	// 'unknown' — not 'folder' — is the kind that reaches the no-exe branch in
	// production: classifyRunTarget only returns 'folder' for a directory that
	// already contains an .exe, so a real no-exe directory arrives as 'unknown'.
	it('returns no-exe for an unknown-kind directory with no .exe files', async () => {
		const result = await validateRunInput(emptyDir, tmpDir, 'unknown');
		assert.equal(result.valid, false);
		if (!result.valid) {
			assert.equal(result.reason, 'no-exe');
			assert.ok(result.message.includes('does not contain any .exe files'));
		}
	});

	it('accepts an unknown-kind directory that does contain an .exe', async () => {
		const result = await validateRunInput(validDir, tmpDir, 'unknown');
		assert.equal(result.valid, true);
	});

	it('returns not-found for an unknown-kind path that does not exist', async () => {
		const result = await validateRunInput('nonexistent-subdir', tmpDir, 'unknown');
		assert.equal(result.valid, false);
		if (!result.valid) {
			assert.equal(result.reason, 'not-found');
		}
	});

	it('resolves relative paths against the provided cwd', async () => {
		const result = await validateRunInput('with-exe', tmpDir, 'folder');
		assert.equal(result.valid, true);
	});

	it('rejects relative paths that do not exist against the cwd', async () => {
		const result = await validateRunInput('nonexistent-subdir', tmpDir, 'folder');
		assert.equal(result.valid, false);
		if (!result.valid) {
			assert.equal(result.reason, 'not-found');
		}
	});

	it('uses the legacy property name in messages when asked', async () => {
		const result = await validateRunInput('nonexistent-subdir', tmpDir, 'folder', 'inputFolder');
		assert.equal(result.valid, false);
		if (!result.valid) {
			assert.ok(result.message.includes('"inputFolder"'));
			assert.ok(!result.message.includes('"input"'));
		}
	});
});

describe('validateRunInput (project mode)', () => {
	let tmpDir: string;
	let projectFile: string;
	let solutionFile: string;
	let projectDir: string;

	before(async () => {
		tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'runinput-project-test-'));
		projectDir = path.join(tmpDir, 'MyApp');
		await fs.promises.mkdir(projectDir);
		projectFile = path.join(projectDir, 'MyApp.csproj');
		solutionFile = path.join(tmpDir, 'MyApp.sln');
		await fs.promises.writeFile(projectFile, '<Project />');
		await fs.promises.writeFile(solutionFile, '');
	});

	after(async () => {
		await fs.promises.rm(tmpDir, { recursive: true, force: true });
	});

	// The whole point of project mode is that build output does not exist yet,
	// so the folder-mode .exe requirement must not be applied.
	it('accepts a project file with no build output', async () => {
		const result = await validateRunInput(projectFile, tmpDir, 'project');
		assert.equal(result.valid, true);
	});

	it('accepts a solution file', async () => {
		const result = await validateRunInput(solutionFile, tmpDir, 'solution');
		assert.equal(result.valid, true);
	});

	it('accepts a directory containing a project', async () => {
		const result = await validateRunInput(projectDir, tmpDir, 'project');
		assert.equal(result.valid, true);
	});

	it('resolves relative project paths against the provided cwd', async () => {
		const result = await validateRunInput('MyApp\\MyApp.csproj', tmpDir, 'project');
		assert.equal(result.valid, true);
	});

	it('rejects a project that does not exist', async () => {
		const result = await validateRunInput('Missing\\Missing.csproj', tmpDir, 'project');
		assert.equal(result.valid, false);
		if (!result.valid) {
			assert.equal(result.reason, 'not-found');
			assert.ok(result.message.includes('project does not exist'));
		}
	});

	it('names the solution in the error when a solution is missing', async () => {
		const result = await validateRunInput('Missing.sln', tmpDir, 'solution');
		assert.equal(result.valid, false);
		if (!result.valid) {
			assert.ok(result.message.includes('solution does not exist'));
		}
	});
});
