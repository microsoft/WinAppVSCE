import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { continueIfDebuggerExtensionInstalled } from '../debugger-extension-guard';
import { NoOpDebugAdapter, type NoOpDebugAdapterOptions } from '../noop-debug-adapter';

type CapturedMessage = {
	type: 'response' | 'event';
	success?: boolean;
	command?: string;
	message?: string;
	event?: string;
};

function request(seq: number, command: string): any {
	return { seq, type: 'request', command };
}

function collectMessages(adapter: NoOpDebugAdapter): CapturedMessage[] {
	const messages: CapturedMessage[] = [];
	adapter.onDidSendMessage(message => {
		const captured = message as CapturedMessage;
		const normalized: CapturedMessage = { type: captured.type };
		if (captured.success !== undefined) {
			normalized.success = captured.success;
		}
		if (captured.command !== undefined) {
			normalized.command = captured.command;
		}
		if (captured.message !== undefined) {
			normalized.message = captured.message;
		}
		if (captured.event !== undefined) {
			normalized.event = captured.event;
		}
		messages.push(normalized);
	});
	return messages;
}

describe('continueIfDebuggerExtensionInstalled', () => {
	it('returns a fail-and-terminate adapter and does not continue launch when the debugger extension is missing', async () => {
		const ensuredDebuggerTypes: string[] = [];
		let continuedLaunch = false;

		const adapter = await continueIfDebuggerExtensionInstalled(
			'coreclr',
			async (debuggerType) => {
				ensuredDebuggerTypes.push(debuggerType);
				return false;
			},
			(options: NoOpDebugAdapterOptions) => new NoOpDebugAdapter(options),
			() => {
				continuedLaunch = true;
				return new NoOpDebugAdapter();
			}
		);

		assert.deepEqual(ensuredDebuggerTypes, ['coreclr']);
		assert.equal(continuedLaunch, false, 'launch continuation should not run, so the winapp CLI is not spawned');

		const messages = collectMessages(adapter);
		adapter.handleMessage(request(1, 'launch'));

		assert.deepEqual(messages, [
			{
				type: 'response',
				success: false,
				command: 'launch',
				message: 'The "coreclr" debugger extension is not installed.'
			},
			{ type: 'event', event: 'terminated' }
		]);
	});

	it('continues normal launch when the debugger extension is installed', async () => {
		let continuedLaunch = false;

		const adapter = await continueIfDebuggerExtensionInstalled(
			'coreclr',
			async () => true,
			(options: NoOpDebugAdapterOptions) => new NoOpDebugAdapter(options),
			() => {
				continuedLaunch = true;
				return new NoOpDebugAdapter();
			}
		);

		assert.equal(continuedLaunch, true);

		const messages = collectMessages(adapter);
		adapter.handleMessage(request(1, 'launch'));

		assert.deepEqual(messages, [
			{ type: 'response', success: true, command: 'launch' }
		]);
	});
});
