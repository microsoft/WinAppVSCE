import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { spawn } from 'child_process';
import { stopLaunchedApp } from '../process-tree';

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
