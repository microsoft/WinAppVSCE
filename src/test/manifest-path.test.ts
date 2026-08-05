import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isManifestPath } from '../manifest-schema/manifest-path';

describe('isManifestPath', () => {
    it('matches AppxManifest.xml and .appxmanifest paths case-insensitively', () => {
        assert.equal(isManifestPath('C:\\project\\AppxManifest.xml'), true);
        assert.equal(isManifestPath('C:\\project\\appxmanifest.xml'), true);
        assert.equal(isManifestPath('C:\\project\\MyApp.appxmanifest'), true);
        assert.equal(isManifestPath('C:\\project\\myapp.APPXMANIFEST'), true);
        assert.equal(isManifestPath('/unix/path/AppxManifest.xml'), true);
    });

    it('rejects non-manifest paths', () => {
        assert.equal(isManifestPath('C:\\project\\package.json'), false);
        assert.equal(isManifestPath('C:\\project\\manifest.xml'), false);
        assert.equal(isManifestPath('C:\\project\\AppxManifest.xml.bak'), false);
        assert.equal(isManifestPath(''), false);
    });
});
