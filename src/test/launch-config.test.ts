import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
	createDefaultLaunchConfiguration,
	hasWinAppConfiguration,
	WINAPP_DEBUG_TYPE,
	WINAPP_LAUNCH_CONFIG_NAME
} from '../launch-config';

describe('createDefaultLaunchConfiguration', () => {
	it('produces the WinApp launch entry', () => {
		assert.deepEqual(createDefaultLaunchConfiguration(), {
			type: WINAPP_DEBUG_TYPE,
			request: 'launch',
			name: WINAPP_LAUNCH_CONFIG_NAME
		});
	});

	// The whole point of the module is that there is one configuration shape.
	// Naming a target here would make generated content depend on which path
	// wrote it, and would go stale as soon as the project moved.
	it('names no run target, leaving discovery to the adapter at F5 time', () => {
		const config = createDefaultLaunchConfiguration();
		assert.deepEqual(Object.keys(config).sort(), ['name', 'request', 'type']);
	});

	it('returns a fresh object so callers cannot mutate the shared default', () => {
		const first = createDefaultLaunchConfiguration();
		first.name = 'mutated';
		assert.equal(createDefaultLaunchConfiguration().name, WINAPP_LAUNCH_CONFIG_NAME);
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
