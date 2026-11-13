import * as fsp from 'fs/promises';
import * as path from 'path';

/**
 * Whether a run target is a WinUI 3 app, checked before launch so an explicit
 * DevTools request for another app type starts the app without DevTools.
 * Uses the CLI's definition; `unknown` leaves the decision to the CLI.
 */
export type AppFrameworkCheck =
    | { kind: 'winui' }
    | { kind: 'other'; description: string }
    | { kind: 'unknown' };

const UNKNOWN: AppFrameworkCheck = { kind: 'unknown' };
const isTrue = (text: string, property: string) =>
    new RegExp(`<${property}(?:\\s[^>]*)?>\\s*true\\s*</${property}>`, 'i').test(text);

async function readText(file: string): Promise<string | undefined> {
    try { return await fsp.readFile(file, 'utf8'); } catch { return undefined; }
}

/** Directory.Build.props files apply to every project below them. */
async function inheritedProps(projectDir: string): Promise<string> {
    const parts: string[] = [];
    let dir = projectDir;
    for (let depth = 0; depth < 12; depth++) {
        const props = await readText(path.join(dir, 'Directory.Build.props'));
        if (props) { parts.push(props); }
        const parent = path.dirname(dir);
        if (parent === dir) { break; }
        dir = parent;
    }
    return parts.join('\n');
}

export async function checkProjectFramework(projectFile: string): Promise<AppFrameworkCheck> {
    const name = path.basename(projectFile);
    const extension = path.extname(projectFile).toLowerCase();
    const dir = path.dirname(projectFile);
    const content = await readText(projectFile);
    if (content === undefined) { return UNKNOWN; }

    if (extension === '.cs') { return { kind: 'other', description: `'${name}' is a .NET file-based app` }; }

    if (extension === '.vcxproj') {
        const hasXaml = /Include="[^"]+\.xaml"/i.test(content);
        if (!hasXaml) { return { kind: 'other', description: `'${name}' has no XAML pages` }; }
        const packages = await readText(path.join(dir, 'packages.config')) ?? '';
        return /Microsoft\.WindowsAppSDK/i.test(content + packages) ? { kind: 'winui' } : UNKNOWN;
    }

    if (extension !== '.csproj') { return UNKNOWN; }
    const all = content + '\n' + await inheritedProps(dir);
    if (isTrue(all, 'UseWinUI')) { return { kind: 'winui' }; }
    if (isTrue(all, 'UseWPF')) { return { kind: 'other', description: `'${name}' is a WPF project` }; }
    if (isTrue(all, 'UseWindowsForms')) { return { kind: 'other', description: `'${name}' is a Windows Forms project` }; }
    // UseWinUI may come from an import this check can't see; only an app without App.xaml is certain.
    const hasAppXaml = await readText(path.join(dir, 'App.xaml')) !== undefined;
    return hasAppXaml ? UNKNOWN : { kind: 'other', description: `'${name}' isn't a WinUI 3 project` };
}

/** A build output folder holds WinUI binaries or compiled XAML (.xbf). */
export function checkOutputFolderEntries(folderName: string, entries: readonly string[]): AppFrameworkCheck {
    const lower = entries.map(entry => entry.toLowerCase());
    const winui = lower.some(entry => entry === 'microsoft.winui.dll' || entry === 'microsoft.ui.xaml.dll'
        || entry.endsWith('.xbf'));
    return winui ? { kind: 'winui' } : { kind: 'other', description: `'${folderName}' doesn't contain a WinUI 3 app` };
}

/** Checks the project when one is known, else the input file or folder. */
export async function checkAppFramework(input: string, project?: string): Promise<AppFrameworkCheck> {
    if (project) {
        const projectPath = path.isAbsolute(project) ? project : path.join(
            path.extname(input) ? path.dirname(input) : input, project);
        return checkProjectFramework(projectPath);
    }
    const extension = path.extname(input).toLowerCase();
    if (['.csproj', '.vcxproj', '.cs'].includes(extension)) { return checkProjectFramework(input); }
    if (extension === '.sln' || extension === '.slnx') { return UNKNOWN; }

    let entries: string[];
    try { entries = await fsp.readdir(input); } catch { return UNKNOWN; }
    if (entries.some(entry => /\.slnx?$/i.test(entry))) { return UNKNOWN; }
    const projects = entries.filter(entry => /\.(cs|vcx)proj$/i.test(entry));
    if (projects.length === 1) { return checkProjectFramework(path.join(input, projects[0])); }
    if (projects.length > 1) { return UNKNOWN; }
    return checkOutputFolderEntries(path.basename(input), entries);
}
