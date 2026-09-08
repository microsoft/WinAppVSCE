import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { knownCapabilities, protocolVersion, type ClientMessage, type ServerMessage, type WireMessage } from './protocol.js';

const directory = __dirname;
interface Fixture { id: string; direction: 'client' | 'server'; wire: WireMessage; normalized?: WireMessage }
const corpus = JSON.parse(readFileSync(join(directory, 'fixtures.json'), 'utf8')) as { messages: Fixture[] };
const clientTypes = ['Hello', 'LoadXaml', 'UpdateXaml', 'Resize', 'EnterNative', 'ExitNative',
    'SetMode', 'SelectByPath', 'PickAt', 'SetProperty', 'SetTheme', 'SetCanvasSize', 'Ping'];
const serverTypes = ['Ready', 'Frame', 'Error', 'Hwnd', 'NativeExited', 'Selected', 'ElementProps', 'ContentProps', 'Pong'];

// These constructions and negative examples are checked by tsc, not merely stripped by tsx.
const typedClients = [
    { type: 'Hello', client: 'vscode', caps: ['frame-stream', 'future-cap'], protocol: 1 },
    { type: 'LoadXaml', xaml: '<Grid />', width: 800, height: 600, scale: 1.5 },
    { type: 'UpdateXaml', xaml: '' }, { type: 'Resize' },
    { type: 'EnterNative', xaml: '<Page />', width: 640.5 },
    { type: 'ExitNative' }, { type: 'SetMode', design: false },
    { type: 'SelectByPath', path: null }, { type: 'PickAt', x: 0, y: 0 },
    { type: 'SetProperty', id: 7, name: 'Text', value: null },
    { type: 'SetTheme', theme: 'Default' }, { type: 'SetCanvasSize', width: 0, height: 0 },
    { type: 'Ping' },
] satisfies ClientMessage[];
const typedServers = [
    { type: 'Ready', protocol: 1, caps: ['frame-stream'], wasdk: '2.2.0' },
    { type: 'Frame', format: 'png', width: 2, height: 2, dipWidth: 1, dipHeight: 1, data: 'iVBORw0KGgo=' },
    { type: 'Error', phase: 'future', message: 'diagnostic' },
    { type: 'Hwnd', hwnd: 4294967297, dipWidth: 640, dipHeight: 480, pixelWidth: 800, pixelHeight: 600, scale: 1.25 },
    { type: 'NativeExited' }, { type: 'Pong' },
    { type: 'Selected', id: 7, elementType: 'Grid', x: 0, y: 0, w: 800, h: 600 },
    { type: 'ElementProps', id: 7, props: [{ name: 'Tag', category: 'Common', type: 'String', value: '', readOnly: false }] },
    { type: 'ContentProps', map: { ControlExample: 'Example' } },
] satisfies ServerMessage[];
// @ts-expect-error XAML is required even though C# DTO construction defaults to "".
const missingXaml: ClientMessage = { type: 'LoadXaml' };
// @ts-expect-error HWND is a JSON number, not a decimal string.
const stringHandle: ServerMessage = { ...typedServers[3], type: 'Hwnd', hwnd: '123' };
// @ts-expect-error PNG is the current frame format (old JPEG comments are not the wire).
const jpeg: ServerMessage = { type: 'Frame', format: 'jpeg', width: 1, height: 1, dipWidth: 1, dipHeight: 1, data: '' };
void [missingXaml, stringHandle, jpeg];

