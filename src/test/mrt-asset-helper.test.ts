/**
 * Unit tests for MRT (Modern Resource Technology) asset resolution.
 *
 * Mirrors the WinApp CLI's MrtAssetHelperTests so both implementations of the
 * qualifier grammar stay in agreement. Regression coverage for issue #191:
 * a manifest referencing the unqualified asset name must not be flagged as broken
 * when only qualifier-suffixed files exist on disk.
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
} from '../manifest-editor/mrt-asset-helper';
import { checkAspectRatio } from '../manifest-editor/asset-dimensions';

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
        assert.equal(result.variants.length, 3);
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
        assert.equal(result.variants.length, 3);
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
        assert.equal(result.variants.length, 2);
        assert.equal(path.dirname(result.resolvedPath).endsWith('scale-200'), true);
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
