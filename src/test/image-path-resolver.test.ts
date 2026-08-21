/**
 * Unit tests for the manifest image-path branch selection used by the editor's
 * `checkImagePath` handler.
 *
 * Covers the branches that used to live inline in the webview message switch and had no
 * direct coverage: the package hit, the `..\`-escaping workspace fallback, the external
 * copy-to-Assets offer, and paths that resolve nowhere.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveManifestImagePath } from '../manifest-editor/image-path-resolver';

let tmpDir: string;
let workspaceDir: string;
let manifestDir: string;
let outsideDir: string;

/** Creates an empty file, making parent directories as needed. */
function write(relative: string): string {
    const full = path.join(tmpDir, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '');
    return full;
}

describe('resolveManifestImagePath', () => {
    before(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'winapp-imgpath-'));
        workspaceDir = path.join(tmpDir, 'workspace');
        manifestDir = path.join(workspaceDir, 'app');
        outsideDir = path.join(tmpDir, 'outside');

        write('workspace/app/Assets/MrtLogo.scale-200.png');
        write('workspace/app/Assets/PlainLogo.png');
        write('workspace/Shared/SharedLogo.scale-200.png');
        write('outside/External.png');
        write('outside/ExternalMrt.scale-200.png');
    });

    after(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const resolve = (imagePath: string) =>
        resolveManifestImagePath(manifestDir, imagePath, [workspaceDir]);

    it('reports an in-package MRT variant as found', () => {
        const outcome = resolve('Assets\\MrtLogo.png');

        assert.equal(outcome.status, 'found');
        assert.equal(outcome.status === 'found' && outcome.resolution.isExact, false);
        assert.equal(
            outcome.status === 'found' && path.basename(outcome.resolution.resolvedPath),
            'MrtLogo.scale-200.png',
        );
    });

    it('reports an in-package literal file as found and exact', () => {
        const outcome = resolve('Assets\\PlainLogo.png');

        assert.equal(outcome.status, 'found');
        assert.equal(outcome.status === 'found' && outcome.resolution.isExact, true);
    });

    it('resolves a workspace-relative reference that escapes the package', () => {
        const outcome = resolve('..\\Shared\\SharedLogo.png');

        assert.equal(outcome.status, 'found');
        assert.equal(
            outcome.status === 'found' && path.basename(outcome.resolution.resolvedPath),
            'SharedLogo.scale-200.png',
        );
    });

    it('offers to copy an existing file outside the package', () => {
        const outcome = resolveManifestImagePath(manifestDir, path.join(outsideDir, 'External.png'), [workspaceDir]);

        assert.equal(outcome.status, 'external');
        assert.equal(outcome.status === 'external' && path.basename(outcome.sourcePath), 'External.png');
    });

    // Copying a variant would rewrite the manifest to "Assets\ExternalMrt.scale-200.png",
    // which is a qualified name the user never typed and MRT would then re-qualify.
    it('does not offer to copy an out-of-package MRT variant', () => {
        const outcome = resolveManifestImagePath(manifestDir, path.join(outsideDir, 'ExternalMrt.png'), [workspaceDir]);

        assert.equal(outcome.status, 'notFound');
    });

    it('reports genuinely missing references as not found', () => {
        assert.equal(resolve('Assets\\DoesNotExist.png').status, 'notFound');
        assert.equal(resolve('').status, 'notFound');
    });

    it('does not use the workspace fallback for plain relative references', () => {
        // "Shared\SharedLogo.png" means app\Shared\..., not workspace\Shared\...
        assert.equal(resolve('Shared\\SharedLogo.png').status, 'notFound');
    });

    it('treats an extensionless value as an MRT key rather than a file', () => {
        assert.equal(resolve('Assets\\MrtLogo').status, 'notFound');
    });

    it('does not resolve outside the workspace when no folder is open', () => {
        const outcome = resolveManifestImagePath(manifestDir, '..\\Shared\\SharedLogo.png', []);

        assert.equal(outcome.status, 'notFound');
    });
});
