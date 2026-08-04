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
	validateInputFolder
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

describe('validateInputFolder', () => {
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
		const result = await validateInputFolder(validDir, tmpDir);
		assert.equal(result.valid, true);
	});

	it('returns not-found when the path does not exist', async () => {
		const result = await validateInputFolder('C:\\does\\not\\exist', tmpDir);
		assert.equal(result.valid, false);
		if (!result.valid) {
			assert.equal(result.reason, 'not-found');
			assert.equal(
				result.message,
				'The configured "inputFolder" path does not exist: C:\\does\\not\\exist. '
					+ 'Build your project first, or update "inputFolder" in the debug configuration to point to your build output directory.'
			);
		}
	});

	it('returns not-directory when the path is a file', async () => {
		const result = await validateInputFolder(aFile, tmpDir);
		assert.equal(result.valid, false);
		if (!result.valid) {
			assert.equal(result.reason, 'not-directory');
			assert.equal(
				result.message,
				`The configured "inputFolder" is not a directory: ${aFile}. `
					+ 'Update "inputFolder" in the debug configuration to point to the folder containing your built application.'
			);
		}
	});

	it('returns no-exe when the directory has no .exe files', async () => {
		const result = await validateInputFolder(emptyDir, tmpDir);
		assert.equal(result.valid, false);
		if (!result.valid) {
			assert.equal(result.reason, 'no-exe');
			assert.equal(
				result.message,
				`The configured "inputFolder" does not contain any .exe files: ${emptyDir}. `
					+ 'Build your project first, or update "inputFolder" in the debug configuration to point to the folder containing your built application.'
			);
		}
	});

	it('resolves relative paths against the provided cwd', async () => {
		const result = await validateInputFolder('with-exe', tmpDir);
		assert.equal(result.valid, true);
	});

	it('rejects relative paths that do not exist against the cwd', async () => {
		const result = await validateInputFolder('nonexistent-subdir', tmpDir);
		assert.equal(result.valid, false);
		if (!result.valid) {
			assert.equal(result.reason, 'not-found');
		}
	});
});
