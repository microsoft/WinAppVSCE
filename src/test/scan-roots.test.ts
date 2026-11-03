import { describe, it } from 'node:test';
import assert from 'node:assert';
import { scanRoots, type ScanCancellationToken } from '../directory-walk';

/**
 * `scanRoots` is the scaffolding every multi-root scan shares: it bridges a
 * VS Code cancellation token to an `AbortSignal`, stops between roots, and
 * disposes its subscription. A leak or a missed cancellation check here shows
 * up as a scan that keeps walking a large tree after the user hit Cancel.
 */

/** Minimal stand-in for `vscode.CancellationToken`. */
function fakeToken(): ScanCancellationToken & { cancel(): void; disposed: boolean } {
	const listeners: Array<() => void> = [];
	const token = {
		isCancellationRequested: false,
		disposed: false,
		onCancellationRequested(listener: () => void) {
			listeners.push(listener);
			return { dispose: () => { token.disposed = true; } };
		},
		cancel() {
			token.isCancellationRequested = true;
			for (const listener of listeners) { listener(); }
		}
	};
	return token;
}

describe('scanRoots', () => {
	it('visits every root and reports completion', async () => {
		const token = fakeToken();
		const visited: string[] = [];

		const completed = await scanRoots(['a', 'b', 'c'], token, async root => {
			visited.push(root);
		});

		assert.strictEqual(completed, true);
		assert.deepStrictEqual(visited, ['a', 'b', 'c']);
	});

	it('stops early when a visitor returns stop', async () => {
		const token = fakeToken();
		const visited: string[] = [];

		const completed = await scanRoots(['a', 'b', 'c'], token, async root => {
			visited.push(root);
			return root === 'a' ? 'stop' : undefined;
		});

		// A cap was reached, not a cancellation, so partial results stand.
		assert.strictEqual(completed, true);
		assert.deepStrictEqual(visited, ['a']);
	});

	it('stops between roots once cancelled and reports it', async () => {
		const token = fakeToken();
		const visited: string[] = [];

		const completed = await scanRoots(['a', 'b', 'c'], token, async root => {
			visited.push(root);
			token.cancel();
		});

		assert.strictEqual(completed, false);
		assert.deepStrictEqual(visited, ['a']);
	});

	it('aborts the signal handed to the visitor', async () => {
		const token = fakeToken();
		let observed: AbortSignal | undefined;

		await scanRoots(['a'], token, async (_root, signal) => {
			observed = signal;
			assert.strictEqual(signal.aborted, false);
			token.cancel();
			assert.strictEqual(signal.aborted, true);
		});

		assert.ok(observed?.aborted);
	});

	it('disposes its cancellation subscription even when a visitor throws', async () => {
		const token = fakeToken();

		await assert.rejects(
			scanRoots(['a'], token, async () => { throw new Error('boom'); }),
			/boom/
		);
		assert.strictEqual(token.disposed, true);
	});

	it('treats an empty root list as a completed scan', async () => {
		const token = fakeToken();
		assert.strictEqual(await scanRoots([], token, async () => {}), true);
		assert.strictEqual(token.disposed, true);
	});
});
