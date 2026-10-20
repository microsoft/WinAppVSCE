import { spawn, type ChildProcess } from 'child_process';

/**
 * Terminates a spawned `winapp` process and everything it started.
 *
 * `child.kill()` on Windows signals only the direct child, so a cancelled run
 * leaves the restore/build/deploy tree (MSBuild, NuGet, the SDK's packaging
 * tools) running in the background. `taskkill /t` walks the tree instead.
 *
 * Falls back to `child.kill()` whenever taskkill is unavailable or fails, so
 * cancellation always terminates *something*.
 */
export function killProcessTree(child: ChildProcess): void {
	if (!child.pid) {
		child.kill();
		return;
	}

	const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
		windowsHide: true
	});
	killer.on('error', () => child.kill());
	killer.on('close', (code) => {
		if (code !== 0) {
			child.kill();
		}
	});
}
