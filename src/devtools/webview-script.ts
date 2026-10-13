/**
 * Client-side script for the WinUI DevTools webview.
 *
 * Returned as a string and inlined under a CSP nonce, matching the approach
 * used by the manifest editor.
 *
 * The script is one IIFE whose body is assembled here from the fragments in
 * the sibling webview-script-*.ts files. They are not separate scripts: every
 * fragment is a verbatim slice of the same function body and they share one
 * closure over the state and el objects, so order matters. Core declares that
 * shared state and goes first; messages is the only fragment that runs
 * anything at load time and goes last.
 *
 * Two things drive the structure of the script itself:
 *
 *  - The tree is virtualized. A WinUI visual tree can run to many thousands of
 *    elements, and a webview has no equivalent of the list virtualization VS
 *    Code's native tree gets for free, so only the rows inside the viewport are
 *    ever in the DOM.
 *  - Every value originates in the inspected app. All of it is written with
 *    textContent, never innerHTML, so an element name or property value cannot
 *    inject markup into the panel.
 */

import { CORE_FRAGMENT } from './webview-script-core';
import { TREE_FRAGMENT } from './webview-script-tree';
import { PROPERTIES_FRAGMENT } from './webview-script-properties';
import { EDITORS_FRAGMENT } from './webview-script-editors';
import { CONTROLS_FRAGMENT } from './webview-script-controls';
import { COMMENTS_FRAGMENT } from './webview-script-comments';
import { MESSAGES_FRAGMENT } from './webview-script-messages';

const FRAGMENTS = [
    CORE_FRAGMENT,
    TREE_FRAGMENT,
    PROPERTIES_FRAGMENT,
    EDITORS_FRAGMENT,
    CONTROLS_FRAGMENT,
    COMMENTS_FRAGMENT,
    MESSAGES_FRAGMENT,
];

export function getDevToolsScript(nonce: string): string {
    return /*html*/`<script nonce="${nonce}">
(function () {
    'use strict';
${FRAGMENTS.join('\n')}
}());
</script>`;
}
