import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	buildDegradedNotification,
	executeDegradedAction,
	shouldShowDegradedNotification,
	SERVER_SETTINGS_QUERY,
} from '../xaml/degradedNotification';

// G7: the degraded-notification message + action buttons must be asserted so a regression that drops
// or rewires an action is caught. buildDegradedNotification is the pure decision the runtime executes.
describe('buildDegradedNotification', () => {
	it('server cause: offers restart, settings, and output actions wired to the right targets', () => {
		const detail = "Configured language server not found: C:\\missing\\server.exe.";
		const { message, actions } = buildDegradedNotification('server', detail);

		assert.match(message, /language server not started/i);
		assert.match(message, /syntax-only/i);
		assert.match(message, /C:\\missing\\server\.exe/);

		assert.deepEqual(
			actions.map((a) => a.label),
			['Restart Language Server', 'Open Settings', 'Show Output']
		);

		const restart = actions.find((a) => a.label === 'Restart Language Server');
		assert.ok(restart);
		assert.equal(restart.command, 'winui-xaml.restartServer');

		const openSettings = actions.find((a) => a.label === 'Open Settings');
		assert.ok(openSettings);
		assert.equal(openSettings.command, 'workbench.action.openSettings');
		assert.equal(openSettings.commandArg, SERVER_SETTINGS_QUERY);
		assert.equal(openSettings.commandArg, 'winapp.xaml');

		const showOutput = actions.find((a) => a.label === 'Show Output');
		assert.ok(showOutput);
		assert.equal(showOutput.showOutput, true);
		assert.equal(showOutput.command, undefined);
		assert.equal(showOutput.url, undefined);
	});

	// The server is self-contained, so it either starts or fails for a reason .NET cannot explain.
	// A .NET cause here would send the user to install something the server never needed.
	it('has no .NET cause, because a missing SDK is reported per project instead', () => {
		const causes = ['untrusted', 'server'] as const;
		for (const cause of causes) {
			const { message } = buildDegradedNotification(cause);
			assert.doesNotMatch(message, /\.NET/i, `${cause} must not mention .NET`);
		}
	});

	it('shows the first warning, suppresses duplicates, and honors explicit retries', () => {
		assert.equal(shouldShowDegradedNotification('server', undefined, false), true);
		assert.equal(shouldShowDegradedNotification('server', 'server', false), false);
		assert.equal(shouldShowDegradedNotification('server', 'untrusted', false), true);
		assert.equal(shouldShowDegradedNotification('server', 'server', true), true);
	});

	it('executes commands, command fallbacks, and output actions through host operations', async () => {
		const commands: Array<[string, string | undefined]> = [];
		let outputShown = false;
		const handlers = {
			showOutput: () => { outputShown = true; },
			openUrl: async () => undefined,
			executeCommand: async (command: string, commandArg?: string) => {
				commands.push([command, commandArg]);
				if (command === 'workbench.trust.manage') {
					throw new Error('command unavailable');
				}
			},
		};

		const serverActions = buildDegradedNotification('server').actions;
		await executeDegradedAction(serverActions[0], handlers);
		await executeDegradedAction(serverActions[1], handlers);
		executeDegradedAction(serverActions[2], handlers);
		await executeDegradedAction(buildDegradedNotification('untrusted').actions[0], handlers);

		assert.deepEqual(commands, [
			['winui-xaml.restartServer', undefined],
			['workbench.action.openSettings', SERVER_SETTINGS_QUERY],
			['workbench.trust.manage', undefined],
			['workbench.action.manageTrust', undefined],
		]);
		assert.equal(outputShown, true);
	});

	it('untrusted cause: offers a single Manage Workspace Trust action with a version fallback', () => {
		const { message, actions } = buildDegradedNotification('untrusted');

		assert.match(message, /not trusted/i);
		assert.match(message, /syntax-only/i);

		assert.equal(actions.length, 1);
		const manageTrust = actions[0];
		assert.equal(manageTrust.label, 'Manage Workspace Trust');
		assert.equal(manageTrust.command, 'workbench.trust.manage');
		assert.equal(manageTrust.fallbackCommand, 'workbench.action.manageTrust');
		assert.equal(manageTrust.url, undefined);
		assert.equal(manageTrust.showOutput, undefined);
	});

	it('untrusted and server causes produce distinct messages and actions', () => {
		const untrusted = buildDegradedNotification('untrusted');
		const server = buildDegradedNotification('server');
		assert.notEqual(untrusted.message, server.message);
		assert.notDeepEqual(
			untrusted.actions.map((a) => a.label),
			server.actions.map((a) => a.label)
		);
	});
});
