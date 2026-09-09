// Kept independent of the VS Code API for unit testing.

/**
 * The persistence surface a dismissal needs. Structurally satisfied by
 * `vscode.ExtensionContext.globalState`, so callers pass that directly.
 */
export interface DismissalStore {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<unknown>;
}

/** Persisted "Don't Show Again" state for a single notification. */
export interface NotificationDismissal {
  /** True once the user has dismissed this notification for good. */
  readonly isDismissed: boolean;
  /** Records the dismissal so the notification stops appearing. */
  dismiss(): Thenable<unknown>;
}

/**
 * Owns the persisted dismissal for one notification key.
 *
 * Only the storage of the flag is shared. The notifications that use it differ
 * too much to share a presentation helper: the Dev Kit recommendation is a
 * one-shot suggestion, while the degraded warning carries a multi-action model
 * and suppresses itself on cause transitions rather than on dismissal alone.
 *
 * A missing store yields a permanently undismissed flag whose {@link dismiss}
 * is a no-op, so callers holding an optional `ExtensionContext` do not each
 * repeat the same fallback.
 */
export function notificationDismissal(
  key: string,
  store: DismissalStore | undefined
): NotificationDismissal {
  return {
    isDismissed: store?.get<boolean>(key, false) ?? false,
    dismiss: () => store?.update(key, true) ?? Promise.resolve(),
  };
}
