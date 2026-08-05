import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	buildDegradedNotification,
	SERVER_SETTINGS_QUERY,
} from '../xaml/degradedNotification';

// G7: the degraded-notification message + action buttons must be asserted so a regression that drops
// or rewires an action is caught. buildDegradedNotification is the pure decision the runtime executes.
describe('buildDegradedNotification', () => {
	it('server cause: offers Open Settings and Show Output wired to the right targets', () => {
		const detail = "Configured language server not found: C:\\missing\\server.exe.";
		const { message, actions } = buildDegradedNotification('server', detail);

		assert.match(message, /language server not started/i);
		assert.match(message, /syntax-only/i);
		assert.match(message, /C:\\missing\\server\.exe/);

		assert.deepEqual(
			actions.map((a) => a.label),
			['Open Settings', 'Show Output']
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
