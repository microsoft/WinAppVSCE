import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'path';
import { loadSchemaModel } from '../manifest-schema/xsd-parser';
import { MANIFEST_NAMESPACES } from '../manifest-schema/schema-model';
import { validateManifestText } from '../manifest-schema/schema-validation';

const SCHEMAS_DIR = path.join(__dirname, '..', '..', 'schemas');
const schemaFiles = fs.readdirSync(SCHEMAS_DIR, { withFileTypes: true }).filter(f => f.name.endsWith('.xsd'));
if (schemaFiles.length === 0) {
    describe('semantic validation tests (SKIPPED - no schemas)', () => {
        it('skipped: run npm run sync-schemas first', { skip: 'schemas/ directory is empty' }, () => {});
    });
    process.exit(0);
}

const FOUNDATION_NS = MANIFEST_NAMESPACES[''];
const UAP_NS = MANIFEST_NAMESPACES['uap'];
const UAP4_NS = MANIFEST_NAMESPACES['uap4'];
const DESKTOP_NS = MANIFEST_NAMESPACES['desktop'];
const DESKTOP4_NS = MANIFEST_NAMESPACES['desktop4'];
const IOT2_NS = MANIFEST_NAMESPACES['iot2'];
const UAP10_NS = MANIFEST_NAMESPACES['uap10'];
const RESCAP_NS = MANIFEST_NAMESPACES['rescap'];
const COM_NS = MANIFEST_NAMESPACES['com'];
const PREVIEWSECURITY2_NS = 'http://schemas.microsoft.com/appx/manifest/preview/windows10/security/2';
const model = loadSchemaModel(SCHEMAS_DIR);

const COMMON_EXTRA_NAMESPACES =
    ` xmlns:uap4="${UAP4_NS}"` +
    ` xmlns:uap10="${UAP10_NS}"` +
    ` xmlns:desktop="${DESKTOP_NS}"` +
    ` xmlns:desktop4="${DESKTOP4_NS}"` +
    ` xmlns:iot2="${IOT2_NS}"` +
    ` xmlns:rescap="${RESCAP_NS}"` +
    ` xmlns:com="${COM_NS}"` +
    ` xmlns:previewsecurity2="${PREVIEWSECURITY2_NS}"`;

const SEMANTIC_MESSAGE_MARKERS = [
    'Application cannot declare both StartPage and Executable.',
    'Application cannot declare both StartPage and EntryPoint.',
    'Application with Executable must also declare EntryPoint when RuntimeBehavior is windowsApp.',
    'Application must declare either Executable or StartPage.',
    'Application cannot use ResourceGroup when SupportsMultipleInstances is true.',
    'Application with Subsystem="console" must declare SupportsMultipleInstances="true".',
    'SupportsMultipleInstances values must be consistent across namespace variants',
    'DefaultTile with Square310x310Logo must also declare Wide310x150Logo.',
    'LockScreen Notification="badgeAndTileText" requires DefaultTile Wide310x150Logo.',
    'Extension category "',
    'ShareTarget must declare at least one SupportedFileTypes or DataFormat child element.',
    'ApplicationContentUriRules Rule with Type="exclude" cannot declare WindowsRuntimeAccess.',
    'COM Class with InsertableObject="true" must also declare ProgId.',
    'COM Class AutoConvertTo value cannot be the same as the Class Id.',
    'Non-resource packages must declare at least one <Resource> element with a Language attribute.',
];

function makeManifest(body: string, extraNamespaces = ''): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="${FOUNDATION_NS}" xmlns:uap="${UAP_NS}"${extraNamespaces}>
${body}
</Package>`;
}

function makeFullManifest(body: string, extraNamespaces = ''): string {
    return makeManifest(`
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" />
  <Properties>
    <DisplayName>Test</DisplayName>
    <PublisherDisplayName>Test Publisher</PublisherDisplayName>
    <Logo>Assets\\StoreLogo.png</Logo>
  </Properties>
  <Resources>
    <Resource Language="en-us" />
  </Resources>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Universal" MinVersion="10.0.17763.0" MaxVersionTested="10.0.22621.0" />
  </Dependencies>
