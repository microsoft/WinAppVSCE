export interface DisposableLike {
	dispose(): void;
}

export interface CancellationTokenLike {
	readonly isCancellationRequested: boolean;
	onCancellationRequested(listener: () => void): DisposableLike;
}

export type CancellationResult<T> =
	| { cancelled: true; value: undefined }
	| { cancelled: false; value: T };

function isCancellationError(error: unknown): boolean {
	return typeof error === 'object'
		&& error !== null
		&& 'name' in error
		&& (error.name === 'AbortError' || error.name === 'CancellationError' || error.name === 'Canceled');
}

/**
 * Adapts a structural cancellation token to an AbortSignal for one operation.
 */
export async function runWithCancellation<T>(
	token: CancellationTokenLike,
	operation: (signal: AbortSignal) => Promise<T>
): Promise<CancellationResult<T>> {
	const abortController = new AbortController();
	const cancellation = token.onCancellationRequested(() => abortController.abort());

	try {
		if (token.isCancellationRequested) {
			abortController.abort();
		}
		if (abortController.signal.aborted) {
			return { cancelled: true, value: undefined };
		}

		try {
			const value = await operation(abortController.signal);
			return abortController.signal.aborted
				? { cancelled: true, value: undefined }
				: { cancelled: false, value };
		} catch (error) {
			if (abortController.signal.aborted && isCancellationError(error)) {
				return { cancelled: true, value: undefined };
			}
			throw error;
		}
	} finally {
		cancellation.dispose();
	}
}
