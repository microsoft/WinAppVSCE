/**
 * Fails the build when the DevTools protocol drifts away from what this
 * extension calls.
 *
 * The protocol is versioned but currently reports itself as experimental, so
 * methods and events can be renamed or removed between CLI builds. Because the
 * CLI payload is re-vendored on every release, that drift would otherwise only
 * show up as a broken panel at runtime.
 *
 * The check has two halves:
 *
 *  1. Against `schemas/devtools/winapp-devtools-schema.json`, a committed copy
 *     of the schema this branch is pinned to. This half always runs, including
 *     in CI, where `bin/` holds a *released* CLI that ships no DevTools schema
 *     at all. Pinning is also the only record in git of which engine build
 *     `src/devtools` was validated against, since `bin/` is gitignored.
 *  2. Against whatever schema `bin/` actually holds, when it holds one. This is
 *     a full content comparison rather than a name comparison, so a changed
 *     params or result *shape* fails too — a renamed field is just as breaking
 *     as a renamed method, and far easier to miss.
 *
 * Run with: npm run check-devtools-schema
 */

import * as fs from 'fs';
import * as path from 'path';
import { USED_METHODS, USED_EVENTS } from '../src/devtools/protocol';

interface DevToolsSchema {
    schemaVersion?: string;
    protocol?: unknown;
    capabilities?: {
        methods?: string[];
        events?: string[];
        domains?: string[];
    };
    $defs?: Record<string, unknown>;
}

interface PinnedCli {
    version?: string;
    branch?: string;
    commit?: string;
}

const repoRoot = path.resolve(__dirname, '..');
const binRoot = path.join(repoRoot, 'bin');
const pinnedDir = path.join(repoRoot, 'schemas', 'devtools');
const pinnedSchemaPath = path.join(pinnedDir, 'winapp-devtools-schema.json');
const pinnedCliPath = path.join(pinnedDir, 'pinned-cli.json');

const syncDoc = '.github/skills/devtools-cli-sync/AGENTS.md';

function fail(message: string): never {
    console.error(`[devtools-schema] ${message}`);
    process.exit(1);
}

function readJson<T>(filePath: string): T {
    const relative = path.relative(repoRoot, filePath);
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    } catch (err) {
        return fail(`Could not read ${relative}: ${(err as Error).message}`);
    }
}

/**
 * Serializes with object keys sorted, so two schemas compare equal when they
 * differ only in key order or formatting. The generator is stable today, but
 * a false positive here would train people to re-pin without reading the diff.
 */
function stable(value: unknown): string {
    return JSON.stringify(value, (_key, val) => {
        if (val === null || typeof val !== 'object' || Array.isArray(val)) { return val; }
        const sorted: Record<string, unknown> = {};
        for (const key of Object.keys(val as Record<string, unknown>).sort()) {
            sorted[key] = (val as Record<string, unknown>)[key];
        }
        return sorted;
    });
}

/** Describes how a candidate schema differs from the pinned one, in review order. */
function describeDrift(pinned: DevToolsSchema, candidate: DevToolsSchema): string[] {
    const lines: string[] = [];

    const compareNames = (label: string, before: string[] = [], after: string[] = []) => {
        const beforeSet = new Set(before);
        const afterSet = new Set(after);
        for (const name of after) {
            if (!beforeSet.has(name)) { lines.push(`    added ${label}:   ${name}`); }
        }
        for (const name of before) {
            if (!afterSet.has(name)) { lines.push(`    removed ${label}: ${name}`); }
        }
    };

    if (pinned.schemaVersion !== candidate.schemaVersion) {
        lines.push(`    schemaVersion: ${pinned.schemaVersion} -> ${candidate.schemaVersion}`);
    }
    // `protocol` is an object, so it has to be compared by value rather than
    // by identity, which would report a difference on every run.
    if (stable(pinned.protocol) !== stable(candidate.protocol)) {
        lines.push(`    protocol: ${stable(pinned.protocol)} -> ${stable(candidate.protocol)}`);
    }

    compareNames('method', pinned.capabilities?.methods, candidate.capabilities?.methods);
    compareNames('event', pinned.capabilities?.events, candidate.capabilities?.events);

    const pinnedDefs = pinned.$defs ?? {};
    const candidateDefs = candidate.$defs ?? {};
    compareNames('type', Object.keys(pinnedDefs), Object.keys(candidateDefs));

    for (const name of Object.keys(candidateDefs)) {
        if (!(name in pinnedDefs)) { continue; }
        if (stable(pinnedDefs[name]) !== stable(candidateDefs[name])) {
            lines.push(`    changed type:   ${name}`);
        }
    }

    // Everything above is a summary. Something could still differ outside the
    // places we itemize, and silently reporting "no differences" on a failing
    // comparison would be worse than saying we do not know.
    if (lines.length === 0) {
        lines.push('    (differences are outside methods, events and $defs - diff the files directly)');
    }

    return lines;
}

