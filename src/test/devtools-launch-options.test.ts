import { test } from 'node:test';
import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    devToolsSpawnArgs, requestsDevTools, shouldAttachDebugger, shouldUseDevTools, unsupportedAppTypeReason, withDevToolsOff,
} from '../devtools/launch-options';
import { checkAppFramework } from '../devtools/app-framework';

test('an omitted devTools leaves the choice to the CLI default', () => {
    for (const config of [undefined, {}, { noDebug: true }]) {
        assert.deepStrictEqual(devToolsSpawnArgs(config), []);
        assert.strictEqual(shouldUseDevTools(config), true);
        assert.strictEqual(requestsDevTools(config), false);
    }
});

test('devTools passes its mode straight to winapp run --devtools', () => {
    assert.deepStrictEqual(devToolsSpawnArgs({ devTools: 'on' }), ['--devtools', 'on']);
    assert.deepStrictEqual(devToolsSpawnArgs({ devTools: 'headless' }), ['--devtools', 'headless']);
    assert.deepStrictEqual(devToolsSpawnArgs({ devTools: 'off' }), ['--devtools', 'off']);
    assert.strictEqual(shouldUseDevTools({ devTools: 'off' }), false);
    assert.strictEqual(requestsDevTools({ devTools: 'headless' }), true);
    assert.strictEqual(requestsDevTools({ devTools: 'off' }), false);
});

test('a value the CLI would reject is ignored rather than passed through', () => {
    for (const devTools of [true, 'ON', 'none', 1]) {
        assert.deepStrictEqual(devToolsSpawnArgs({ devTools }), [], `devTools: ${JSON.stringify(devTools)}`);
    }
});

test('noDebug suppresses only the debugger, and only for a literal true', () => {
    assert.strictEqual(shouldAttachDebugger({}), true);
    assert.strictEqual(shouldAttachDebugger({ noDebug: true }), false);
    for (const value of ['true', 1, false]) {
        assert.strictEqual(shouldAttachDebugger({ noDebug: value as never }), true);
    }
    assert.deepStrictEqual(devToolsSpawnArgs({ noDebug: true, devTools: 'on' }), ['--devtools', 'on']);
});

// Captured from `winapp run BBWpf.csproj --devtools on --json` against the pinned CLI.
const WPF_REFUSAL = "DevTools requires WinUI 3; 'BBWpf.csproj' is a WPF-only project. Run with --devtools off to start the app without DevTools.";

test('the CLI refusal of an explicit request falls back to running without DevTools', () => {
    assert.strictEqual(unsupportedAppTypeReason(['run', '.', '--devtools', 'on'], WPF_REFUSAL),
        "'BBWpf.csproj' is a WPF-only project");
    assert.deepStrictEqual(withDevToolsOff(['run', '.', '--devtools', 'headless', '--json']),
        ['run', '.', '--devtools', 'off', '--json']);
    assert.strictEqual(unsupportedAppTypeReason(['run', '.'], WPF_REFUSAL), undefined, 'automatic mode never refuses');
    assert.strictEqual(unsupportedAppTypeReason(['run', '.', '--devtools', 'on'], 'Build failed with 3 errors.'), undefined);
});

function tempTree(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'winapp-framework-'));
    for (const [name, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
        fs.writeFileSync(path.join(root, name), content);
    }
    return root;
}

test('the pre-launch check recognizes WinUI 3 the way the CLI does', async t => {
    const root = tempTree({
        'WinUi/WinUi.csproj': '<Project><PropertyGroup><UseWinUI>true</UseWinUI></PropertyGroup></Project>',
        'Inherited/src/App/App.csproj': '<Project></Project>',
        'Inherited/Directory.Build.props': '<Project><PropertyGroup><UseWinUI>true</UseWinUI></PropertyGroup></Project>',
        'Native/Native.vcxproj': '<Project><ItemGroup><Page Include="MainWindow.xaml" /></ItemGroup></Project>',
        'Native/packages.config': '<packages><package id="Microsoft.WindowsAppSDK" /></packages>',
        'Output/App.exe': '', 'Output/MainWindow.xbf': '',
    });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const input of ['WinUi/WinUi.csproj', 'WinUi', 'Inherited/src/App/App.csproj', 'Native/Native.vcxproj', 'Output']) {
        assert.deepStrictEqual(await checkAppFramework(path.join(root, input)), { kind: 'winui' }, input);
    }
});

test('the pre-launch check names apps that are not WinUI 3', async t => {
    const root = tempTree({
        'Wpf/Wpf.csproj': '<Project><PropertyGroup><UseWPF>true</UseWPF></PropertyGroup></Project>',
        'Forms/Forms.csproj': '<Project><PropertyGroup><UseWindowsForms>true</UseWindowsForms></PropertyGroup></Project>',
        'Console/Console.csproj': '<Project><PropertyGroup><OutputType>Exe</OutputType></PropertyGroup></Project>',
        'Win32/Win32.vcxproj': '<Project><ItemGroup><ClCompile Include="main.cpp" /></ItemGroup></Project>',
        'electron/electron.exe': '', 'electron/resources/app.asar': '',
    });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const description = async (input: string) => {
        const result = await checkAppFramework(path.join(root, input));
        return result.kind === 'other' ? result.description : result.kind;
    };
    assert.strictEqual(await description('Wpf/Wpf.csproj'), "'Wpf.csproj' is a WPF project");
    assert.strictEqual(await description('Forms'), "'Forms.csproj' is a Windows Forms project");
    assert.strictEqual(await description('Console/Console.csproj'), "'Console.csproj' isn't a WinUI 3 project");
    assert.strictEqual(await description('Win32/Win32.vcxproj'), "'Win32.vcxproj' has no XAML pages");
    assert.strictEqual(await description('electron'), "'electron' doesn't contain a WinUI 3 app");
});

test('the pre-launch check defers to the CLI when it cannot be sure', async t => {
    const root = tempTree({
        'Imported/Imported.csproj': '<Project><Import Project="..\\shared.props" /></Project>',
        'Imported/App.xaml': '<Application />',
        'Solution/App.sln': '',
    });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    assert.deepStrictEqual(await checkAppFramework(path.join(root, 'Imported/Imported.csproj')), { kind: 'unknown' });
    assert.deepStrictEqual(await checkAppFramework(path.join(root, 'Solution/App.sln')), { kind: 'unknown' });
    assert.deepStrictEqual(await checkAppFramework(path.join(root, 'Solution')), { kind: 'unknown' });
    assert.deepStrictEqual(await checkAppFramework(path.join(root, 'Missing')), { kind: 'unknown' });
});

test('a project chosen inside a solution is checked directly', async t => {
    const root = tempTree({
        'App.sln': '',
        'Wpf/Wpf.csproj': '<Project><PropertyGroup><UseWPF>true</UseWPF></PropertyGroup></Project>',
    });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const result = await checkAppFramework(path.join(root, 'App.sln'), path.join(root, 'Wpf', 'Wpf.csproj'));
    assert.strictEqual(result.kind, 'other');
});