${body}`, extraNamespaces);
}

function makeApplicationManifest(
    applicationAttributes = 'Executable="App\\\\Test.exe" EntryPoint="Test.App"',
    applicationChildren = '',
    extraNamespaces = COMMON_EXTRA_NAMESPACES
): string {
    return makeFullManifest(`
  <Applications>
    <Application Id="App" ${applicationAttributes}>
      <uap:VisualElements
        DisplayName="Test"
        Description="Test app"
        BackgroundColor="transparent"
        Square150x150Logo="Assets\\Logo.png"
        Square44x44Logo="Assets\\SmallLogo.png">
${applicationChildren}
      </uap:VisualElements>
    </Application>
  </Applications>`, extraNamespaces);
}

function getSemanticDiagnostics(xml: string) {
    const diagnostics = validateManifestText(model, xml);
    const semanticDiagnostics = diagnostics.filter(d =>
        SEMANTIC_MESSAGE_MARKERS.some(marker => d.message.includes(marker))
    );

    for (const diagnostic of semanticDiagnostics) {
        assert.equal(diagnostic.severity, 'error');
    }

    return semanticDiagnostics;
}

function assertHasSemanticError(xml: string, messageFragment: string): void {
    const diagnostics = getSemanticDiagnostics(xml);
    assert.ok(
        diagnostics.some(d => d.message.includes(messageFragment)),
        `Expected semantic error containing "${messageFragment}". Got: ${diagnostics.map(d => d.message).join(' | ')}`
    );
}

function assertNoSemanticError(xml: string, messageFragment: string): void {
    const diagnostics = getSemanticDiagnostics(xml);
    assert.ok(
        !diagnostics.some(d => d.message.includes(messageFragment)),
        `Did not expect semantic error containing "${messageFragment}". Got: ${diagnostics.map(d => d.message).join(' | ')}`
    );
}

function assertNoSemanticErrors(xml: string): void {
    const diagnostics = getSemanticDiagnostics(xml);
    assert.equal(
        diagnostics.length,
        0,
        `Expected no semantic errors. Got: ${diagnostics.map(d => d.message).join(' | ')}`
    );
}

describe('Application attribute conflicts', () => {
    it('flags StartPage and Executable together', () => {
        const xml = makeApplicationManifest('StartPage="default.html" Executable="App\\\\Test.exe" uap10:RuntimeBehavior="packagedClassicApp"');
        assertHasSemanticError(xml, 'Application cannot declare both StartPage and Executable.');
    });

    it('flags StartPage and EntryPoint together', () => {
        const xml = makeApplicationManifest('StartPage="default.html" EntryPoint="Test.App"');
        assertHasSemanticError(xml, 'Application cannot declare both StartPage and EntryPoint.');
    });

    it('flags Executable without EntryPoint when RuntimeBehavior is windowsApp', () => {
        const xml = makeApplicationManifest('Executable="App\\\\Test.exe" uap10:RuntimeBehavior="windowsApp"');
        assertHasSemanticError(xml, 'Application with Executable must also declare EntryPoint when RuntimeBehavior is windowsApp.');
    });

    it('does not flag Executable without EntryPoint when RuntimeBehavior is packagedClassicApp', () => {
        const xml = makeApplicationManifest('Executable="App\\\\Test.exe" uap10:RuntimeBehavior="packagedClassicApp"');
        assertNoSemanticError(xml, 'Application with Executable must also declare EntryPoint when RuntimeBehavior is windowsApp.');
    });

    it('flags Application without Executable or StartPage', () => {
        const xml = makeApplicationManifest('');
        assertHasSemanticError(xml, 'Application must declare either Executable or StartPage.');
    });

    it('does not flag full-trust Application (EntryPoint="Windows.FullTrustApplication") without Executable', () => {
        const xml = makeApplicationManifest('EntryPoint="Windows.FullTrustApplication"');
        assertNoSemanticError(xml, 'Application must declare either Executable or StartPage.');
    });

    it('does not flag partial-trust Application without Executable', () => {
        const xml = makeApplicationManifest('EntryPoint="Windows.PartialTrustApplication"');
        assertNoSemanticError(xml, 'Application must declare either Executable or StartPage.');
    });

    it('does not flag hosted app (with HostId) without Executable', () => {
        const xml = makeApplicationManifest('uap10:HostId="Contoso.Host"');
        assertNoSemanticError(xml, 'Application must declare either Executable or StartPage.');
    });

    it('valid Application with Executable and EntryPoint produces no semantic errors', () => {
        const xml = makeApplicationManifest();
        assertNoSemanticErrors(xml);
    });
});

describe('SupportsMultipleInstances rules', () => {
    it('flags SupportsMultipleInstances with ResourceGroup', () => {
        const xml = makeApplicationManifest('Executable="App\\\\Test.exe" EntryPoint="Test.App" ResourceGroup="group1" uap10:SupportsMultipleInstances="true"');
        assertHasSemanticError(xml, 'Application cannot use ResourceGroup when SupportsMultipleInstances is true.');
    });

    it('flags console subsystem without SupportsMultipleInstances', () => {
        const xml = makeApplicationManifest('Executable="App\\\\Console.exe" EntryPoint="Test.App" uap10:Subsystem="console"');
        assertHasSemanticError(xml, 'Application with Subsystem="console" must declare SupportsMultipleInstances="true".');
    });

    it('does not flag console subsystem with SupportsMultipleInstances="true"', () => {
        const xml = makeApplicationManifest('Executable="App\\\\Console.exe" EntryPoint="Test.App" uap10:Subsystem="console" uap10:SupportsMultipleInstances="true"');
        assertNoSemanticError(xml, 'Application with Subsystem="console" must declare SupportsMultipleInstances="true".');
    });

    it('flags inconsistent SupportsMultipleInstances across namespace variants', () => {
        const xml = makeApplicationManifest('Executable="App\\\\Test.exe" EntryPoint="Test.App" desktop4:SupportsMultipleInstances="true" iot2:SupportsMultipleInstances="false"');
        assertHasSemanticError(xml, 'SupportsMultipleInstances values must be consistent across namespace variants');
    });

    it('does not flag consistent SupportsMultipleInstances across namespace variants', () => {
        const xml = makeApplicationManifest('Executable="App\\\\Test.exe" EntryPoint="Test.App" desktop4:SupportsMultipleInstances="true" iot2:SupportsMultipleInstances="true" uap10:SupportsMultipleInstances="true"');
        assertNoSemanticError(xml, 'SupportsMultipleInstances values must be consistent across namespace variants');
    });
});

describe('Visual Elements rules', () => {
    it('flags Square310x310Logo without Wide310x150Logo', () => {
        const xml = makeApplicationManifest(
            'Executable="App\\\\Test.exe" EntryPoint="Test.App"',
            '        <uap:DefaultTile Square310x310Logo="Assets\\Square310x310Logo.png" />\n'
        );
        assertHasSemanticError(xml, 'DefaultTile with Square310x310Logo must also declare Wide310x150Logo.');
    });

    it('does not flag Square310x310Logo with Wide310x150Logo present', () => {
        const xml = makeApplicationManifest(
            'Executable="App\\\\Test.exe" EntryPoint="Test.App"',
            '        <uap:DefaultTile Square310x310Logo="Assets\\Square310x310Logo.png" Wide310x150Logo="Assets\\Wide310x150Logo.png" />\n'
        );
        assertNoSemanticError(xml, 'DefaultTile with Square310x310Logo must also declare Wide310x150Logo.');
    });

    it('flags LockScreen badgeAndTileText without Wide310x150Logo', () => {
        const xml = makeApplicationManifest(
            'Executable="App\\\\Test.exe" EntryPoint="Test.App"',
            '        <uap:LockScreen Notification="badgeAndTileText" />\n'
        );
        assertHasSemanticError(xml, 'LockScreen Notification="badgeAndTileText" requires DefaultTile Wide310x150Logo.');
    });

    it('does not flag LockScreen badge without Wide310x150Logo', () => {
        const xml = makeApplicationManifest(
            'Executable="App\\\\Test.exe" EntryPoint="Test.App"',
            '        <uap:LockScreen Notification="badge" />\n'
        );
        assertNoSemanticError(xml, 'LockScreen Notification="badgeAndTileText" requires DefaultTile Wide310x150Logo.');
    });
});

describe('Extension category validation', () => {
    it('flags missing child element for known extension category', () => {
        const xml = makeApplicationManifest(
            'Executable="App\\\\Test.exe" EntryPoint="Test.App"',
            `        <Extensions>
          <uap:Extension Category="windows.protocol" />
        </Extensions>
