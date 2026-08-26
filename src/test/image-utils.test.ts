/**
 * Unit tests for the manifest editor's image utilities: MRT (Modern Resource Technology)
 * asset resolution, editor branch selection, and aspect-ratio checking.
 *
 * The qualifier-grammar suites mirror the WinApp CLI's MrtAssetHelperTests so both
 * implementations stay in agreement. Regression coverage for issue #191: a manifest
 * referencing the unqualified asset name must not be flagged as broken when only
 * qualifier-suffixed files exist on disk.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    isSingleQualifierToken,
    isQualifierToken,
    isMrtVariantName,
    getMrtVariantBaseName,
    getVariantQualifiers,
    getVariantScale,
    hasTargetSizeQualifier,
    resolveMrtAsset,
    resolveManifestImagePath,
    isPathWithin,
    getImageDimensions,
    checkAspectRatio,
} from '../manifest-editor/image-utils';

describe('isSingleQualifierToken', () => {
    const valid = [
        'scale-100', 'scale-200', 'scale-400',
        'targetsize-16', 'targetsize-24', 'targetsize-256',
        'altform-unplated', 'altform-lightunplated',
        'theme-light', 'theme-dark',
        'contrast-standard', 'contrast-high',
        'dxfeaturelevel-9', 'dxfeaturelevel-10', 'dxfeaturelevel-11',
        'device-family-desktop', 'device-family-xbox',
        'homeregion-US', 'homeregion-JP',
        'configuration-debug', 'configuration-retail',
        'en', 'en-US', 'zh-Hans', 'pt-BR',
        'ltr', 'rtl',
    ];
    for (const token of valid) {
        it(`accepts ${token}`, () => assert.equal(isSingleQualifierToken(token), true));
    }

    const invalid = ['', 'scale-', 'scale-abc', 'targetsize-', 'theme-blue', 'contrast-medium', 'dxfeaturelevel-12', 'backup', 'Extra1'];
    for (const token of invalid) {
        it(`rejects ${JSON.stringify(token)}`, () => assert.equal(isSingleQualifierToken(token), false));
    }
});

describe('isQualifierToken', () => {
    it('accepts compound qualifiers', () => {
        assert.equal(isQualifierToken('targetsize-24_altform-unplated'), true);
        assert.equal(isQualifierToken('scale-200_theme-dark'), true);
    });

    it('rejects a compound qualifier with an invalid part', () => {
        assert.equal(isQualifierToken('targetsize-24_backup'), false);
    });
});

describe('isMrtVariantName', () => {
    it('accepts the exact unqualified name', () => {
        assert.equal(isMrtVariantName('Logo', 'Logo'), true);
    });

    it('accepts scale variants', () => {
        assert.equal(isMrtVariantName('Square150x150Logo', 'Square150x150Logo.scale-200'), true);
    });

    it('accepts compound targetsize/altform variants', () => {
        assert.equal(isMrtVariantName('Square44x44Logo', 'Square44x44Logo.targetsize-24_altform-unplated'), true);
        assert.equal(isMrtVariantName('Square44x44Logo', 'Square44x44Logo.targetsize-24_altform-lightunplated'), true);
    });

    it('accepts multiple chained qualifiers', () => {
        assert.equal(isMrtVariantName('Logo', 'Logo.scale-200.theme-dark'), true);
    });

    it('is case-insensitive on the base name', () => {
        assert.equal(isMrtVariantName('logo', 'Logo.scale-200'), true);
    });

    it('rejects non-variant siblings', () => {
        assert.equal(isMrtVariantName('Logo', 'Logo.backup'), false);
        assert.equal(isMrtVariantName('Logo', 'LogoExtra'), false);
        assert.equal(isMrtVariantName('Logo', 'OtherLogo.scale-200'), false);
    });

    it('rejects empty inputs', () => {
        assert.equal(isMrtVariantName('', 'Logo'), false);
        assert.equal(isMrtVariantName('Logo', ''), false);
    });
});

describe('getMrtVariantBaseName', () => {
    it('strips trailing qualifiers', () => {
        assert.equal(getMrtVariantBaseName('Logo.scale-100'), 'Logo');
        assert.equal(getMrtVariantBaseName('Logo.targetsize-24_altform-unplated'), 'Logo');
        assert.equal(getMrtVariantBaseName('Logo.scale-200.theme-dark'), 'Logo');
    });

    it('preserves non-qualifier dots', () => {
        assert.equal(getMrtVariantBaseName('Assets.Logo.scale-200'), 'Assets.Logo');
        assert.equal(getMrtVariantBaseName('Logo.backup'), 'Logo.backup');
    });

    it('returns unqualified names unchanged', () => {
        assert.equal(getMrtVariantBaseName('Logo'), 'Logo');
    });
});

describe('getVariantQualifiers / getVariantScale / hasTargetSizeQualifier', () => {
    it('splits compound qualifiers into tokens', () => {
        assert.deepEqual(
            getVariantQualifiers('Square44x44Logo', 'Square44x44Logo.targetsize-24_altform-unplated'),
            ['targetsize-24', 'altform-unplated'],
        );
    });

    it('returns no qualifiers for the exact name', () => {
        assert.deepEqual(getVariantQualifiers('Logo', 'Logo'), []);
    });

    it('reads the scale factor', () => {
        assert.equal(getVariantScale(['scale-200']), 200);
        assert.equal(getVariantScale(['targetsize-24', 'altform-unplated']), null);
    });

    it('detects targetsize qualifiers', () => {
        assert.equal(hasTargetSizeQualifier(['targetsize-24', 'altform-unplated']), true);
        assert.equal(hasTargetSizeQualifier(['scale-200']), false);
    });
});

// ─── Filesystem resolution ──────────────────────────────

let tmpDir: string;

function write(relative: string): string {
    const full = path.join(tmpDir, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '');
    return full;
}

describe('resolveMrtAsset', () => {
    before(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrt-assets-'));
    });

    after(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('finds MRT variants when the unqualified file does not exist (issue #191)', () => {
        write('app1/Assets/Square150x150Logo.scale-100.png');
        write('app1/Assets/Square150x150Logo.scale-200.png');
        write('app1/Assets/Square150x150Logo.scale-400.png');

        const result = resolveMrtAsset(path.join(tmpDir, 'app1'), 'Assets\\Square150x150Logo.png');

        assert.ok(result, 'expected the reference to resolve via MRT variants');
        assert.equal(result.isExact, false);
        // scale-200 is the preferred preview variant
        assert.equal(path.basename(result.resolvedPath), 'Square150x150Logo.scale-200.png');
        assert.deepEqual(result.qualifiers, ['scale-200']);
    });

    it('prefers the exact file when it exists', () => {
        write('app2/Assets/Logo.png');
        write('app2/Assets/Logo.scale-200.png');

        const result = resolveMrtAsset(path.join(tmpDir, 'app2'), 'Assets\\Logo.png');

        assert.ok(result);
        assert.equal(result.isExact, true);
        assert.equal(path.basename(result.resolvedPath), 'Logo.png');
        assert.deepEqual(result.qualifiers, []);
    });

    it('falls back to the exact file when no variants exist', () => {
        write('app3/Assets/StoreLogo.png');

        const result = resolveMrtAsset(path.join(tmpDir, 'app3'), 'Assets\\StoreLogo.png');

        assert.ok(result);
        assert.equal(result.isExact, true);
    });

    it('excludes non-variant files', () => {
        write('app4/Assets/Logo.backup.png');
        write('app4/Assets/LogoExtra.png');

        const result = resolveMrtAsset(path.join(tmpDir, 'app4'), 'Assets\\Logo.png');

        assert.equal(result, null);
    });

    it('includes unplated and light-unplated targetsize variants', () => {
        write('app5/Assets/Square44x44Logo.targetsize-24_altform-unplated.png');
        write('app5/Assets/Square44x44Logo.targetsize-24_altform-lightunplated.png');
        write('app5/Assets/Square44x44Logo.scale-200.png');

        const result = resolveMrtAsset(path.join(tmpDir, 'app5'), 'Assets\\Square44x44Logo.png');

        assert.ok(result);
        // The plain scaled variant is preferred over altform variants for preview
        assert.equal(path.basename(result.resolvedPath), 'Square44x44Logo.scale-200.png');
    });

    it('resolves an unplated-only asset family', () => {
        write('app6/Assets/BadgeLogo.targetsize-24_altform-unplated.png');

        const result = resolveMrtAsset(path.join(tmpDir, 'app6'), 'Assets\\BadgeLogo.png');

        assert.ok(result);
        assert.equal(result.isExact, false);
        assert.deepEqual(result.qualifiers, ['targetsize-24', 'altform-unplated']);
    });

    it('resolves qualifier-folder layouts', () => {
        write('app7/Assets/scale-200/SplashScreen.png');
        write('app7/Assets/scale-100/SplashScreen.png');

        const result = resolveMrtAsset(path.join(tmpDir, 'app7'), 'Assets\\SplashScreen.png');

        assert.ok(result);
        assert.equal(result.isExact, false);
        assert.equal(path.dirname(result.resolvedPath).endsWith('scale-200'), true);
    });

    it('resolves compound qualifier-folder names', () => {
        write('app7b/Assets/scale-200_contrast-high/SplashScreen.png');

        const result = resolveMrtAsset(path.join(tmpDir, 'app7b'), 'Assets\\SplashScreen.png');

        assert.ok(result);
        assert.deepEqual(result.qualifiers, ['scale-200', 'contrast-high']);
    });

    it('ignores folders whose names are not qualifiers', () => {
        write('app7c/Assets/backup/SplashScreen.png');

        assert.equal(resolveMrtAsset(path.join(tmpDir, 'app7c'), 'Assets\\SplashScreen.png'), null);
    });

    it('prefers sibling variants over qualifier-folder variants', () => {
        write('app7d/Assets/Logo.scale-100.png');
        write('app7d/Assets/scale-400/Logo.png');

        const result = resolveMrtAsset(path.join(tmpDir, 'app7d'), 'Assets\\Logo.png');

        assert.ok(result);
        assert.equal(path.basename(result.resolvedPath), 'Logo.scale-100.png');
    });

    it('handles forward-slash and subdirectory references', () => {
        write('app8/Assets/Nested/Logo.scale-200.png');

        const result = resolveMrtAsset(path.join(tmpDir, 'app8'), 'Assets/Nested/Logo.png');

        assert.ok(result);
        assert.equal(result.relativePath.replace(/\\/g, '/'), 'Assets/Nested/Logo.scale-200.png');
    });

    it('matches variants only within the same extension', () => {
        write('app9/Assets/Logo.scale-200.jpg');

        assert.equal(resolveMrtAsset(path.join(tmpDir, 'app9'), 'Assets\\Logo.png'), null);
        assert.ok(resolveMrtAsset(path.join(tmpDir, 'app9'), 'Assets\\Logo.jpg'));
    });

    it('returns null for a missing directory, empty path, or extensionless MRT key', () => {
        assert.equal(resolveMrtAsset(path.join(tmpDir, 'nope'), 'Assets\\Logo.png'), null);
        assert.equal(resolveMrtAsset(tmpDir, ''), null);
        write('app10/Assets/StoreLogo.scale-200.png');
        assert.equal(resolveMrtAsset(path.join(tmpDir, 'app10'), 'Assets\\StoreLogo'), null);
    });

    it('does not treat a directory as a resolved file', () => {
        fs.mkdirSync(path.join(tmpDir, 'app11', 'Assets', 'Logo.png'), { recursive: true });

        assert.equal(resolveMrtAsset(path.join(tmpDir, 'app11'), 'Assets\\Logo.png'), null);
    });

    // Parity check, not an endorsement: MrtAssetHelper.IsMrtVariantName in the WinApp CLI
    // compares only the first dot-separated segment, so a base name containing dots never
    // matches its own variants. Pinned here so the two implementations can't silently diverge.
    it('matches the CLI by not resolving variants of a dotted base name', () => {
        write('app12/Assets/Contoso.Logo.scale-200.png');

        assert.equal(resolveMrtAsset(path.join(tmpDir, 'app12'), 'Assets\\Contoso.Logo.png'), null);
    });

    it('skips variant probing outside the allowed probe roots', () => {
        write('app13/Assets/Logo.scale-200.png');
        write('app13/Assets/Exact.png');
        const appDir = path.join(tmpDir, 'app13');

        // Probing is confined to the app directory, so a reference escaping it gets the
        // literal check only — no readdir of an arbitrary (or UNC) directory.
        assert.equal(resolveMrtAsset(appDir, 'Assets\\Logo.png', { probeRoots: [path.join(tmpDir, 'other')] }), null);
        assert.ok(resolveMrtAsset(appDir, 'Assets\\Logo.png', { probeRoots: [appDir] }));
        // The literal file still resolves regardless of probe roots.
        assert.ok(resolveMrtAsset(appDir, 'Assets\\Exact.png', { probeRoots: [] })?.isExact);
    });
});

describe('checkAspectRatio with MRT qualifiers', () => {
    it('accepts a scale-200 square logo at 2× the base size', () => {
        assert.equal(checkAspectRatio('visualElements.square150x150Logo', 300, 300, ['scale-200']), null);
    });

    it('accepts a scale-200 wide logo at 2× the base size', () => {
        assert.equal(checkAspectRatio('visualElements.wide310x150Logo', 620, 300, ['scale-200']), null);
    });

    it('does not flag a square targetsize variant of a wide field', () => {
        assert.equal(checkAspectRatio('visualElements.wide310x150Logo', 24, 24, ['targetsize-24', 'altform-unplated']), null);
    });

    it('still flags a genuinely wrong aspect ratio', () => {
        const warning = checkAspectRatio('visualElements.square150x150Logo', 300, 100, ['scale-200']);
        assert.equal(typeof warning, 'string');
        assert.equal(warning!.includes('1:1'), true);
    });

    it('ignores fields without an expected ratio', () => {
        assert.equal(checkAspectRatio('visualElements.unknownLogo', 10, 99), null);
    });
});

// ─── Editor branch selection ────────────────────────────

/**
 * Covers the branches that used to live inline in the webview `checkImagePath` switch: the
 * package hit, the `..\`-escaping workspace fallback, the external copy-to-Assets offer, and
 * paths that resolve nowhere.
 */
