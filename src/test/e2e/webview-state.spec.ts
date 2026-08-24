/**
 * Webview-level tests for the manifest editor UI state (issue #192).
 *
 * These render the real generated webview document in Chromium with a stubbed
 * `acquireVsCodeApi`, so the state-preservation behaviour can be exercised
 * deterministically without launching VS Code.
 */

import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { getWebviewContent } from '../../manifest-editor/webview-content';
import { parseManifest } from '../../manifest-editor/manifest-parser';

test.use({ viewport: { width: 900, height: 420 } });

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'winui-gallery.appxmanifest');

// `cspSource` / `asWebviewUri` are the only Webview members the generator touches.
const webviewStub = { cspSource: '', asWebviewUri: (u: unknown) => u } as never;

/** The CSP meta blocks the test's stub script, and isn't what these tests cover. */
const EDITOR_HTML = getWebviewContent(webviewStub, 'test-nonce', 'https://manifest.test/dir')
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');

const manifestXml = fs.readFileSync(FIXTURE, 'utf-8');
const manifestData = parseManifest(manifestXml);
const manifestDataWithCapability = parseManifest(
    manifestXml.replace('  </Capabilities>', '    <Capability Name="internetClient" />\n  </Capabilities>'),
);

/** Loads the editor document with a stubbed VS Code webview API, optionally seeding persisted state. */
async function loadEditor(page: Page, seedState: unknown = null): Promise<void> {
    // Injected ahead of the editor script so `acquireVsCodeApi` exists when it runs.
    const stub = `<script>
        globalThis.__state = ${JSON.stringify(seedState)};
        globalThis.__posted = [];
        globalThis.acquireVsCodeApi = () => ({
            postMessage: (m) => globalThis.__posted.push(m),
            setState: (s) => { globalThis.__state = s; },
            getState: () => globalThis.__state,
        });
    </script>`;
    await page.setContent(EDITOR_HTML.replace('</head>', `${stub}</head>`));
    await page.waitForFunction(() =>
        ((globalThis as unknown as { __posted: { type: string }[] }).__posted ?? []).some(m => m.type === 'ready'));
}

/** Mimics the extension pushing new document state into the webview. */
async function postUpdate(page: Page, data: unknown, forceAll = false): Promise<void> {
    await page.evaluate(([d, f]) => {
        (globalThis as unknown as { postMessage(m: unknown, o: string): void })
            .postMessage({ type: 'update', data: d, errors: [], forceAll: f }, '*');
    }, [data, forceAll] as [unknown, boolean]);
    await page.waitForTimeout(150);
}

async function postParseError(page: Page, message: string): Promise<void> {
    await page.evaluate((m) => {
        (globalThis as unknown as { postMessage(msg: unknown, o: string): void })
            .postMessage({ type: 'parseError', message: m }, '*');
    }, message);
    await page.waitForTimeout(150);
}

/** Reads the state the webview persisted through `vscode.setState`. */
function readPersistedState(page: Page): Promise<unknown> {
    return page.evaluate(() => (globalThis as unknown as { __state: unknown }).__state);
}

