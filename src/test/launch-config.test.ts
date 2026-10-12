import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import {
	createFallbackLaunchConfiguration,
	createLaunchConfiguration,
	hasWinAppConfiguration,
	toConfiguredPath,
	WINAPP_LAUNCH_CONFIG_NAME,
	WORKSPACE_FOLDER_TOKEN
} from '../launch-config';

const root = path.resolve('C:', 'work', 'MyApp');

describe('toConfiguredPath', () => {
	it('rewrites a contained path as workspace-relative', () => {
		const target = path.join(root, 'src', 'MyApp.csproj');
		assert.equal(toConfiguredPath(root, target), `${WORKSPACE_FOLDER_TOKEN}/src/MyApp.csproj`);
	});

	it('uses forward slashes regardless of platform separator', () => {
		const target = path.join(root, 'bin', 'Debug', 'net8.0-windows');
		assert.ok(!toConfiguredPath(root, target).includes('\\'));
	});

	it('returns the bare token when the target is the root itself', () => {
		assert.equal(toConfiguredPath(root, root), WORKSPACE_FOLDER_TOKEN);
	});

	it('leaves a path outside the workspace absolute', () => {
		const outside = path.resolve('C:', 'elsewhere', 'Other.csproj');
		assert.equal(toConfiguredPath(root, outside), outside);
	});

	it('does not treat a sibling with a shared prefix as contained', () => {
		const sibling = path.resolve('C:', 'work', 'MyApplication', 'A.csproj');
		assert.equal(toConfiguredPath(root, sibling), sibling);
	});
});

describe('createLaunchConfiguration', () => {
	it('produces a launch entry pointing at the target', () => {
		const config = createLaunchConfiguration(root, path.join(root, 'MyApp.csproj'));
		assert.deepEqual(config, {
			type: 'winapp',
			request: 'launch',
			name: WINAPP_LAUNCH_CONFIG_NAME,
			input: `${WORKSPACE_FOLDER_TOKEN}/MyApp.csproj`
		});
	});

	it('omits project when no solution member was chosen', () => {
		const config = createLaunchConfiguration(root, path.join(root, 'App.sln'));
		assert.ok(!('project' in config));
	});

	it('includes project when one was chosen, also workspace-relative', () => {
		const config = createLaunchConfiguration(
			root,
			path.join(root, 'App.sln'),
			path.join(root, 'src', 'App', 'App.csproj')
		);
		assert.equal(config.input, `${WORKSPACE_FOLDER_TOKEN}/App.sln`);
		assert.equal(config.project, `${WORKSPACE_FOLDER_TOKEN}/src/App/App.csproj`);
	});
});

describe('createFallbackLaunchConfiguration', () => {
	it('omits input so the adapter discovers a target at F5 time', () => {
		const config = createFallbackLaunchConfiguration();
		assert.equal(config.type, 'winapp');
		assert.equal(config.request, 'launch');
		assert.ok(!('input' in config));
	});
});

describe('hasWinAppConfiguration', () => {
	it('detects an existing winapp entry', () => {
		assert.equal(hasWinAppConfiguration([{ type: 'node' }, { type: 'winapp' }]), true);
	});

	it('ignores configurations owned by other debuggers', () => {
		assert.equal(hasWinAppConfiguration([{ type: 'coreclr' }]), false);
	});

	it('tolerates missing or malformed configuration lists', () => {
		assert.equal(hasWinAppConfiguration(undefined), false);
		assert.equal(hasWinAppConfiguration([]), false);
		assert.equal(hasWinAppConfiguration([null, 'winapp', 42]), false);
	});
});
