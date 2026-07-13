import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	buildDegradedNotification,
	DOTNET_DOWNLOAD_URL,
	SERVER_SETTINGS_QUERY,
} from '../xaml/degradedNotification';

// G7: the degraded-notification message + action buttons must be asserted so a regression that drops
// or rewires an action is caught. buildDegradedNotification is the pure decision the runtime executes.
describe('buildDegradedNotification', () => {
	it('server cause: offers Open Settings / Show Output / Install .NET wired to the right targets', () => {
		const { message, actions } = buildDegradedNotification('server');

		assert.match(message, /language server not started/i);
		assert.match(message, /syntax-only/i);

		assert.deepEqual(
			actions.map((a) => a.label),
			['Open Settings', 'Show Output', 'Install .NET']
		);

		const openSettings = actions.find((a) => a.label === 'Open Settings');
		assert.ok(openSettings);
		assert.equal(openSettings.command, 'workbench.action.openSettings');
		assert.equal(openSettings.commandArg, SERVER_SETTINGS_QUERY);
		assert.equal(openSettings.commandArg, 'winui-xaml.server');

		const showOutput = actions.find((a) => a.label === 'Show Output');
		assert.ok(showOutput);
		assert.equal(showOutput.showOutput, true);
		assert.equal(showOutput.command, undefined);
		assert.equal(showOutput.url, undefined);

		const installDotnet = actions.find((a) => a.label === 'Install .NET');
		assert.ok(installDotnet);
		assert.equal(installDotnet.url, DOTNET_DOWNLOAD_URL);
		assert.equal(installDotnet.url, 'https://dotnet.microsoft.com/download');
		assert.equal(installDotnet.command, undefined);
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
