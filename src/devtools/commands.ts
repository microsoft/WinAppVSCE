import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { BUILD_OUTPUT_EXCLUDE_GLOB } from '../project-detection';
import { getWinappOutputChannel, selectFolder } from '../winapp-host';
import { DevToolsCli, parseApps } from './devtools-cli';
import { DevToolsPanel } from './devtools-panel';
import { inspectorPreference } from './launch-options';
import { existingSourceRoot, matchSourceRoot } from './source-resolver';

/** The running exe's path, which tells apart two projects that build the same exe name. */
function processImagePath(processId: number): Promise<string | undefined> {
    return new Promise(resolve => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            `(Get-Process -Id ${Math.trunc(processId)} -ErrorAction Stop).Path`],
        { windowsHide: true, timeout: 10_000 }, (error, stdout) => {
            const text = stdout?.trim();
            resolve(!error && text ? text : undefined);
        });
    });
}

async function chooseSourceRoot(processName?: string, exePath?: string): Promise<string | undefined> {
    const projects = await vscode.workspace.findFiles('**/*.{csproj,vcxproj}', BUILD_OUTPUT_EXCLUDE_GLOB);
    const match = matchSourceRoot(projects.map(uri => uri.fsPath), processName, exePath);
    if (match) { return match; }
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (projects.length === 0 && folders.length === 1) { return folders[0].uri.fsPath; }
    const items = [
        ...projects.map(uri => ({ label: path.basename(uri.fsPath), description: path.dirname(uri.fsPath), root: path.dirname(uri.fsPath) })),
        ...folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, root: folder.uri.fsPath })),
        { label: 'Browse for a project folder...', description: '', root: undefined },
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select the app project folder (source root)' });
    if (!picked) { return undefined; }
    return picked.root ?? selectFolder('Select the app project folder');
}

export function registerDevToolsCommands(context: vscode.ExtensionContext): void {
    const cli = new DevToolsCli(context.extensionPath, message => getWinappOutputChannel().appendLine(message));
    const register = (name: string, run: () => Promise<void>) => {
        context.subscriptions.push(vscode.commands.registerCommand(name, async () => {
            try { await run(); }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                getWinappOutputChannel().appendLine(`${name}: ${message}`);
                void vscode.window.showErrorMessage(`WinUI DevTools: ${message}`);
            }
        }));
    };

    register('winapp.attachDevTools', async () => {
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? context.extensionPath;
        const apps = parseApps(await cli.run(['devtools', 'list', '--include-available'], cwd));
        if (!apps.length) {
            void vscode.window.showInformationMessage('No running WinUI apps were found.');
            return;
        }
        const picked = await vscode.window.showQuickPick(apps.map(app => ({
            label: app.windowTitle || app.processName,
            description: `${app.processName} (${app.processId})${app.attached ? ' - DevTools attached' : ''}`,
            app,
        })), { placeHolder: 'Attach WinUI DevTools to a running app' });
        if (!picked) { return; }
        let sourceRoot = await chooseSourceRoot(picked.app.processName, await processImagePath(picked.app.processId));
        if (!sourceRoot) { return; }
        const inspector = inspectorPreference(undefined,
            vscode.workspace.getConfiguration('winapp.devTools', vscode.Uri.file(sourceRoot)).get('inspector'));
        const surfaceArgs = inspector === 'native' ? ['--show-window'] : ['--overlay'];
        const attachArgs = ['devtools', 'attach', '--pid', String(picked.app.processId)];
        try {
            await cli.run([...attachArgs, '--source-root', sourceRoot, ...surfaceArgs], sourceRoot);
        } catch (error) {
            // An app launched from another folder keeps that folder; attach to it rather than fail.
            const existing = existingSourceRoot(error instanceof Error ? error.message : String(error));
            if (!existing) { throw error; }
            sourceRoot = existing;
            await cli.run([...attachArgs, ...surfaceArgs], sourceRoot);
        }
        if (inspector === 'vscode') {
            await DevToolsPanel.show(picked.app.processId, context.extensionUri, vscode.ViewColumn.Active, sourceRoot);
        }
    });

    register('winapp.showDevTools', async () => {
        if (DevToolsPanel.revealLive()) { return; }
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? context.extensionPath;
        const apps = parseApps(await cli.run(['devtools', 'list'], cwd)).filter(app => app.attached);
        if (!apps.length) {
            const attach = 'Attach to Running App';
            const choice = await vscode.window.showInformationMessage('No running app has DevTools attached.', attach);
            if (choice === attach) { await vscode.commands.executeCommand('winapp.attachDevTools'); }
            return;
        }
        const app = apps.length === 1 ? apps[0] : (await vscode.window.showQuickPick(apps.map(entry => ({
            label: entry.windowTitle || entry.processName,
            description: `${entry.processName} (${entry.processId})`,
            app: entry,
        })), { placeHolder: 'Show WinUI DevTools for' }))?.app;
        if (!app) { return; }
        const sourceRoot = DevToolsPanel.knownSourceRoot(app.processId)
            ?? await chooseSourceRoot(app.processName, await processImagePath(app.processId));
        if (!sourceRoot) { return; }
        await DevToolsPanel.show(app.processId, context.extensionUri, vscode.ViewColumn.Active, sourceRoot);
    });

    register('winapp.openDevToolsComments', async () => {
        const sourceRoot = await chooseSourceRoot();
        if (sourceRoot) { await DevToolsPanel.showComments(context.extensionUri, sourceRoot); }
    });
    register('winapp.devToolsTogglePick', async () => { DevToolsPanel.togglePickInActive(); });
    context.subscriptions.push({ dispose: () => DevToolsPanel.disposeAll() });
}
