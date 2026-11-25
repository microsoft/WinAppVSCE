/**
 * Reads the project file next to a manifest to tell WinUI 3 / desktop apps from UWP apps when
 * the manifest only carries the template EntryPoint token.
 */

import type { Dirent } from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { ProjectAppKind } from '../manifest-schema/semantic-validation';

const PROJECT_EXTENSIONS = new Set(['.csproj', '.vbproj', '.vcxproj', '.wapproj']);
const MAX_PROJECT_FILE_BYTES = 1024 * 1024;

/** Classifies one project file; undefined when it carries no app-model signal. */
export function classifyProjectFile(fileName: string, content: string): ProjectAppKind | undefined {
    // A Windows Application Packaging Project only packages desktop apps.
    if (path.extname(fileName).toLowerCase() === '.wapproj') { return 'desktop'; }
    // WinUI 3 C++ projects also say AppContainerApplication/ApplicationType, so desktop signals win.
    if (/<UseWinUI>\s*true\s*</i.test(content) || /Microsoft\.WindowsAppSDK/i.test(content)
        || /<WindowsPackageType>/i.test(content)) {
        return 'desktop';
    }
    if (/<UseUwp>\s*true\s*</i.test(content) || /<TargetPlatformIdentifier>\s*UAP\s*</i.test(content)
        || /<AppContainerApplication>\s*true\s*</i.test(content)) {
        return 'uwp';
    }
    return undefined;
}

/** Looks only in the manifest's own folder, where VS and WinUI 3 templates put the project. */
export async function detectProjectAppKind(manifestDir: string): Promise<ProjectAppKind | undefined> {
    let entries: Dirent[];
    try {
        entries = await fsp.readdir(manifestDir, { withFileTypes: true });
    } catch {
        return undefined;
    }
    const kinds: ProjectAppKind[] = [];
    for (const entry of entries) {
        if (!entry.isFile() || !PROJECT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) { continue; }
        const filePath = path.join(manifestDir, entry.name);
        try {
            if ((await fsp.stat(filePath)).size > MAX_PROJECT_FILE_BYTES) { continue; }
            const kind = classifyProjectFile(entry.name, await fsp.readFile(filePath, 'utf8'));
            if (kind) { kinds.push(kind); }
        } catch {
            // An unreadable project file just contributes no signal.
        }
    }
    if (kinds.includes('desktop')) { return 'desktop'; }
    return kinds.includes('uwp') ? 'uwp' : undefined;
}
