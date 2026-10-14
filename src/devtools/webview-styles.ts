/**
 * Styles for the WinUI DevTools webview.
 *
 * Everything is expressed in `--vscode-*` custom properties so the panel tracks
 * the active colour theme, including High Contrast, without extra work.
 *
 * Form controls come from `src/shared/webview-controls.ts` so this panel and
 * the manifest editor stay visually identical; only geometry is overridden
 * locally below.
 */

import { getSharedControlStyles } from '../shared/webview-controls';

export function getDevToolsStyles(nonce: string): string {
    return /*html*/`<style nonce="${nonce}">
* { box-sizing: border-box; }

${getSharedControlStyles({
    fieldSelectors: ['.filter', '.prop-filter', '.pfield', '.comment-compose-text', '.pdrop-btn'],
    primaryButtonSelectors: ['.pbtn.primary'],
    secondaryButtonSelectors: ['.pbtn'],
    colorSwatchSelectors: ['.pswatch'],
    includeDropdownMenu: true,
})}

html, body {
    height: 100%;
    margin: 0;
    padding: 0;
    overflow: hidden;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background-color: var(--vscode-editor-background);

    /* Tree column geometry. Fixed by design: the divider is deliberately not
       draggable, because every width a user could drag to that was narrower
       than the floor produced an unreadable tree. */
    --tree-width: 380px;
    --tree-width-min: 300px;

    /* Property name column. Fixed so values form a straight vertical edge — a
       reflowing value column is the defect this replaced — but wide enough for
       the dotted attached-property names that used to truncate to
       "AutomationProperti…". Widens again when there is room for it. */
    --pname-width: 164px;
}

@media (min-width: 900px) {
    html, body { --pname-width: 210px; }
}

body { display: flex; flex-direction: column; }

/* ───────── View tabs (Visual tree / Comments) ─────────
   Mirrors the native window's RadioButton tab strip: a 2px accent rule under
   the selected tab, semibold label, and a pill badge carrying the open-comment
   count that stays hidden at zero so "no comments" reads as absence. */

.view-tabs {
    display: flex;
    gap: 2px;
    margin: 6px 8px 0 8px;
    border-bottom: 1px solid var(--vscode-panel-border);
    flex: 0 0 auto;
}

.view-tab {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 11px 7px 11px;
    border: none;
    border-radius: 4px 4px 0 0;
    background: transparent;
    color: var(--vscode-descriptionForeground);
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
}

.view-tab:hover { background: var(--vscode-toolbar-hoverBackground); }
.view-tab:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }

.view-tab[aria-selected="true"] {
    color: var(--vscode-foreground);
    font-weight: 600;
}

.view-tab[aria-selected="true"]::after {
    content: '';
    position: absolute;
    left: 8px;
    right: 8px;
    bottom: 0;
    height: 2px;
    border-radius: 1px;
    background: var(--vscode-focusBorder);
}

.tab-badge {
    min-width: 18px;
    height: 16px;
    padding: 0 5px;
    border-radius: 8px;
    background: var(--vscode-activityBarBadge-background);
    color: var(--vscode-activityBarBadge-foreground);
    font-size: 10px;
    font-weight: 600;
    line-height: 16px;
    text-align: center;
}

/* ───────── Controls row ───────── */

.controls {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 8px 8px 4px 8px;
    flex: 0 0 auto;
}

/* 32x32 square icon buttons with the native "on" accent rule along the bottom
   edge, which survives High Contrast where a background fill would not. */
.icon-btn {
    position: relative;
    width: 32px;
    height: 32px;
    flex: 0 0 auto;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    color: var(--vscode-foreground);
    cursor: pointer;
}

.icon-btn:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
.icon-btn:disabled { opacity: 0.4; cursor: default; }
.icon-btn:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }

.glyph {
    font-family: 'Segoe Fluent Icons', 'Segoe MDL2 Assets', var(--vscode-font-family);
    font-size: 14px;
    line-height: 1;
}

.on-rule {
    position: absolute;
    left: 50%;
    bottom: 4px;
    width: 16px;
    height: 2px;
    margin-left: -8px;
    border-radius: 1px;
    background: var(--vscode-focusBorder);
    display: none;
}

.icon-btn[aria-pressed="true"] .on-rule { display: block; }

/* Now a wrapper around a shared dropdown, so it carries only layout. */
.surface {
    margin: 0 8px 4px 8px;
    flex: 0 0 auto;
}
.surface .pdrop { display: block; }

.focus-notice {
    margin: 0 8px 4px 8px;
    padding: 6px 8px;
    border-radius: 4px;
    background: var(--vscode-editorWidget-background);
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    flex: 0 0 auto;
}

/* The node-count header above the tree, matching the native caption style. */
.tree-header {
    margin: 4px 4px 10px 4px;
    font-size: 11px;
    letter-spacing: 0.06em;
    color: var(--vscode-descriptionForeground);
}

.comments-viewport {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 8px;
}

.hidden { display: none !important; }

/* Geometry only — colour, border and focus come from the shared controls.
   The filter lives in the .controls row, so it has to be targeted there;
   an earlier .toolbar prefix matched no element and left the input unstyled,
   which is why it rendered with the user agent's white background. */
.controls .filter {
    flex: 1 1 auto;
    min-width: 60px;
}

/* ───────── Status banner ───────── */

.status {
    flex: 0 0 auto;
    padding: 4px 10px;
    font-size: 0.9em;
    border-bottom: 1px solid var(--vscode-panel-border);
}

.status.hidden { display: none; }
.status.info { background: var(--vscode-editorInfo-background, transparent); }
.status.warn {
    background: var(--vscode-inputValidation-warningBackground);
    border-bottom-color: var(--vscode-inputValidation-warningBorder);
}
.status.error {
    background: var(--vscode-inputValidation-errorBackground);
    border-bottom-color: var(--vscode-inputValidation-errorBorder);
}

/* ───────── Split layout ───────── */

.split {
    flex: 1 1 auto;
    display: flex;
    min-height: 0;
}

.pane {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
}

/* The tree pane is a fixed column, not a draggable one. It may shrink to its
   floor when the whole panel is narrow, but never below it — a tree narrower
   than this truncates type names to uselessness. The props pane takes whatever
   is left and is allowed to reach zero, which is what keeps the flex row from
   overflowing the panel and clipping its own content. */
#tree-pane {
    flex: 0 1 var(--tree-width);
    min-width: var(--tree-width-min);
}

#props-pane {
    flex: 1 1 0;
    min-width: 0;
    border: 1px solid var(--vscode-panel-border);
    border-right: none;
    border-bottom: none;
    border-radius: 8px 0 0 0;
    background: var(--vscode-editorWidget-background);
}

/* Below this width the two panes cannot both be usable side by side, so they
   stack instead. Without this the props pane is squeezed to a sliver. */
@media (max-width: 620px) {
    .split { flex-direction: column; }
    #tree-pane {
        flex: 1 1 auto;
        min-width: 0;
        min-height: 180px;
    }
    #props-pane {
        flex: 1 1 auto;
        min-height: 160px;
        border-right: 1px solid var(--vscode-panel-border);
        border-radius: 8px 8px 0 0;
    }
}

.pane-header {
    flex: 0 0 auto;
    padding: 4px 10px;
    font-size: 0.85em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--vscode-descriptionForeground);
    border-bottom: 1px solid var(--vscode-panel-border);
}

/* ───────── Virtualized tree ───────── */

.tree-viewport {
    flex: 1 1 auto;
    overflow-y: auto;
    /* Rows ellipsize instead of scrolling sideways: a horizontal scrollbar
       moves the whole tree off-screen to read one long label, and the label
       is already reachable through the row tooltip. */
    overflow-x: hidden;
    position: relative;
    outline: none;
    padding: 8px;
    font-family: 'Cascadia Mono', Consolas, var(--vscode-editor-font-family), monospace;
    font-size: 12px;
}

/* Sized to the full row count so the scrollbar reflects the whole tree
   while only the visible window is in the DOM. */
.tree-sizer { position: relative; width: 100%; }

.tree-row {
    position: absolute;
    left: 0;
    right: 0;
    height: 22px;
    display: flex;
    align-items: center;
    white-space: nowrap;
    cursor: pointer;
    padding-right: 8px;
}

.tree-row:hover { background: var(--vscode-list-hoverBackground); }
.tree-row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.tree-row.selected .node-name, .tree-row.selected .node-file, .tree-row.selected .node-preview { color: inherit; }

.twisty {
    flex: 0 0 16px;
    width: 16px;
    text-align: center;
    opacity: 0.8;
    user-select: none;
}
.twisty.leaf { visibility: hidden; }

/* Rows never scroll sideways, so every caption part has to be able to shrink;
   without min-width:0 a flex item refuses to go below its text width. */
.node-type { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--vscode-symbolIcon-classForeground, var(--vscode-foreground)); }
.node-name { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; margin-left: 6px; color: var(--vscode-descriptionForeground); }
/* The element's own text, which is usually how a human recognizes the row. */
.node-preview { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; margin-left: 8px; color: var(--vscode-debugTokenExpression-string, var(--vscode-descriptionForeground)); }
.node-file { flex: 0 0 auto; margin-left: 8px; font-size: 0.85em; opacity: 0.6; }

.tree-empty, .props-empty {
    padding: 12px 10px;
    color: var(--vscode-descriptionForeground);
}

/* ───────── Property grid ─────────
   Mirrors the native window's row metrics: a 14px chevron column, a FIXED
   126px monospace name column so values form a straight vertical edge, and a
   star value column. The fixed width is load-bearing — a reflowing row is the
   defect it was chosen to fix. */

.props-header {
    flex: 0 0 auto;
    padding: 12px 14px 0 14px;
}

.props-header:empty { padding: 0; }

.props-controls {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
}

/* Segmented Computed/Set switch, matching the native toggle pair. */
.pview-toggle { display: inline-flex; flex: 0 0 auto; }

.pview-btn {
    padding: 3px 10px;
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    background: transparent;
    color: var(--vscode-descriptionForeground);
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
}
.pview-btn:first-child { border-radius: 4px 0 0 4px; }
.pview-btn:last-child { border-radius: 0 4px 4px 0; margin-left: -1px; }
.pview-btn:hover:not(.active) { background: var(--vscode-toolbar-hoverBackground); }
.pview-btn:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; z-index: 1; }
.pview-btn.active {
    background: var(--vscode-inputOption-activeBackground);
    border-color: var(--vscode-inputOption-activeBorder);
    color: var(--vscode-inputOption-activeForeground);
}

.prop-filter { flex: 1 1 auto; min-width: 0; }

.prop-count {
    flex: 0 0 auto;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
}

.props-viewport {
    flex: 1 1 auto;
    overflow: auto;
    padding: 0 14px 14px 14px;
}

.prop-source {
    padding: 0 0 8px 0;
    margin-bottom: 6px;
    border-bottom: 1px solid var(--vscode-panel-border);
}

/* Group heading. A label, not a control: categories no longer collapse, so it
   carries no caret, no hover affordance and no focus ring. */
.pgroup {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    margin: 10px 0 3px 0;
    padding: 2px 4px;
    border: none;
    background: transparent;
    color: var(--vscode-descriptionForeground);
    font-family: inherit;
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    text-align: left;
}

.pgroup-count {
    margin-left: auto;
    font-size: 10px;
    opacity: 0.75;
}

/* The "Show all N properties" escape hatch, styled as a link rather than a
   button so it reads as secondary to the rows above it. */
.plink {
    display: inline-block;
    margin: 10px 0 0 4px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--vscode-textLink-foreground);
    font-family: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
}
.plink:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
.plink:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }

.prow-line {
    display: grid;
    grid-template-columns: 14px var(--pname-width) 1fr;
    column-gap: 8px;
    min-height: 22px;
    padding: 1px 4px;
    align-items: center;
}

.prow-line:hover { background: var(--vscode-list-hoverBackground); }

.pchevron {
    width: 14px;
    height: 18px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--vscode-foreground);
    font-family: 'Segoe Fluent Icons', 'Segoe MDL2 Assets', var(--vscode-font-family);
    font-size: 8px;
    cursor: pointer;
    transition: transform 100ms linear;
}
.pchevron.leaf { visibility: hidden; }
.pchevron.open { transform: rotate(90deg); }
.pchevron:focus-visible { outline: 1px solid var(--vscode-focusBorder); }

.pname {
    font-family: Consolas, 'Cascadia Mono', monospace;
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.pvalue-cell { display: flex; align-items: center; min-width: 0; }

/* Status only — kept outside the value button so assistive tech cannot turn
   the changed marker into the button's action. */
.pdot {
    margin: 0 5px 0 2px;
    font-size: 10px;
    color: var(--vscode-charts-blue, var(--vscode-focusBorder));
}

.pvalue {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 22px;
    padding: 0 2px;
    border: none;
    background: transparent;
    color: var(--vscode-foreground);
    font-family: Consolas, 'Cascadia Mono', monospace;
    font-size: 12px;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
}
.pvalue:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }

/* The expansion card: a 2px accent stroke on the leading edge rather than a
   fill, so it survives High Contrast. */
.pexpand {
    margin: 1px 0 6px 22px;
    padding: 7px 9px 8px 9px;
    border-left: 2px solid var(--vscode-focusBorder);
    border-radius: 0 4px 4px 0;
    background: var(--vscode-editorWidget-background);
}

.pcap {
    margin: 0 0 3px 0;
    font-size: 10px;
    letter-spacing: 0.06em;
    color: var(--vscode-descriptionForeground);
}
.pcap.spaced { margin-top: 10px; }

/* Monospace and height only — the rest comes from the shared field styling. */
.pfield {
    width: 100%;
    min-height: 30px;
    font-family: Consolas, 'Cascadia Mono', monospace;
    font-size: 12px;
}

select.pfield { font-family: var(--vscode-font-family); }

/* Padding only — colour and focus come from the shared button styling. */
.pbtn { padding: 4px 10px; }
.prow-actions { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }

/* Colour editor: swatch + hex field + optional preset list. */
.pcolor { display: grid; grid-template-columns: auto 1fr; column-gap: 7px; align-items: center; }
/* .pswatch sizing and border come from the shared controls module. */

/* Value picker built on the shared dropdown. The trigger is styled as a
   field (see fieldSelectors) so it matches the inputs it sits beside. */
.pdrop { display: block; }
.pdrop-btn {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    width: 100%;
    text-align: left;
    cursor: pointer;
}
.pdrop-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pdrop-chev { flex: 0 0 auto; opacity: 0.7; font-size: 10px; }
.pdrop .custom-dropdown-menu {
    left: 0;
    right: 0;
    min-width: 0;
    max-height: 260px;
    overflow-y: auto;
}

.pfields { display: flex; gap: 6px; flex-wrap: wrap; }
.pfields .pfield { width: 72px; min-width: 0; }

.pnote {
    margin-top: 3px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
}

/* Staged edit: a caution stroke, never a fill. */
.pstaged {
    margin-top: 8px;
    padding: 6px 8px 7px 8px;
    border-left: 2px solid var(--vscode-editorWarning-foreground);
    border-radius: 0 4px 4px 0;
}
.pstaged-head { font-size: 11px; font-weight: 600; }
.pstaged-body { font-size: 11px; color: var(--vscode-descriptionForeground); }

/* Binding diagnosis block. */
.pbind-grid {
    display: grid;
    grid-template-columns: 88px 1fr;
    column-gap: 8px;
    row-gap: 4px;
    font-size: 12px;
}
.pbind-key { color: var(--vscode-descriptionForeground); }
.pbind-bad { color: var(--vscode-errorForeground); }
.pwalk {
    margin-top: 4px;
    padding: 3px 0 3px 7px;
    border-left: 1px solid var(--vscode-panel-border);
    font-size: 11px;
}

/* Provenance witnesses. Each is a leading hairline, matching the native
   "the app's source" / "DevTools, this session" / precedence-chain blocks. */
.pwit {
    margin-bottom: 4px;
    padding: 4px 0 4px 7px;
    border-left: 1px solid var(--vscode-panel-border);
}
.pwit.session { border-left-color: var(--vscode-descriptionForeground); }
.pwit-who { font-size: 10px; color: var(--vscode-descriptionForeground); }
.pwit-text {
    font-family: Consolas, 'Cascadia Mono', monospace;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    white-space: pre-wrap;
}
.pwit-note { font-size: 10px; font-style: italic; color: var(--vscode-descriptionForeground); }

.link {
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    text-decoration: none;
    background: none;
    border: none;
    padding: 0;
    font-family: inherit;
    font-size: inherit;
}
.link:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
.link:focus-visible { outline: 1px solid var(--vscode-focusBorder); }

.badge {
    display: inline-block;
    margin-left: 6px;
    padding: 0 4px;
    border-radius: 2px;
    font-size: 0.8em;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
}

/* Value-precedence chain, winner first. Losing entries are struck through the
   same way a browser shows an overridden declaration. */
.chain { margin: 2px 0 0 0; padding: 0; list-style: none; }
.chain li { font-size: 11px; font-family: Consolas, 'Cascadia Mono', monospace; color: var(--vscode-descriptionForeground); }
.chain li.loser { text-decoration: line-through; opacity: 0.7; }
.chain li.winner { color: var(--vscode-foreground); }

/* ───────── Comments ───────── */

.comment {
    margin-bottom: 8px;
    padding: 8px 10px;
    border-left: 2px solid var(--vscode-focusBorder);
    border-radius: 0 4px 4px 0;
    background: var(--vscode-editorWidget-background);
}
.comment.resolved { border-left-color: var(--vscode-charts-green, var(--vscode-descriptionForeground)); opacity: 0.75; }
.comment.stale { border-left-color: var(--vscode-editorWarning-foreground); }
.comment-el { font-family: Consolas, 'Cascadia Mono', monospace; font-size: 11px; color: var(--vscode-descriptionForeground); }
.comment-text { margin: 4px 0; white-space: pre-wrap; font-size: 12px; }
.comment-meta { font-size: 10px; color: var(--vscode-descriptionForeground); }
.comment-source {
    margin-top: 4px;
    padding: 0;
    border: none;
    background: none;
    font: inherit;
    font-size: 10px;
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    text-align: left;
}
.comment-source:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
.comment-actions { display: flex; gap: 6px; margin-top: 6px; }

.comment-compose {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 12px;
    padding: 8px 10px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
}
.comment-compose-target {
    font-family: Consolas, 'Cascadia Mono', monospace;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
}
.comment-compose-error {
    font-size: 11px;
    color: var(--vscode-errorForeground);
}
.comment-compose-text {
    width: 100%;
    resize: vertical;
    font-size: 12px;
}
.comment-compose .pbtn { align-self: flex-start; }
.comment-compose .pbtn[disabled] { opacity: 0.5; cursor: default; }

.pbtn.needs-confirm { border-color: var(--vscode-editorWarning-foreground); }

/* Nested box model, laid out the way the in-app adorner draws it: a margin
   rect around a padding rect around the content rect, with each rect's four
   edge values sitting on the edge they describe. The side padding is what
   reserves room for those numbers. */
.lay-box {
    margin: 2px 0 10px 0;
    padding: 8px 9px;
    border: 1px dashed var(--vscode-panel-border);
    border-radius: 4px;
}
.lay-ring {
    position: relative;
    padding: 18px 26px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 3px;
}
.lay-ring.margin { border-color: #F2A03D; }
.lay-ring.padding { border-color: #3FBF6F; }
.lay-tag {
    position: absolute;
    top: 2px;
    left: 5px;
    font-size: 9px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
}
.lay-edge {
    position: absolute;
    font-family: Consolas, 'Cascadia Mono', monospace;
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
}
.lay-edge.top { top: 3px; left: 50%; transform: translateX(-50%); }
.lay-edge.bottom { bottom: 3px; left: 50%; transform: translateX(-50%); }
.lay-edge.left { left: 5px; top: 50%; transform: translateY(-50%); }
.lay-edge.right { right: 5px; top: 50%; transform: translateY(-50%); }
.lay-core {
    padding: 10px 6px;
    text-align: center;
    font-family: Consolas, 'Cascadia Mono', monospace;
    font-size: 11px;
    border: 1px solid var(--vscode-focusBorder);
    border-radius: 3px;
}
.lay-facts { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin-top: 8px; font-size: 11px; }
.lay-facts dt { color: var(--vscode-descriptionForeground); }
.lay-facts dd { margin: 0; font-family: Consolas, 'Cascadia Mono', monospace; }

/* Identity header: what the selection is, then how you got to it. */
.props-identity { margin-bottom: 6px; }
.props-identity:empty { display: none; }

.props-badge {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-size: 13px;
    font-weight: 600;
    color: var(--vscode-foreground);
}
.props-name {
    font-family: Consolas, 'Cascadia Mono', monospace;
    font-size: 12px;
    font-weight: 400;
    color: var(--vscode-descriptionForeground);
}

.props-crumbs {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 2px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
}
.props-crumb-trail { word-break: break-word; }
.props-crumb-toggle {
    border: none;
    padding: 0;
    background: transparent;
    color: var(--vscode-textLink-foreground);
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
    white-space: nowrap;
}
.props-crumb-toggle:hover { text-decoration: underline; }
.props-crumb-toggle:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }

.redacted { font-style: italic; opacity: 0.7; }
</style>`;
}