/** Test oracle for valid canonical shapes, not a claim that either legacy receiver validates them. */
function assertWire(value: unknown): asserts value is WireMessage {
    assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'message must be an object');
    const object = value as Record<string, unknown>;
    const string = (key: string, optional = false, nullable = false) => {
        if (optional && !(key in object)) return;
        if (nullable && object[key] === null) return;
        assert.equal(typeof object[key], 'string', `${String(object.type)}.${key} must be a string`);
    };
    const number = (key: string, optional = false, integer = false) => {
        if (optional && !(key in object)) return;
        assert.equal(typeof object[key], 'number', `${String(object.type)}.${key} must be a number`);
        assert.ok(Number.isFinite(object[key]), `${key} must be finite`);
        if (integer) assert.ok(Number.isSafeInteger(object[key]), `${key} must be a safe integer`);
    };
    const boolean = (key: string, optional = false) => {
        if (optional && !(key in object)) return;
        assert.equal(typeof object[key], 'boolean', `${key} must be a boolean`);
    };
    const strings = (key: string, optional = false) => {
        if (optional && !(key in object)) return;
        assert.ok(Array.isArray(object[key]), `${key} must be an array`);
        for (const item of object[key]) assert.equal(typeof item, 'string', `${key} item must be a string`);
    };
    string('type');
    switch (object.type) {
        case 'Hello': string('client', true); strings('caps', true); number('protocol', true, true); break;
        case 'LoadXaml': case 'EnterNative':
            string('xaml');
            for (const key of ['width', 'height', 'scale']) number(key, true);
            break;
        case 'UpdateXaml': string('xaml'); break;
        case 'Resize':
            for (const key of ['width', 'height', 'scale']) number(key, true);
            break;
        case 'SetCanvasSize': number('width', true); number('height', true); break;
        case 'SetMode': boolean('design', true); break;
        case 'SelectByPath': string('path', true, true); break;
        case 'PickAt': number('x'); number('y'); break;
        case 'SetProperty':
            number('id', false, true); string('name'); string('value', true, true);
            assert.ok(Number(object.id) >= 0 && Number(object.id) <= 2147483647, 'property id is a nonnegative Int32');
            assert.notEqual(object.name, '', 'property name must not be empty');
            break;
        case 'SetTheme':
            if ('theme' in object) assert.ok(['Light', 'Dark', 'Default'].includes(String(object.theme)), 'theme convention');
            break;
        case 'Ready': number('protocol', false, true); strings('caps'); string('wasdk'); break;
        case 'Frame':
            assert.equal(object.format, 'png');
            for (const key of ['width', 'height', 'dipWidth', 'dipHeight']) {
                number(key, false, true);
                assert.ok(Number(object[key]) > 0, `${key} must be positive`);
            }
            string('data');
            assert.match(String(object.data), /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, 'base64 payload');
            break;
        case 'Error':
            string('phase'); string('message'); boolean('notDesignable', true);
            for (const key of ['line', 'column']) if (object[key] !== null) number(key, true, true);
            break;
        case 'Hwnd':
            number('hwnd', false, true);
            number('pixelWidth', false, true); number('pixelHeight', false, true);
            for (const key of ['dipWidth', 'dipHeight', 'scale']) number(key);
            break;
        case 'Selected':
            number('id', false, true); string('elementType'); string('name', true, true); string('path', true, true);
            for (const key of ['x', 'y', 'w', 'h']) number(key);
            break;
        case 'ElementProps':
            number('id', false, true);
            assert.ok(Array.isArray(object.props), 'props must be an array');
            for (const prop of object.props) {
                assert.ok(prop !== null && typeof prop === 'object' && !Array.isArray(prop));
                for (const key of ['name', 'category', 'type', 'value']) assert.equal(typeof prop[key], 'string', `property.${key}`);
                assert.equal(typeof prop.readOnly, 'boolean');
                if (prop.options !== undefined && prop.options !== null) {
                    assert.ok(Array.isArray(prop.options));
                    for (const option of prop.options) assert.equal(typeof option, 'string');
                }
            }
            break;
        case 'ContentProps':
            assert.ok(object.map !== null && typeof object.map === 'object' && !Array.isArray(object.map));
            for (const property of Object.values(object.map)) assert.equal(typeof property, 'string');
            break;
        case 'Ping': case 'Pong': case 'ExitNative': case 'NativeExited': break;
        default: assert.fail(`unknown canonical message: ${String(object.type)}`);
    }
}

test('complete typed shapes and shared serialized corpus', () => {
    assert.equal(protocolVersion, 1);
    assert.deepEqual(knownCapabilities, ['frame-stream', 'native-hwnd']);
    assert.deepEqual(new Set(typedClients.map(x => x.type)), new Set(clientTypes));
    assert.deepEqual(new Set(typedServers.map(x => x.type)), new Set(serverTypes));
    assert.equal(new Set(corpus.messages.map(x => x.id)).size, corpus.messages.length, 'unique fixture ids');
    for (const direction of ['client', 'server'] as const) {
        assert.deepEqual(new Set(corpus.messages.filter(x => x.direction === direction).map(x => x.wire.type)),
            new Set(direction === 'client' ? clientTypes : serverTypes), `complete ${direction} coverage`);
    }
    for (const wire of [...typedClients, ...typedServers]) assertWire(wire);
    for (const fixture of corpus.messages) {
        assertWire(fixture.wire);
        if (fixture.normalized) assertWire(fixture.normalized);
        const encoded = JSON.stringify(fixture.wire);
        assert.ok(!/[\r\n]/.test(encoded), `${fixture.id}: embedded data must not split NDJSON`);
        assert.deepEqual(JSON.parse(Buffer.from(encoded + '\n', 'utf8').toString('utf8')), fixture.wire, fixture.id);
        assertWire({ ...fixture.wire, futureField: { nested: ['unknown', 42] } });
    }
    const frame = corpus.messages.find(x => x.id === 'frame')!.wire;
    assert.equal(frame.type, 'Frame');
    if (frame.type === 'Frame') {
        const png = Buffer.from(frame.data, 'base64');
        assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
        assert.equal(png.readUInt32BE(16), frame.width, 'PNG IHDR width');
        assert.equal(png.readUInt32BE(20), frame.height, 'PNG IHDR height');
    }
});

