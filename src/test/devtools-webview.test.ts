import { test } from 'node:test';
import * as assert from 'node:assert';
import * as vm from 'node:vm';
import { getDevToolsScript } from '../devtools/webview-script';
import { getDevToolsStyles } from '../devtools/webview-styles';
import { getDevToolsWebviewContent } from '../devtools/webview-content';

const NONCE = 'test-nonce-0123456789';

function scriptBody(): string {
    const script = getDevToolsScript(NONCE);
    const open = `<script nonce="${NONCE}">`;
    assert.ok(script.startsWith(open), 'script should open with a nonced tag');
    return script.slice(open.length, script.lastIndexOf('</script>'));
}

/**
 * The webview script is authored inside a template literal, which TypeScript
 * treats as opaque text — a stray backtick or brace silently produces a broken
 * page instead of a compile error. Parsing it here restores that safety net.
 */
test('webview script is syntactically valid JavaScript', () => {
    assert.doesNotThrow(() => new vm.Script(scriptBody(), { filename: 'devtools-webview.js' }));
});

test('webview script never assigns innerHTML', () => {
    // Every value rendered in the panel originates in the inspected app, so
    // markup injection is prevented structurally rather than by escaping.
    assert.ok(!scriptBody().includes('innerHTML'));
});

test('styles are emitted inside a nonced style tag', () => {
    const styles = getDevToolsStyles(NONCE);
    assert.ok(styles.includes(`<style nonce="${NONCE}">`));
    assert.ok(styles.trimEnd().endsWith('</style>'));
});

test('html shell locks down content with a nonce-based CSP', () => {
    const webview = { cspSource: 'vscode-webview://fake' } as never;
    const html = getDevToolsWebviewContent(webview, NONCE);

    assert.ok(html.includes('<!DOCTYPE html>'));
    assert.ok(html.includes('Content-Security-Policy'));
    assert.ok(html.includes("default-src 'none'"));
    assert.ok(html.includes(NONCE));
});

test('html shell has no script tag without a nonce', () => {
    const webview = { cspSource: 'vscode-webview://fake' } as never;
    const html = getDevToolsWebviewContent(webview, NONCE);

    assert.ok(!/<script(?![^>]*nonce=)/i.test(html), 'every script tag must carry the nonce');
});
