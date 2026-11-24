import { test } from 'node:test';
import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    devToolsSpawnArgs, requestsDevTools, shouldAttachDebugger, shouldUseDevTools,
} from '../devtools/launch-options';
import { checkAppFramework, type PropertyEvaluator } from '../devtools/app-framework';

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

function tempTree(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'winapp-framework-'));
    for (const [name, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
        fs.writeFileSync(path.join(root, name), content);
    }
    return root;
}

// Stands in for `dotnet msbuild -getProperty`, keyed by project file name.
const evaluated = (byName: Record<string, Record<string, string>>): PropertyEvaluator =>
    async file => byName[path.basename(file)];

test('the pre-launch check recognizes WinUI 3 the way the CLI does', async t => {
    const root = tempTree({
        'WinUi/WinUi.csproj': '<Project><PropertyGroup><UseWinUI>true</UseWinUI></PropertyGroup></Project>',
        'Imported/Imported.csproj': '<Project><Import Project="..\\shared.props" /></Project>',
        'Native/Native.vcxproj': '<Project><ItemGroup><Page Include="MainWindow.xaml" /></ItemGroup></Project>',
        'Output/App.exe': '', 'Output/MainWindow.xbf': '',
    });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const evaluate = evaluated({ 'Imported.csproj': { UseWinUI: 'true' } });
    for (const input of ['WinUi/WinUi.csproj', 'WinUi', 'Imported/Imported.csproj', 'Native/Native.vcxproj', 'Output']) {
        assert.deepStrictEqual(await checkAppFramework(path.join(root, input), undefined, evaluate), { kind: 'winui' }, input);
    }
});

test('the pre-launch check names every app that is not WinUI 3', async t => {
    const root = tempTree({
        'Wpf/Wpf.csproj': '<Project><PropertyGroup><UseWPF>true</UseWPF></PropertyGroup></Project>',
        'Inherited/Inherited.csproj': '<Project></Project>',
        'Console/Console.csproj': '<Project><PropertyGroup><OutputType>Exe</OutputType></PropertyGroup></Project>',
        'Win32/Win32.vcxproj': '<Project><ItemGroup><ClCompile Include="main.cpp" /></ItemGroup></Project>',
        'electron/electron.exe': '', 'electron/resources/app.asar': '',
    });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const evaluate = evaluated({ 'Inherited.csproj': { UseWindowsForms: 'true' }, 'Console.csproj': {} });
    const description = async (input: string) => {
        const result = await checkAppFramework(path.join(root, input), undefined, evaluate);
        return result.kind === 'other' ? result.description : result.kind;
    };
    assert.strictEqual(await description('Wpf/Wpf.csproj'), "'Wpf.csproj' is a WPF project");
    assert.strictEqual(await description('Inherited'), "'Inherited.csproj' is a Windows Forms project");
    assert.strictEqual(await description('Console/Console.csproj'), "'Console.csproj' isn't a WinUI 3 project");
    assert.strictEqual(await description('Win32/Win32.vcxproj'), "'Win32.vcxproj' has no XAML pages");
    assert.strictEqual(await description('electron'), "'electron' doesn't contain a WinUI 3 app");
});

test('a solution is judged by the app the CLI will run', async t => {
    const sln = (members: string[]) => members.map(member =>
        `Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "${path.parse(member).name}", "${member}", "{00000000-0000-0000-0000-000000000000}"\nEndProject`).join('\n');
    const wpf = '<Project><PropertyGroup><OutputType>WinExe</OutputType><UseWPF>true</UseWPF></PropertyGroup></Project>';
    const winui = '<Project><PropertyGroup><OutputType>WinExe</OutputType><UseWinUI>true</UseWinUI></PropertyGroup></Project>';
    const library = '<Project><PropertyGroup><OutputType>Library</OutputType><UseWinUI>true</UseWinUI></PropertyGroup></Project>';
    const root = tempTree({
        'WpfOnly/App.sln': sln(['Wpf\\Wpf.csproj', 'Controls\\Controls.csproj']),
        'WpfOnly/Wpf/Wpf.csproj': wpf, 'WpfOnly/Controls/Controls.csproj': library,
        'Mixed/App.sln': sln(['Wpf\\Wpf.csproj', 'WinUi\\WinUi.csproj']),
        'Mixed/Wpf/Wpf.csproj': wpf, 'Mixed/WinUi/WinUi.csproj': winui,
    });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const evaluate = evaluated({});
    assert.deepStrictEqual(await checkAppFramework(path.join(root, 'WpfOnly', 'App.sln'), undefined, evaluate),
        { kind: 'other', description: "'Wpf.csproj' is a WPF project" }, 'a WinUI library does not make the app WinUI');
    assert.strictEqual((await checkAppFramework(path.join(root, 'WpfOnly'), undefined, evaluate)).kind, 'other');
    assert.strictEqual((await checkAppFramework(path.join(root, 'Mixed', 'App.sln'), 'Wpf', evaluate)).kind, 'other');
    assert.strictEqual((await checkAppFramework(path.join(root, 'Mixed', 'App.sln'), 'WinUi.csproj', evaluate)).kind, 'winui');
});

test('only an unreadable input is left to the CLI', async () => {
    assert.deepStrictEqual(await checkAppFramework(path.join(os.tmpdir(), 'winapp-missing-input'), undefined, evaluated({})),
        { kind: 'unknown' });
});