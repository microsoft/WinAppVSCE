/**
 * Image helpers for the manifest editor: MRT-aware asset resolution, image header
 * measurement, and aspect-ratio checking.
 *
 * An MSIX manifest references the *unqualified* asset name (Assets\Logo.png) while the
 * files that actually ship are qualifier-suffixed (Assets\Logo.scale-200.png,
 * Assets\Logo.targetsize-24_altform-unplated.png, ...). MRT resolves the reference at
 * runtime, so a missing literal file is correct authoring — not an error.
 *
 * The qualifier grammar and variant-matching rules here mirror `MrtAssetHelper` in the
 * WinApp CLI (microsoft/winappCli) so that both tools agree. This module is kept free of
 * `vscode` imports so all of it stays unit-testable.
 */

import * as path from 'path';
import * as fs from 'fs';

// Language (en, en-US, pt-BR, zh-Hans, ...)
const LANGUAGE_QUALIFIER = /^[a-zA-Z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const SCALE_QUALIFIER = /^scale-(\d+)$/;
const THEME_QUALIFIER = /^theme-(light|dark)$/i;
const CONTRAST_QUALIFIER = /^contrast-(standard|high)$/i;
const DX_FEATURE_LEVEL_QUALIFIER = /^dxfeaturelevel-(9|10|11)$/i;
const DEVICE_FAMILY_QUALIFIER = /^device-family-(desktop|mobile|team|xbox|iot)$/i;
const HOME_REGION_QUALIFIER = /^homeregion-[A-Za-z]{2}$/;
const CONFIGURATION_QUALIFIER = /^configuration-[A-Za-z0-9]+$/;
const TARGET_SIZE_QUALIFIER = /^targetsize-(\d+)$/;
const ALT_FORM_QUALIFIER = /^altform-[A-Za-z0-9]+$/;

/** ltr / rtl */
function isLayoutDirectionQualifier(token: string): boolean {
    const lower = token.toLowerCase();
    return lower === 'ltr' || lower === 'rtl';
}

/** Returns true if a single (non-compound) token is a valid MRT qualifier. */
export function isSingleQualifierToken(token: string): boolean {
    if (!token) { return false; }
    return LANGUAGE_QUALIFIER.test(token)
        || SCALE_QUALIFIER.test(token)
        || THEME_QUALIFIER.test(token)
        || CONTRAST_QUALIFIER.test(token)
        || DX_FEATURE_LEVEL_QUALIFIER.test(token)
        || DEVICE_FAMILY_QUALIFIER.test(token)
        || HOME_REGION_QUALIFIER.test(token)
        || CONFIGURATION_QUALIFIER.test(token)
        || TARGET_SIZE_QUALIFIER.test(token)
        || ALT_FORM_QUALIFIER.test(token)
        || isLayoutDirectionQualifier(token);
}

/** Returns true for a qualifier token, including compound ones (targetsize-24_altform-unplated). */
export function isQualifierToken(token: string): boolean {
    if (!token) { return false; }
    return token.split('_').every(part => isSingleQualifierToken(part));
}

/**
 * Returns true if `candidateNameWithoutExtension` is a valid MRT variant of
 * `logicalBaseName`.
 *
 * Only the first dot-separated segment is compared against the base name, so a base name
 * that itself contains dots ("Contoso.Logo") never matches its own variants. That mirrors
 * `MrtAssetHelper.IsMrtVariantName` in the WinApp CLI, which does the same `Split('.')` and
 * `parts[0]` comparison. Diverging here would make the editor accept assets the CLI does not
 * package, which is worse than the shared limitation — keep the two in lockstep.
 */
export function isMrtVariantName(logicalBaseName: string, candidateNameWithoutExtension: string): boolean {
    if (!logicalBaseName?.trim() || !candidateNameWithoutExtension?.trim()) { return false; }

    // "Logo.scale-200.theme-dark" -> ["Logo", "scale-200", "theme-dark"]
    const parts = candidateNameWithoutExtension.split('.');
    if (parts[0].toLowerCase() !== logicalBaseName.toLowerCase()) { return false; }
    if (parts.length === 1) { return true; }

    return parts.slice(1).every(part => isQualifierToken(part));
}

/**
 * For a qualified logical name like "Logo.scale-100" or "Logo.targetsize-24_altform-unplated",
 * returns the unqualified asset family base ("Logo"). Names without trailing qualifier tokens
 * are returned unchanged, so "Assets.Logo" stays "Assets.Logo".
 */
export function getMrtVariantBaseName(logicalBaseName: string): string {
    if (!logicalBaseName?.trim()) { return logicalBaseName; }

    const parts = logicalBaseName.split('.');
    if (parts.length <= 1) { return logicalBaseName; }

    // Find the earliest segment where every remaining segment is a valid qualifier token.
    for (let i = 1; i < parts.length; i++) {
        if (parts.slice(i).every(part => isQualifierToken(part))) {
            return parts.slice(0, i).join('.');
        }
    }
    return logicalBaseName;
}

/** Qualifier tokens carried by a variant file name, relative to its family base. */
export function getVariantQualifiers(logicalBaseName: string, candidateNameWithoutExtension: string): string[] {
    if (!isMrtVariantName(logicalBaseName, candidateNameWithoutExtension)) { return []; }
    return candidateNameWithoutExtension.split('.').slice(1)
        .flatMap(part => part.split('_'));
}

/** Scale factor encoded in a variant's qualifiers, or null when unscaled. */
export function getVariantScale(qualifiers: string[]): number | null {
    for (const q of qualifiers) {
        const m = SCALE_QUALIFIER.exec(q);
        if (m) { return parseInt(m[1], 10); }
    }
    return null;
}

/** True when any qualifier is a targetsize-N (those assets are square regardless of the field). */
export function hasTargetSizeQualifier(qualifiers: string[]): boolean {
    return qualifiers.some(q => TARGET_SIZE_QUALIFIER.test(q));
}

/** How a manifest image reference was resolved on disk. */
export interface MrtResolution {
    /** Absolute path of the file that best represents the reference. */
    resolvedPath: string;
    /** Path of `resolvedPath` relative to the directory the reference was resolved against. */
    relativePath: string;
    /** True when the literal (unqualified) path exists on disk. */
    isExact: boolean;
    /** Qualifier tokens of the resolved variant (empty when `isExact`). */
    qualifiers: string[];
}

type Candidate = { file: string; qualifiers: string[] };

/**
 * Picks the variant that best represents the reference in a preview: plain (unqualified or
 * scale-only) beats altform/targetsize/contrast/theme variants, scale-200 beats other scales,
 * higher scales beat lower ones, and file name breaks ties so the result is deterministic.
 */
function pickBest(candidates: Candidate[]): Candidate {
    const rank = ({ qualifiers, file }: Candidate): [number, number, number, string] => {
        const scale = getVariantScale(qualifiers);
        return [
            qualifiers.every(q => SCALE_QUALIFIER.test(q)) ? 0 : 1,
            scale === 200 ? 0 : 1,
            -(scale ?? 0),
            file,
        ];
    };
    return candidates.reduce((best, current) => {
        const [a, b] = [rank(current), rank(best)];
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) { return a[i] < b[i] ? current : best; }
        }
        return best;
    });
}

