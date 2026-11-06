import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    devToolsPipePath,
    normalizeEnumerateResult,
    USED_METHODS,
    USED_EVENTS,
} from '../devtools/protocol';

test('builds the per-process pipe path', () => {
    assert.strictEqual(devToolsPipePath(1234), '\\\\.\\pipe\\winapp-devtools-1234');
});

test('normalizeEnumerateResult accepts a bare node array', () => {
    const nodes = [{ handle: 1, type: 'Grid' }] as never;
    assert.deepStrictEqual(normalizeEnumerateResult(nodes), nodes);
});

test('normalizeEnumerateResult accepts the envelope shape', () => {
    const nodes = [{ handle: 1, type: 'Grid' }];
    assert.deepStrictEqual(normalizeEnumerateResult({ nodes } as never), nodes);
});

test('normalizeEnumerateResult tolerates missing or empty results', () => {
    assert.deepStrictEqual(normalizeEnumerateResult(undefined), []);
    assert.deepStrictEqual(normalizeEnumerateResult({} as never), []);
    assert.deepStrictEqual(normalizeEnumerateResult([] as never), []);
});

test('declared method and event names are unique', () => {
    assert.strictEqual(new Set(USED_METHODS).size, USED_METHODS.length);
    assert.strictEqual(new Set(USED_EVENTS).size, USED_EVENTS.length);
});

/**
 * Guards against calling a method the engine does not expose. The bundled
 * schema is the authoritative contract, but bin/ is gitignored and only
 * populated by `npm run download-cli`, so this is skipped on a clean checkout
 * rather than failing it.
 */
test('every used method and event exists in the bundled schema', () => {
    const binRoot = path.resolve(__dirname, '..', '..', 'bin');
    if (!fs.existsSync(binRoot)) {
        return;
    }

    const schemaPaths = fs.readdirSync(binRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(binRoot, entry.name, 'winapp-devtools-schema.json'))
        .filter((candidate) => fs.existsSync(candidate));

    if (schemaPaths.length === 0) {
        return;
    }

    for (const schemaPath of schemaPaths) {
        const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as {
            capabilities?: { methods?: string[]; events?: string[] };
        };
        const methods = new Set(schema.capabilities?.methods ?? []);
        const events = new Set(schema.capabilities?.events ?? []);

        for (const name of USED_METHODS) {
            assert.ok(methods.has(name), `${schemaPath} does not declare method ${name}`);
        }
        for (const name of USED_EVENTS) {
            assert.ok(events.has(name), `${schemaPath} does not declare event ${name}`);
        }
    }
});
