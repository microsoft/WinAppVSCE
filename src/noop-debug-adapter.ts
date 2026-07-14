import type * as vscode from 'vscode';

type DebugRequest = {
	seq: number;
	type: 'request';
	command: string;
};

type DebugResponse = {
	seq: number;
	type: 'response';
	request_seq: number;
	success: boolean;
	command: string;
	message?: string;
	body?: unknown;
};

type DebugEvent = {
	seq: number;
	type: 'event';
	event: string;
	body?: unknown;
};

type Listener<T> = (event: T) => unknown;

class SimpleEventEmitter<T> {
	private listeners = new Set<Listener<T>>();

	readonly event: vscode.Event<T> = ((listener: Listener<T>) => {
		this.listeners.add(listener);
		return {
			dispose: () => {
				this.listeners.delete(listener);
			}
		};
	}) as vscode.Event<T>;

	fire(event: T): void {
		for (const listener of [...this.listeners]) {
			listener(event);
		}
	}

	dispose(): void {
		this.listeners.clear();
	}
}

export type NoOpDebugAdapterOptions = {
	launchErrorMessage?: string;
};

/**
 * Minimal debug adapter for the parent `winapp` session. The real debugging
 * happens in the child coreclr/node session, but this adapter must still
 * complete the DAP launch handshake (initialize, initialized event,
 * launch/attach, configurationDone) or startDebugging/F5 resolves to `false`
 * even when the app launched fine (see issue #40).
 */
export class NoOpDebugAdapter implements vscode.DebugAdapter {
	private sendMessageEmitter = new SimpleEventEmitter<vscode.DebugProtocolMessage>();
	readonly onDidSendMessage: vscode.Event<vscode.DebugProtocolMessage> = this.sendMessageEmitter.event;
	private seq = 1;

	constructor(private readonly options: NoOpDebugAdapterOptions = {}) { }

	private sendResponse(request: DebugRequest, body?: unknown): void {
		this.sendMessageEmitter.fire({
			seq: this.seq++,
			type: 'response',
			request_seq: request.seq,
			success: true,
			command: request.command,
			body
		} as vscode.DebugProtocolMessage);
	}

	private sendErrorResponse(request: DebugRequest, message: string): void {
		this.sendMessageEmitter.fire({
			seq: this.seq++,
			type: 'response',
			request_seq: request.seq,
			success: false,
			command: request.command,
			message
		} as vscode.DebugProtocolMessage);
	}

	private sendEvent(event: string, body?: unknown): void {
		this.sendMessageEmitter.fire({
			seq: this.seq++,
			type: 'event',
			event,
			body
		} as vscode.DebugProtocolMessage);
	}

	handleMessage(message: vscode.DebugProtocolMessage): void {
		const msg = message as DebugRequest;
		if (msg.type !== 'request') {
			return;
		}

		switch (msg.command) {
			case 'initialize':
				// Advertise configurationDone support so VS Code sends it as the
				// final handshake step, then signal we're ready for configuration.
				this.sendResponse(msg, { supportsConfigurationDoneRequest: true });
				this.sendEvent('initialized');
				break;
			case 'launch':
			case 'attach':
				if (this.options.launchErrorMessage) {
					this.sendErrorResponse(msg, this.options.launchErrorMessage);
					this.sendEvent('terminated');
					break;
				}
				// Acknowledge the launch/attach — this is the response VS Code
				// keys `startDebugging`'s truthy result on.
				this.sendResponse(msg);
				break;
			case 'configurationDone':
				this.sendResponse(msg);
				break;
			case 'disconnect':
				this.sendResponse(msg);
				break;
			default:
				// Acknowledge any other request so VS Code never blocks on us.
				this.sendResponse(msg);
				break;
		}
	}

	dispose(): void {
		this.sendMessageEmitter.dispose();
	}
}
