import * as crypto from 'crypto';

/** Tokens expire after this long if never consumed, so the store can't grow unbounded. */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** Hard cap on concurrently outstanding tokens; the oldest is evicted first past this. */
const DEFAULT_MAX_TOKENS = 50;

interface TokenEntry {
    sourcePath: string;
    expiresAt: number;
    /** True while a copy authorized by this token is actively being confirmed/copied. */
    pending: boolean;
}

/** Result of {@link AssetCopyTokenStore.beginCopy}. */
export type BeginCopyResult =
    | { status: 'ok'; sourcePath: string }
    /** A copy against this same token is already in flight (e.g. an overlapping double-click). */
    | { status: 'pending' }
    /** The token is unknown, expired, or evicted. */
    | { status: 'invalid' };

/**
 * Tracks single-use, time-limited tokens that authorize copying one external
 * file path into the workspace's Assets folder (see issue #71). `issue()`
 * deduplicates repeated calls for the same path (e.g. from debounced
 * `checkImagePath` messages while a user types) so the store stays bounded by
 * `maxTokens` and `ttlMs` without needing a background sweep timer — expired
 * and excess entries are pruned lazily on the next `issue`/`peek`/`consume`.
 *
 * `peek()` is non-destructive so a pending native confirmation dialog can be
 * cancelled without invalidating the token — a re-click retries against the
 * same authorization. `consume()` should only be called once the copy it
 * authorizes has actually succeeded, making the token single-use per copy.
 *
 * `beginCopy()`/`endCopy()` guard the confirm-then-copy window so two
 * overlapping requests for the *same* token (a rapid double-click, or a
 * duplicated webview message) can't both pass the confirmation dialog and
 * race `fs.copyFileSync` concurrently. `endCopy()` releases the claim without
 * consuming the token so the copy can be retried after a cancelled
 * confirmation or a failed copy.
 */
export class AssetCopyTokenStore {
    private readonly entries = new Map<string, TokenEntry>();

    constructor(
        private readonly ttlMs: number = DEFAULT_TTL_MS,
        private readonly maxTokens: number = DEFAULT_MAX_TOKENS,
    ) {}

    /** Issues a token for sourcePath, reusing and refreshing a live token already issued for the same path. */
    public issue(sourcePath: string): string {
        this.pruneExpired();

        for (const [token, entry] of this.entries) {
            if (entry.sourcePath === sourcePath) {
                entry.expiresAt = Date.now() + this.ttlMs;
                return token;
            }
        }

        if (this.entries.size >= this.maxTokens) {
            const oldestToken = this.entries.keys().next().value;
            if (oldestToken !== undefined) {
                this.entries.delete(oldestToken);
            }
        }

        const token = crypto.randomBytes(32).toString('hex');
        this.entries.set(token, { sourcePath, expiresAt: Date.now() + this.ttlMs, pending: false });
        return token;
    }

    /** Returns the source path for a live token without invalidating it. */
    public peek(token: string): string | undefined {
        this.pruneExpired();
        return this.entries.get(token)?.sourcePath;
    }

    /**
     * Atomically claims a live token for a copy that's about to start. Returns
     * `{ status: 'invalid' }` for an unknown/expired/evicted token, or
     * `{ status: 'pending' }` if a copy against this token is already in
     * flight — callers should treat that as a no-op, not an error, since it's
     * just an overlapping duplicate of a copy that's already proceeding.
     * Otherwise marks the token pending and returns its source path.
     */
    public beginCopy(token: string): BeginCopyResult {
        this.pruneExpired();
        const entry = this.entries.get(token);
        if (!entry) {
            return { status: 'invalid' };
        }
        if (entry.pending) {
            return { status: 'pending' };
        }
        entry.pending = true;
        return { status: 'ok', sourcePath: entry.sourcePath };
    }

    /**
     * Releases a claim taken by `beginCopy` without invalidating the token,
     * so a cancelled confirmation or a failed copy can be retried against the
     * same authorization. Safe to call on an already-consumed/expired token.
     */
    public endCopy(token: string): void {
        const entry = this.entries.get(token);
        if (entry) {
            entry.pending = false;
        }
    }

    /** Invalidates a token after it has been used (e.g. a successful copy). */
    public consume(token: string): string | undefined {
        this.pruneExpired();
        const entry = this.entries.get(token);
        if (!entry) {
            return undefined;
        }
        this.entries.delete(token);
        return entry.sourcePath;
    }

    private pruneExpired(): void {
        const now = Date.now();
        for (const [token, entry] of this.entries) {
            if (entry.expiresAt <= now) {
                this.entries.delete(token);
            }
        }
    }
}