`
        );
        assertHasSemanticError(xml, 'requires a <Protocol> child element.');
    });

    it('flags mismatched child element for extension category', () => {
        const xml = makeApplicationManifest(
            'Executable="App\\\\Test.exe" EntryPoint="Test.App"',
            `        <Extensions>
          <uap:Extension Category="windows.protocol">
            <uap:ShareTarget>
              <uap:DataFormat>Text</uap:DataFormat>
            </uap:ShareTarget>
          </uap:Extension>
        </Extensions>
`
        );
        assertHasSemanticError(xml, 'must have <Protocol> as its first child element, but found <ShareTarget>.');
    });

    it('does not flag correct category-child mapping (e.g., windows.protocol + Protocol)', () => {
        const xml = makeApplicationManifest(
            'Executable="App\\\\Test.exe" EntryPoint="Test.App"',
            `        <Extensions>
          <uap:Extension Category="windows.protocol">
            <uap:Protocol Name="sample" />
          </uap:Extension>
        </Extensions>
`
        );
        assertNoSemanticError(xml, 'windows.protocol');
    });

    it('does not flag unknown extension category', () => {
        const xml = makeApplicationManifest(
            'Executable="App\\\\Test.exe" EntryPoint="Test.App"',
            `        <Extensions>
          <desktop:Extension Category="windows.fullTrustProcess" />
        </Extensions>
