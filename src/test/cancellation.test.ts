import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	runWithCancellation,
	type CancellationTokenLike,
	type DisposableLike
} from '../cancellation';

class TestCancellationToken implements CancellationTokenLike {
	isCancellationRequested = false;
	disposed = false;
	private listener: (() => void) | undefined;

	onCancellationRequested(listener: () => void): DisposableLike {
		this.listener = listener;
		return {
			dispose: () => {
				this.disposed = true;
				this.listener = undefined;
			}
		};
	}

	cancel(): void {
		this.isCancellationRequested = true;
		this.listener?.();
	}
}

describe('runWithCancellation', () => {
	it('returns a successful value and disposes the listener', async () => {
		const token = new TestCancellationToken();

		const result = await runWithCancellation(token, async signal => {
			assert.equal(signal.aborted, false);
			return 'completed';
		});

		assert.deepEqual(result, { cancelled: false, value: 'completed' });
		assert.equal(token.disposed, true);
	});

	it('skips an operation for an already-cancelled token and disposes the listener', async () => {
		const token = new TestCancellationToken();
		token.isCancellationRequested = true;
		let operationCalled = false;

		const result = await runWithCancellation(token, async () => {
			operationCalled = true;
			return 'unexpected';
		});

		assert.deepEqual(result, { cancelled: true, value: undefined });
		assert.equal(operationCalled, false);
		assert.equal(token.disposed, true);
	});

	it('aborts promptly when cancellation occurs during an operation', async () => {
		const token = new TestCancellationToken();
		let observedAbort = false;

		const result = await runWithCancellation(token, signal => new Promise<string>(resolve => {
			signal.addEventListener('abort', () => {
				observedAbort = true;
				resolve('aborted');
			}, { once: true });
			token.cancel();
		}));

		assert.equal(observedAbort, true);
		assert.deepEqual(result, { cancelled: true, value: undefined });
		assert.equal(token.disposed, true);
	});

	it('propagates non-cancellation errors and still disposes the listener', async () => {
		const token = new TestCancellationToken();
		const error = new Error('scan failed');

		await assert.rejects(
			runWithCancellation(token, async () => {
				throw error;
			}),
			error
		);
		assert.equal(token.disposed, true);
	});

	it('does not swallow a non-cancellation error after cancellation', async () => {
		const token = new TestCancellationToken();
		const error = new Error('scan failed while cancelling');

		await assert.rejects(
			runWithCancellation(token, async () => {
				token.cancel();
				throw error;
			}),
			error
		);
		assert.equal(token.disposed, true);
	});

	it('recognizes Canceled errors raised after cancellation', async () => {
		const token = new TestCancellationToken();
		const error = new Error('cancelled');
		error.name = 'Canceled';

		const result = await runWithCancellation(token, async () => {
			token.cancel();
			throw error;
		});

		assert.deepEqual(result, { cancelled: true, value: undefined });
		assert.equal(token.disposed, true);
	});
});
