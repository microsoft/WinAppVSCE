import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { classifyRunExit, DebugLaunchCancelled, WinAppRunFailure } from '../run-exit';

/**
 * These three outcomes decide whether a user sees a red "Failed to launch and
 * attach" toast. Getting the cancellation case wrong blames the user for
 * pressing Cancel, which is the exact UX this branch set out to remove.
 */
describe('classifyRunExit', () => {
	it('treats cancellation as a cancellation, not a failure', () => {
		const error = classifyRunExit({ code: 1, cancelled: true });
		assert.ok(error instanceof DebugLaunchCancelled);
		assert.ok(!(error instanceof WinAppRunFailure));
		assert.equal(error.name, 'Canceled');
		assert.equal(error.message, 'Canceled');
	});

	// Killing the process tree makes the exit code arbitrary — on Windows a
	// taskkill'd child usually reports 1, but it may also be null. Neither may
	// turn a cancellation into a failure.
	it('still reports cancellation when the kill produced a clean or signal exit', () => {
		assert.ok(classifyRunExit({ code: 0, cancelled: true }) instanceof DebugLaunchCancelled);
		assert.ok(classifyRunExit({ code: null, cancelled: true }) instanceof DebugLaunchCancelled);
	});

	it('reports a non-zero exit as a run failure naming the code', () => {
		const error = classifyRunExit({ code: 3, cancelled: false });
		assert.ok(error instanceof WinAppRunFailure);
		assert.match(error.message, /exit code 3/);
	});

	it('reports a signal exit as a run failure', () => {
		assert.ok(classifyRunExit({ code: null, cancelled: false }) instanceof WinAppRunFailure);
	});

	// A clean exit still reaches here only when no process ID was reported,
	// so there is nothing for the debugger to attach to.
	it('reports a clean exit with no process ID as a run failure', () => {
		const error = classifyRunExit({ code: 0, cancelled: false });
		assert.ok(error instanceof WinAppRunFailure);
		assert.match(error.message, /before reporting a process ID/);
	});
});
