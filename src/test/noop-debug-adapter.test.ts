import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NoOpDebugAdapter } from '../noop-debug-adapter';

type CapturedMessage = {
	seq: number;
	type: 'response' | 'event';
	request_seq?: number;
	success?: boolean;
	command?: string;
	message?: string;
	body?: Record<string, unknown>;
	event?: string;
};

function request(seq: number, command: string): any {
	return { seq, type: 'request', command };
}

function collectMessages(adapter: NoOpDebugAdapter): CapturedMessage[] {
	const messages: CapturedMessage[] = [];
	adapter.onDidSendMessage(message => {
		messages.push(message as CapturedMessage);
	});
	return messages;
}

describe('NoOpDebugAdapter', () => {
	it('completes the launch handshake with successful responses in DAP order', () => {
		const adapter = new NoOpDebugAdapter();
		const messages = collectMessages(adapter);

		adapter.handleMessage(request(1, 'initialize'));
		adapter.handleMessage(request(2, 'launch'));
		adapter.handleMessage(request(3, 'configurationDone'));

		assert.deepEqual(messages, [
			{
				seq: 1,
				type: 'response',
				request_seq: 1,
				success: true,
				command: 'initialize',
				body: { supportsConfigurationDoneRequest: true }
			},
			{ seq: 2, type: 'event', event: 'initialized', body: undefined },
			{ seq: 3, type: 'response', request_seq: 2, success: true, command: 'launch', body: undefined },
			{ seq: 4, type: 'response', request_seq: 3, success: true, command: 'configurationDone', body: undefined }
		]);
	});

	it('completes the attach handshake with successful responses', () => {
		const adapter = new NoOpDebugAdapter();
		const messages = collectMessages(adapter);

		adapter.handleMessage(request(1, 'initialize'));
		adapter.handleMessage(request(2, 'attach'));
		adapter.handleMessage(request(3, 'configurationDone'));

		const responses = messages.filter(message => message.type === 'response');
		assert.deepEqual(
			responses.map(response => [response.command, response.success]),
			[['initialize', true], ['attach', true], ['configurationDone', true]]
		);
		assert.equal(messages[1].type, 'event');
		assert.equal(messages[1].event, 'initialized');
	});

	it('fails launch and terminates when the required debugger extension is missing', () => {
		const adapter = new NoOpDebugAdapter({
			launchErrorMessage: 'The "coreclr" debugger extension is not installed.'
		});
		const messages = collectMessages(adapter);

		adapter.handleMessage(request(1, 'initialize'));
		adapter.handleMessage(request(2, 'launch'));

		assert.deepEqual(messages.slice(2), [
			{
				seq: 3,
				type: 'response',
				request_seq: 2,
				success: false,
				command: 'launch',
				message: 'The "coreclr" debugger extension is not installed.'
			},
			{ seq: 4, type: 'event', event: 'terminated', body: undefined }
		]);
	});
});
