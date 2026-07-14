import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { continueIfChildDebugStarted } from '../child-debug-session';
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

describe('continueIfChildDebugStarted', () => {
	it('kills the run process and returns a fail-and-terminate parent adapter when child debugging returns false', async () => {
		let killCount = 0;
		let registeredSuccessfulCleanup = false;

		const adapter = await continueIfChildDebugStarted(
			'coreclr',
			async () => false,
			() => {
				killCount++;
			},
			(options: NoOpDebugAdapterOptions) => new NoOpDebugAdapter(options),
			() => {
				registeredSuccessfulCleanup = true;
				return new NoOpDebugAdapter();
			}
		);

		assert.equal(killCount, 1);
		assert.equal(registeredSuccessfulCleanup, false, 'successful-session cleanup should not be registered');

		const messages = collectMessages(adapter);
		adapter.handleMessage(request(1, 'launch'));

		assert.deepEqual(messages, [
			{
				type: 'response',
				success: false,
				command: 'launch',
				message: 'Failed to start the "coreclr" child debugger session.'
			},
			{ type: 'event', event: 'terminated' }
		]);
	});

	it('kills the run process and rethrows when child debugging rejects', async () => {
		let killCount = 0;
		let registeredSuccessfulCleanup = false;
		const startError = new Error('debug adapter startup failed');

		await assert.rejects(
			continueIfChildDebugStarted(
				'coreclr',
				async () => {
					throw startError;
				},
				() => {
					killCount++;
				},
				(options: NoOpDebugAdapterOptions) => new NoOpDebugAdapter(options),
				() => {
					registeredSuccessfulCleanup = true;
					return new NoOpDebugAdapter();
				}
			),
			(error) => error === startError
		);

		assert.equal(killCount, 1);
		assert.equal(registeredSuccessfulCleanup, false, 'successful-session cleanup should not be registered');
	});

	it('preserves the normal successful parent adapter path when child debugging starts', async () => {
		let killCount = 0;
		let registeredSuccessfulCleanup = false;

		const adapter = await continueIfChildDebugStarted(
			'coreclr',
			async () => true,
			() => {
				killCount++;
			},
			(options: NoOpDebugAdapterOptions) => new NoOpDebugAdapter(options),
			() => {
				registeredSuccessfulCleanup = true;
				return new NoOpDebugAdapter();
			}
		);

		assert.equal(killCount, 0);
		assert.equal(registeredSuccessfulCleanup, true);

		const messages = collectMessages(adapter);
		adapter.handleMessage(request(1, 'launch'));

		assert.deepEqual(messages, [
			{ type: 'response', success: true, command: 'launch' }
		]);
	});
});
