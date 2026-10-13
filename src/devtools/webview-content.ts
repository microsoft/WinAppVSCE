/**
 * HTML shell for the WinUI DevTools webview.
 *
 * Scripts and styles are inlined under a per-load nonce and the CSP denies
 * everything else, matching the manifest editor. The panel loads no remote
 * resources, so `default-src 'none'` holds.
 */

import * as vscode from 'vscode';
import { getDevToolsStyles } from './webview-styles';
import { getDevToolsScript } from './webview-script';
import { getSharedColorPickerScript } from '../shared/webview-controls';

export function getDevToolsWebviewContent(webview: vscode.Webview, nonce: string): string {
    return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WinUI DevTools</title>
${getDevToolsStyles(nonce)}
</head>
<body>
    <div class="split">
        <div class="pane" id="tree-pane">
            <div class="view-tabs" role="tablist">
                <button id="tab-tree" class="view-tab" role="tab" aria-selected="true"
                        title="Show this app's visual tree">Visual tree</button>
                <button id="tab-comments" class="view-tab" role="tab" aria-selected="false"
                        title="Show this app's UI comments">Comments<span id="comments-badge" class="tab-badge hidden">0</span></button>
            </div>

            <div class="controls" id="tree-controls">
                <button id="btn-pick" class="icon-btn" aria-pressed="false" title="Pick element (Ctrl+Shift+P)" aria-label="Pick element">
                    <span class="glyph" aria-hidden="true">&#xE7C9;</span><span class="on-rule"></span>
                </button>
                <button id="btn-focus" class="icon-btn" aria-pressed="false" title="Track keyboard focus" aria-label="Track keyboard focus">
                    <span class="glyph" aria-hidden="true">&#xE7B3;</span><span class="on-rule"></span>
                </button>
                <input type="search" id="filter" class="filter" placeholder="Filter tree &#x2014; type or #name" aria-label="Filter tree" />
                <button id="btn-layout" class="icon-btn" aria-pressed="false" title="Layout adorners (margin, padding, alignment)" aria-label="Layout adorners">
                    <span class="glyph" aria-hidden="true">&#xE80A;</span><span class="on-rule"></span>
                </button>
                <button id="btn-jmx" class="icon-btn" aria-pressed="true" title="Just my XAML" aria-label="Just my XAML">
                    <span class="glyph" aria-hidden="true">&#xE943;</span><span class="on-rule"></span>
                </button>
            </div>

            <div id="surface" class="surface hidden"></div>

            <div id="focus-notice" class="focus-notice hidden" role="status" aria-live="polite"></div>
            <div id="status" class="status hidden" role="status" aria-live="polite"></div>

            <div id="tree-viewport" class="tree-viewport" role="tree" aria-label="Visual tree" tabindex="0">
                <div id="tree-header" class="tree-header"></div>
                <div id="tree-sizer" class="tree-sizer"></div>
            </div>

            <div id="comments-viewport" class="comments-viewport hidden">
                <div class="comment-compose">
                    <div id="compose-target" class="comment-compose-target"></div>
                    <textarea id="compose-text" class="comment-compose-text" rows="2"
                              placeholder="Leave a note on the selected element"
                              aria-label="New comment"></textarea>
                    <button id="compose-add" type="button" class="pbtn" disabled>Add comment</button>
                    <div id="compose-error" class="comment-compose-error hidden" role="alert"></div>
                </div>
                <div id="comments-host"></div>
            </div>
        </div>

        <div class="pane" id="props-pane">
            <div id="props-header" class="props-header"></div>

            <div id="props-controls" class="props-controls hidden">
                <div class="pview-toggle" role="group" aria-label="Property view">
                    <button id="pview-computed" type="button" class="pview-btn" aria-pressed="true"
                            title="Every property, with one resolved value each: what this element's state IS">Computed</button>
                    <button id="pview-set" type="button" class="pview-btn" aria-pressed="false"
                            title="Only what was written on this element, grouped by where it came from: what you actually SET">Set</button>
                </div>
                <input type="search" id="prop-filter" class="prop-filter"
                       placeholder="Filter properties"
                       title="Show only properties whose name, value or authored text contains this text"
                       aria-label="Filter properties" />
                <span id="prop-count" class="prop-count" aria-live="polite"></span>
            </div>

            <div id="props-viewport" class="props-viewport"></div>
        </div>
    </div>
${getDevToolsScript(nonce)}
    <script nonce="${nonce}">${getSharedColorPickerScript()}</script>
</body>
</html>`;
}
