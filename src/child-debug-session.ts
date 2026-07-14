import type { NoOpDebugAdapterOptions } from './noop-debug-adapter';

type StartChildDebugging = () => PromiseLike<boolean>;
type CleanupRunProcess = () => void;
type CreateChildStartFailureAdapter<T> = (options: NoOpDebugAdapterOptions) => T;
type ContinueLaunch<T> = () => T | Promise<T>;

export function createChildDebugStartFailureMessage(debuggerType: string): string {
	return `Failed to start the "${debuggerType}" child debugger session.`;
}

export async function continueIfChildDebugStarted<T>(
	debuggerType: string,
	startChildDebugging: StartChildDebugging,
	cleanupRunProcess: CleanupRunProcess,
	createChildStartFailureAdapter: CreateChildStartFailureAdapter<T>,
	continueLaunch: ContinueLaunch<T>
): Promise<T> {
	let childStarted: boolean;
	try {
		childStarted = await startChildDebugging();
	} catch (error) {
		cleanupRunProcess();
		throw error;
	}

	if (!childStarted) {
		cleanupRunProcess();
		return createChildStartFailureAdapter({
			launchErrorMessage: createChildDebugStartFailureMessage(debuggerType)
		});
	}

	return continueLaunch();
}