test('shape oracle rejects invalid serialized fields rather than accepting a cast', () => {
    for (const wire of [
        null, [], {}, { type: 'Future' }, { type: 'LoadXaml' }, { type: 'LoadXaml', xaml: 1 },
        { type: 'PickAt', x: '1', y: 2 }, { type: 'SetProperty', id: -1, name: 'Text' },
        { type: 'SetMode', design: 'true' }, { type: 'ContentProps', map: { Card: 3 } },
        { type: 'ElementProps', id: 7, props: [{ name: 'Text' }] },
        { ...typedServers[3], type: 'Hwnd', hwnd: 9007199254740992 },
        { ...typedServers[1], type: 'Frame', data: 'not\nbase64' },
    ]) assert.throws(() => assertWire(wire), { name: 'AssertionError' }, JSON.stringify(wire));
});

test('linked production C# readers/writers consume TS JSON and return compatible NDJSON', { timeout: 180_000 }, () => {
    const project = join(directory, 'Compatibility.csproj');
    const build = spawnSync('dotnet', ['build', project, '--no-restore', '--nologo', '-v:q'], { encoding: 'utf8', timeout: 120_000 });
    assert.equal(build.status, 0, `C# build failed (restore the dependency-free project first if assets are missing):\n${build.error ?? ''}\n${build.stdout}\n${build.stderr}`);
    const execution = spawnSync('dotnet', [join(directory, 'bin', 'Debug', 'net10.0', 'Compatibility.dll'), '-'], {
        input: JSON.stringify(corpus), encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(execution.status, 0, `C# assertion/process failure:\n${execution.error ?? ''}\n${execution.stdout}\n${execution.stderr}`);
    const outputs = execution.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line) as {
        kind: string; id?: string; message?: unknown; assertions?: number; fixtures?: number;
    });
    const dtos = outputs.filter(x => x.kind === 'dto');
    const expected = corpus.messages.filter(x => x.wire.type !== 'Ping' && x.wire.type !== 'Pong');
    assert.deepEqual(new Set(dtos.map(x => x.id)), new Set(expected.map(x => x.id)), 'all linked DTO serializer outputs consumed');
    assert.equal(dtos.length, expected.length, 'no duplicate outputs');
    for (const output of dtos) {
        const fixture = expected.find(x => x.id === output.id)!;
        assertWire(output.message);
        assert.deepEqual(output.message, fixture.normalized ?? fixture.wire, `C# serialized content: ${output.id}`);
    }
    const server = outputs.filter(x => x.kind === 'server');
    assert.deepEqual(server.map(x => x.id), ['ready', 'error-helper', 'frame', 'hwnd', 'content', 'selected', 'props']);
    for (const output of server) {
        const fixture = structuredClone(corpus.messages.find(x => x.id === output.id)!.wire);
        if (fixture.type === 'Ready') fixture.caps = ['frame-stream', 'native-hwnd'];
        assertWire(output.message);
        assert.deepEqual(output.message, fixture, `actual FrameServer serialization: ${output.id}`);
    }
    const wide = outputs.find(x => x.kind === 'int64');
    assert.ok(wide, 'C# Int64 precision fixture was emitted');
    assert.ok(!Number.isSafeInteger((wide.message as { hwnd: number }).hwnd), 'unsafe Int64 is detectable after JSON.parse');
    assert.throws(() => assertWire(wide.message), /hwnd must be a safe integer/);
    const summaries = outputs.filter(x => x.kind === 'summary');
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].fixtures, corpus.messages.length);
    assert.ok(Number(summaries[0].assertions) >= 250, 'C# assertions really executed');
    assert.equal(outputs.length, dtos.length + server.length + 2, 'no unexplained stdout records');
    console.log(`C#: ${summaries[0].assertions} assertions; ${dtos.length} DTO and ${server.length} server payloads verified by TypeScript.`);
});
