/**
 * MRT (Modern Resource Technology) asset resolution.
 *
 * An MSIX manifest references the *unqualified* asset name (Assets\Logo.png) while the
 * files that actually ship are qualifier-suffixed (Assets\Logo.scale-200.png,
 * Assets\Logo.targetsize-24_altform-unplated.png, ...). MRT resolves the reference at
 * runtime, so a missing literal file is correct authoring — not an error.
 *
 * The qualifier grammar and variant-matching rules here mirror
 * `MrtAssetHelper` in the WinApp CLI (microsoft/winappCli) so that both tools agree.
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
 * `logicalBaseName` (dots are allowed inside the base name).
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
    /** Absolute paths of every MRT variant found (empty when the literal file was used). */
    variants: string[];
    /** Qualifier tokens of the resolved variant (empty when `isExact`). */
    qualifiers: string[];
}

/**
 * Ranks variants so the preview shows the most representative image:
 * plain (unqualified or scale-only) beats altform/targetsize/contrast/theme variants,
 * and scale-200 beats other scales, then higher scales beat lower ones.
 */
function scoreVariant(qualifiers: string[]): number[] {
    const isPlain = qualifiers.every(q => SCALE_QUALIFIER.test(q));
    const scale = getVariantScale(qualifiers);
    return [
        isPlain ? 0 : 1,
        scale === 200 ? 0 : 1,
        -(scale ?? 0),
    ];
}

function compareScores(a: number[], b: number[]): number {
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) { return a[i] - b[i]; }
    }
    return 0;
}

function safeReadDir(dir: string): fs.Dirent[] {
    try {
        return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
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
 */
export function resolveMrtAsset(baseDir: string, referencePath: string): MrtResolution | null {
    if (!referencePath) { return null; }

    let absolute: string;
    try {
        absolute = path.resolve(baseDir, referencePath);
    } catch {
        return null;
    }

    const relativeTo = (candidate: string): string => path.relative(baseDir, candidate) || path.basename(candidate);

    if (fileExists(absolute)) {
        return { resolvedPath: absolute, relativePath: relativeTo(absolute), isExact: true, variants: [], qualifiers: [] };
    }

    const dir = path.dirname(absolute);
    const fileName = path.basename(absolute);
    const ext = path.extname(fileName);
    // An extensionless reference is an MRT key, not a file path — nothing to probe for.
    if (!ext) { return null; }
    const logicalBase = getMrtVariantBaseName(fileName.slice(0, fileName.length - ext.length));

    // 2. Qualifier-suffixed siblings.
    const siblings: { file: string; qualifiers: string[] }[] = [];
    for (const entry of safeReadDir(dir)) {
        if (!entry.isFile()) { continue; }
        const entryExt = path.extname(entry.name);
        if (entryExt.toLowerCase() !== ext.toLowerCase()) { continue; }
        const nameWithoutExt = entry.name.slice(0, entry.name.length - entryExt.length);
        if (!isMrtVariantName(logicalBase, nameWithoutExt)) { continue; }
        siblings.push({ file: path.join(dir, entry.name), qualifiers: getVariantQualifiers(logicalBase, nameWithoutExt) });
    }

    if (siblings.length > 0) {
        const best = pickBest(siblings);
        return {
            resolvedPath: best.file,
            relativePath: relativeTo(best.file),
            isExact: false,
            variants: siblings.map(s => s.file).sort((a, b) => a.localeCompare(b)),
            qualifiers: best.qualifiers,
        };
    }

    // 3. Qualifier-folder layouts: Assets\scale-200\Logo.png
    const folderMatches: { file: string; qualifiers: string[] }[] = [];
    for (const entry of safeReadDir(dir)) {
        if (!entry.isDirectory() || !isQualifierToken(entry.name)) { continue; }
        const candidate = path.join(dir, entry.name, fileName);
        if (fileExists(candidate)) {
            folderMatches.push({ file: candidate, qualifiers: entry.name.split('_') });
        }
    }

    if (folderMatches.length > 0) {
        const best = pickBest(folderMatches);
        return {
            resolvedPath: best.file,
            relativePath: relativeTo(best.file),
            isExact: false,
            variants: folderMatches.map(f => f.file).sort((a, b) => a.localeCompare(b)),
            qualifiers: best.qualifiers,
        };
    }

    return null;
}

function pickBest(candidates: { file: string; qualifiers: string[] }[]): { file: string; qualifiers: string[] } {
    return candidates.reduce((best, current) => {
        const cmp = compareScores(scoreVariant(current.qualifiers), scoreVariant(best.qualifiers));
        if (cmp < 0) { return current; }
        if (cmp > 0) { return best; }
        return current.file.localeCompare(best.file) < 0 ? current : best;
    });
}

function fileExists(candidate: string): boolean {
    try {
        return fs.statSync(candidate).isFile();
    } catch {
        return false;
    }
}
