// Image helpers for the manifest editor: MRT-aware asset resolution, image measurement, and
// aspect-ratio checking. Qualifier rules mirror `MrtAssetHelper` in the WinApp CLI.

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
 * True when `candidateNameWithoutExtension` is an MRT variant of `logicalBaseName`. Only the
 * first dot-separated segment is compared, matching `MrtAssetHelper.IsMrtVariantName`.
 */
export function isMrtVariantName(logicalBaseName: string, candidateNameWithoutExtension: string): boolean {
    if (!logicalBaseName?.trim() || !candidateNameWithoutExtension?.trim()) { return false; }

    const parts = candidateNameWithoutExtension.split('.');
    if (parts[0].toLowerCase() !== logicalBaseName.toLowerCase()) { return false; }
    if (parts.length === 1) { return true; }

    return parts.slice(1).every(part => isQualifierToken(part));
}

/**
 * Strips trailing qualifier tokens to get the asset family base: "Logo.scale-100" -> "Logo".
 * Names without trailing qualifiers are returned unchanged.
 */
export function getMrtVariantBaseName(logicalBaseName: string): string {
    if (!logicalBaseName?.trim()) { return logicalBaseName; }

    const parts = logicalBaseName.split('.');
    if (parts.length <= 1) { return logicalBaseName; }

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

/** True when any qualifier is a targetsize-N (those assets are square regardless of the field). */
export function hasTargetSizeQualifier(qualifiers: string[]): boolean {
    return qualifiers.some(q => TARGET_SIZE_QUALIFIER.test(q));
}

/** How a manifest image reference was resolved on disk. */
export interface MrtResolution {
    /** Absolute path of the file that represents the reference. */
    resolvedPath: string;
    /** Path of `resolvedPath` relative to the directory the reference was resolved against. */
    relativePath: string;
    /** True when the literal (unqualified) path exists on disk. */
    isExact: boolean;
    /** Qualifier tokens of the resolved variant (empty when `isExact`). */
    qualifiers: string[];
}

type Candidate = { file: string; qualifiers: string[] };

/** Keeps the scale-200 variant when there is one, otherwise the first match alphabetically. */
function preferVariant(best: Candidate | null, next: Candidate): Candidate {
    if (!best) { return next; }
    const isPreferred = (c: Candidate): boolean => c.qualifiers.some(q => q.toLowerCase() === 'scale-200');
    if (isPreferred(best) !== isPreferred(next)) { return isPreferred(next) ? next : best; }
    return path.basename(next.file).localeCompare(path.basename(best.file)) < 0 ? next : best;
}

/** True when `candidate` is `root` or sits underneath it (case-insensitive, Windows paths). */
export function isPathWithin(root: string, candidate: string): boolean {
    if (!root) { return false; }
    const relative = path.relative(root, candidate);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
}

export interface ResolveMrtAssetOptions {
    /**
     * Directories that MRT probing may enumerate, so a manifest can't drive the extension host
     * into listing arbitrary local or UNC directories.
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
 * Resolves an image reference to the literal file, a qualifier-suffixed sibling, or a
 * qualifier-folder entry. Returns null only when none exist — the one case worth warning about.
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

    // Qualifier-suffixed siblings: Assets\Logo.scale-200.png
    let best: Candidate | null = null;
    for (const entry of safeReadDir(dir)) {
        if (!entry.isFile()) { continue; }
        const entryExt = path.extname(entry.name);
        if (entryExt.toLowerCase() !== ext.toLowerCase()) { continue; }
        const nameWithoutExt = entry.name.slice(0, entry.name.length - entryExt.length);
        if (!isMrtVariantName(logicalBase, nameWithoutExt)) { continue; }
        best = preferVariant(best, {
            file: path.join(dir, entry.name),
            qualifiers: getVariantQualifiers(logicalBase, nameWithoutExt),
        });
    }
    if (best) { return resolutionFor(best); }

    // Qualifier-folder layouts: Assets\scale-200\Logo.png
    for (const entry of safeReadDir(dir)) {
        if (!entry.isDirectory() || !isQualifierToken(entry.name)) { continue; }
        const candidate = path.join(dir, entry.name, fileName);
        if (fileExists(candidate)) {
            best = preferVariant(best, { file: candidate, qualifiers: entry.name.split('_') });
        }
    }

    return best ? resolutionFor(best) : null;
}

export type ImagePathResolution =
    /** The reference resolves inside the package (or a workspace folder) — show a preview. */
    | { status: 'found'; resolution: MrtResolution }
    /** The literal file exists outside the package — offer to copy it into Assets. */
    | { status: 'external'; sourcePath: string }
    | { status: 'notFound' };

/**
 * Decides how a manifest image reference should be reported in the editor.
 * `workspaceRoots` are the open workspace folders, used for `..\`-escaping references.
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
    const inWorkspace = workspaceRoots.some(root => isPathWithin(root, resolved));

    const packageResolution = resolveMrtAsset(manifestDir, imagePath, { probeRoots });

    if (packageResolution && isPathWithin(manifestDir, packageResolution.resolvedPath)) {
        return { status: 'found', resolution: packageResolution };
    }

    if (packageResolution && escapesPackage && inWorkspace) {
        return { status: 'found', resolution: packageResolution };
    }

    // Outside the package. Only the literal file is offered for copying: copying a variant would
    // rewrite the manifest to a qualified name the user never typed.
    if (packageResolution?.isExact) {
        return { status: 'external', sourcePath: packageResolution.resolvedPath };
    }

    return { status: 'notFound' };
}

/** Reads width/height from PNG or JPEG file headers without loading the full image. */
export function getImageDimensions(filePath: string): { width: number; height: number } | null {
    let fd: number | undefined;
    try {
        fd = fs.openSync(filePath, 'r');
        const header = Buffer.alloc(32);
        const headerBytes = fs.readSync(fd, header, 0, 32, 0);

        // PNG: bytes 0-7 are signature, IHDR chunk starts at byte 8, width at 16, height at 20
        if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47) {
            // A truncated PNG would read zeroes out of the zero-filled buffer and report 0x0.
            if (headerBytes < 24) { return null; }
            return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
        }

        // JPEG: scan for SOF0/SOF2 marker (0xFF 0xC0 or 0xFF 0xC2)
        if (header[0] === 0xFF && header[1] === 0xD8) {
            const buf = Buffer.alloc(65536);
            const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
            let offset = 2;
            while (offset < bytes - 9) {
                if (buf[offset] !== 0xFF) { break; }
                const marker = buf[offset + 1];
                if (marker === 0xC0 || marker === 0xC2) {
                    return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5) };
                }
                const len = buf.readUInt16BE(offset + 2);
                // A zero/negative segment length would spin here forever.
                if (len < 2) { break; }
                offset += 2 + len;
            }
            return null;
        }

        return null;
    } catch {
        return null;
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch { /* already closed */ }
        }
    }
}

/** Expected aspect ratios per manifest image field, mirroring the WinApp CLI's asset table. */
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
 * Warns when the aspect ratio doesn't match the field's expectation (±5%). Skipped for
 * targetsize-N variants, which are square N×N icons whatever field they hang off.
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
