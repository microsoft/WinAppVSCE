import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	parsePackagedArtifactPath,
	buildPackSuccessMessage,
	deriveAppNameFromArtifact,
	PACK_ACTIONS,
	getPackNotificationAction,
	isArtifactWithinRoot,
	planPackCompletion
} from '../pack-result';

describe('parsePackagedArtifactPath', () => {
	it('extracts a following-line path that contains spaces', () => {
		const output = [
			'Creating MSIX package...\r',
			'  📦 Package: \r',
			'C:\\Users\\me\\My Project\\My App_1.0.0.0_x64.msix\r',
			'✅ MSIX package creation completed.\r',
			''
		].join('\n');

		assert.equal(
			parsePackagedArtifactPath(output),
			'C:\\Users\\me\\My Project\\My App_1.0.0.0_x64.msix'
		);
	});

	it('trims an indented following-line path while preserving internal spaces', () => {
		const output =
			'Creating MSIX package...\n' +
			'  📦 Package: \n' +
			'   C:\\Users\\me\\My Project\\My App_1.0.0.0_x64.msix   \n';

		assert.equal(
			parsePackagedArtifactPath(output),
			'C:\\Users\\me\\My Project\\My App_1.0.0.0_x64.msix'
		);
	});

	it('extracts the path when it is on the same line as the marker', () => {
		const output =
			'Creating MSIX package...\n' +
			'  📦 Package: C:\\out\\MyApp_2.3.4_arm64.msix\n' +
			'✅ MSIX package creation completed.\n';

		assert.equal(parsePackagedArtifactPath(output), 'C:\\out\\MyApp_2.3.4_arm64.msix');
	});

	it('recognizes a .msixbundle artifact', () => {
		const output =
			'  📦 Package: \nC:\\out\\MyApp_1.0.0_x64_arm64.msixbundle\n';

		assert.equal(
			parsePackagedArtifactPath(output),
			'C:\\out\\MyApp_1.0.0_x64_arm64.msixbundle'
		);
	});

	it('falls back to the last package-like line when the marker is absent', () => {
		const output =
			'some noisy log line\n' +
			'C:\\out\\First_1.0.0_x64.msix\n' +
			'another log line\n' +
			'C:\\out\\Final_2.0.0_x64.msix\n' +
			'done\n';

		assert.equal(parsePackagedArtifactPath(output), 'C:\\out\\Final_2.0.0_x64.msix');
	});

	it('is case-insensitive about the extension', () => {
		const output = '  📦 Package: \nC:\\out\\MyApp_1.0.0_x64.MSIX\n';
		assert.equal(parsePackagedArtifactPath(output), 'C:\\out\\MyApp_1.0.0_x64.MSIX');
	});

	it('returns undefined when no artifact path is present', () => {
		const output = 'Creating MSIX package...\n❌ Failed to create MSIX package\n';
		assert.equal(parsePackagedArtifactPath(output), undefined);
	});

	it('returns undefined for empty output', () => {
		assert.equal(parsePackagedArtifactPath(''), undefined);
	});

	it('does not treat a non-package line after the marker as the path', () => {
		// If the line right after the marker is not a package path, we must not
		// misreport a log line as the artifact.
		const output =
			'  📦 Package: \n' +
			'Run with --verbose for more details.\n' +
			'❌ Failed\n';
		assert.equal(parsePackagedArtifactPath(output), undefined);
	});

	it('reconstructs a path wrapped across multiple lines after the marker', () => {
		const output = [
			'⚠ Found `Appx` directory in input folder. It will be excluded from the package.',
			'  📦 Package:',
			'c:\\Users\\chiaramooney\\winappCli\\samples\\winui-app\\winui-app-sample_1.0.0.0_arm64',
			'.msix',
			'✅ MSIX package creation completed.'
		].join('\n');

		assert.equal(
			parsePackagedArtifactPath(output),
			'c:\\Users\\chiaramooney\\winappCli\\samples\\winui-app\\winui-app-sample_1.0.0.0_arm64.msix'
		);
	});

	it('reconstructs a path wrapped across three lines after the marker', () => {
		const output = [
			'  📦 Package:',
			'C:\\very\\long\\path\\to\\some\\deep\\folder\\winui-app-sample_1.0.0.0',
			'_arm64',
			'.msix',
			'✅ Done.'
		].join('\n');

		assert.equal(
			parsePackagedArtifactPath(output),
			'C:\\very\\long\\path\\to\\some\\deep\\folder\\winui-app-sample_1.0.0.0_arm64.msix'
		);
	});
});

describe('buildPackSuccessMessage', () => {
	it('uses the file name and app name when provided', () => {
		assert.equal(
			buildPackSuccessMessage('C:\\out\\CounterApp_1.0.0.0_x64.msix', 'CounterApp'),
			'CounterApp packaged → CounterApp_1.0.0.0_x64.msix'
		);
	});

	it('falls back to a generic message when no app name is given', () => {
		assert.equal(
			buildPackSuccessMessage('C:\\out\\CounterApp_1.0.0.0_x64.msix'),
			'Package created → CounterApp_1.0.0.0_x64.msix'
		);
	});

	it('trims a whitespace-only app name and uses the fallback', () => {
		assert.equal(
			buildPackSuccessMessage('C:\\out\\App_1.0_x64.msix', '   '),
			'Package created → App_1.0_x64.msix'
		);
	});

	it('shows only the basename, not the full path', () => {
		const message = buildPackSuccessMessage('C:\\deep\\nested\\out\\App_1.0_x64.msix', 'App');
		assert.ok(!message.includes('nested'));
		assert.ok(message.endsWith('App_1.0_x64.msix'));
	});
});

