import type { NoOpDebugAdapterOptions } from './noop-debug-adapter';

type EnsureDebuggerExtensionInstalled = (debuggerType: string) => Promise<boolean>;
type CreateMissingDebuggerAdapter<T> = (options: NoOpDebugAdapterOptions) => T;
type ContinueLaunch<T> = () => T | Promise<T>;

export function createMissingDebuggerLaunchErrorMessage(debuggerType: string): string {
	return `The "${debuggerType}" debugger extension is not installed.`;
}

export async function continueIfDebuggerExtensionInstalled<T>(
	debuggerType: string,
	ensureDebuggerExtensionInstalled: EnsureDebuggerExtensionInstalled,
	createMissingDebuggerAdapter: CreateMissingDebuggerAdapter<T>,
	continueLaunch: ContinueLaunch<T>
): Promise<T> {
	if (!await ensureDebuggerExtensionInstalled(debuggerType)) {
		return createMissingDebuggerAdapter({
			launchErrorMessage: createMissingDebuggerLaunchErrorMessage(debuggerType)
		});
	}

	return continueLaunch();
}
