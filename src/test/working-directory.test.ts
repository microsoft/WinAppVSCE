/**
 * Unit tests for resolveWorkingDirectory (src/winapp-cli-utils.ts).
 *
 * The debug adapter passes the launch.json `workingDirectory` straight to
 * `spawn`, so a relative value would resolve against the extension host's
 * process cwd instead of the workspace folder. These tests pin the resolution
 * behavior for unset, relative, root-relative, fully qualified, and
 * drive-relative values.
 *
 * Windows-specific expectations are written out literally rather than computed
 * with `path.resolve`, so a regression in the helper cannot be masked by the
 * test reusing the same operation it is meant to verify.
 *
 * Run: npx tsx --test src/test/working-directory.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { resolveWorkingDirectory } from '../winapp-cli-utils';

const isWindows = path.sep === '\\';

describe('resolveWorkingDirectory', () => {
	const workspace = path.resolve(isWindows ? 'C:\\repos\\MyApp' : '/repos/MyApp');

	it('falls back to the workspace folder when workingDirectory is unset', () => {
		assert.equal(resolveWorkingDirectory(workspace, undefined), workspace);
	});

	it('falls back to the workspace folder for an empty workingDirectory', () => {
		assert.equal(resolveWorkingDirectory(workspace, ''), workspace);
	});

	it('resolves a relative workingDirectory against the workspace folder', () => {
		assert.equal(
			resolveWorkingDirectory(workspace, 'subdir'),
			path.join(workspace, 'subdir')
		);
	});

	it('resolves an explicitly dot-prefixed relative path against the workspace folder', () => {
		assert.equal(
			resolveWorkingDirectory(workspace, './subdir'),
			path.join(workspace, 'subdir')
		);
	});

	it('resolves a parent-relative path against the workspace folder', () => {
		assert.equal(
			resolveWorkingDirectory(workspace, '../sibling'),
			path.resolve(workspace, '..', 'sibling')
		);
	});

	it('does not resolve against the process cwd', () => {
		const resolved = resolveWorkingDirectory(workspace, 'out');
		assert.equal(resolved, path.join(workspace, 'out'));
		assert.notEqual(resolved, path.resolve(process.cwd(), 'out'));
	});

	it('leaves a fully qualified workingDirectory untouched', () => {
		const absolute = path.resolve(isWindows ? 'C:\\other\\place' : '/other/place');
		assert.equal(resolveWorkingDirectory(workspace, absolute), absolute);
	});

	if (isWindows) {
		it('anchors a root-relative path to the workspace drive, not the host drive', () => {
			// "\out" is absolute per path.isAbsolute but names no drive, so spawn
			// would resolve it against whichever drive the extension host is on.
			assert.equal(resolveWorkingDirectory('C:\\repos\\MyApp', '\\out'), 'C:\\out');
		});

		it('anchors a root-relative path to a non-C workspace drive', () => {
			assert.equal(resolveWorkingDirectory('D:\\work\\MyApp', '\\out'), 'D:\\out');
		});

		it('keeps a fully qualified path on its own drive even when it differs from the workspace', () => {
			assert.equal(resolveWorkingDirectory('D:\\work\\MyApp', 'C:\\tools'), 'C:\\tools');
		});

		it('resolves a plain relative path onto the workspace drive', () => {
			assert.equal(resolveWorkingDirectory('D:\\work\\MyApp', 'out'), 'D:\\work\\MyApp\\out');
		});

		it('rejects a drive-relative path that matches the workspace drive', () => {
			assert.throws(
				() => resolveWorkingDirectory('C:\\repos\\MyApp', 'C:out'),
				/drive-relative/
			);
		});

		it('rejects a drive-relative path on a different drive than the workspace', () => {
			assert.throws(
				() => resolveWorkingDirectory('D:\\work\\MyApp', 'C:out'),
				/drive-relative/
			);
		});

		it('suggests both a workspace-relative and a fully qualified alternative', () => {
			assert.throws(
				() => resolveWorkingDirectory('C:\\repos\\MyApp', 'C:out'),
				(error: Error) => error.message.includes('"out"') && error.message.includes('C:\\out')
			);
		});
	}
});
