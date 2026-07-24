import * as path from 'path';
import * as vscode from 'vscode';
import {
	CloseAction,
	ErrorAction,
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient | undefined;
let restartInProgress = false;

async function startClient(context: vscode.ExtensionContext): Promise<void> {
	if (client || !vscode.workspace.getConfiguration('winapp.xaml').get<boolean>('languageServer.enable', true)) {
		return;
	}

	const serverModule = path.join(context.extensionPath, 'dist', 'xaml-server.js');
	const serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: { module: serverModule, transport: TransportKind.ipc }
	};

	const clientOptions: LanguageClientOptions = {
		documentSelector: [{ language: 'xaml' }],
		synchronize: {
			configurationSection: 'winapp',
			fileEvents: vscode.workspace.createFileSystemWatcher('**/*.xaml')
		},
		errorHandler: {
			error: (error) => {
				vscode.window.showErrorMessage(`WinApp XAML language server error: ${error.message}`);
				return { action: ErrorAction.Continue };
			},
			closed: () => {
				if (vscode.workspace.getConfiguration('winapp.xaml').get<boolean>('languageServer.enable', true)) {
					return { action: CloseAction.Restart };
				}
				return { action: CloseAction.DoNotRestart };
			}
		}
	};

	client = new LanguageClient('winapp-xaml-language-server', 'WinApp XAML Language Server', serverOptions, clientOptions);
	await client.start();
}

async function stopClient(): Promise<void> {
	if (!client) {
		return;
	}
	const currentClient = client;
	client = undefined;
	await currentClient.stop();
}

async function restartClient(context: vscode.ExtensionContext, silent: boolean = false): Promise<void> {
	if (restartInProgress) {
		return;
	}
	restartInProgress = true;
	try {
		await stopClient();
		await startClient(context);
		if (!silent) {
			vscode.window.showInformationMessage('WinApp XAML language server restarted.');
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(`Failed to restart WinApp XAML language server: ${message}`);
	} finally {
		restartInProgress = false;
	}
}

/**
 * Activates the XAML language client and related commands.
 */
export function activateXamlLanguageServer(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('winapp.xaml.restartLanguageServer', async () => {
			await restartClient(context);
		}),
		vscode.commands.registerCommand('winapp.xaml.reloadMetadata', async () => {
			if (!client) {
				await startClient(context);
			}
			await client?.sendRequest('winapp/xaml/reloadMetadata');
			vscode.window.showInformationMessage('WinApp XAML metadata reloaded.');
		}),
		vscode.workspace.onDidChangeConfiguration(async (event) => {
			if (!event.affectsConfiguration('winapp.xaml')) {
				return;
			}
			if (vscode.workspace.getConfiguration('winapp.xaml').get<boolean>('languageServer.enable', true)) {
				await startClient(context);
			} else {
				await stopClient();
			}
		}),
		{ dispose: () => { void stopClient(); } }
	);

	void startClient(context);
}

/**
 * Deactivates the XAML language client.
 */
export function deactivateXamlLanguageServer(): Promise<void> | undefined {
	return client ? stopClient() : undefined;
}
