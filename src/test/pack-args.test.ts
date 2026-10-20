import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	buildPackArgs,
	getPackContainmentRoots,
	isBundleInput,
	isBundleSelection,
	packProgressTitle,
	mergeFolderSelections,
	resolveFolderSelection,
	shouldCheckSelfContainedArch,
	type PackInput
} from '../pack-args';

const BROWSE_DETAIL = 'Open a folder picker';
const folderInput = (folders: string[]): PackInput => ({
	kind: 'folders',
	folders,
	workspaceRoot: 'C:\\workspace'
});
const projectInput = (
	architectures: ['x64' | 'arm64' | 'x86', ...('x64' | 'arm64' | 'x86')[]] = ['x64']
): PackInput => ({
	kind: 'project',
	projectFile: 'C:\\workspace\\App\\App.csproj',
	workspaceRoot: 'C:\\workspace',
	architectures
});

describe('isBundleSelection', () => {
	it('treats a single folder as a single package', () => {
		assert.equal(isBundleSelection(['C:\\publish\\x64']), false);
	});

	it('treats two or more folders as a bundle', () => {
		assert.equal(isBundleSelection(['C:\\publish\\x64', 'C:\\publish\\arm64']), true);
		assert.equal(
			isBundleSelection(['C:\\publish\\x64', 'C:\\publish\\arm64', 'C:\\publish\\x86']),
			true
		);
	});

	it('treats an empty selection as not a bundle', () => {
		assert.equal(isBundleSelection([]), false);
	});
});

describe('resolveFolderSelection', () => {
	it('returns none when the QuickPick was dismissed', () => {
		assert.deepEqual(resolveFolderSelection(undefined, BROWSE_DETAIL), { kind: 'none' });
	});

	it('returns none for an empty selection', () => {
		assert.deepEqual(resolveFolderSelection([], BROWSE_DETAIL), { kind: 'none' });
	});

	it('returns the ticked folders in order', () => {
		assert.deepEqual(
			resolveFolderSelection(
				[
					{ detail: 'C:\\publish\\x64', directory: 'C:\\publish\\x64' },
					{ detail: 'C:\\publish\\arm64', directory: 'C:\\publish\\arm64' }
				],
				BROWSE_DETAIL
			),
			{ kind: 'folders', folders: ['C:\\publish\\x64', 'C:\\publish\\arm64'] }
		);
	});

	it('returns browse when only the Browse… row is ticked', () => {
		assert.deepEqual(
			resolveFolderSelection([{ detail: BROWSE_DETAIL }], BROWSE_DETAIL),
			{ kind: 'browse', folders: [] }
		);
	});

	it('preserves checked folders when Browse… is also ticked', () => {
		assert.deepEqual(
			resolveFolderSelection(
				[
					{ detail: 'C:\\publish\\x64', directory: 'C:\\publish\\x64' },
					{ detail: BROWSE_DETAIL }
				],
				BROWSE_DETAIL
			),
			{ kind: 'browse', folders: ['C:\\publish\\x64'] }
		);
	});

	it('returns none when ticked items carry no directory', () => {
		assert.deepEqual(
			resolveFolderSelection([{ detail: 'something else' }], BROWSE_DETAIL),
			{ kind: 'none' }
		);
	});
});

describe('mergeFolderSelections', () => {
	it('appends browsed folders to discovered folders', () => {
		assert.deepEqual(
			mergeFolderSelections(
				['C:\\publish\\x64'],
				['C:\\publish\\arm64']
			),
			['C:\\publish\\x64', 'C:\\publish\\arm64']
		);
	});

	it('removes duplicate folders case-insensitively', () => {
		assert.deepEqual(
			mergeFolderSelections(
				['C:\\publish\\x64'],
				['c:\\PUBLISH\\x64', 'C:\\publish\\arm64']
			),
			['C:\\publish\\x64', 'C:\\publish\\arm64']
		);
	});
});

