// Kept independent of the VS Code API for unit testing.

/** Mirrors vscode-languageclient's ErrorAction.Shutdown and CloseAction.DoNotRestart. */
export const ERROR_ACTION_SHUTDOWN = 2;
export const CLOSE_ACTION_DO_NOT_RESTART = 1;

export interface HandlerResult {
  action: number;
  message?: string;
  handled?: boolean;
}

export interface ErrorHandlerLike<TError, TMessage> {
  error(
    error: TError,
    message: TMessage | undefined,
    count: number | undefined
  ): HandlerResult | Promise<HandlerResult>;
  closed(): HandlerResult | Promise<HandlerResult>;
}

/**
 * Wraps the client's default handler so a stop that will not be retried is reported through
 * onFinalStop, which can offer Restart, instead of the client's "Go to output" toast.
 */
export function reportFinalStops<TError, TMessage>(
  inner: ErrorHandlerLike<TError, TMessage>,
  onFinalStop: (reason: string | undefined) => void
): ErrorHandlerLike<TError, TMessage> {
  return {
    async error(error, message, count) {
      const result = await inner.error(error, message, count);
      if (result.action !== ERROR_ACTION_SHUTDOWN) {
        return result;
      }
      onFinalStop(result.message);
      return { ...result, handled: true };
    },
    async closed() {
      const result = await inner.closed();
      if (result.action !== CLOSE_ACTION_DO_NOT_RESTART) {
        return result;
      }
      onFinalStop(result.message);
      return { ...result, handled: true };
    },
  };
}

/**
 * Calls onFinal if the client is still stopped a tick after reporting Stopped. An automatic
 * restart passes through Stopped but re-enters Starting synchronously; a failed relaunch does not.
 */
export function confirmFinalStop(
  isStillStopped: () => boolean,
  onFinal: () => void,
  defer: (callback: () => void) => void = (callback) => setTimeout(callback, 0)
): void {
  defer(() => {
    if (isStillStopped()) {
      onFinal();
    }
  });
}
