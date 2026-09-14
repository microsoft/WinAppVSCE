import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	buildPackArgs,
	isBundleSelection,
	packProgressTitle,
	resolveFolderSelection,
	shouldCheckSelfContainedArch
} from '../pack-args';

const BROWSE_DETAIL = 'Open a folder picker';

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
			{ kind: 'browse' }
		);
	});

	it('prefers browse when Browse… is ticked alongside real folders', () => {
		// Browse… keeps the same styling as every other picker, so under
		// multi-select it can be ticked together with discovered folders. An
		// explicit request to browse wins.
		assert.deepEqual(
			resolveFolderSelection(
				[
					{ detail: 'C:\\publish\\x64', directory: 'C:\\publish\\x64' },
					{ detail: BROWSE_DETAIL }
				],
				BROWSE_DETAIL
			),
			{ kind: 'browse' }
		);
	});

	it('returns none when ticked items carry no directory', () => {
		assert.deepEqual(
			resolveFolderSelection([{ detail: 'something else' }], BROWSE_DETAIL),
			{ kind: 'none' }
		);
	});
});

describe('buildPackArgs', () => {
	it('packs a single folder with no flags', () => {
		assert.deepEqual(
			buildPackArgs(['C:\\publish\\x64'], { generateCert: false, selfContained: false }),
			['pack', 'C:\\publish\\x64']
		);
	});

	it('passes every folder positionally so the CLI emits a bundle', () => {
		assert.deepEqual(
			buildPackArgs(['C:\\publish\\x64', 'C:\\publish\\arm64'], {
				generateCert: false,
				selfContained: false
			}),
			['pack', 'C:\\publish\\x64', 'C:\\publish\\arm64']
		);
	});

	it('adds certificate flags when requested', () => {
		assert.deepEqual(
			buildPackArgs(['C:\\publish\\x64'], { generateCert: true, selfContained: false }),
			['pack', 'C:\\publish\\x64', '--generate-cert', '--install-cert']
		);
	});

	it('adds the self-contained flag when requested', () => {
		assert.deepEqual(
			buildPackArgs(['C:\\publish\\x64'], { generateCert: false, selfContained: true }),
			['pack', 'C:\\publish\\x64', '--self-contained']
		);
	});

	it('keeps folders ahead of flags when everything is enabled', () => {
		assert.deepEqual(
			buildPackArgs(['C:\\publish\\x64', 'C:\\publish\\arm64'], {
				generateCert: true,
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
			buildPackArgs(['C:\\My Project\\publish\\x64'], {
				generateCert: false,
				selfContained: false
			}),
			['pack', 'C:\\My Project\\publish\\x64']
		);
	});
});

describe('shouldCheckSelfContainedArch', () => {
	it('checks a single self-contained package', () => {
		assert.equal(shouldCheckSelfContainedArch(['C:\\publish\\x64'], true), true);
	});

	it('skips the check when self-contained was not requested', () => {
		assert.equal(shouldCheckSelfContainedArch(['C:\\publish\\x64'], false), false);
	});

	it('skips the check for bundles', () => {
		// The CLI packs each bundle slice with an explicit per-slice
		// architecture override, so each package gets a matching runtime and
		// the machine-architecture warning would be misleading.
		assert.equal(
			shouldCheckSelfContainedArch(['C:\\publish\\x64', 'C:\\publish\\arm64'], true),
			false
		);
	});
});

describe('packProgressTitle', () => {
	it('describes a single package run', () => {
		assert.equal(packProgressTitle(['C:\\publish\\x64']), 'Packaging app...');
	});

	it('describes a bundle run', () => {
		assert.equal(
			packProgressTitle(['C:\\publish\\x64', 'C:\\publish\\arm64']),
			'Creating MSIX bundle...'
		);
	});
});
