/**
 * The `winapp.new` command: scaffold a WinUI app from an official Windows App
 * SDK template. Deliberately skips getWorkspacePath() — scaffolding is most
 * useful with no folder open, and it writes outside the current workspace.
 */

import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import {
	buildNewArgs,
	describeNewFailure,
	isNonEmptyOutputFailure,
	isSdkMissingExit,
	NEW_EXIT,
	parseScaffoldResult,
	parseTemplateList,
	type TemplateListAttempt,
	type TemplateListResult,
	type TemplateLoad,
	type WinUiTemplate
} from './new-command-utils';
import {
	DOTNET_DOWNLOAD_URL,
	getWinappOutputChannel,
	runWinappCapture,
	selectFolder
} from './winapp-host';

/**
 * Load the WinUI template list, installing the pack only when necessary. Probes
 * `--template-version installed` first to skip an ~8s feed round trip; only exit
 * 4 (no pack) retries unpinned. Never cached: the pack changes outside VS Code.
 *
 * @param templateVersion When `'latest'`, installs the newest template pack
 *                        before listing. Omitted on the normal path.
 * @returns The parsed list, or `undefined` when the run failed or was cancelled
 *          (the failure has already been reported to the user).
 */
async function loadWinUiTemplates(
	extensionPath: string,
	cwd: string,
	templateVersion?: 'latest'
): Promise<TemplateLoad | undefined> {
	if (templateVersion !== 'latest') {
		const local = await runTemplateList(
			extensionPath,
			cwd,
			'installed',
			'Loading WinUI templates...'
		);

		if (local.cancelled) {
			return undefined;
		}
		if (local.parsed?.ok && local.code === 0) {
			return { list: local.parsed.value, freshlyInstalled: false };
		}
		if (local.code !== NEW_EXIT.packFailed) {
			// Only "no pack installed" justifies retrying unpinned; anything else
			// fails identically behind a progress message promising an install the
			// retry can never do. The CLI distinguishes "no SDK" from "SDK too old".
			const detail = local.parsed && !local.parsed.ok
				? local.parsed.error
				: describeNewFailure(local.code, undefined);
			await showNewFailure(detail, isSdkMissingExit(local.code));
			return undefined;
		}
		// Exit 4 from the `installed` probe means no pack is installed yet: fall
		// through to the unpinned listing, which installs the latest on demand.
	}

	// Both routes here install the newest pack: an explicit 'latest' updates a
	// stale one, and the unpinned listing fetches on demand when none exists.
	const result = await runTemplateList(
		extensionPath,
		cwd,
		templateVersion,
		'Installing the latest WinUI templates...'
	);

	if (result.cancelled) {
		return undefined;
	}

	if (!result.parsed?.ok || result.code !== 0) {
		const message = result.parsed && !result.parsed.ok
			? result.parsed.error
			: 'Failed to load the WinUI templates.';
		await showNewFailure(message, isSdkMissingExit(result.code));
		return undefined;
	}

	// Reaching the unpinned listing on the default path means nothing was
	// installed and the CLI has just fetched the newest pack.
	return { list: result.parsed.value, freshlyInstalled: templateVersion !== 'latest' };
}

/**
 * Run one `winapp new --list --json` attempt, returning the outcome rather than
 * reporting it: the first attempt fails routinely when no pack is installed, and
 * the retry succeeds. {@link loadWinUiTemplates} reports whatever is final.
 */
async function runTemplateList(
	extensionPath: string,
	cwd: string,
	templateVersion: 'latest' | 'installed' | undefined,
	progressMessage: string
): Promise<TemplateListAttempt> {
	const args = ['new', '--list', '--json'];
	if (templateVersion) {
		args.push('--template-version', templateVersion);
	}

	const result = await runWinappCapture(
		extensionPath,
		args,
		cwd,
		progressMessage
	);

	if (result.cancelled) {
		return { cancelled: true, code: result.code };
	}

	return { cancelled: false, code: result.code, parsed: parseTemplateList(result.output) };
}

/**
 * Show a `winapp new` failure with an actionable follow-up. A missing .NET SDK
 * is the one failure with a specific remedy, so it gets a modal and an installer
 * link; everything else points at the output channel.
 */
async function showNewFailure(message: string, sdkMissing: boolean): Promise<void> {
	if (sdkMissing) {
		const choice = await vscode.window.showErrorMessage(
			message,
			{ modal: true },
			'Install .NET SDK'
		);
		if (choice === 'Install .NET SDK') {
			await vscode.env.openExternal(vscode.Uri.parse(DOTNET_DOWNLOAD_URL));
		}
		return;
	}

	const choice = await vscode.window.showErrorMessage(message, 'Show Output');
	if (choice === 'Show Output') {
		getWinappOutputChannel().show();
	}
}