describe('resolveManifestImagePath', () => {
    let pathTmpDir: string;
    let workspaceDir: string;
    let manifestDir: string;
    let outsideDir: string;

    const writeUnder = (relative: string): void => {
        const full = path.join(pathTmpDir, relative);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, '');
    };

    before(() => {
        pathTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'winapp-imgpath-'));
        workspaceDir = path.join(pathTmpDir, 'workspace');
        manifestDir = path.join(workspaceDir, 'app');
        outsideDir = path.join(pathTmpDir, 'outside');

        writeUnder('workspace/app/Assets/MrtLogo.scale-200.png');
        writeUnder('workspace/app/Assets/PlainLogo.png');
        writeUnder('workspace/Shared/SharedLogo.scale-200.png');
        writeUnder('outside/External.png');
        writeUnder('outside/ExternalMrt.scale-200.png');
    });

    after(() => {
        fs.rmSync(pathTmpDir, { recursive: true, force: true });
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

    // resolveMrtAsset returns a literal file before it consults probeRoots, so the workspace
    // fallback has to re-check containment itself or a ..\ chain reaches anywhere on disk.
    it('does not let the workspace fallback resolve outside the workspace root', () => {
        // Escapes `workspace` when resolved from the workspace root, but stays inside
        // pathTmpDir, so the file genuinely exists — only containment can reject it.
        const outcome = resolve('..\\outside\\External.png');

        assert.notEqual(outcome.status, 'found');
    });
});

