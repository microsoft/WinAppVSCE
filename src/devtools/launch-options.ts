/**
 * Pure launch-configuration logic for the DevTools integration, kept out of
 * extension.ts so the `devTools` launch.json property is unit-testable.
 */

/** Mirrors `winapp run --devtools`. */
export const DEVTOOLS_MODES = ['on', 'headless', 'off'] as const;
export type DevToolsMode = typeof DEVTOOLS_MODES[number];

/** The subset of a launch.json entry that the DevTools integration reads. */
export interface DevToolsLaunchConfig {
    /** Explicit DevTools mode; omitted leaves the choice to the CLI's default. */
    devTools?: unknown;

    /** Set by VS Code for "Run Without Debugging" (Ctrl+F5) or written in launch.json. */
    noDebug?: boolean;

    /** Lets a `vscode.DebugConfiguration` be passed straight in. */
    [key: string]: unknown;
}

/** The explicit mode, or undefined when the CLI default applies. */
export function devToolsMode(config: DevToolsLaunchConfig | undefined): DevToolsMode | undefined {
    const mode = config?.devTools;
    return (DEVTOOLS_MODES as readonly unknown[]).includes(mode) ? mode as DevToolsMode : undefined;
}

/** Whether the user explicitly asked for DevTools (on or headless). */
export function requestsDevTools(config: DevToolsLaunchConfig | undefined): boolean {
    const mode = devToolsMode(config);
    return mode === 'on' || mode === 'headless';
}

/** Whether DevTools may engage; both the spawn arguments and the panel are gated on it. */
export function shouldUseDevTools(config: DevToolsLaunchConfig | undefined): boolean {
    return devToolsMode(config) !== 'off';
}

/** False only for an explicit `noDebug`, so the default stays "attach". */
export function shouldAttachDebugger(config: DevToolsLaunchConfig | undefined): boolean {
    return config?.noDebug !== true;
}

/** Leave automatic launches to the CLI; an explicit mode is passed through as-is. */
export function devToolsSpawnArgs(config: DevToolsLaunchConfig | undefined): string[] {
    const mode = devToolsMode(config);
    return mode ? ['--devtools', mode] : [];
}

/**
 * Why the CLI refused an explicit DevTools launch for the app's type, or undefined.
 * Covers app types the pre-launch check could not decide; the CLI names no error code.
 */
export function unsupportedAppTypeReason(spawnArgs: string[], failure: string): string | undefined {
    const index = spawnArgs.indexOf('--devtools');
    if (index === -1 || spawnArgs[index + 1] === 'off') { return undefined; }
    const match = /^DevTools requires WinUI 3;\s*(.+?)\.(?:\s+Run with --devtools off\b.*)?$/i.exec(failure.trim());
    return match ? match[1] : undefined;
}

/** The same launch with DevTools turned off. */
export function withDevToolsOff(spawnArgs: string[]): string[] {
    const index = spawnArgs.indexOf('--devtools');
    if (index === -1) { return [...spawnArgs, '--devtools', 'off']; }
    const next = [...spawnArgs];
    next[index + 1] = 'off';
    return next;
}