/**
 * Ask which WinUI template pack to scaffold from. `--json` forces
 * `--use-defaults`, so a JSON caller would otherwise pin itself to the installed
 * pack forever. "No changes to your machine" leads, so Enter can't install.
 *
 * @returns The list to use, or `undefined` if the user cancelled.
 */
async function resolveTemplatePack(
	extensionPath: string,
	cwd: string,
	initial: TemplateListResult,
	freshlyInstalled: boolean
): Promise<TemplateListResult | undefined> {
	// Nothing installed before this run means the listing just fetched the
	// latest pack, so "installed" and "latest" are the same thing and the
	// question would be noise.
	if (!initial.templateVersion || freshlyInstalled) {
		return initial;
	}

	const useInstalled = {
		label: 'Use installed templates',
		description: `Pack ${initial.templateVersion} — no changes to your machine`
	};
	const useLatest = {
		label: 'Use latest templates',
		description:
			"Installs the newest WinUI template pack machine-wide, for all projects and tools that use 'dotnet new'"
	};

	const picked = await vscode.window.showQuickPick([useInstalled, useLatest], {
		placeHolder: 'Which WinUI templates should be used?'
	});

	if (!picked) {
		return undefined;
	}

	if (picked.label === useInstalled.label) {
		return initial;
	}

	const latest = await loadWinUiTemplates(extensionPath, cwd, 'latest');
	return latest?.list;
}

/** Let the user pick a WinUI template from the installed pack. */
async function pickWinUiTemplate(templates: WinUiTemplate[]): Promise<WinUiTemplate | undefined> {
	const items = templates.map((template) => ({
		label: template.displayName,
		description: `(${template.shortName})`,
		template
	}));

	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: 'Select a WinUI template',
		matchOnDescription: true
	});

	return picked?.template;
}

/** Register `winapp.new`. */
export function registerWinappNewCommand(
	context: vscode.ExtensionContext,
	extensionPath: string
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('winapp.new', async () => {
			// The folder picker should open somewhere familiar, so it still starts
			// from the workspace (or home when nothing is open).
			const defaultFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();

			// Listing runs from a neutral directory: a global.json here pinning an
			// unavailable SDK would make the CLI report exit 3 even though the SDK
			// is installed. The scaffold still runs from the destination.
			const listingCwd = os.tmpdir();

			const initialLoad = await loadWinUiTemplates(extensionPath, listingCwd);
			if (!initialLoad) {
				return;
			}

			const templateList = await resolveTemplatePack(
				extensionPath,
				listingCwd,
				initialLoad.list,
				initialLoad.freshlyInstalled
			);
			if (!templateList) {
				return;
			}

			const template = await pickWinUiTemplate(templateList.templates);
			if (!template) {
				return;
			}

			// Prefill only: the flow always passes --name, so the CLI's own
			// default never applies and cannot drift from this value.
			const defaultName = 'WinUIApp';
			const requestedName = await vscode.window.showInputBox({
				prompt: 'Name for the new app',
				value: defaultName,
				valueSelection: [0, defaultName.length]
			});
			if (!requestedName) {
				return;
			}

			const parentDirectory = await selectFolder(
				`Select the parent folder — ${requestedName} will be created inside it`,
				vscode.Uri.file(defaultFolder)
			);
			if (!parentDirectory) {
				return;
			}

			const outputDirectory = path.join(parentDirectory, requestedName);
			const scaffoldOnce = async (force: boolean) =>
				runWinappCapture(
					extensionPath,
					buildNewArgs({
						template: template.shortName,
						name: requestedName,
						output: outputDirectory,
						force,
						// The pack the user chose is already installed by the listing
						// step, so pin to it rather than letting the scaffold re-check
						// the feed (and potentially pull a newer pack mid-flow).
						templateVersion: 'installed'
					}),
					parentDirectory,
					`Creating ${requestedName}...`
				);

			let result = await scaffoldOnce(false);
			if (result.cancelled) {
				return;
			}
			let scaffold = parseScaffoldResult(result.output);

			// The CLI refuses a non-empty output directory without writing anything
			// and says to use --force. That's the one failure worth offering a retry.
			if (isNonEmptyOutputFailure(result.code, scaffold)) {
				const createAnyway = 'Create Anyway';
				const choice = await vscode.window.showWarningMessage(
					describeNewFailure(result.code, scaffold, result.output),
					{ modal: true },
					createAnyway
				);
				if (choice !== createAnyway) {
					return;
				}

				result = await scaffoldOnce(true);
				if (result.cancelled) {
					return;
				}
				scaffold = parseScaffoldResult(result.output);
			}

			if (result.code !== 0 || !scaffold?.created) {
				await showNewFailure(
					describeNewFailure(result.code, scaffold, result.output),
					isSdkMissingExit(result.code)
				);
				return;
			}

			vscode.window.showInformationMessage(
				`Created ${scaffold.name ?? requestedName} at ${scaffold.projectPath ?? outputDirectory}`
			);
		})
	);
}