`
        );
        assertNoSemanticErrors(xml);
    });
});

describe('ShareTarget rules', () => {
    it('flags ShareTarget without SupportedFileTypes or DataFormat', () => {
        const xml = makeApplicationManifest(
            'Executable="App\\\\Test.exe" EntryPoint="Test.App"',
            `        <Extensions>
          <uap:Extension Category="windows.shareTarget">
            <uap:ShareTarget />
          </uap:Extension>
        </Extensions>
`
        );
        assertHasSemanticError(xml, 'ShareTarget must declare at least one SupportedFileTypes or DataFormat child element.');
    });

    it('does not flag ShareTarget with SupportedFileTypes', () => {
        const xml = makeApplicationManifest(
            'Executable="App\\\\Test.exe" EntryPoint="Test.App"',
            `        <Extensions>
          <uap:Extension Category="windows.shareTarget">
            <uap:ShareTarget>
              <uap:SupportedFileTypes>
                <uap:FileType>.txt</uap:FileType>
              </uap:SupportedFileTypes>
            </uap:ShareTarget>
          </uap:Extension>
        </Extensions>
`
        );
        assertNoSemanticError(xml, 'ShareTarget must declare at least one SupportedFileTypes or DataFormat child element.');
    });

    it('does not flag ShareTarget with DataFormat', () => {
        const xml = makeApplicationManifest(
            'Executable="App\\\\Test.exe" EntryPoint="Test.App"',
            `        <Extensions>
          <uap:Extension Category="windows.shareTarget">
            <uap:ShareTarget>
              <uap:DataFormat>Text</uap:DataFormat>
            </uap:ShareTarget>
          </uap:Extension>
        </Extensions>
`
        );
        assertNoSemanticError(xml, 'ShareTarget must declare at least one SupportedFileTypes or DataFormat child element.');
    });
});

describe('Content URI rules', () => {
    it('flags WindowsRuntimeAccess on exclude rule', () => {
        const xml = makeApplicationManifest(
            'Executable="App\\\\Test.exe" EntryPoint="Test.App"',
            `        <uap:ApplicationContentUriRules>
          <uap:Rule Type="exclude" Match="https://example.com" WindowsRuntimeAccess="all" />
        </uap:ApplicationContentUriRules>
`
        );
        assertHasSemanticError(xml, 'ApplicationContentUriRules Rule with Type="exclude" cannot declare WindowsRuntimeAccess.');
    });

    it('does not flag WindowsRuntimeAccess on include rule', () => {
        const xml = makeApplicationManifest(
            'Executable="App\\\\Test.exe" EntryPoint="Test.App"',
            `        <uap:ApplicationContentUriRules>
          <uap:Rule Type="include" Match="https://example.com" WindowsRuntimeAccess="all" />
        </uap:ApplicationContentUriRules>
