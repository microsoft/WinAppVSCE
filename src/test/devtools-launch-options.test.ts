/**
 * Tests for the launch.json DevTools options.
 *
 * This is the entry point to the whole feature — if these two flags are read
 * wrongly, pressing F5 either silently skips DevTools or forces it on someone
 * who opted out. The logic is small but the default is deliberately tri-state,
 * which is exactly the kind of thing that gets "simplified" into a bug.
 */

import { test } from 'node:test';
import * as assert from 'assert';
import { devToolsSpawnArgs, shouldAttachDebugger, shouldUseDevTools } from '../devtools/launch-options';

// ───────────────────────────── the default ─────────────────────────────

test('DevTools is on for a configuration that never mentions it', () => {
    // Configurations written before the feature existed must still get it.
    assert.strictEqual(shouldUseDevTools({}), true);
});

test('DevTools is on when there is no configuration at all', () => {
    assert.strictEqual(shouldUseDevTools(undefined), true);
});

test('DevTools is on when explicitly requested', () => {
    assert.strictEqual(shouldUseDevTools({ useDevTools: true }), true);
});

test('only an explicit false turns DevTools off', () => {
    assert.strictEqual(shouldUseDevTools({ useDevTools: false }), false);
});

// ───────────────────────────── spawn arguments ─────────────────────────────

test('an unconfigured launch asks the CLI for DevTools on', () => {
    assert.deepStrictEqual(devToolsSpawnArgs({}), ['--devtools', 'on']);
});

test('opting out turns DevTools off explicitly', () => {
    // The CLI enables DevTools by default for WinUI projects, so passing
    // nothing here would quietly override useDevTools: false.
    assert.deepStrictEqual(devToolsSpawnArgs({ useDevTools: false }), ['--devtools', 'off']);
});

test('hiding the overlay still starts the engine', () => {
    // The panel is a second client of the same engine, so a mode that stopped
    // the engine would leave the panel with nothing to talk to.
    assert.deepStrictEqual(
        devToolsSpawnArgs({ noOverlay: true }),
        ['--devtools', 'headless'],
    );
});

test('off wins over noOverlay', () => {
    // noOverlay only chooses how DevTools is shown; it must never resurrect it.
    assert.deepStrictEqual(
        devToolsSpawnArgs({ useDevTools: false, noOverlay: true }),
        ['--devtools', 'off'],
    );
});

test('an explicitly false noOverlay keeps the overlay', () => {
    assert.deepStrictEqual(devToolsSpawnArgs({ noOverlay: false }), ['--devtools', 'on']);
});

test('the mode is always one the CLI accepts', () => {
    // --devtools is a valued option; a bare flag or an unknown mode fails the launch.
    for (const config of [{}, { useDevTools: true }, { useDevTools: false }, { noOverlay: true }]) {
        const args = devToolsSpawnArgs(config);
        assert.strictEqual(args[0], '--devtools', `missing flag for ${JSON.stringify(config)}`);
        assert.ok(
            ['on', 'off', 'headless'].includes(args[1]),
            `unexpected mode ${args[1]} for ${JSON.stringify(config)}`,
        );
    }
});

// ───────────────────────────── agreement ─────────────────────────────

test('the spawn arguments and the panel never disagree about being on', () => {
    // The panel and the CLI flag are gated separately in extension.ts; if they
    // ever diverged the user would get a panel with no engine behind it.
    const configs = [
        {},
        { useDevTools: true },
        { useDevTools: false },
        { noOverlay: true },
        { useDevTools: false, noOverlay: true },
        { useDevTools: true, noOverlay: true },
    ];

    for (const config of configs) {
        assert.strictEqual(
            devToolsSpawnArgs(config)[1] !== 'off',
            shouldUseDevTools(config),
            `disagreement for ${JSON.stringify(config)}`,
        );
    }
});

// ───────────────────────────── noDebug ─────────────────────────────

test('a debugger attaches by default', () => {
    assert.strictEqual(shouldAttachDebugger({}), true);
    assert.strictEqual(shouldAttachDebugger(undefined), true);
});

test('an explicit noDebug suppresses the debugger', () => {
    assert.strictEqual(shouldAttachDebugger({ noDebug: true }), false);
});

test('noDebug false still attaches', () => {
    assert.strictEqual(shouldAttachDebugger({ noDebug: false }), true);
});

test('only a literal true suppresses the debugger', () => {
    // VS Code sets noDebug itself for Run Without Debugging, but a hand-written
    // launch.json can carry anything. Anything other than true must not silently
    // drop the debugger, which would look like "my breakpoints stopped working".
    for (const value of ['true', 1, {}, [], 'yes']) {
        assert.strictEqual(
            shouldAttachDebugger({ noDebug: value as never }),
            true,
            `noDebug: ${JSON.stringify(value)} should not suppress the debugger`,
        );
    }
});

test('noDebug leaves DevTools fully enabled', () => {
    // The whole point of the flag: the app still launches with DevTools, we
    // just skip the debugger extension. If these ever coupled, a no-debug run
    // would lose the panel it exists to provide.
    const config = { noDebug: true };
    assert.strictEqual(shouldUseDevTools(config), true);
    assert.deepStrictEqual(devToolsSpawnArgs(config), ['--devtools', 'on']);
});

test('noDebug and useDevTools are independent across every combination', () => {
    for (const noDebug of [true, false, undefined]) {
        for (const useDevTools of [true, false, undefined]) {
            const config = { noDebug, useDevTools };
            assert.strictEqual(
                shouldUseDevTools(config),
                useDevTools !== false,
                `DevTools gate changed by noDebug=${noDebug}`,
            );
            assert.strictEqual(
                shouldAttachDebugger(config),
                noDebug !== true,
                `debugger gate changed by useDevTools=${useDevTools}`,
            );
        }
    }
});
