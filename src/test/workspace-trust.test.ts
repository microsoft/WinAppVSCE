import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { ModuleKind, transpileModule } from 'typescript';

const sourceRoot = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);
type Callback = (...args: unknown[]) => unknown;

function createHost(trusted = false) {
	const commands = new Map<string, Callback>();
	const providers: Record<string, Callback>[] = [];
	const factories: Record<string, Callback>[] = [];
	const trustListeners: (() => void)[] = [];
	const warnings: string[] = [];
	const calls: string[] = [];
	const disposable = { dispose() {} };
	const vscode = {
		DebugConfigurationProviderTriggerKind: { Dynamic: 2 },
		workspace: {
			isTrusted: trusted,
			onDidGrantWorkspaceTrust: (callback: () => void) => {
				trustListeners.push(callback);
				return disposable;
			}
		},
		window: {
			onDidChangeActiveTextEditor: () => disposable,
			showWarningMessage: (message: string) => {
				warnings.push(message);
				return Promise.resolve(undefined);
			},
			showOpenDialog: async () => {
				calls.push('filePicker');
				return undefined;
			},
			showErrorMessage: () => undefined
		},
		commands: {
			registerCommand: (id: string, callback: Callback) => {
				commands.set(id, callback);
				return disposable;
			}
		},
		debug: {
			registerDebugConfigurationProvider: (_type: string, provider: Record<string, Callback>) => {
				providers.push(provider);
				return disposable;
			},
			registerDebugAdapterDescriptorFactory: (_type: string, factory: Record<string, Callback>) => {
				factories.push(factory);
				return disposable;
			}
		}
	};
	const context = { extensionPath: 'C:\\extension', subscriptions: [] };
	const imports: Record<string, unknown> = {
		vscode,
		'./winapp-cli-utils': { resolveWindowsPowerShellPath: () => 'powershell.exe' },
		'./launch-config': {
			WINAPP_DEBUG_TYPE: 'winapp',
			createDefaultLaunchConfiguration: () => ({ type: 'winapp' })
		},
		'./launch-assets': { offerLaunchConfiguration: async () => { calls.push('launchOffer'); } },
		'./manifest-editor/manifest-editor-provider': {
			ManifestEditorProvider: { register: () => { calls.push('manifestEditor'); return disposable; } }
		},
		'./manifest-intellisense/manifest-intellisense': {
			registerManifestIntelliSense: () => calls.push('manifestIntelliSense')
		},
		'./xaml/xamlLanguageService': { activateXaml: () => calls.push('xaml') }
	};
	const cache = new Map<string, Record<string, Callback>>();
	function loadSource(name: string): Record<string, Callback> {
		const cached = cache.get(name);
		if (cached) { return cached; }
		const module = { exports: {} };
		const source = readFileSync(path.join(sourceRoot, `${name}.ts`), 'utf8');
		const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS } });
		runInNewContext(compiled.outputText, {
			module,
			exports: module.exports,
			process,
			console,
			require: (request: string) => {
				if (request in imports) { return imports[request]; }
				if (request === './workspace-trust' || request === './new-command') {
					return loadSource(request.slice(2));
				}
				if (!request.startsWith('.')) { return nodeRequire(request); }
				return new Proxy({}, {
					get: (_target, key) => {
						if (key === '__esModule') { return false; }
						return () => { throw new Error(`Unexpected dependency call: ${request}.${String(key)}`); };
					}
				});
			}
		});
		const exports = module.exports as Record<string, Callback>;
		cache.set(name, exports);
		return exports;
	}
	loadSource('extension').activate(context);
	return { vscode, commands, providers, factories, trustListeners, warnings, calls };
}

test('declares limited Restricted Mode support', () => {
	const manifest = JSON.parse(readFileSync(path.join(sourceRoot, '..', 'package.json'), 'utf8'));
	assert.equal(manifest.capabilities.untrustedWorkspaces.supported, 'limited');
	assert.match(manifest.capabilities.untrustedWorkspaces.description, /trust/i);
});

test('untrusted activation keeps safe editors but blocks every CLI command before side effects', async () => {
	const host = createHost();
	assert.deepEqual(host.calls, ['manifestEditor', 'manifestIntelliSense', 'xaml']);
	assert.ok(host.commands.has('winapp.openManifestEditor'));
	const manifest = JSON.parse(readFileSync(path.join(sourceRoot, '..', 'package.json'), 'utf8'));
	const cliCommands = manifest.contributes.commands
		.map((entry: { command: string }) => entry.command as string)
		.filter((command: string) => !command.startsWith('winapp.xaml.') && command !== 'winapp.openManifestEditor');
	assert.ok(cliCommands.includes('winapp.new'));
	assert.ok(cliCommands.includes('winapp.certInfo'));
	for (const command of cliCommands) {
		assert.ok(host.commands.has(command), `${command} is registered in Restricted Mode`);
		assert.equal(await host.commands.get(command)!(), undefined, `${command} is blocked`);
	}
	assert.equal(host.warnings.length, cliCommands.length);
	assert.deepEqual(host.calls, ['manifestEditor', 'manifestIntelliSense', 'xaml']);
});

test('all debugger entry points reject untrusted workspaces', async () => {
	const host = createHost();
	const provider = host.providers[0];
	assert.equal(await provider.resolveDebugConfiguration(undefined, {}), undefined);
	assert.equal(await provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, {}), undefined);
	assert.equal((host.providers[1].provideDebugConfigurations() as unknown[]).length, 0);
	await assert.rejects(async () => host.factories[0].createDebugAdapterDescriptor({}), /Trust this workspace/);
	assert.equal(host.warnings.length, 3);
	assert.deepEqual(host.calls, ['manifestEditor', 'manifestIntelliSense', 'xaml']);
});

test('granting trust enables existing command handlers and launch setup without reactivation', async () => {
	const host = createHost();
	await host.commands.get('winapp.certInfo')!();
	assert.ok(!host.calls.includes('filePicker'));
	host.vscode.workspace.isTrusted = true;
	for (const listener of host.trustListeners) { listener(); }
	await host.commands.get('winapp.certInfo')!();
	assert.ok(host.calls.includes('launchOffer'));
	assert.ok(host.calls.includes('filePicker'));
	assert.equal((host.providers[1].provideDebugConfigurations() as unknown[]).length, 1);
});

test('trusted activation preserves launch setup and executable commands', async () => {
	const host = createHost(true);
	assert.ok(host.calls.includes('launchOffer'));
	await host.commands.get('winapp.certInfo')!();
	assert.ok(host.calls.includes('filePicker'));
	assert.deepEqual(host.warnings, []);
});

test('manifest asset regeneration checks trust before file selection or CLI execution', () => {
	const source = readFileSync(path.join(sourceRoot, 'manifest-editor', 'manifest-editor-provider.ts'), 'utf8');
	const handler = source.slice(source.indexOf("case 'updateAssets':"));
	assert.ok(handler.indexOf('requireTrustedWorkspace()') > 0);
	assert.ok(handler.indexOf('requireTrustedWorkspace()') < handler.indexOf('showOpenDialog'));
	assert.ok(handler.indexOf('requireTrustedWorkspace()') < handler.indexOf('execFile('));
});