describe('buildPackArgs', () => {
	it('packs a single folder with no flags', () => {
		assert.deepEqual(
			buildPackArgs(folderInput(['C:\\publish\\x64']), {
				signing: 'default',
				selfContained: false
			}),
			['pack', 'C:\\publish\\x64']
		);
	});

	it('passes every folder positionally so the CLI emits a bundle', () => {
		assert.deepEqual(
			buildPackArgs(folderInput(['C:\\publish\\x64', 'C:\\publish\\arm64']), {
				signing: 'default',
				selfContained: false
			}),
			['pack', 'C:\\publish\\x64', 'C:\\publish\\arm64']
		);
	});

	it('adds certificate flags when requested', () => {
		assert.deepEqual(
			buildPackArgs(folderInput(['C:\\publish\\x64']), {
				signing: 'generateDev',
				selfContained: false
			}),
			['pack', 'C:\\publish\\x64', '--generate-cert', '--install-cert']
		);
	});

	it('adds the self-contained flag when requested', () => {
		assert.deepEqual(
			buildPackArgs(folderInput(['C:\\publish\\x64']), {
				signing: 'default',
				selfContained: true
			}),
			['pack', 'C:\\publish\\x64', '--self-contained']
		);
	});

	it('keeps folders ahead of flags when everything is enabled', () => {
		assert.deepEqual(
			buildPackArgs(folderInput(['C:\\publish\\x64', 'C:\\publish\\arm64']), {
				signing: 'generateDev',
				selfContained: true
			}),
			[
				'pack',
				'C:\\publish\\x64',
				'C:\\publish\\arm64',
				'--generate-cert',
				'--install-cert',
				'--self-contained'
			]
		);
	});

	it('passes paths containing spaces through unquoted for shell-free spawn', () => {
		assert.deepEqual(
			buildPackArgs(folderInput(['C:\\My Project\\publish\\x64']), {
				signing: 'default',
				selfContained: false
			}),
			['pack', 'C:\\My Project\\publish\\x64']
		);
	});

	it('builds and packages a project for one architecture', () => {
		assert.deepEqual(
			buildPackArgs(projectInput(['x64']), {
				signing: 'default',
				selfContained: false
			}),
			['pack', 'C:\\workspace\\App\\App.csproj', '--arch', 'x64']
		);
	});

	it('repeats --arch to create a project-mode bundle', () => {
		assert.deepEqual(
			buildPackArgs(projectInput(['x64', 'arm64']), {
				signing: 'default',
				selfContained: false
			}),
			[
				'pack',
				'C:\\workspace\\App\\App.csproj',
				'--arch',
				'x64',
				'--arch',
				'arm64'
			]
		);
	});

	it('adds a non-default project configuration', () => {
		assert.deepEqual(
			buildPackArgs(projectInput(), {
				signing: 'default',
				selfContained: false,
				configuration: 'Debug'
			}),
			[
				'pack',
				'C:\\workspace\\App\\App.csproj',
				'--arch',
				'x64',
				'--configuration',
				'Debug'
			]
		);
	});

	it('can explicitly override project signing with unsigned output', () => {
		assert.deepEqual(
			buildPackArgs(projectInput(), {
				signing: 'unsigned',
				selfContained: false
			}),
			['pack', 'C:\\workspace\\App\\App.csproj', '--arch', 'x64', '--no-sign']
		);
	});
});

describe('shouldCheckSelfContainedArch', () => {
	it('checks a single self-contained package', () => {
		assert.equal(
			shouldCheckSelfContainedArch(folderInput(['C:\\publish\\x64']), true),
			true
		);
	});

	it('skips the check when self-contained was not requested', () => {
		assert.equal(
			shouldCheckSelfContainedArch(folderInput(['C:\\publish\\x64']), false),
			false
		);
	});

	it('skips the check for bundles', () => {
		// The CLI packs each bundle slice with an explicit per-slice
		// architecture override, so each package gets a matching runtime and
		// the machine-architecture warning would be misleading.
		assert.equal(
			shouldCheckSelfContainedArch(
				folderInput(['C:\\publish\\x64', 'C:\\publish\\arm64']),
				true
			),
			false
		);
	});

	it('skips the path-based check for project inputs', () => {
		assert.equal(shouldCheckSelfContainedArch(projectInput(), true), false);
	});
});

describe('packProgressTitle', () => {
	it('describes a single package run', () => {
		assert.equal(packProgressTitle(folderInput(['C:\\publish\\x64'])), 'Packaging app...');
	});

	it('describes a bundle run', () => {
		assert.equal(
			packProgressTitle(folderInput(['C:\\publish\\x64', 'C:\\publish\\arm64'])),
			'Creating MSIX bundle...'
		);
	});

	it('describes a multi-architecture project as a bundle', () => {
		assert.equal(packProgressTitle(projectInput(['x64', 'arm64'])), 'Creating MSIX bundle...');
	});
});

describe('isBundleInput', () => {
	it('uses folder count for existing output', () => {
		assert.equal(isBundleInput(folderInput(['C:\\publish\\x64'])), false);
		assert.equal(
			isBundleInput(folderInput(['C:\\publish\\x64', 'C:\\publish\\arm64'])),
			true
		);
	});

	it('uses architecture count for project mode', () => {
		assert.equal(isBundleInput(projectInput(['x64'])), false);
		assert.equal(isBundleInput(projectInput(['x64', 'arm64'])), true);
	});
});

describe('getPackContainmentRoots', () => {
	it('accepts the workspace and every selected folder', () => {
		assert.deepEqual(
			getPackContainmentRoots(folderInput(['C:\\publish\\x64', 'D:\\publish\\arm64'])),
			['C:\\workspace', 'C:\\publish\\x64', 'D:\\publish\\arm64']
		);
	});

	it('accepts the workspace and project directory', () => {
		assert.deepEqual(
			getPackContainmentRoots(projectInput()),
			['C:\\workspace', 'C:\\workspace\\App']
		);
	});
});
