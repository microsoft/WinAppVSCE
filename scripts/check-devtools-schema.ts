/**
 * Fails the build when the DevTools protocol drifts away from what this
 * extension calls.
 *
 * The protocol is versioned but currently reports itself as experimental, so
 * methods and events can be renamed or removed between CLI builds. Because the
 * CLI payload is re-vendored on every release, that drift would otherwise only
 * show up as a broken panel at runtime. Diffing the bundled schema against the
 * names declared in `src/devtools/protocol.ts` turns it into a build break.
 *
 * Run with: npm run check-devtools-schema
 */

import * as fs from 'fs';
import * as path from 'path';
import { USED_METHODS, USED_EVENTS } from '../src/devtools/protocol';

interface DevToolsSchema {
    schemaVersion?: string;
    capabilities?: {
        methods?: string[];
        events?: string[];
        domains?: string[];
    };
}

const repoRoot = path.resolve(__dirname, '..');
const binRoot = path.join(repoRoot, 'bin');

/** Locates every bundled copy of the schema (one per target architecture). */
function findSchemas(): string[] {
    if (!fs.existsSync(binRoot)) { return []; }

    const found: string[] = [];
    for (const entry of fs.readdirSync(binRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) { continue; }
        const candidate = path.join(binRoot, entry.name, 'winapp-devtools-schema.json');
        if (fs.existsSync(candidate)) {
            found.push(candidate);
        }
    }
    return found;
}

const schemaPaths = findSchemas();

if (schemaPaths.length === 0) {
    // bin/ is gitignored and populated by `npm run download-cli`, so a clean
    // checkout legitimately has no schema to check against. A released CLI
    // without DevTools also ships no schema, which is why this currently
    // no-ops in CI — worth saying out loud, because the step still reports
    // success and could otherwise be mistaken for real coverage.
    console.log(
        '[devtools-schema] WARNING: no bundled schema found under bin/, so NO drift check ran. ' +
        'This is expected on a clean checkout, or when bin/ holds a CLI build without DevTools support.',
    );
    process.exit(0);
}

let failed = false;

for (const schemaPath of schemaPaths) {
    const relative = path.relative(repoRoot, schemaPath);
    let schema: DevToolsSchema;

    try {
        schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as DevToolsSchema;
    } catch (err) {
        console.error(`[devtools-schema] Could not parse ${relative}: ${(err as Error).message}`);
        failed = true;
        continue;
    }

    const methods = new Set(schema.capabilities?.methods ?? []);
    const events = new Set(schema.capabilities?.events ?? []);

    if (methods.size === 0) {
        console.error(`[devtools-schema] ${relative} declares no methods; the schema format may have changed.`);
        failed = true;
        continue;
    }

    const missingMethods = USED_METHODS.filter((name) => !methods.has(name));
    const missingEvents = USED_EVENTS.filter((name) => !events.has(name));

    if (missingMethods.length === 0 && missingEvents.length === 0) {
        console.log(
            `[devtools-schema] ${relative} (schemaVersion ${schema.schemaVersion ?? 'unknown'}): ` +
            `${USED_METHODS.length} methods and ${USED_EVENTS.length} events verified.`
        );
        continue;
    }

    failed = true;
    console.error(`[devtools-schema] Drift detected in ${relative}:`);
    for (const name of missingMethods) {
        console.error(`    missing method: ${name}`);
    }
    for (const name of missingEvents) {
        console.error(`    missing event:  ${name}`);
    }
}

if (failed) {
    console.error('');
    console.error('The bundled DevTools schema no longer advertises everything src/devtools/protocol.ts uses.');
    console.error('Update USED_METHODS / USED_EVENTS and the call sites, then re-run this check.');
    process.exit(1);
}

// USED_METHODS is only meaningful if it actually mirrors the call sites. A
// method sent via trySend() but left out of the list would silently escape the
// drift check above, so verify the two agree.
const devtoolsDir = path.join(repoRoot, 'src', 'devtools');
const knownMethods = new Set<string>();
for (const schemaPath of schemaPaths) {
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as DevToolsSchema;
    for (const name of schema.capabilities?.methods ?? []) { knownMethods.add(name); }
}

const declared = new Set<string>(USED_METHODS);
const undeclared = new Map<string, string>();
const called = new Set<string>();

for (const entry of fs.readdirSync(devtoolsDir)) {
    if (!entry.endsWith('.ts') || entry === 'protocol.ts') { continue; }
    const source = fs.readFileSync(path.join(devtoolsDir, entry), 'utf8');
    for (const match of source.matchAll(/'([A-Za-z]+\.[A-Za-z]+)'/g)) {
        const name = match[1];
        if (!knownMethods.has(name)) { continue; }
        called.add(name);
        if (!declared.has(name)) {
            undeclared.set(name, entry);
        }
    }
}

const uncalled = [...declared].filter((name) => !called.has(name));

if (undeclared.size > 0) {
    console.error('');
    console.error('[devtools-schema] These protocol methods are called but missing from USED_METHODS,');
    console.error('so they are not covered by the drift check:');
    for (const [name, file] of undeclared) {
        console.error(`    ${name}  (src/devtools/${file})`);
    }
}

if (uncalled.length > 0) {
    console.error('');
    console.error('[devtools-schema] These methods are declared in USED_METHODS but never called.');
    console.error('A dead entry reads as an implemented feature; remove it or add the call site:');
    for (const name of uncalled) {
        console.error(`    ${name}`);
    }
}

if (undeclared.size > 0 || uncalled.length > 0) {
    process.exit(1);
}

console.log(`[devtools-schema] USED_METHODS matches the call sites in src/devtools.`);
