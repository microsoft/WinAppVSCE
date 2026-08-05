import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { glob } from 'glob';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
    APPX_MANIFEST_EXTENSION_GLOB,
    APPX_MANIFEST_EXTENSION_PATTERN,
    APPX_MANIFEST_XML_GLOB,
    APPX_MANIFEST_XML_PATTERN,
    isManifestPath,
    MANIFEST_DIALOG_FILTER,
    MANIFEST_SELECTOR,
    WORKSPACE_MANIFEST_EXCLUDE_GLOB,
    WORKSPACE_MANIFEST_GLOB
} from '../manifest-schema/manifest-path';

describe('isManifestPath', () => {
    it('matches AppxManifest.xml and .appxmanifest paths case-insensitively', () => {
        assert.equal(isManifestPath('C:\\project\\AppxManifest.xml'), true);
        assert.equal(isManifestPath('C:\\project\\appxmanifest.xml'), true);
        assert.equal(isManifestPath('C:\\project\\MyApp.appxmanifest'), true);
        assert.equal(isManifestPath('C:\\project\\myapp.APPXMANIFEST'), true);
        assert.equal(isManifestPath('C:\\project\\myapp.aPpXmAnIfEsT'), true);
        assert.equal(isManifestPath('/unix/path/AppxManifest.xml'), true);
    });

    it('rejects non-manifest paths', () => {
        assert.equal(isManifestPath('C:\\project\\package.json'), false);
        assert.equal(isManifestPath('C:\\project\\manifest.xml'), false);
        assert.equal(isManifestPath('C:\\project\\AppxManifest.xml.bak'), false);
        assert.equal(isManifestPath(''), false);
    });
});

describe('workspace manifest discovery patterns', () => {
    it('constructs case-insensitive patterns for both supported manifest names', () => {
        assert.equal(
            APPX_MANIFEST_XML_GLOB,
            '[Aa][Pp][Pp][Xx][Mm][Aa][Nn][Ii][Ff][Ee][Ss][Tt].[Xx][Mm][Ll]'
        );
        assert.equal(
            APPX_MANIFEST_EXTENSION_GLOB,
            '[Aa][Pp][Pp][Xx][Mm][Aa][Nn][Ii][Ff][Ee][Ss][Tt]'
        );
        assert.equal(
            WORKSPACE_MANIFEST_GLOB,
            `{${APPX_MANIFEST_XML_PATTERN},${APPX_MANIFEST_EXTENSION_PATTERN}}`
        );
        assert.deepEqual(MANIFEST_SELECTOR, [
            { language: 'xml', pattern: APPX_MANIFEST_XML_PATTERN },
            { language: 'xml', pattern: APPX_MANIFEST_EXTENSION_PATTERN },
        ]);
        assert.equal(WORKSPACE_MANIFEST_EXCLUDE_GLOB, '**/{node_modules,.git}/**');
    });

    it('finds only supported mixed-case manifests outside excluded directories', async () => {
        const fixtureDirectory = await mkdtemp(path.join(process.cwd(), 'manifest-glob-test-'));
        const files = [
            'src/APPXMANIFEST.XML',
            'src/Widget.AppXmAnIfEsT',
            'src/AppxManifest.xml.bak',
            'src/AlmostAppxManifest.xml',
            'src/Widget.appxmanifest.bak',
            'node_modules/package/AppxManifest.xml',
            '.git/AppxManifest.xml'
        ];

        try {
            await Promise.all(files.map(async file => {
                const filePath = path.join(fixtureDirectory, file);
                await mkdir(path.dirname(filePath), { recursive: true });
                await writeFile(filePath, '');
            }));

            const matches = await glob(WORKSPACE_MANIFEST_GLOB, {
                cwd: fixtureDirectory,
                dot: true,
                ignore: WORKSPACE_MANIFEST_EXCLUDE_GLOB
            });

            assert.deepEqual(matches.map(match => match.replaceAll('\\', '/')).sort(), [
                'src/APPXMANIFEST.XML',
                'src/Widget.AppXmAnIfEsT'
            ]);
        } finally {
            await rm(fixtureDirectory, { recursive: true, force: true });
        }
    });

    it('labels the XML dialog filter as requiring the AppxManifest.xml filename', () => {
        assert.deepEqual(MANIFEST_DIALOG_FILTER, {
            'Manifest files (.appxmanifest or AppxManifest.xml)': ['appxmanifest', 'xml']
        });
    });

    it('keeps package manifest patterns aligned and case-insensitive', async () => {
        const packageJson = JSON.parse(
            await readFile(path.join(process.cwd(), 'package.json'), 'utf8')
        );
        const expectedPatterns = [APPX_MANIFEST_XML_PATTERN, APPX_MANIFEST_EXTENSION_PATTERN];
        const customEditor = packageJson.contributes.customEditors.find(
            (editor: { viewType: string }) => editor.viewType === 'winapp.manifestEditor'
        );
        const language = packageJson.contributes.languages.find(
            (contribution: { id: string }) => contribution.id === 'xml'
        );

        assert.deepEqual(
            customEditor.selector.map((selector: { filenamePattern: string }) => selector.filenamePattern),
            expectedPatterns
        );
        assert.deepEqual(language.filenamePatterns, expectedPatterns);
        assert.ok(packageJson.activationEvents.includes(`workspaceContains:${APPX_MANIFEST_XML_PATTERN}`));
        assert.ok(packageJson.activationEvents.includes(`workspaceContains:${APPX_MANIFEST_EXTENSION_PATTERN}`));
        assert.match(
            packageJson.contributes.menus['editor/title'][0].when,
            /resourceFilename =~ \/appxmanifest\\\.xml\$\/i/
        );
        assert.match(
            packageJson.contributes.menus['editor/title'][0].when,
            /resourceExtname =~ \/\^\\\.appxmanifest\$\/i/
        );

        const fixtureDirectory = await mkdtemp(path.join(process.cwd(), 'manifest-selector-test-'));
        const files = ['nested/aPpXmAnIfEsT.XmL', 'nested/Widget.ApPxMaNiFeSt'];

        try {
            await Promise.all(files.map(async file => {
                const filePath = path.join(fixtureDirectory, file);
                await mkdir(path.dirname(filePath), { recursive: true });
                await writeFile(filePath, '');
            }));

            const matches = await Promise.all(expectedPatterns.map(pattern =>
                glob(pattern, { cwd: fixtureDirectory })
            ));
            assert.deepEqual(
                matches.flat().map(match => match.replaceAll('\\', '/')).sort(),
                [...files].sort()
            );
        } finally {
            await rm(fixtureDirectory, { recursive: true, force: true });
        }
    });
});
