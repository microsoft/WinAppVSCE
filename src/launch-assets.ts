import * as vscode from 'vscode';
import {
	createFallbackLaunchConfiguration,
	createLaunchConfiguration,
	hasWinAppConfiguration,
	WINAPP_LAUNCH_CONFIG_NAME,
	type WinAppLaunchConfiguration
} from './launch-config';
import { pickRunTarget, pickSolutionProject } from './run-utils';

/**
 * Generates `launch.json` for the user, so pressing F5 works without
 * hand-authoring a configuration.
 *
 * VS Code resolves a bare F5 from the *active editor's language*, so an
 * extension can never be offered for every file type a user might have open.
 * The durable fix is the one the C# extension uses: make sure a `launch.json`
 * exists, after which the active editor stops mattering entirely.
 */

/** Opt-out for the proactive offer, mirroring csharp.suppressBuildAssetsNotification. */
const SUPPRESS_SETTING = 'winapp.suppressLaunchConfigNotification';

/** Files that mark a workspace as a WinApp project worth offering F5 for. */
const MANIFEST_GLOB = '**/{*.appxmanifest,[Aa]ppx[Mm]anifest.xml}';

const MANIFEST_EXCLUDE_GLOB = '**/{node_modules,bin,obj,.git}/**';

function launchConfigurationSection(folder: vscode.WorkspaceFolder): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration('launch', folder.uri);
}

/** Read the configurations already present for a folder. */
function readConfigurations(folder: vscode.WorkspaceFolder): unknown[] {
	return launchConfigurationSection(folder).get<unknown[]>('configurations') ?? [];
}

/**
 * Append a configuration and persist it. Targets the folder rather than the
 * workspace so multi-root setups get a `launch.json` beside the project the
 * user actually chose.
 */
async function appendConfiguration(
	folder: vscode.WorkspaceFolder,
	config: WinAppLaunchConfiguration
): Promise<void> {
	const existing = readConfigurations(folder);
	await launchConfigurationSection(folder).update(
		'configurations',
		[...existing, config],
		vscode.ConfigurationTarget.WorkspaceFolder
	);
}

/**
 * Choose the folder to generate into. Prompts only when a multi-root
 * workspace makes the answer genuinely ambiguous.
 */
async function resolveTargetFolder(): Promise<vscode.WorkspaceFolder | undefined> {
	const folders = vscode.workspace.workspaceFolders ?? [];
	if (folders.length === 0) {
		vscode.window.showErrorMessage('Open a folder or workspace before generating a launch configuration.');
		return undefined;
	}
	if (folders.length === 1) {
		return folders[0];
	}
	return vscode.window.showWorkspaceFolderPick({
		placeHolder: 'Which folder should the WinApp launch configuration be added to?'
	});
}

/**
 * Build a configuration for `folder`, asking the user what to run.
 *
 * Always resolves to a configuration: if discovery finds nothing, or the user
 * backs out of the picker, fall back to a target-less entry whose discovery
 * happens at F5 time instead. A `launch.json` that needs one field filled in
 * beats no `launch.json` at all, which is the state that produces VS Code's
 * "install an extension for <language>" dead end.
 */
export async function buildLaunchConfiguration(
	folder: vscode.WorkspaceFolder
): Promise<WinAppLaunchConfiguration> {
	const selection = await pickRunTarget(folder);
	if (!selection) {
		return createFallbackLaunchConfiguration();
	}

	const { cancelled, project } = await pickSolutionProject(selection);
	if (cancelled) {
		return createFallbackLaunchConfiguration();
	}

	return createLaunchConfiguration(folder.uri.fsPath, selection.target.path, project);
}

/**
 * `WinApp: Generate launch.json`. Adds a configuration and opens the file so
 * the result is visible and editable rather than silently applied.
 */
export async function generateLaunchConfiguration(): Promise<void> {
	const folder = await resolveTargetFolder();
	if (!folder) {
		return;
	}

	const config = await buildLaunchConfiguration(folder);

	try {
		await appendConfiguration(folder, config);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(`Failed to write launch.json: ${message}`);
		return;
	}

	await vscode.commands.executeCommand('workbench.action.debug.configure', folder.uri);
	vscode.window.showInformationMessage(
		`Added "${WINAPP_LAUNCH_CONFIG_NAME}" to launch.json. Press F5 to run and debug.`
	);
}

/** True when the workspace holds a package manifest, our strongest WinApp signal. */
async function looksLikeWinAppWorkspace(): Promise<boolean> {
	const found = await vscode.workspace.findFiles(MANIFEST_GLOB, MANIFEST_EXCLUDE_GLOB, 1);
	return found.length > 0;
}

/**
 * Offer to generate `launch.json` on activation when a WinApp workspace has
 * none. Silent unless all of: the workspace looks like a WinApp project, no
 * WinApp configuration exists yet, and the user hasn't opted out.
 */
export async function offerLaunchConfiguration(): Promise<void> {
	if (vscode.workspace.getConfiguration().get<boolean>(SUPPRESS_SETTING)) {
		return;
	}

	const folders = vscode.workspace.workspaceFolders ?? [];
	if (folders.length === 0) {
		return;
	}

	// Never nag a workspace that is already set up.
	if (folders.some(folder => hasWinAppConfiguration(readConfigurations(folder)))) {
		return;
	}

	if (!await looksLikeWinAppWorkspace()) {
		return;
	}

	const yes = 'Yes';
	const notNow = 'Not Now';
	const never = "Don't Ask Again";

	const choice = await vscode.window.showInformationMessage(
		'This looks like a WinApp project, but there is no launch configuration to build and debug it. Add one?',
		yes,
		notNow,
		never
	);

	if (choice === never) {
		await vscode.workspace.getConfiguration().update(
			SUPPRESS_SETTING,
			true,
			vscode.ConfigurationTarget.Global
		);
		return;
	}

	if (choice === yes) {
		await generateLaunchConfiguration();
	}
}
