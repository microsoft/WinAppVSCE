import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AssetCopyTokenStore } from '../manifest-editor/asset-copy-token-store';

describe('AssetCopyTokenStore', () => {
    it('returns the extension-approved path once for a valid token', () => {
        const store = new AssetCopyTokenStore();
        const sourcePath = 'C:\\Users\\user\\Pictures\\logo.png';
        const token = store.issue(sourcePath);

        assert.equal(store.consume(token), sourcePath);
        assert.equal(store.consume(token), undefined);
    });

    it('rejects a forged token', () => {
        const store = new AssetCopyTokenStore();

        assert.equal(store.consume('C:\\Users\\user\\secret.txt'), undefined);
    });

    it('issues distinct tokens without exposing the source path', () => {
        const store = new AssetCopyTokenStore();
        const sourcePath = 'C:\\Users\\user\\Pictures\\logo.png';

        const first = store.issue(sourcePath);
        const second = store.issue(sourcePath);

        assert.notEqual(first, second);
        assert.equal(first.includes(sourcePath), false);
        assert.equal(second.includes(sourcePath), false);
    });
});
