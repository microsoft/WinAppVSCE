import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	buildDegradedNotification,
	DOTNET_DOWNLOAD_URL,
	DOTNET_RUNTIME_DISMISSED_KEY,
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

	it('installTool cause: offers a retry instead of telling the user to install .NET', () => {
		const { message, actions } = buildDegradedNotification('installTool');

		// The runtime may well be installed; only the tool that locates it is missing,
		// so "Install .NET" would be wrong advice here.
		assert.match(message, /Install Tool/i);
		assert.doesNotMatch(message, /requires the \.NET 10 runtime/i);
		assert.ok(!actions.some((a) => a.url));
		assert.ok(!actions.some((a) => a.dismissDotnetRequirement));

		assert.deepEqual(
			actions.map((a) => a.label),
			['Retry', 'Install Manually', 'Show Output']
		);

		const retry = actions.find((a) => a.label === 'Retry');
		assert.ok(retry);
		assert.equal(retry.command, 'winui-xaml.restartServer');

		const manual = actions.find((a) => a.label === 'Install Manually');
		assert.ok(manual);
		assert.equal(manual.command, 'workbench.extensions.search');
		assert.equal(manual.commandArg, 'ms-dotnettools.vscode-dotnet-runtime');
	});

	it('shows the first warning, suppresses duplicates and dismissal, and honors explicit retries', () => {
		assert.equal(shouldShowDegradedNotification('dotnet', undefined, false, false), true);
		assert.equal(shouldShowDegradedNotification('dotnet', 'dotnet', false, false), false);
		assert.equal(shouldShowDegradedNotification('dotnet', undefined, true, false), false);
		assert.equal(shouldShowDegradedNotification('dotnet', 'dotnet', true, true), true);
	});

	it('dotnet cause: offers only explicit install and dismiss actions', () => {
		const { message, actions } = buildDegradedNotification('dotnet');

		assert.match(message, /\.NET 10 runtime/i);
		assert.match(message, /not found/i);
		assert.match(message, /Restart Language Server/i);
		assert.deepEqual(actions.map((a) => a.label), ['Install .NET', "Don't Show Again"]);
		assert.equal(actions[0].url, DOTNET_DOWNLOAD_URL);
		assert.equal(actions[1].dismissDotnetRequirement, true);
		assert.equal(DOTNET_RUNTIME_DISMISSED_KEY, 'winui-xaml.dotnetRuntimeRequirementDismissed');
	});

	it('executes Install .NET and persistent dismissal through host operations', async () => {
		const actions = buildDegradedNotification('dotnet').actions;
		const opened: string[] = [];
		let dismissed = false;
		const handlers = {
			dismissDotnetRequirement: async () => { dismissed = true; },
			showOutput: () => undefined,
			openUrl: async (url: string) => { opened.push(url); },
			executeCommand: async () => undefined,
		};

		await executeDegradedAction(actions[0], handlers);
		assert.deepEqual(opened, [DOTNET_DOWNLOAD_URL]);
		await executeDegradedAction(actions[1], handlers);
		assert.equal(dismissed, true);
	});

	it('executes commands, command fallbacks, and output actions through host operations', async () => {
		const commands: Array<[string, string | undefined]> = [];
		let outputShown = false;
		const handlers = {
			dismissDotnetRequirement: async () => undefined,
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
