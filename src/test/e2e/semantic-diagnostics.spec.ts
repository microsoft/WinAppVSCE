/**
 * E2E tests: Semantic validation diagnostics in the Problems panel.
 * Verifies that semantic validation rules (cross-element checks from the
 * OS manifest validator) produce diagnostics when editing manifests.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import {
    createTempWorkspace,
    launchVSCode,
    teardown,
    type VSCodeTestContext,
} from './helpers';

const FOUNDATION_NS = 'http://schemas.microsoft.com/appx/manifest/foundation/windows10';
const UAP_NS = 'http://schemas.microsoft.com/appx/manifest/uap/windows10';
const UAP10_NS = 'http://schemas.microsoft.com/appx/manifest/uap/windows10/10';
const DESKTOP4_NS = 'http://schemas.microsoft.com/appx/manifest/desktop/windows10/4';
const COM_NS = 'http://schemas.microsoft.com/appx/manifest/com/windows10';

function makeManifest(body: string, extraNs = ''): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="${FOUNDATION_NS}" xmlns:uap="${UAP_NS}"${extraNs}>
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
${body}
</Package>`;
}

async function openProblemsPanel(ctx: VSCodeTestContext): Promise<void> {
    await ctx.page.keyboard.press('Control+Shift+M');
    await ctx.page.waitForTimeout(2_000);
}

async function getProblemsText(ctx: VSCodeTestContext): Promise<string> {
    // The Problems panel content lives in the main page DOM
    const problemsPanel = ctx.page.locator('.markers-panel-container');
    try {
        await problemsPanel.waitFor({ state: 'visible', timeout: 5_000 });
        return await problemsPanel.innerText();
    } catch {
        return '';
    }
}

// ─── StartPage + Executable conflict ────────────────────

let ctx1: VSCodeTestContext;

test.afterAll(async () => {
    if (ctx1) await teardown(ctx1);
});

test('shows semantic error for StartPage and Executable conflict', async () => {
    const tmpDir = createTempWorkspace('winui-gallery.appxmanifest');
    const manifestPath = path.join(tmpDir, 'AppxManifest.xml');
    fs.writeFileSync(manifestPath, makeManifest(`
  <Applications>
    <Application Id="App" Executable="test.exe" StartPage="index.html" EntryPoint="App.App">
      <uap:VisualElements DisplayName="Test" Description="Test" BackgroundColor="transparent"
        Square150x150Logo="Assets\\Logo.png" Square44x44Logo="Assets\\Small.png" />
    </Application>
  </Applications>`), 'utf-8');

    ctx1 = await launchVSCode(tmpDir);

    // Wait for diagnostics to compute (the text editor should already be open)
    await ctx1.page.waitForTimeout(5_000);
    await openProblemsPanel(ctx1);
    const problems = await getProblemsText(ctx1);

    expect(problems).toContain('StartPage');
    expect(problems).toContain('Executable');
});

// ─── Extension category mismatch ────────────────────────

let ctx2: VSCodeTestContext;

test.afterAll(async () => {
    if (ctx2) await teardown(ctx2);
});

test('shows semantic error for extension category-child mismatch', async () => {
    const tmpDir = createTempWorkspace('winui-gallery.appxmanifest');
    const manifestPath = path.join(tmpDir, 'AppxManifest.xml');
    fs.writeFileSync(manifestPath, makeManifest(`
  <Applications>
    <Application Id="App" Executable="test.exe" EntryPoint="App.App">
      <uap:VisualElements DisplayName="Test" Description="Test" BackgroundColor="transparent"
        Square150x150Logo="Assets\\Logo.png" Square44x44Logo="Assets\\Small.png" />
      <Extensions>
        <uap:Extension Category="windows.protocol">
          <uap:ShareTarget>
            <uap:DataFormat>text</uap:DataFormat>
          </uap:ShareTarget>
        </uap:Extension>
      </Extensions>
    </Application>
  </Applications>`), 'utf-8');

    ctx2 = await launchVSCode(tmpDir);
    await ctx2.page.waitForTimeout(5_000);
    await openProblemsPanel(ctx2);
    const problems = await getProblemsText(ctx2);

    expect(problems).toContain('windows.protocol');
    expect(problems).toContain('Protocol');
});

// ─── Missing Language resource ──────────────────────────

let ctx3: VSCodeTestContext;

test.afterAll(async () => {
    if (ctx3) await teardown(ctx3);
});

test('shows semantic error for missing language resource', async () => {
    const tmpDir = createTempWorkspace('winui-gallery.appxmanifest');
    const manifestPath = path.join(tmpDir, 'AppxManifest.xml');
    // Manifest without any Resources element
    fs.writeFileSync(manifestPath, `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="${FOUNDATION_NS}" xmlns:uap="${UAP_NS}">
  <Identity Name="Test" Publisher="CN=Test" Version="1.0.0.0" />
  <Properties>
    <DisplayName>Test</DisplayName>
    <PublisherDisplayName>Test Publisher</PublisherDisplayName>
    <Logo>Assets\\StoreLogo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Universal" MinVersion="10.0.17763.0" MaxVersionTested="10.0.22621.0" />
  </Dependencies>
</Package>`, 'utf-8');

    ctx3 = await launchVSCode(tmpDir);
    await ctx3.page.waitForTimeout(5_000);
    await openProblemsPanel(ctx3);
    const problems = await getProblemsText(ctx3);

    expect(problems).toContain('Language');
});

// ─── Clean manifest produces no semantic errors ─────────

let ctx4: VSCodeTestContext;

test.afterAll(async () => {
    if (ctx4) await teardown(ctx4);
});

test('clean manifest with valid Application shows no semantic errors', async () => {
    const tmpDir = createTempWorkspace('winui-gallery.appxmanifest');
    const manifestPath = path.join(tmpDir, 'AppxManifest.xml');
    fs.writeFileSync(manifestPath, makeManifest(`
  <Applications>
    <Application Id="App" Executable="test.exe" EntryPoint="App.App">
      <uap:VisualElements DisplayName="Test" Description="Test" BackgroundColor="transparent"
        Square150x150Logo="Assets\\Logo.png" Square44x44Logo="Assets\\Small.png" />
    </Application>
  </Applications>`), 'utf-8');

    ctx4 = await launchVSCode(tmpDir);
    await ctx4.page.waitForTimeout(5_000);
    await openProblemsPanel(ctx4);
    const problems = await getProblemsText(ctx4);

    // Should not contain any semantic error messages
    expect(problems).not.toContain('StartPage');
    expect(problems).not.toContain('must declare');
    expect(problems).not.toContain('cannot declare both');
});