const pinnedSchema = readJson<DevToolsSchema>(pinnedSchemaPath);
const pinnedCli = fs.existsSync(pinnedCliPath) ? readJson<PinnedCli>(pinnedCliPath) : {};

const pinnedMethods = pinnedSchema.capabilities?.methods ?? [];
const pinnedEvents = pinnedSchema.capabilities?.events ?? [];

if (pinnedMethods.length === 0) {
    fail(`${path.relative(repoRoot, pinnedSchemaPath)} declares no methods; the schema format may have changed.`);
}

console.log(
    `[devtools-schema] Pinned to winapp ${pinnedCli.version ?? 'unknown'}` +
    `${pinnedCli.commit ? ` (${pinnedCli.branch ?? 'unknown branch'} @ ${pinnedCli.commit})` : ''}, ` +
    `schemaVersion ${pinnedSchema.schemaVersion ?? 'unknown'}: ` +
    `${pinnedMethods.length} methods, ${pinnedEvents.length} events advertised.`,
);

// Half 1: everything we call has to exist in the pinned schema.
const pinnedMethodSet = new Set(pinnedMethods);
const pinnedEventSet = new Set(pinnedEvents);
const missingMethods = USED_METHODS.filter((name) => !pinnedMethodSet.has(name));
const missingEvents = USED_EVENTS.filter((name) => !pinnedEventSet.has(name));

if (missingMethods.length > 0 || missingEvents.length > 0) {
    console.error('[devtools-schema] The pinned schema does not advertise everything src/devtools/protocol.ts uses:');
    for (const name of missingMethods) { console.error(`    missing method: ${name}`); }
    for (const name of missingEvents) { console.error(`    missing event:  ${name}`); }
    console.error('');
    fail('Update USED_METHODS / USED_EVENTS and the call sites, then re-run this check.');
}

console.log(
    `[devtools-schema] ${USED_METHODS.length} methods and ${USED_EVENTS.length} events ` +
    'used by src/devtools are advertised by the pinned schema.',
);

// Half 2: the CLI staged in bin/ has to match what we pinned, byte for byte
// once normalized. A released CLI ships no DevTools schema, so finding none is
// normal rather than a failure - but it means this half did not run, and the
// output says so instead of implying coverage it does not have.
function findBundledSchemas(): string[] {
    if (!fs.existsSync(binRoot)) { return []; }
    const found: string[] = [];
    for (const entry of fs.readdirSync(binRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) { continue; }
        const candidate = path.join(binRoot, entry.name, 'winapp-devtools-schema.json');
        if (fs.existsSync(candidate)) { found.push(candidate); }
    }
    return found;
}

const bundled = findBundledSchemas();
const pinnedStable = stable(pinnedSchema);
let bundledDrift = false;

for (const schemaPath of bundled) {
    const relative = path.relative(repoRoot, schemaPath);
    const schema = readJson<DevToolsSchema>(schemaPath);

    if (stable(schema) === pinnedStable) {
        console.log(`[devtools-schema] ${relative} matches the pinned schema.`);
        continue;
    }

    bundledDrift = true;
    console.error(`[devtools-schema] ${relative} differs from the pinned schema:`);
    for (const line of describeDrift(pinnedSchema, schema)) { console.error(line); }
}

if (bundledDrift) {
    console.error('');
    console.error('[devtools-schema] The CLI staged in bin/ is not the one this branch is pinned to.');
    console.error('Review the differences above, update src/devtools to match, then re-pin by copying');
    console.error('the new schema over schemas/devtools/winapp-devtools-schema.json and updating');
    console.error(`schemas/devtools/pinned-cli.json. Full procedure: ${syncDoc}`);
    process.exit(1);
}

if (bundled.length === 0) {
    console.log(
        '[devtools-schema] NOTE: no schema under bin/, so the staged CLI was not compared. ' +
        'Expected on a clean checkout or with a released CLI, which ships no DevTools schema.',
    );
}

// USED_METHODS is only meaningful if it actually mirrors the call sites. A
// method sent via trySend() but left out of the list would silently escape the
// drift check above, so verify the two agree.
const devtoolsDir = path.join(repoRoot, 'src', 'devtools');
const declared = new Set<string>(USED_METHODS);
const undeclared = new Map<string, string>();
const called = new Set<string>();

for (const entry of fs.readdirSync(devtoolsDir)) {
    if (!entry.endsWith('.ts') || entry === 'protocol.ts') { continue; }
    const source = fs.readFileSync(path.join(devtoolsDir, entry), 'utf8');
    for (const match of source.matchAll(/'([A-Za-z]+\.[A-Za-z]+)'/g)) {
        const name = match[1];
        if (!pinnedMethodSet.has(name)) { continue; }
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

console.log('[devtools-schema] USED_METHODS matches the call sites in src/devtools.');