`
        );
        assertNoSemanticError(xml, 'ApplicationContentUriRules Rule with Type="exclude" cannot declare WindowsRuntimeAccess.');
    });
});

describe('COM class rules', () => {
    it('flags InsertableObject without ProgId', () => {
        const xml = makeApplicationManifest(
            'Executable="App\\\\Test.exe" EntryPoint="Test.App"',
            `        <Extensions>
          <com:Extension Category="windows.comServer">
            <com:ComServer>
              <com:ExeServer Executable="App\\ComServer.exe">
                <com:Class Id="{11111111-1111-1111-1111-111111111111}" InsertableObject="true" />
              </com:ExeServer>
            </com:ComServer>
          </com:Extension>
        </Extensions>
`
        );
        assertHasSemanticError(xml, 'COM Class with InsertableObject="true" must also declare ProgId.');
    });

    it('does not flag InsertableObject with ProgId', () => {
        const xml = makeApplicationManifest(
            'Executable="App\\\\Test.exe" EntryPoint="Test.App"',
            `        <Extensions>
          <com:Extension Category="windows.comServer">
            <com:ComServer>
              <com:ExeServer Executable="App\\ComServer.exe">
                <com:Class Id="{11111111-1111-1111-1111-111111111111}" InsertableObject="true" ProgId="Contoso.Component" />
              </com:ExeServer>
            </com:ComServer>
          </com:Extension>
        </Extensions>
`
        );
        assertNoSemanticError(xml, 'COM Class with InsertableObject="true" must also declare ProgId.');
    });

    it('flags AutoConvertTo same as Class Id', () => {
        const guid = '{11111111-1111-1111-1111-111111111111}';
        const xml = makeApplicationManifest(
            'Executable="App\\\\Test.exe" EntryPoint="Test.App"',
            `        <Extensions>
          <com:Extension Category="windows.comServer">
            <com:ComServer>
              <com:ExeServer Executable="App\\ComServer.exe">
                <com:Class Id="${guid}" AutoConvertTo="${guid}" />
              </com:ExeServer>
            </com:ComServer>
          </com:Extension>
        </Extensions>
`
        );
        assertHasSemanticError(xml, 'COM Class AutoConvertTo value cannot be the same as the Class Id.');
    });

    it('does not flag AutoConvertTo different from Class Id', () => {
        const xml = makeApplicationManifest(
            'Executable="App\\\\Test.exe" EntryPoint="Test.App"',
            `        <Extensions>
          <com:Extension Category="windows.comServer">
            <com:ComServer>
              <com:ExeServer Executable="App\\ComServer.exe">
                <com:Class Id="{11111111-1111-1111-1111-111111111111}" AutoConvertTo="{22222222-2222-2222-2222-222222222222}" />
                <com:Class Id="{22222222-2222-2222-2222-222222222222}" />
              </com:ExeServer>
            </com:ComServer>
          </com:Extension>
        </Extensions>
`
        );
        assertNoSemanticError(xml, 'COM Class AutoConvertTo value cannot be the same as the Class Id.');
    });
});

describe('Resource validation', () => {
    it('flags missing Language resource for non-resource packages', () => {
        const xml = makeManifest(`
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" />
  <Properties>
    <DisplayName>Test</DisplayName>
    <PublisherDisplayName>Test Publisher</PublisherDisplayName>
    <Logo>Assets\\StoreLogo.png</Logo>
  </Properties>
  <Resources />
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Universal" MinVersion="10.0.17763.0" MaxVersionTested="10.0.22621.0" />
  </Dependencies>`, COMMON_EXTRA_NAMESPACES);
        assertHasSemanticError(xml, 'Non-resource packages must declare at least one <Resource> element with a Language attribute.');
    });

    it('does not flag missing Language when ResourcePackage is true', () => {
        const xml = makeManifest(`
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" />
  <Properties>
    <DisplayName>Test</DisplayName>
    <PublisherDisplayName>Test Publisher</PublisherDisplayName>
    <Logo>Assets\\StoreLogo.png</Logo>
    <ResourcePackage>true</ResourcePackage>
  </Properties>
  <Resources />
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Universal" MinVersion="10.0.17763.0" MaxVersionTested="10.0.22621.0" />
  </Dependencies>`, COMMON_EXTRA_NAMESPACES);
        assertNoSemanticError(xml, 'Non-resource packages must declare at least one <Resource> element with a Language attribute.');
    });

    it('does not flag when Language resource is present', () => {
        const xml = makeFullManifest('', COMMON_EXTRA_NAMESPACES);
        assertNoSemanticError(xml, 'Non-resource packages must declare at least one <Resource> element with a Language attribute.');
    });
});
