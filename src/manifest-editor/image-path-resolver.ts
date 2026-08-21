/**
 * Decides how a manifest image reference should be reported in the editor.
 *
 * Kept free of `vscode` imports so the branch selection — which is the part with real edge
 * cases (MRT variants, workspace fallbacks, paths escaping the package) — is unit-testable.
 */

import * as path from 'path';
import { MrtResolution, isPathWithin, resolveMrtAsset } from './mrt-asset-helper';

export type ImagePathResolution =
    /** The reference resolves inside the package (or a workspace folder) — show a preview. */
    | { status: 'found'; resolution: MrtResolution }
    /** The literal file exists outside the package — offer to copy it into Assets. */
    | { status: 'external'; sourcePath: string }
    | { status: 'notFound' };

/**
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
