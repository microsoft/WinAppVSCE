/**
 * Pure launch-configuration logic for the DevTools integration.
 *
 * Lives outside extension.ts so the semantics of the `useDevTools` and
 * `noOverlay` launch.json properties are unit-testable. The extension host is
 * not importable from the unit suite, and these two flags decide whether the
 * feature engages at all, so they are worth testing directly rather than only
 * through a manual F5.
 */

/** The subset of a launch.json entry that the DevTools integration reads. */
export interface DevToolsLaunchConfig {
    /**
     * Opt out of DevTools for this configuration.
     *
     * Deliberately tri-state: absent means on. DevTools is the default
     * experience, so a configuration written before the feature existed still
     * gets it, and only an explicit `false` turns it off.
     */
    useDevTools?: boolean;

    /**
     * Suppress the in-app overlay toolbar while keeping the engine running.
     *
     * The VS Code panel is a second client of the same engine, so a user who
     * wants to inspect entirely from the editor can hide the floating toolbar
     * without losing the panel.
     */
    noOverlay?: boolean;

    /**
     * Run the app without attaching a debugger.
     *
     * Set by VS Code itself for "Run Without Debugging" (Ctrl+F5), and also
     * writable directly in launch.json. Honouring it lets the app launch —
     * with DevTools — without a language debugger extension installed at all,
     * which is the only part of the flow that depends on C# Dev Kit.
     */
    noDebug?: boolean;

    /**
     * The rest of the launch configuration, which we do not read here.
     *
     * Declared so a `vscode.DebugConfiguration` can be passed straight in: it
     * carries an index signature of its own, and without one here TypeScript
     * treats this as a weak type and rejects the assignment.
     */
    [key: string]: unknown;
}

/**
 * Whether DevTools should engage for a launch configuration.
 *
 * Both the CLI spawn arguments and the panel are gated on this, so they can
 * never disagree about whether the feature is on.
 */
export function shouldUseDevTools(config: DevToolsLaunchConfig | undefined): boolean {
    return config?.useDevTools !== false;
}

/**
 * Whether to attach a language debugger to the launched app.
 *
 * False only for an explicit `noDebug`, so the default stays "attach". When
 * this is false the launch skips both the debugger-extension check and the
 * child debug session, which is what makes a DevTools-only run possible
 * without C# Dev Kit.
 */
export function shouldAttachDebugger(config: DevToolsLaunchConfig | undefined): boolean {
    return config?.noDebug !== true;
}

/**
 * The `winapp run` arguments that select a DevTools mode.
 *
 * `--devtools` takes a mode: `on` draws the in-app toolbar, `headless` runs the
 * engine with nothing drawn in the app, and `off` disables it. The mode is
 * always passed explicitly, including `off`: the CLI turns DevTools on by
 * default for WinUI projects, so omitting the flag would quietly enable it for
 * someone who asked for `useDevTools: false`.
 */
export function devToolsSpawnArgs(config: DevToolsLaunchConfig | undefined): string[] {
    if (!shouldUseDevTools(config)) {
        return ['--devtools', 'off'];
    }

    // The panel is a second client of the same engine, so hiding the overlay
    // has to keep the engine running - that is exactly what headless is.
    return ['--devtools', config?.noOverlay ? 'headless' : 'on'];
}
