/**
 * E2E tests: the visual editor must keep its UI state when the manifest XML is
 * edited outside the webview (text editor / external tooling), including while
 * the XML is transiently unparseable mid-edit.
 *
 * Regression coverage for #192.
 */

import { test, expect, type FrameLocator } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import {
    createTempWorkspace,
    launchVSCode,
    openManifestEditor,
    switchTab,
    switchAppSubTab,
    teardown,
    type VSCodeTestContext,
} from './helpers';

let ctx: VSCodeTestContext;
let frame: FrameLocator;
let manifestPath: string;
let original: string;

/** Writes the manifest to disk, mimicking an edit made in the text editor. */
function writeManifest(contents: string): void {
    fs.writeFileSync(manifestPath, contents, 'utf-8');
}

// This spec drives external, on-disk edits, which conflict with the unsaved webview
// edits other specs leave in the shared editor. Use a dedicated VS Code instance.
test.beforeAll(async () => {
    const tmpDir = createTempWorkspace('winui-gallery.appxmanifest');
    manifestPath = path.join(tmpDir, 'AppxManifest.xml');
    original = fs.readFileSync(manifestPath, 'utf-8');
    ctx = await launchVSCode(tmpDir);
    frame = await openManifestEditor(ctx.page);
});

test.afterAll(async () => {
    if (ctx) { await teardown(ctx); }
});

// The last test leaves the text editor focused rather than the custom editor, so these run in
// order. Serial mode also retries the file from the top instead of resuming mid-sequence.
test.describe.configure({ mode: 'serial' });

// Each test must stand on its own: restore valid XML and re-establish the view state, so running
// one in isolation (--grep) or retrying it in a fresh worker starts from the same place.
test.beforeEach(async () => {
    writeManifest(original);
    await expect(frame.locator('#parse-error-overlay')).toBeHidden({ timeout: 20_000 });
    await switchTab(frame, 'applications');
    await switchAppSubTab(frame, 0, 'visual');
});

test('keeps the selected tab, app sub-tab and scroll position across an external edit that breaks the XML mid-way', async () => {
    // beforeEach already selected Applications / Visual Assets; scroll down to complete the state.
    await expect(frame.locator('.app-sub-tab[data-subtab="visual"]').first()).toHaveClass(/active/);

    const panel = frame.locator('#tab-applications');
    await panel.evaluate(el => { el.scrollTop = 150; });
    await ctx.page.waitForTimeout(500);
    const scrollBefore = await panel.evaluate(el => el.scrollTop);
    expect(scrollBefore).toBeGreaterThan(0);

    // Typing `<Capability Name="internetClient" />` in the text editor passes through
    // many transiently-invalid states. Replay a few of them, then land on valid XML.
    const partials = ['<', '<Capability', '<Capability Name="internetClient"'];
    for (const partial of partials) {
        writeManifest(original.replace('</Capabilities>', `  ${partial}\n  </Capabilities>`));
        await ctx.page.waitForTimeout(400);
    }
    writeManifest(original.replace('</Capabilities>', '  <Capability Name="internetClient" />\n  </Capabilities>'));

    // The capability lands in the editor and the parse-error overlay clears…
    await expect(frame.locator('input[data-capability="internetClient"]')).toBeChecked({ timeout: 20_000 });
    await expect(frame.locator('#parse-error-overlay')).toBeHidden({ timeout: 20_000 });
    // …and the UI state must have survived the round trip.
    await expect(frame.locator('.tab-btn[data-tab="applications"]')).toHaveClass(/active/);
    await expect(panel).toBeVisible();
    await expect(frame.locator('.app-sub-tab[data-subtab="visual"]').first()).toHaveClass(/active/);
    expect(await panel.evaluate(el => el.scrollTop)).toBe(scrollBefore);
});

test('exactly one top-level tab button is marked active after an external edit', async () => {
    await expect(frame.locator('.tab-btn.active')).toHaveCount(1);
    await expect(frame.locator('.tab-content.active')).toHaveCount(1);
});

test('shows an in-place overlay — not a rebuilt document — while the XML is invalid', async () => {
    writeManifest(original.replace('</Package>', '<Unclosed>'));

    // The editor document is still alive behind the overlay.
    await expect(frame.locator('#parse-error-overlay')).toBeVisible({ timeout: 20_000 });
    await expect(frame.locator('#parse-error-detail')).not.toBeEmpty();
    await expect(frame.locator('.tab-bar')).toBeAttached();
    await expect(frame.locator('.tab-btn[data-tab="applications"]')).toHaveClass(/active/);

    // The overlay offers the same recovery action as the standalone error page…
    await expect(frame.locator('#parse-error-open-text')).toBeVisible();
    // …and is modal: the form behind it must not stay reachable by keyboard or AT.
    await expect(frame.locator('.tab-bar')).toHaveAttribute('inert', '');

    // Restoring valid XML clears the overlay and keeps the selected tab.
    writeManifest(original);
    await expect(frame.locator('#parse-error-overlay')).toBeHidden({ timeout: 20_000 });
    await expect(frame.locator('.tab-btn[data-tab="applications"]')).toHaveClass(/active/);
    await expect(frame.locator('.tab-bar')).not.toHaveAttribute('inert', '');
});