test('external updates preserve the active tab, app sub-tab and scroll position', async ({ page }) => {
    await loadEditor(page);
    await postUpdate(page, manifestData);

    await page.click('.tab-btn[data-tab="applications"]');
    await page.locator('.app-card').first().locator('.app-sub-tab[data-subtab="visual"]').click();
    await expect(page.locator('.app-sub-content[data-subcontent="visual"]').first()).toBeVisible();

    const panel = page.locator('#tab-applications');
    expect(await panel.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    await panel.evaluate(el => { el.scrollTop = 120; });
    await page.waitForTimeout(100);
    const scrollBefore = await panel.evaluate(el => el.scrollTop);
    expect(scrollBefore).toBeGreaterThan(0);

    // An external edit force-updates every field — that must not reset the view.
    await postUpdate(page, manifestDataWithCapability, true);

    await expect(page.locator('input[data-capability="internetClient"]')).toBeChecked();
    await expect(page.locator('.tab-btn[data-tab="applications"]')).toHaveClass(/active/);
    await expect(page.locator('.app-sub-tab[data-subtab="visual"]').first()).toHaveClass(/active/);
    await expect(page.locator('.app-sub-content[data-subcontent="visual"]').first()).toBeVisible();
    expect(await panel.evaluate(el => el.scrollTop)).toBe(scrollBefore);
});

test('a parse error is shown as an overlay without discarding the editor or its state', async ({ page }) => {
    await loadEditor(page);
    await postUpdate(page, manifestData);
    await page.click('.tab-btn[data-tab="applications"]');

    await expect(page.locator('#parse-error-overlay')).toBeHidden();
    await postParseError(page, 'unclosed tag: Package');

    await expect(page.locator('#parse-error-overlay')).toBeVisible();
    await expect(page.locator('#parse-error-detail')).toHaveText('unclosed tag: Package');
    // The editor document itself is untouched behind the overlay.
    await expect(page.locator('.tab-btn[data-tab="applications"]')).toHaveClass(/active/);
    await expect(page.locator('.app-card')).not.toHaveCount(0);

    // Recovering clears the overlay and keeps the selected tab.
    await postUpdate(page, manifestData, true);
    await expect(page.locator('#parse-error-overlay')).toBeHidden();
    await expect(page.locator('.tab-btn[data-tab="applications"]')).toHaveClass(/active/);
});

test('UI state is restored after the webview document is rebuilt', async ({ page, context }) => {
    await loadEditor(page);
    await postUpdate(page, manifestData);

    await page.click('.tab-btn[data-tab="applications"]');
    await page.locator('.app-card').first().locator('.app-sub-tab[data-subtab="visual"]').click();
    await page.locator('#tab-applications').evaluate(el => { el.scrollTop = 100; });
    await page.waitForTimeout(150);

    const persisted = await readPersistedState(page);
    expect(persisted).toMatchObject({ activeTab: 'applications' });

    // A brand-new script context (VS Code reload / editor rebuild) seeded with the persisted state.
    const reloaded = await context.newPage();
    await reloaded.setViewportSize({ width: 900, height: 420 });
    await loadEditor(reloaded, persisted);
    await postUpdate(reloaded, manifestData);

    await expect(reloaded.locator('.tab-btn[data-tab="applications"]')).toHaveClass(/active/);
    await expect(reloaded.locator('.app-sub-content[data-subcontent="visual"]').first()).toBeVisible();
    expect(await reloaded.locator('#tab-applications').evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    await reloaded.close();
});

test('a saved tab that is hidden on the first update is restored once it becomes available', async ({ page }) => {
    // Applications is hidden for a framework package, so the first update cannot restore it.
    // Restoration must stay pending rather than being consumed and lost.
    await loadEditor(page, { activeTab: 'applications', activeAppSubTabs: {}, userOpenedOptionalFields: [], scrollPositions: {} });

    const frameworkData = JSON.parse(JSON.stringify(manifestData));
    frameworkData.properties.framework = 'true';
    await postUpdate(page, frameworkData);
    await expect(page.locator('.tab-btn[data-tab="applications"]')).toHaveClass(/hidden-tab/);
    await expect(page.locator('.tab-btn[data-tab="identity"]')).toHaveClass(/active/);

    // A later update makes the tab available again — the saved selection should apply now.
    await postUpdate(page, manifestData, true);
    await expect(page.locator('.tab-btn[data-tab="applications"]')).toHaveClass(/active/);
});

test('the parse-error overlay is modal — the form behind it is inert', async ({ page }) => {
    await loadEditor(page);
    await postUpdate(page, manifestData);

    await expect(page.locator('.tab-bar')).not.toHaveAttribute('inert', '');
    await postParseError(page, 'unclosed tag: Package');

    // The overlay offers the same recovery action as the standalone parse-error page.
    await expect(page.locator('#parse-error-open-text')).toBeVisible();

    // Content behind the overlay must not remain keyboard- or AT-reachable.
    await expect(page.locator('.tab-bar')).toHaveAttribute('inert', '');
    await expect(page.locator('#tab-identity')).toHaveAttribute('aria-hidden', 'true');
    expect(await page.evaluate(() =>
        (globalThis as unknown as { document: { activeElement: { id: string } | null } }).document.activeElement?.id,
    )).toBe('parse-error-box');

    await page.locator('#parse-error-open-text').click();
    expect(await page.evaluate(() =>
        (globalThis as unknown as { __posted: { type: string }[] }).__posted.some(m => m.type === 'openAsText'),
    )).toBe(true);

    // Recovery lifts the modality again.
    await postUpdate(page, manifestData, true);
    await expect(page.locator('.tab-bar')).not.toHaveAttribute('inert', '');
    await expect(page.locator('#identity-name')).toBeEditable();
});

test('hiding a tab for a non-application package clears its button selection', async ({ page }) => {
    await loadEditor(page);
    await postUpdate(page, manifestData);
    await page.click('.tab-btn[data-tab="applications"]');
    await expect(page.locator('.tab-btn[data-tab="applications"]')).toHaveClass(/active/);

    const frameworkData = JSON.parse(JSON.stringify(manifestData));
    frameworkData.properties.framework = 'true';
    await postUpdate(page, frameworkData, true);

    await expect(page.locator('.tab-btn[data-tab="applications"]')).toHaveClass(/hidden-tab/);
    await expect(page.locator('.tab-btn.active')).toHaveCount(1);
    await expect(page.locator('.tab-content.active')).toHaveCount(1);
    await expect(page.locator('.tab-btn[data-tab="identity"]')).toHaveClass(/active/);
});