describe('deriveAppNameFromArtifact', () => {
	it('extracts the name before the version segment', () => {
		assert.equal(
			deriveAppNameFromArtifact('C:\\out\\CounterApp_1.0.0.0_x64.msix'),
			'CounterApp'
		);
	});

	it('preserves underscores within the app name', () => {
		assert.equal(
			deriveAppNameFromArtifact('C:\\out\\My_Cool_App_1.0.0_x64.msix'),
			'My_Cool_App'
		);
	});

	it('works for bundles', () => {
		assert.equal(
			deriveAppNameFromArtifact('App_1.0.0_x64_arm64.msixbundle'),
			'App'
		);
	});

	it('returns undefined when there is no version segment', () => {
		assert.equal(deriveAppNameFromArtifact('C:\\out\\NoVersion.msix'), undefined);
	});
});

describe('PACK_ACTIONS', () => {
	it('exposes the three action labels', () => {
		assert.deepEqual(PACK_ACTIONS, {
			reveal: 'Reveal in Explorer',
			sign: 'Sign',
			install: 'Install'
		});
	});
});

describe('getPackNotificationAction', () => {
	it('maps notification labels to action kinds', () => {
		assert.equal(getPackNotificationAction(PACK_ACTIONS.reveal), 'reveal');
		assert.equal(getPackNotificationAction(PACK_ACTIONS.sign), 'sign');
		assert.equal(getPackNotificationAction(PACK_ACTIONS.install), 'install');
	});

	it('maps dismissal and unknown choices to none', () => {
		assert.equal(getPackNotificationAction(undefined), 'none');
		assert.equal(getPackNotificationAction('Dismiss'), 'none');
	});
});

describe('isArtifactWithinRoot', () => {
	it('accepts an artifact under the root', () => {
		assert.equal(
			isArtifactWithinRoot('C:\\workspace\\out\\App_1.0.0.0_x64.msix', 'C:\\workspace'),
			true
		);
	});

	it('rejects a sibling path escape', () => {
		assert.equal(
			isArtifactWithinRoot('C:\\workspace-other\\App_1.0.0.0_x64.msix', 'C:\\workspace'),
			false
		);
	});

	it('rejects a different drive', () => {
		assert.equal(
			isArtifactWithinRoot('D:\\workspace\\out\\App_1.0.0.0_x64.msix', 'C:\\workspace'),
			false
		);
	});

	it('rejects the exact root path', () => {
		assert.equal(isArtifactWithinRoot('C:\\workspace', 'C:\\workspace'), false);
	});

	it('compares paths case-insensitively', () => {
		assert.equal(
			isArtifactWithinRoot('c:\\workspace\\out\\App_1.0.0.0_x64.msix', 'C:\\WORKSPACE'),
			true
		);
	});

	it('can be composed to accept a selected input folder outside the workspace', () => {
		const artifactPath = 'C:\\selected-input\\out\\App_1.0.0.0_x64.msix';

		assert.equal(
			isArtifactWithinRoot(artifactPath, 'C:\\workspace') ||
				isArtifactWithinRoot(artifactPath, 'C:\\selected-input'),
			true
		);
		assert.equal(
			isArtifactWithinRoot('C:\\unrelated\\App_1.0.0.0_x64.msix', 'C:\\workspace') ||
				isArtifactWithinRoot('C:\\unrelated\\App_1.0.0.0_x64.msix', 'C:\\selected-input'),
			false
		);
	});
});

describe('planPackCompletion', () => {
	it('plans a silent cancellation', () => {
		assert.deepEqual(
			planPackCompletion({ code: null, output: '', cancelled: true }),
			{ kind: 'cancelled' }
		);
	});

	it('plans an error for non-zero exit code', () => {
		assert.deepEqual(
			planPackCompletion({
				code: 1,
				output: '  📦 Package: C:\\out\\CounterApp_1.0.0.0_x64.msix\n'
			}),
			{
				kind: 'error',
				message: 'Packaging failed. See the WinApp output channel for details.'
			}
		);
	});

	it('plans an error for unparseable successful output', () => {
		assert.deepEqual(
			planPackCompletion({ code: 0, output: '✅ MSIX package creation completed.\n' }),
			{
				kind: 'error',
				message: 'Packaging failed. See the WinApp output channel for details.'
			}
		);
	});

	it('plans success with the artifact path, app name, and message', () => {
		assert.deepEqual(
			planPackCompletion({
				code: 0,
				output: '  📦 Package: C:\\out\\CounterApp_1.0.0.0_x64.msix\n'
			}),
			{
				kind: 'success',
				artifactPath: 'C:\\out\\CounterApp_1.0.0.0_x64.msix',
				appName: 'CounterApp',
				message: 'CounterApp packaged → CounterApp_1.0.0.0_x64.msix'
			}
		);
	});
});
