import * as vscode from 'vscode';
import * as path from 'path';
import { BUILD_OUTPUT_EXCLUDE_GLOB } from '../project-detection';
import { getWinappOutputChannel, selectFolder } from '../winapp-host';
import { DevToolsCli, parseApps } from './devtools-cli';
import { DevToolsPanel } from './devtools-panel';
import { inspectorPreference } from './launch-options';
import { matchSourceRoot } from './source-resolver';

async function chooseSourceRoot(processName?: string): Promise<string | undefined> {
    const projects = await vscode.workspace.findFiles('**/*.{csproj,vcxproj}', BUILD_OUTPUT_EXCLUDE_GLOB);
    const match = matchSourceRoot(projects.map(uri => uri.fsPath), processName);
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
        const sourceRoot = await chooseSourceRoot(picked.app.processName);
        if (!sourceRoot) { return; }
        const inspector = inspectorPreference(undefined,
            vscode.workspace.getConfiguration('winapp.devTools', vscode.Uri.file(sourceRoot)).get('inspector'));
        const args = ['devtools', 'attach', '--pid', String(picked.app.processId), '--source-root', sourceRoot];
        if (inspector === 'native') { args.push('--show-window'); }
        else { args.push('--overlay'); }
        await cli.run(args, sourceRoot);
        if (inspector === 'vscode') {
            await DevToolsPanel.show(picked.app.processId, context.extensionUri, vscode.ViewColumn.Active, sourceRoot);
        }
    });

    register('winapp.openDevToolsComments', async () => {
        const sourceRoot = await chooseSourceRoot();
        if (sourceRoot) { await DevToolsPanel.showComments(context.extensionUri, sourceRoot); }
    });
    register('winapp.devToolsTogglePick', async () => { DevToolsPanel.togglePickInActive(); });
    context.subscriptions.push({ dispose: () => DevToolsPanel.disposeAll() });
}
