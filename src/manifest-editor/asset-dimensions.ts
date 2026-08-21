/**
 * Expected dimensions for manifest visual assets, and aspect-ratio checking that is
 * aware of MRT qualifiers.
 *
 * Base dimensions mirror the WinApp CLI's `ManifestService.ExtractAssetReferencesFromManifest`
 * table. A `scale-200` file is legitimately 2× the base size — aspect ratio is scale
 * invariant so scaled variants need no special handling — but a `targetsize-N` file is a
 * square N×N icon regardless of the field it is attached to, so it must not be
 * ratio-checked against, say, a wide tile.
 */

import { hasTargetSizeQualifier } from './mrt-asset-helper';

/** Expected aspect ratios for manifest image fields (width:height). */
export const EXPECTED_RATIOS: Record<string, { w: number; h: number; label: string }> = {
    'visualElements.square150x150Logo': { w: 1, h: 1, label: '1:1 (square)' },
    'visualElements.square44x44Logo': { w: 1, h: 1, label: '1:1 (square)' },
    'visualElements.square71x71Logo': { w: 1, h: 1, label: '1:1 (square)' },
    'visualElements.square310x310Logo': { w: 1, h: 1, label: '1:1 (square)' },
    'visualElements.wide310x150Logo': { w: 310, h: 150, label: '310:150 (wide)' },
    'visualElements.badgeLogo': { w: 1, h: 1, label: '1:1 (square)' },
    'visualElements.splashScreenImage': { w: 620, h: 300, label: '620:300 (wide)' },
    'logo': { w: 1, h: 1, label: '1:1 (square)' },
};

/**
 * Returns a warning string if the image aspect ratio doesn't match expectations (±5% tolerance).
 * `qualifiers` are the MRT qualifier tokens of the file that was actually measured.
 */
export function checkAspectRatio(field: string, width: number, height: number, qualifiers: string[] = []): string | null {
    const expected = EXPECTED_RATIOS[field];
    if (!expected || width === 0 || height === 0) { return null; }
    // targetsize-N variants are square N×N icons by definition, whatever the field expects.
    if (hasTargetSizeQualifier(qualifiers)) { return null; }
    const actualRatio = width / height;
    const expectedRatio = expected.w / expected.h;
    const tolerance = 0.05;
    if (Math.abs(actualRatio - expectedRatio) / expectedRatio > tolerance) {
        return `Image is ${width}×${height} — expected ${expected.label} aspect ratio`;
    }
    return null;
}