test('a save flushes webview input that is still inside the debounce window', async () => {
    // The Chromium spec only proves the webview *posts* changesFlushed. This drives the provider
    // handler that turns that message into a TextEdit, so a failure there cannot go unnoticed.
    await switchAppSubTab(frame, 0, 'extensions');
    await ctx.page.waitForTimeout(500);

    const hostInput = frame.locator('input[data-ext-field="Host.Name"]').first();
    await expect(hostInput).toBeVisible({ timeout: 10_000 });
    await hostInput.click();
    await hostInput.fill('flushed-on-save.example.com');

    // Save well inside the 300 ms input debounce, so the keystroke only reaches disk if the
    // flush path works end to end.
    await ctx.page.keyboard.press('Control+S');

    await expect.poll(
        () => fs.readFileSync(manifestPath, 'utf-8'),
        { timeout: 15_000, message: 'flushed value never reached the saved manifest' },
    ).toContain('flushed-on-save.example.com');

    // The save must not have corrupted the rest of the document.
    const saved = fs.readFileSync(manifestPath, 'utf-8');
    expect(saved).toContain('<Package');
    expect(saved).toContain('</Package>');
});

test('the save-flush echo refreshes validation instead of rebuilding the form', async () => {
    // The flush edit echoes back as a document change. Treating that echo as an external edit
    // makes populateForm run renderApplications, which rebuilds the Applications inputs from the
    // document and drops any text typed since the save, out from under the user's cursor.
    //
    // The webview's own 300 ms input debounce flushes that text a moment later and the field
    // converges, so asserting the settled value proves nothing. What distinguishes the two
    // behaviours is the message the echo produces: 'validationErrors' (form untouched) rather
    // than a second 'update' (form rebuilt). Verified by reverting the fix: the trace becomes
    // flushChanges -> update -> update instead of flushChanges -> validationErrors -> update.
    await switchAppSubTab(frame, 0, 'extensions');
    await ctx.page.waitForTimeout(500);

    const hostInput = frame.locator('input[data-ext-field="Host.Name"]').first();
    await expect(hostInput).toBeVisible({ timeout: 10_000 });

    // Record what the extension posts to the webview. 'body' survives renderApplications, which
    // only rebuilds the applications container, so the recorder is not torn down mid-test.
    await frame.locator('body').evaluate(el => {
        const w = el.ownerDocument.defaultView as unknown as {
            __msgs: string[];
            addEventListener: (type: string, cb: (e: { data?: { type?: string } }) => void) => void;
        };
        w.__msgs = [];
        w.addEventListener('message', e => { w.__msgs.push(((e.data || {}).type) as string); });
    });

    await hostInput.click();
    await hostInput.fill('echo-base.example.com');
    await ctx.page.keyboard.press('Control+S');

    // Keep typing straight away, so this text is still local when the echo arrives.
    await hostInput.pressSequentially('/more');

    // The save landing on disk is what triggers the echo, so poll for it first.
    await expect.poll(
        () => fs.readFileSync(manifestPath, 'utf-8'),
        { timeout: 15_000, message: 'the flushed value never reached the saved manifest' },
    ).toContain('echo-base.example.com');

    const readMessages = () => frame.locator('body').evaluate(
        el => (el.ownerDocument.defaultView as unknown as { __msgs: string[] }).__msgs);

    // Wait for the echo to be handled rather than sleeping a fixed amount.
    await expect.poll(readMessages, {
        timeout: 15_000,
        message: 'the save never produced a flushChanges/validationErrors exchange',
    }).toContain('validationErrors');

    const msgs = await readMessages();
    const flushIndex = msgs.indexOf('flushChanges');
    expect(flushIndex, 'the save never reached the webview').toBeGreaterThanOrEqual(0);

    // The echo must refresh validation before anything rebuilds the form.
    const afterFlush = msgs.slice(flushIndex + 1).filter(m => m === 'update' || m === 'validationErrors');
    expect(afterFlush[0], `unexpected message order after the save: ${msgs.join(', ')}`)
        .toBe('validationErrors');

    // And the text typed after the save is still in the field.
    await expect(hostInput).toHaveValue('echo-base.example.com/more');

    // Leave the document clean: the next test edits the file on disk, which VS Code ignores
    // while the in-memory document still has unsaved changes.
    await ctx.page.keyboard.press('Control+S');
    await expect.poll(
        () => fs.readFileSync(manifestPath, 'utf-8'),
        { timeout: 15_000, message: 'the trailing edit was never saved' },
    ).toContain('echo-base.example.com/more');
});

test('saving while the XML is unparseable stores the raw text instead of rewriting the document', async () => {
    writeManifest(original.replace('</Package>', '<Unclosed>'));
    await expect(frame.locator('#parse-error-overlay')).toBeVisible({ timeout: 20_000 });

    // Open the raw XML in the text editor and make it dirty, so that saving actually runs the
    // provider's onWillSaveTextDocument flush against a document that cannot be parsed.
    // This test runs last: it leaves the text editor, not the custom editor, focused.
    await frame.locator('#parse-error-open-text').click();

    // The overlay opens the text editor beside the visual one and focuses it. Wait for that
    // focus rather than sleeping or clicking — typing before the editor is ready silently sends
    // the keystrokes to the webview, and the webview overlay intercepts clicks while the new
    // group is still laying out.
    const textEditor = ctx.page.locator('.editor-group-container.active .monaco-editor.focused');
    await expect(textEditor).toBeVisible({ timeout: 20_000 });
    // The assertion below depends on the insert position, so anchor the caret explicitly
    // instead of assuming it landed at offset 0.
    await ctx.page.keyboard.press('Control+Home');
    await ctx.page.keyboard.type('<Another>');
    await ctx.page.keyboard.press('Control+S');

    // The save must complete and persist exactly what the user typed. If the provider applied
    // pending field changes here it would have serialised valid XML over the broken text.
    await expect.poll(
        () => fs.readFileSync(manifestPath, 'utf-8'),
        { timeout: 15_000, message: 'the typed text never reached the saved manifest' },
    ).toContain('<Another>');

    const saved = fs.readFileSync(manifestPath, 'utf-8');
    expect(saved.startsWith('<Another>')).toBe(true);
    expect(saved).toContain('<Unclosed>');
});
