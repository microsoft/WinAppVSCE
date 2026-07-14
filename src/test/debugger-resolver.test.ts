import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	DEBUGGER_CHOICE_LABELS,
	chooseInstalledDebuggerType,
	getDebuggerExtensionRequirement,
	getDebuggerTypeFromChoice,
	inferDebuggerTypeFromProject
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

	describe('inferDebuggerTypeFromProject', () => {
		it('infers coreclr for pure .NET project files', () => {
			assert.equal(inferDebuggerTypeFromProject(['src/App.csproj']), 'coreclr');
			assert.equal(inferDebuggerTypeFromProject(['src/Library.fsproj']), 'coreclr');
		});

		it('infers cppvsdbg for pure C++ project files', () => {
			assert.equal(inferDebuggerTypeFromProject(['native/App.vcxproj']), 'cppvsdbg');
		});

		it('infers node for package.json or Electron-style Node projects without native signals', () => {
			assert.equal(inferDebuggerTypeFromProject(['package.json']), 'node');
			assert.equal(inferDebuggerTypeFromProject(['apps/electron/package.json']), 'node');
		});

		it('returns undefined for mixed or ambiguous project families', () => {
			assert.equal(inferDebuggerTypeFromProject(['App.csproj', 'package.json']), undefined);
			assert.equal(inferDebuggerTypeFromProject(['App.csproj', 'Native.vcxproj']), undefined);
			// C++ plus package.json is ambiguous: it could be a native app with JS tooling.
			assert.equal(inferDebuggerTypeFromProject(['Native.vcxproj', 'package.json']), undefined);
			assert.equal(inferDebuggerTypeFromProject(['package.json', 'Cargo.toml']), undefined);
			assert.equal(inferDebuggerTypeFromProject(['src-tauri/tauri.conf.json', 'package.json']), undefined);
			assert.equal(inferDebuggerTypeFromProject(['CMakeLists.txt', 'package.json']), undefined);
		});

		it('returns undefined for empty or unknown file listings', () => {
			assert.equal(inferDebuggerTypeFromProject([]), undefined);
			assert.equal(inferDebuggerTypeFromProject(['README.md', 'src/app.ts']), undefined);
		});
	});
});