/** True when `candidate` is `root` or sits underneath it (case-insensitive, Windows paths). */
export function isPathWithin(root: string, candidate: string): boolean {
    if (!root) { return false; }
    const relative = path.relative(root, candidate);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
}

export interface ResolveMrtAssetOptions {
    /**
     * Directories that MRT probing is allowed to enumerate. A reference resolving outside all
     * of them falls back to a plain existence check, so a manifest can't drive the extension
     * host into listing arbitrary local or UNC directories.
     */
    probeRoots?: string[];
}

function safeReadDir(dir: string): fs.Dirent[] {
    try {
        return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
}

function fileExists(candidate: string): boolean {
    try {
        return fs.statSync(candidate).isFile();
    } catch {
        return false;
    }
}

/**
 * Resolves a manifest-relative (or absolute) image reference, MRT-aware.
 *
 * Resolution order, mirroring the CLI:
 *  1. the literal file, when it exists;
 *  2. qualifier-suffixed siblings (`Logo.scale-200.png`, `Logo.targetsize-24_altform-unplated.png`);
 *  3. qualifier-folder layouts (`Assets\scale-200\Logo.png`).
 *
 * Returns null only when none of those exist — the one case that warrants a warning.
 *
 * Steps 2 and 3 enumerate a directory, so they run only when the reference resolves inside
 * `options.probeRoots` (when supplied). Everything else gets the literal check alone.
 */
export function resolveMrtAsset(baseDir: string, referencePath: string, options?: ResolveMrtAssetOptions): MrtResolution | null {
    if (!referencePath) { return null; }

    let absolute: string;
    try {
        absolute = path.resolve(baseDir, referencePath);
    } catch {
        return null;
    }

    const relativeTo = (candidate: string): string => path.relative(baseDir, candidate) || path.basename(candidate);
    const resolutionFor = (best: Candidate): MrtResolution => ({
        resolvedPath: best.file,
        relativePath: relativeTo(best.file),
        isExact: false,
        qualifiers: best.qualifiers,
    });

    if (fileExists(absolute)) {
        return { resolvedPath: absolute, relativePath: relativeTo(absolute), isExact: true, qualifiers: [] };
    }

    const dir = path.dirname(absolute);
    const fileName = path.basename(absolute);
    const ext = path.extname(fileName);
    // An extensionless reference is an MRT key, not a file path — nothing to probe for.
    if (!ext) { return null; }
    // Probing enumerates `dir`; refuse to do that outside the roots the caller trusts.
    if (options?.probeRoots && !options.probeRoots.some(root => isPathWithin(root, dir))) { return null; }
    const logicalBase = getMrtVariantBaseName(fileName.slice(0, fileName.length - ext.length));

    // 2. Qualifier-suffixed siblings.
    const siblings: Candidate[] = [];
    for (const entry of safeReadDir(dir)) {
        if (!entry.isFile()) { continue; }
        const entryExt = path.extname(entry.name);
        if (entryExt.toLowerCase() !== ext.toLowerCase()) { continue; }
        const nameWithoutExt = entry.name.slice(0, entry.name.length - entryExt.length);
        if (!isMrtVariantName(logicalBase, nameWithoutExt)) { continue; }
        siblings.push({ file: path.join(dir, entry.name), qualifiers: getVariantQualifiers(logicalBase, nameWithoutExt) });
    }

    if (siblings.length > 0) { return resolutionFor(pickBest(siblings)); }

    // 3. Qualifier-folder layouts: Assets\scale-200\Logo.png
    const folderMatches: Candidate[] = [];
    for (const entry of safeReadDir(dir)) {
        if (!entry.isDirectory() || !isQualifierToken(entry.name)) { continue; }
        const candidate = path.join(dir, entry.name, fileName);
        if (fileExists(candidate)) {
            folderMatches.push({ file: candidate, qualifiers: entry.name.split('_') });
        }
    }

    if (folderMatches.length > 0) { return resolutionFor(pickBest(folderMatches)); }

    return null;
}

export type ImagePathResolution =
    /** The reference resolves inside the package (or a workspace folder) — show a preview. */
    | { status: 'found'; resolution: MrtResolution }
    /** The literal file exists outside the package — offer to copy it into Assets. */
    | { status: 'external'; sourcePath: string }
    | { status: 'notFound' };

/**
 * Decides how a manifest image reference should be reported in the editor.
 *
 * @param manifestDir Directory containing AppxManifest.xml — the package root.
 * @param imagePath   The raw manifest/field value.
 * @param workspaceRoots Open workspace folder paths, used for `..\`-escaping references.
 */
export function resolveManifestImagePath(
    manifestDir: string,
    imagePath: string,
    workspaceRoots: readonly string[],
): ImagePathResolution {
    if (!imagePath) { return { status: 'notFound' }; }

    // Only these directories may be enumerated while probing for MRT variants.
    const probeRoots = [manifestDir, ...workspaceRoots];
    const escapesPackage = imagePath.startsWith('..\\') || imagePath.startsWith('../');
    const resolved = path.resolve(manifestDir, imagePath);
    const inWorkspace = workspaceRoots.some(root =>
        resolved.toLowerCase() === root.toLowerCase() || isPathWithin(root, resolved));

    const packageResolution = resolveMrtAsset(manifestDir, imagePath, { probeRoots });

    if (packageResolution && isPathWithin(manifestDir, packageResolution.resolvedPath)) {
        return { status: 'found', resolution: packageResolution };
    }

    if (packageResolution && escapesPackage && inWorkspace && !path.isAbsolute(imagePath)) {
        return { status: 'found', resolution: packageResolution };
    }

    // Outside the package (for example ..\..\Downloads\img.png or an absolute path). Only the
    // literal file is offered for copying: copying a variant would rewrite the manifest to a
    // qualified name like Logo.scale-200.png, which is not what the user typed.
    if (packageResolution?.isExact) {
        return { status: 'external', sourcePath: packageResolution.resolvedPath };
    }

    // Fall back to workspace-root resolution only for references that explicitly escape the
    // manifest folder (for example ..\Assets\logo.png).
    if (escapesPackage) {
        for (const root of workspaceRoots) {
            const candidate = resolveMrtAsset(root, imagePath, { probeRoots });
            if (candidate) { return { status: 'found', resolution: candidate }; }
        }
    }

    return { status: 'notFound' };
}

/** Reads width/height from PNG or JPEG file headers without loading the full image. */
export function getImageDimensions(filePath: string): { width: number; height: number } | null {
    try {
        const fd = fs.openSync(filePath, 'r');
        const header = Buffer.alloc(32);
        fs.readSync(fd, header, 0, 32, 0);

        // PNG: bytes 0-7 are signature, IHDR chunk starts at byte 8, width at 16, height at 20
        if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47) {
            const width = header.readUInt32BE(16);
            const height = header.readUInt32BE(20);
            fs.closeSync(fd);
            return { width, height };
        }

        // JPEG: scan for SOF0/SOF2 marker (0xFF 0xC0 or 0xFF 0xC2)
        if (header[0] === 0xFF && header[1] === 0xD8) {
            const buf = Buffer.alloc(65536);
            fs.readSync(fd, buf, 0, buf.length, 0);
            fs.closeSync(fd);
            let offset = 2;
            while (offset < buf.length - 9) {
                if (buf[offset] !== 0xFF) break;
                const marker = buf[offset + 1];
                if (marker === 0xC0 || marker === 0xC2) {
                    const height = buf.readUInt16BE(offset + 5);
                    const width = buf.readUInt16BE(offset + 7);
                    return { width, height };
                }
                const len = buf.readUInt16BE(offset + 2);
                offset += 2 + len;
            }
            return null;
        }

        fs.closeSync(fd);
        return null;
    } catch {
        return null;
    }
}

/**
 * Expected aspect ratios for manifest image fields (width:height).
 *
 * Mirrors the WinApp CLI's `ManifestService.ExtractAssetReferencesFromManifest` table.
 */
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
 * `qualifiers` are the MRT qualifier tokens of the file that was actually measured: a
 * `scale-200` file is legitimately 2× the base size (ratio is scale invariant), but a
 * `targetsize-N` file is a square N×N icon regardless of the field it is attached to, so it
 * must not be ratio-checked against, say, a wide tile.
 */
export function checkAspectRatio(field: string, width: number, height: number, qualifiers: string[] = []): string | null {
    const expected = EXPECTED_RATIOS[field];
    if (!expected || width === 0 || height === 0) { return null; }
    if (hasTargetSizeQualifier(qualifiers)) { return null; }
    const actualRatio = width / height;
    const expectedRatio = expected.w / expected.h;
    const tolerance = 0.05;
    if (Math.abs(actualRatio - expectedRatio) / expectedRatio > tolerance) {
        return `Image is ${width}×${height} — expected ${expected.label} aspect ratio`;
    }
    return null;
}
