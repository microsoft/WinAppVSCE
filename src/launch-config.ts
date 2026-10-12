import * as path from 'path';
import { isContainedIn } from './project-detection';

/**
 * Builds the `launch.json` entries the extension generates for users, so a
 * first F5 works without hand-authoring a configuration.
 *
 * Deliberately free of `vscode` imports: VS Code owns writing these objects
 * out, and keeping the shapes pure makes them unit-testable.
 */

export const WINAPP_DEBUG_TYPE = 'winapp';

/** Also the label of the static snippet in package.json; keep them in sync. */
export const WINAPP_LAUNCH_CONFIG_NAME = 'WinApp: Launch and Attach';

/** The token VS Code substitutes with the folder a configuration belongs to. */
export const WORKSPACE_FOLDER_TOKEN = '${workspaceFolder}';

export interface WinAppLaunchConfiguration {
	type: typeof WINAPP_DEBUG_TYPE;
	request: 'launch';
	name: string;
	/** Project, solution, or build output folder to run. */
	input?: string;
	/** Selects one app inside a multi-project solution. */
	project?: string;
}

/**
 * Render a path for `launch.json`, preferring a `${workspaceFolder}`-relative
 * form so the configuration survives being cloned to another machine.
 * Paths outside the folder stay absolute — there is no portable spelling.
 */
export function toConfiguredPath(rootPath: string, targetPath: string): string {
	if (!isContainedIn(rootPath, targetPath)) {
		return targetPath;
	}

	const relative = path.relative(rootPath, targetPath);
	if (!relative) {
		return WORKSPACE_FOLDER_TOKEN;
	}

	// launch.json is cross-platform JSON; forward slashes read better and are
	// accepted by Windows APIs all the same.
	return `${WORKSPACE_FOLDER_TOKEN}/${relative.split(path.sep).join('/')}`;
}

/**
 * A configuration pointing at a discovered run target. `project` is only
 * emitted when the user picked one app inside a solution, matching the CLI's
 * own rule that `--project` is meaningful in project mode only.
 */
export function createLaunchConfiguration(
	rootPath: string,
	targetPath: string,
	projectPath?: string
): WinAppLaunchConfiguration {
	const config: WinAppLaunchConfiguration = {
		type: WINAPP_DEBUG_TYPE,
		request: 'launch',
		name: WINAPP_LAUNCH_CONFIG_NAME,
		input: toConfiguredPath(rootPath, targetPath)
	};

	if (projectPath) {
		config.project = toConfiguredPath(rootPath, projectPath);
	}

	return config;
}

/**
 * Used when discovery finds nothing or the user dismisses the target picker.
 * Omitting `input` is what makes this useful rather than wrong: the debug
 * adapter then runs its own discovery at F5 time, by which point the project
 * may well have been created or built.
 */
export function createFallbackLaunchConfiguration(): WinAppLaunchConfiguration {
	return {
		type: WINAPP_DEBUG_TYPE,
		request: 'launch',
		name: WINAPP_LAUNCH_CONFIG_NAME
	};
}

/** True when `launch.json` already has a WinApp entry worth preserving. */
export function hasWinAppConfiguration(configurations: unknown): boolean {
	return Array.isArray(configurations)
		&& configurations.some(entry =>
			typeof entry === 'object'
			&& entry !== null
			&& (entry as { type?: unknown }).type === WINAPP_DEBUG_TYPE);
}
