import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AssetCopyTokenStore } from '../manifest-editor/asset-copy-token-store';

describe('AssetCopyTokenStore', () => {
    it('returns the server-approved path for a valid token', () => {
        const store = new AssetCopyTokenStore();
        const sourcePath = 'C:\\Users\\user\\Pictures\\logo.png';

        const token = store.issue(sourcePath);

        assert.equal(store.consume(token), sourcePath);
    });

    it('rejects forged tokens', () => {
        const store = new AssetCopyTokenStore();

        assert.equal(store.consume('forged-token'), undefined);
    });

    it('invalidates a token after it is consumed', () => {
        const store = new AssetCopyTokenStore();
        const token = store.issue('C:\\Users\\user\\Pictures\\logo.png');

        assert.notEqual(store.consume(token), undefined);
        assert.equal(store.consume(token), undefined);
    });

    it('peek does not invalidate a token, so a cancelled confirmation can be retried', () => {
        // Regression for issue #71 / H1: cancelling the confirmation dialog must not
        // burn the token, since the webview link the user clicked keeps the same
        // token and may be re-clicked without a fresh checkImagePath round-trip.
        const store = new AssetCopyTokenStore();
        const sourcePath = 'C:\\Users\\user\\Pictures\\logo.png';
        const token = store.issue(sourcePath);

        assert.equal(store.peek(token), sourcePath);
        assert.equal(store.peek(token), sourcePath);

        // The re-click's copy still succeeds against the same, still-live token.
        assert.equal(store.consume(token), sourcePath);
        assert.equal(store.consume(token), undefined);
    });

    it('reuses and refreshes an existing live token for the same source path (dedup)', () => {
        // Repeated checkImagePath calls for the same path (e.g. debounced typing)
        // must not grow the store unbounded.
        const store = new AssetCopyTokenStore();
        const sourcePath = 'C:\\Users\\user\\Pictures\\logo.png';

        const first = store.issue(sourcePath);
        const second = store.issue(sourcePath);

        assert.equal(first, second);
    });

    it('expires a token after its TTL elapses', async () => {
        const store = new AssetCopyTokenStore(10 /* ttlMs */);
        const token = store.issue('C:\\Users\\user\\Pictures\\logo.png');

        await new Promise((resolve) => setTimeout(resolve, 25));

        assert.equal(store.peek(token), undefined);
        assert.equal(store.consume(token), undefined);
    });

    it('evicts the oldest token once the bounded capacity is exceeded', () => {
        const store = new AssetCopyTokenStore(5 * 60 * 1000, 2 /* maxTokens */);
        const first = store.issue('C:\\Users\\user\\Pictures\\one.png');
        const second = store.issue('C:\\Users\\user\\Pictures\\two.png');
        const third = store.issue('C:\\Users\\user\\Pictures\\three.png');

        assert.equal(store.peek(first), undefined, 'oldest token should have been evicted');
        // Positive assertions: tokens issued within the cap must stay live —
        // eviction should only ever remove the excess, never a token that
        // should still be usable.
        assert.equal(store.peek(second), 'C:\\Users\\user\\Pictures\\two.png');
        assert.equal(store.peek(third), 'C:\\Users\\user\\Pictures\\three.png');
    });

    it('keeps all tokens live while within the bounded capacity', () => {
        const store = new AssetCopyTokenStore(5 * 60 * 1000, 3 /* maxTokens */);
        const first = store.issue('C:\\Users\\user\\Pictures\\one.png');
        const second = store.issue('C:\\Users\\user\\Pictures\\two.png');
        const third = store.issue('C:\\Users\\user\\Pictures\\three.png');

        assert.equal(store.peek(first), 'C:\\Users\\user\\Pictures\\one.png');
        assert.equal(store.peek(second), 'C:\\Users\\user\\Pictures\\two.png');
        assert.equal(store.peek(third), 'C:\\Users\\user\\Pictures\\three.png');
    });

    describe('beginCopy / endCopy (overlapping-copy guard)', () => {
        it('claims a live token and returns its source path', () => {
            const store = new AssetCopyTokenStore();
            const sourcePath = 'C:\\Users\\user\\Pictures\\logo.png';
            const token = store.issue(sourcePath);

            assert.deepEqual(store.beginCopy(token), { status: 'ok', sourcePath });
        });

        it('reports "invalid" for an unknown or forged token', () => {
            const store = new AssetCopyTokenStore();

            assert.deepEqual(store.beginCopy('forged-token'), { status: 'invalid' });
        });

        it('reports "invalid" for an expired token', async () => {
            const store = new AssetCopyTokenStore(10 /* ttlMs */);
            const token = store.issue('C:\\Users\\user\\Pictures\\logo.png');

            await new Promise((resolve) => setTimeout(resolve, 25));

            assert.deepEqual(store.beginCopy(token), { status: 'invalid' });
        });

        it('rejects an overlapping claim on the same token while one copy is in flight (M3)', () => {
            // Regression for issue #71 / M3: two overlapping copyToAssets
            // requests for the same token (e.g. a rapid double-click) must not
            // both be allowed to proceed into a confirmation + fs.copyFileSync.
            const store = new AssetCopyTokenStore();
            const token = store.issue('C:\\Users\\user\\Pictures\\logo.png');

            assert.deepEqual(store.beginCopy(token), { status: 'ok', sourcePath: 'C:\\Users\\user\\Pictures\\logo.png' });
            assert.deepEqual(store.beginCopy(token), { status: 'pending' }, 'a second overlapping claim must not also succeed');
        });

        it('allows a retry after endCopy releases a cancelled confirmation (M3)', () => {
            // Regression for issue #71 / M3: cancelling the native confirmation
            // dialog must release the claim (without invalidating the token) so
            // a re-click on the same link can retry.
            const store = new AssetCopyTokenStore();
            const sourcePath = 'C:\\Users\\user\\Pictures\\logo.png';
            const token = store.issue(sourcePath);

            assert.deepEqual(store.beginCopy(token), { status: 'ok', sourcePath });
            store.endCopy(token); // simulates the user cancelling the confirmation

            assert.deepEqual(store.beginCopy(token), { status: 'ok', sourcePath });
            // The retried copy still succeeds against the same, still-live token.
            assert.equal(store.consume(token), sourcePath);
        });

        it('allows a retry after endCopy releases a failed copy (M3)', () => {
            // Regression for issue #71 / M3: a copy that throws (e.g. a
            // permissions or disk-full error) must release the claim so the
            // user can retry without a fresh checkImagePath round-trip.
            const store = new AssetCopyTokenStore();
            const sourcePath = 'C:\\Users\\user\\Pictures\\logo.png';
            const token = store.issue(sourcePath);

            const claim = store.beginCopy(token);
            assert.equal(claim.status, 'ok');
            // Simulate fs.copyFileSync throwing: the caller releases the claim
            // instead of consuming the token.
            store.endCopy(token);

            assert.deepEqual(store.beginCopy(token), { status: 'ok', sourcePath });
        });

        it('endCopy is a safe no-op for an already-consumed or unknown token', () => {
            const store = new AssetCopyTokenStore();
            const token = store.issue('C:\\Users\\user\\Pictures\\logo.png');
            store.consume(token);

            assert.doesNotThrow(() => store.endCopy(token));
            assert.doesNotThrow(() => store.endCopy('forged-token'));
        });
    });
});
