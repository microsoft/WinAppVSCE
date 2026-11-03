import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
	createDefaultLaunchConfiguration,
	hasWinAppConfiguration,
	shouldOfferLaunchConfiguration,
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

describe('shouldOfferLaunchConfiguration', () => {
	const winapp = { type: WINAPP_DEBUG_TYPE, request: 'launch', name: WINAPP_LAUNCH_CONFIG_NAME };

	/** Records whether the expensive workspace scan was actually run. */
	function manifestProbe(result: boolean) {
		const probe = {
			calls: 0,
			hasManifest: async () => {
				probe.calls += 1;
				return result;
			}
		};
		return probe;
	}

	const base = () => ({
		dismissed: false,
		folderConfigurations: [[]],
		hasManifest: async () => true
	});

	it('offers when a manifest workspace has no WinApp configuration', async () => {
		assert.equal(await shouldOfferLaunchConfiguration(base()), true);
	});

	it('stays silent once the user has dismissed it for good', async () => {
		assert.equal(await shouldOfferLaunchConfiguration({ ...base(), dismissed: true }), false);
	});

	it('stays silent with no folder open, where there is nowhere to write', async () => {
		assert.equal(await shouldOfferLaunchConfiguration({ ...base(), folderConfigurations: [] }), false);
	});

	it('stays silent when the workspace holds no manifest', async () => {
		const probe = manifestProbe(false);
		assert.equal(await shouldOfferLaunchConfiguration({ ...base(), ...probe }), false);
		assert.equal(probe.calls, 1, 'the manifest scan decides this case, so it must run');
	});

	it('stays silent when a folder is already configured', async () => {
		assert.equal(
			await shouldOfferLaunchConfiguration({ ...base(), folderConfigurations: [[winapp]] }),
			false
		);
	});

	// A workspace-file configuration is visible from every folder, so one
	// configured folder is enough to mean the workspace is already set up.
	it('stays silent when any folder in a multi-root workspace is configured', async () => {
		assert.equal(
			await shouldOfferLaunchConfiguration({ ...base(), folderConfigurations: [[], [winapp]] }),
			false
		);
	});

	// Other debuggers do not make F5 work for a WinApp package.
	it('still offers when only non-WinApp configurations exist', async () => {
		assert.equal(
			await shouldOfferLaunchConfiguration({
				...base(),
				folderConfigurations: [[{ type: 'coreclr', request: 'launch', name: 'Other' }]]
			}),
			true
		);
	});

	// The scan walks the whole workspace, so it must not run on activation for
	// a user who already said no or is already set up.
	it('skips the workspace scan when a cheap condition already decided', async () => {
		const dismissedProbe = manifestProbe(true);
		await shouldOfferLaunchConfiguration({ ...base(), ...dismissedProbe, dismissed: true });
		assert.equal(dismissedProbe.calls, 0, 'a dismissed offer must not scan');

		const configuredProbe = manifestProbe(true);
		await shouldOfferLaunchConfiguration({
			...base(),
			...configuredProbe,
			folderConfigurations: [[winapp]]
		});
		assert.equal(configuredProbe.calls, 0, 'an already-configured workspace must not scan');

		const emptyProbe = manifestProbe(true);
		await shouldOfferLaunchConfiguration({ ...base(), ...emptyProbe, folderConfigurations: [] });
		assert.equal(emptyProbe.calls, 0, 'no open folder must not scan');
	});
});