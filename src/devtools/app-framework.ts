import * as fsp from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import {
    classifyOfferableProjects, readDirectoryProjectPaths, readDirectorySolutionPaths, readSolutionProjectPaths,
} from '../run-target';

/**
 * Whether a run target is a WinUI 3 app, checked before launch so an explicit
 * DevTools request for any other app starts it without DevTools. Anything not
 * shown to be WinUI 3 counts as other; `unknown` is only an unreadable input.
 */
export type AppFrameworkCheck =
    | { kind: 'winui' }
    | { kind: 'other'; description: string }
    | { kind: 'unknown' };

export interface UiFrameworkProperties { UseWinUI?: string; UseWPF?: string; UseWindowsForms?: string }
export type PropertyEvaluator = (projectFile: string) => Promise<UiFrameworkProperties | undefined>;

const UNKNOWN: AppFrameworkCheck = { kind: 'unknown' };
const PROJECT_EXTENSIONS = ['.csproj', '.vcxproj', '.cs'];
const isTrueText = (text: string, property: string) =>
    new RegExp(`<${property}(?:\\s[^>]*)?>\\s*true\\s*</${property}>`, 'i').test(text);
const isTrue = (value: string | undefined) => value?.trim().toLowerCase() === 'true';

async function readText(file: string): Promise<string | undefined> {
    try { return await fsp.readFile(file, 'utf8'); } catch { return undefined; }
}

/** The same MSBuild evaluation the CLI uses, so imports and Directory.Build.props count. */
export const evaluateWithMsBuild: PropertyEvaluator = projectFile => new Promise(resolve => {
    execFile('dotnet', ['msbuild', projectFile, '-nologo',
        '-getProperty:UseWinUI', '-getProperty:UseWPF', '-getProperty:UseWindowsForms'],
    { windowsHide: true, timeout: 60_000 }, (error, stdout) => {
        try { resolve(error ? undefined : JSON.parse(stdout).Properties); } catch { resolve(undefined); }
    });
});

export async function checkProjectFramework(projectFile: string, evaluate: PropertyEvaluator): Promise<AppFrameworkCheck> {
    const name = path.basename(projectFile);
    const extension = path.extname(projectFile).toLowerCase();
    const content = await readText(projectFile);
    if (content === undefined) { return UNKNOWN; }

    if (extension === '.cs') { return { kind: 'other', description: `'${name}' is a .NET file-based app` }; }
    if (extension === '.vcxproj') {
        return /Include="[^"]+\.xaml"/i.test(content)
            ? { kind: 'winui' } : { kind: 'other', description: `'${name}' has no XAML pages` };
    }
    if (isTrueText(content, 'UseWinUI')) { return { kind: 'winui' }; }

    const properties = await evaluate(projectFile) ?? {
        UseWPF: isTrueText(content, 'UseWPF') ? 'true' : '',
        UseWindowsForms: isTrueText(content, 'UseWindowsForms') ? 'true' : '',
    };
    if (isTrue(properties.UseWinUI)) { return { kind: 'winui' }; }
    if (isTrue(properties.UseWPF)) { return { kind: 'other', description: `'${name}' is a WPF project` }; }
    if (isTrue(properties.UseWindowsForms)) { return { kind: 'other', description: `'${name}' is a Windows Forms project` }; }
    return { kind: 'other', description: `'${name}' isn't a WinUI 3 project` };
}

/** A build output folder holds WinUI binaries or compiled XAML (.xbf). */
export function checkOutputFolderEntries(folderName: string, entries: readonly string[]): AppFrameworkCheck {
    const winui = entries.some(entry => /^microsoft\.(winui|ui\.xaml)\.dll$/i.test(entry) || /\.xbf$/i.test(entry));
    return winui ? { kind: 'winui' } : { kind: 'other', description: `'${folderName}' doesn't contain a WinUI 3 app` };
}

/** The project `winapp run` will build: the chosen one, or the solution's single app. */
async function projectsToCheck(members: string[], project: string | undefined): Promise<string[]> {
    if (members.length <= 1) { return members; }
    if (project) {
        const wanted = project.toLowerCase();
        const match = members.find(member => member.toLowerCase() === path.resolve(project).toLowerCase()
            || path.basename(member).toLowerCase() === wanted
            || path.parse(member).name.toLowerCase() === wanted);
        if (match) { return [match]; }
    }
    const offerable = await classifyOfferableProjects(members);
    const apps = offerable.filter(entry => entry.runnability === 'app');
    return (apps.length === 1 ? apps : offerable).map(entry => entry.path);
}

async function checkMembers(container: string, members: string[], project: string | undefined,
    evaluate: PropertyEvaluator): Promise<AppFrameworkCheck> {
    const candidates = await projectsToCheck(members, project);
    if (candidates.length === 0) { return { kind: 'other', description: `'${container}' has no runnable project` }; }
    const checks = await Promise.all(candidates.map(candidate => checkProjectFramework(candidate, evaluate)));
    // With several possible apps, any WinUI 3 one may be the app the CLI runs.
    if (checks.some(check => check.kind !== 'other')) { return checks.find(check => check.kind === 'winui') ?? UNKNOWN; }
    return candidates.length === 1 ? checks[0] : { kind: 'other', description: `'${container}' has no WinUI 3 app` };
}

export async function checkAppFramework(
    input: string, project?: string, evaluate: PropertyEvaluator = evaluateWithMsBuild,
): Promise<AppFrameworkCheck> {
    if (project && PROJECT_EXTENSIONS.includes(path.extname(project).toLowerCase()) && path.isAbsolute(project)) {
        return checkProjectFramework(project, evaluate);
    }
    const extension = path.extname(input).toLowerCase();
    if (PROJECT_EXTENSIONS.includes(extension)) { return checkProjectFramework(input, evaluate); }
    if (extension === '.sln' || extension === '.slnx') {
        return checkMembers(path.basename(input), await readSolutionProjectPaths(input), project, evaluate);
    }

    let entries: string[];
    try { entries = await fsp.readdir(input); } catch { return UNKNOWN; }
    const solutions = await readDirectorySolutionPaths(input);
    if (solutions.length === 1) {
        return checkMembers(path.basename(solutions[0]), await readSolutionProjectPaths(solutions[0]), project, evaluate);
    }
    const projects = [
        ...await readDirectoryProjectPaths(input),
        ...entries.filter(entry => /\.vcxproj$/i.test(entry)).map(entry => path.join(input, entry)),
    ];
    if (projects.length > 0) { return checkMembers(path.basename(input), projects, project, evaluate); }
    return checkOutputFolderEntries(path.basename(input), entries);
}
