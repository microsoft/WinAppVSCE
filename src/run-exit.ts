/**
 * How a `winapp run` launch ended, and the error each outcome produces.
 *
 * Deliberately free of `vscode` imports. Deciding whether a user sees a red
 * error toast or nothing at all is the part most worth testing, and keeping it
 * pure means it can be unit-tested without a VS Code host.
 */

/** Preserves failed run output so callers can offer the output channel. */
export class WinAppRunFailure extends Error { }

/**
 * A launch the user cancelled.
 *
 * Dismissing a prompt or pressing Cancel is a decision, not a failure, so this
 * is thrown instead of a plain `Error` to mark the difference. `extension.ts`
 * lets it end the debug session quietly rather than blaming the user with a
 * "Failed to launch and attach" toast.
 */
export class DebugLaunchCancelled extends Error {
	constructor() {
		// VS Code recognizes cancellation across the extension-host boundary
		// only when both fields use its canonical spelling.
		super('Canceled');
		this.name = 'Canceled';
	}
}

export interface RunExit {
	/** Process exit code, or `null` when it was terminated by a signal. */
	code: number | null;
	/** The user cancelled the progress notification. */
	cancelled: boolean;
	/** The CLI's own one-line reason (its JSON `Error`), when it reported one. */
	detail?: string;
}

/** A toast holds a sentence, not a stack trace or build log. */
const MAX_DETAIL_LENGTH = 300;

/**
 * Turns a finished `winapp run` into the error to reject with.
 *
 * Only called when the run ended *without* reporting a process ID — a run that
 * reported one has already resolved, so every outcome here is a failure of
 * some kind.
 */
export function classifyRunExit({ code, cancelled, detail }: RunExit): Error {
	if (cancelled) {
		return new DebugLaunchCancelled();
	}
	const reason = summarizeDetail(detail);
	if (code !== 0) {
		// The full output is already in the channel; only the CLI's own reason belongs in a toast.
		return new WinAppRunFailure(reason ?? `winapp run failed with exit code ${code}.`);
	}
	return new WinAppRunFailure(reason ?? 'winapp run exited before reporting a process ID to attach to.');
}

function summarizeDetail(detail: string | undefined): string | undefined {
	const text = detail?.replace(/\s+/g, ' ').trim();
	if (!text) { return undefined; }
	return text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH - 1)}\u2026` : text;
}
