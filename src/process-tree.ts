import { spawn, type ChildProcess } from 'child_process';

/** Bounds how long the CLI may run its exit work (e.g. --unregister-on-exit) after the app stops. */
export const RUN_EXIT_GRACE_MS = 35_000;

/**
 * Stops the app `winapp run` launched, as cancelling the CLI does. Packaged apps
 * are not children of the CLI, so killing the run process alone leaves them open.
 */
export function stopLaunchedApp(processId: number, kill: (pid: number) => void = pid => process.kill(pid)): boolean {
	try {
		kill(processId);
		return true;
	} catch {
		return false;
	}
}

/**
 * Ends a `winapp run` session. When the app is stopped, the CLI sees it exit and
 * runs its own exit work, so it is only killed if it has not finished in time.
 */
export function endRun(
	runProcess: { kill(): unknown; once(event: 'close', listener: () => void): unknown }, processId: number, stopApp: boolean,
	stop: (pid: number) => boolean = stopLaunchedApp, graceMs = RUN_EXIT_GRACE_MS,
): void {
	if (!stopApp || !stop(processId)) {
		runProcess.kill();
		return;
	}
	const fallback = setTimeout(() => runProcess.kill(), graceMs);
	fallback.unref?.();
	runProcess.once('close', () => clearTimeout(fallback));
}

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
