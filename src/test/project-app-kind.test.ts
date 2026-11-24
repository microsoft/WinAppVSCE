import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { classifyProjectFile, detectProjectAppKind } from '../manifest-editor/project-app-kind';

describe('classifyProjectFile', () => {
    it('recognizes WinUI 3 C# and C++ projects as desktop', () => {
        assert.equal(classifyProjectFile('App.csproj', '<PropertyGroup><UseWinUI>true</UseWinUI></PropertyGroup>'), 'desktop');
        // C++ WinUI 3 projects also carry UWP-looking properties; the Windows App SDK import wins.
        const cppWinUI = '<AppContainerApplication>false</AppContainerApplication><ApplicationType>Windows Store</ApplicationType>'
            + '<Import Project="..\\packages\\Microsoft.WindowsAppSDK.1.6.0\\build\\native\\Microsoft.WindowsAppSDK.targets" />';
        assert.equal(classifyProjectFile('App.vcxproj', cppWinUI), 'desktop');
        assert.equal(classifyProjectFile('App.Package.wapproj', '<Project />'), 'desktop');
    });

    it('recognizes UWP projects', () => {
        assert.equal(classifyProjectFile('App.csproj', '<TargetPlatformIdentifier>UAP</TargetPlatformIdentifier>'), 'uwp');
        assert.equal(classifyProjectFile('App.csproj', '<UseUwp>true</UseUwp>'), 'uwp');
        assert.equal(classifyProjectFile('App.vcxproj', '<AppContainerApplication>true</AppContainerApplication>'), 'uwp');
    });

    it('returns undefined when the project says nothing about the app model', () => {
        assert.equal(classifyProjectFile('Lib.csproj', '<TargetFramework>net8.0</TargetFramework>'), undefined);
    });
});

describe('detectProjectAppKind', () => {
    let dir: string;
    before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'winapp-appkind-')); });
    after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('reads project files in the manifest folder, preferring a desktop signal', async () => {
        const sub = (name: string) => { const p = path.join(dir, name); fs.mkdirSync(p); return p; };
        assert.equal(await detectProjectAppKind(sub('empty')), undefined);

        const uwp = sub('uwp');
        fs.writeFileSync(path.join(uwp, 'App.csproj'), '<TargetPlatformIdentifier>UAP</TargetPlatformIdentifier>');
        assert.equal(await detectProjectAppKind(uwp), 'uwp');

        const mixed = sub('mixed');
        fs.writeFileSync(path.join(mixed, 'Old.csproj'), '<TargetPlatformIdentifier>UAP</TargetPlatformIdentifier>');
        fs.writeFileSync(path.join(mixed, 'App.csproj'), '<UseWinUI>true</UseWinUI>');
        assert.equal(await detectProjectAppKind(mixed), 'desktop');
    });

    it('returns undefined for a folder that cannot be read', async () => {
        assert.equal(await detectProjectAppKind(path.join(dir, 'missing')), undefined);
    });
});