// ─── Path containment ───────────────────────────────────

/**
 * `isPathWithin` gates every directory enumeration MRT probing performs, so its failure
 * modes are security-relevant rather than cosmetic.
 */
describe('isPathWithin', () => {
    const root = path.join('C:', 'pkg');

    it('accepts the root itself and its descendants', () => {
        assert.equal(isPathWithin(root, root), true);
        assert.equal(isPathWithin(root, path.join(root, 'Assets')), true);
        assert.equal(isPathWithin(root, path.join(root, 'Assets', 'scale-200', 'Logo.png')), true);
    });

    it('rejects a sibling whose name merely starts with the root', () => {
        assert.equal(isPathWithin(root, path.join('C:', 'pkg-evil', 'Logo.png')), false);
        assert.equal(isPathWithin(root, path.join('C:', 'pkgevil')), false);
    });

    it('rejects parents and ..-traversal back out of the root', () => {
        assert.equal(isPathWithin(root, path.join('C:', 'Windows', 'System32')), false);
        assert.equal(isPathWithin(root, path.join(root, '..', 'other', 'Logo.png')), false);
        assert.equal(isPathWithin(root, path.join(root, 'Assets', '..', '..', 'Logo.png')), false);
    });

    it('ignores a trailing separator on the root', () => {
        assert.equal(isPathWithin(root + path.sep, path.join(root, 'Assets')), true);
    });

    it('rejects an empty root rather than matching everything', () => {
        assert.equal(isPathWithin('', path.join(root, 'Logo.png')), false);
    });
});

