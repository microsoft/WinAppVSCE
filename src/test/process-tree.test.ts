import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { endRun, stopLaunchedApp } from '../process-tree';

function fakeRun() {
	const run = Object.assign(new EventEmitter(), { kills: 0, kill() { run.kills++; return true; } });
	return run;
}

describe('endRun', () => {
	it('lets the CLI finish its exit work once the app is stopped', async () => {
		const run = fakeRun();
		endRun(run, 42, true, () => true, 20);
		run.emit('close');
		await new Promise(resolve => setTimeout(resolve, 40));
		assert.equal(run.kills, 0, 'a CLI that exits on its own is never killed');
	});

	it('kills a CLI that has not exited within the grace period', async () => {
		const run = fakeRun();
		endRun(run, 42, true, () => true, 10);
		await new Promise(resolve => setTimeout(resolve, 40));
		assert.equal(run.kills, 1);
	});

	it('kills the CLI at once when the app was not stopped', () => {
		const leftOpen = fakeRun();
		endRun(leftOpen, 42, false, () => true);
		assert.equal(leftOpen.kills, 1);
		const alreadyGone = fakeRun();
		endRun(alreadyGone, 42, true, () => false);
		assert.equal(alreadyGone.kills, 1);
	});
});

describe('stopLaunchedApp', () => {
	it('stops the app process that winapp run launched', async () => {
		const app = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
		const exited = new Promise(resolve => app.on('exit', resolve));
		assert.equal(stopLaunchedApp(app.pid!), true);
		await exited;
	});

	it('ignores an app that has already exited', () => {
		const gone = () => { throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' }); };
		assert.equal(stopLaunchedApp(123, gone), false);
	});
});
