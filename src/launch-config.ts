/**
 * The `launch.json` entry the extension generates, so a first F5 works
 * without hand-authoring a configuration.
 *
 * There is deliberately ONE configuration shape. The notification, VS Code's
 * "create a launch.json file" flow, and the Run and Debug dropdown must all
 * produce identical content — a user should never be able to tell which path
 * wrote their launch.json. It matches
 * `contributes.debuggers[0].initialConfigurations` in package.json, which is
 * what VS Code would write on its own if we contributed no provider at all;
 * package-contributions.test.ts asserts the two stay in step.
 *
 * Deliberately free of `vscode` imports: VS Code owns writing these objects
 * out, and keeping the shape pure makes it unit-testable.
 */

export const WINAPP_DEBUG_TYPE = 'winapp';

/** Also the label of the static snippet in package.json; keep them in sync. */
export const WINAPP_LAUNCH_CONFIG_NAME = 'WinApp: Launch and Attach';

export interface WinAppLaunchConfiguration {
	type: typeof WINAPP_DEBUG_TYPE;
	request: 'launch';
	name: string;
}

/**
 * The configuration every generation path writes.
 *
 * It names no run target on purpose. The debug adapter already discovers one
 * at F5 time — silently when the workspace holds a single app — so baking a
 * path in here would only go stale, and would differ from what VS Code's own
 * "create a launch.json file" flow produces.
 */
export function createDefaultLaunchConfiguration(): WinAppLaunchConfiguration {
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