// ─── Image header parsing ───────────────────────────────

describe('getImageDimensions', () => {
    let dimTmpDir: string;

    const writeBytes = (name: string, bytes: number[]): string => {
        const full = path.join(dimTmpDir, name);
        fs.writeFileSync(full, Buffer.from(bytes));
        return full;
    };

    /** Minimal PNG: 8-byte signature, IHDR length/type, then width and height. */
    const png = (width: number, height: number): number[] => {
        const buf = Buffer.alloc(32);
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).copy(buf, 0);
        buf.writeUInt32BE(13, 8);
        buf.write('IHDR', 12, 'ascii');
        buf.writeUInt32BE(width, 16);
        buf.writeUInt32BE(height, 20);
        return [...buf];
    };

    /** Minimal JPEG: SOI followed directly by an SOF0 frame header. */
    const jpeg = (width: number, height: number): number[] => {
        const buf = Buffer.alloc(24);
        buf.writeUInt16BE(0xFFD8, 0);
        buf.writeUInt16BE(0xFFC0, 2);
        buf.writeUInt16BE(17, 4);
        buf.writeUInt8(8, 6);
        buf.writeUInt16BE(height, 7);
        buf.writeUInt16BE(width, 9);
        return [...buf];
    };

    before(() => {
        dimTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'winapp-imgdim-'));
    });

    after(() => {
        fs.rmSync(dimTmpDir, { recursive: true, force: true });
    });

    it('reads PNG dimensions', () => {
        assert.deepEqual(getImageDimensions(writeBytes('logo.png', png(310, 150))), { width: 310, height: 150 });
    });

    it('reads JPEG SOF0 dimensions', () => {
        assert.deepEqual(getImageDimensions(writeBytes('logo.jpg', jpeg(600, 400))), { width: 600, height: 400 });
    });

    it('reads a JPEG SOF2 (progressive) frame header', () => {
        const bytes = jpeg(120, 90);
        bytes[3] = 0xC2;

        assert.deepEqual(getImageDimensions(writeBytes('progressive.jpg', bytes)), { width: 120, height: 90 });
    });

    it('returns null for a truncated PNG instead of reporting 0x0', () => {
        assert.equal(getImageDimensions(writeBytes('cut.png', png(64, 64).slice(0, 16))), null);
    });

    it('returns null for a JPEG whose segment length would never advance', () => {
        // A zero-length segment used to spin the marker walk forever.
        const bytes = [...Buffer.alloc(24)];
        bytes[0] = 0xFF; bytes[1] = 0xD8;
        bytes[2] = 0xFF; bytes[3] = 0xE0;
        bytes[4] = 0x00; bytes[5] = 0x00;

        assert.equal(getImageDimensions(writeBytes('stuck.jpg', bytes)), null);
    });

    it('returns null for an unsupported format, an empty file, and a missing file', () => {
        assert.equal(getImageDimensions(writeBytes('anim.gif', [...Buffer.from('GIF89a'), 0, 0, 0, 0])), null);
        assert.equal(getImageDimensions(writeBytes('empty.png', [])), null);
        assert.equal(getImageDimensions(path.join(dimTmpDir, 'missing.png')), null);
    });
});
