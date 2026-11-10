/**
 * Webview script fragment: the property grid.
 *
 * Covers curation into categories, the identity header and ancestor
 * breadcrumb, the margin/padding/content layout box and the rendering of
 * individual property rows. The editors those rows host live in the editors
 * fragment.
 */

export const PROPERTIES_FRAGMENT = `
    // ───────────────────────── property grid ─────────────────────────

    /* ── Curation helpers (ports of the native predicates) ── */

    function isCoreProp(name) { return CORE_PROPS.has(name); }

    /** Native SourceIsSetHere: written on this element, not inherited. */
    function sourceIsSetHere(source) {
        return source === 'Local' || source === 'Binding';
    }

    function isAuthored(prop) {
        return !!(prop.authoredKind && String(prop.authoredKind).length > 0);
    }

    /** Native OnlySetKeeps: a no-op outside the Set view. */
    function onlySetKeeps(prop) {
        if (state.propView !== 'set') { return true; }
        return sourceIsSetHere(prop.valueSource) || isAuthored(prop)
            || STYLE_SOURCES.has(prop.valueSource);
    }

    /** Native PropRowIsRendered. Order of the clauses is load-bearing. */
    function propRowIsRendered(prop) {
        if (!onlySetKeeps(prop)) { return false; }
        if (state.propView === 'set' || state.propShowAll || state.propFilter) { return true; }
        return isCoreProp(prop.name) || sourceIsSetHere(prop.valueSource) || isAuthored(prop);
    }

    /** The haystack the property filter searches: name, value and authored text. */
    function propLabel(prop) {
        return (String(prop.name || '') + ' ' + String(prop.value || '') + ' '
            + String(prop.authored || '')).toLowerCase();
    }

    function propMatchesFilter(prop) {
        if (!state.propFilter) { return true; }
        return propLabel(prop).indexOf(state.propFilter) !== -1;
    }

    /** Native PropGroupIndex. Unknown names, including attached properties
        such as AutomationProperties.*, fall through to "Other". */
    function propGroupIndex(prop) {
        if (state.propView === 'set') {
            return STYLE_SOURCES.has(prop.valueSource) && !isAuthored(prop) ? 1 : 0;
        }
        for (let i = 0; i < PROP_GROUPS.length - 1; i++) {
            if (PROP_GROUPS[i].names.has(prop.name)) { return i; }
        }
        return PROP_GROUPS.length - 1;
    }

    function groupTitle(index) {
        if (state.propView === 'set') { return SET_VIEW_GROUPS[index]; }
        return PROP_GROUPS[index].title;
    }

    function groupCount() { return state.propView === 'set' ? 2 : PROP_GROUPS.length; }

    /** Core first, then alphabetical within each partition. */
    function compareProps(a, b) {
        const ca = isCoreProp(a.name);
        const cb = isCoreProp(b.name);
        if (ca !== cb) { return ca ? -1 : 1; }
        return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    }

    /** True while the grid is rebuilt, so replaced editors do not commit. */
    let propsRendering = false;
    /** The element the grid currently shows, so a draft knows where it belongs. */
    let renderedHandle = null;

    /**
     * Rebuilds the grid. A half-typed value survives a rebuild of the same
     * element, and is saved to its own element when the selection moves on.
     */
    function renderProperties() {
        // Rebuilding would destroy an open menu under the pointer; redraw once it closes.
        if (((openDrop && el.propsViewport.contains(openDrop.root)) || document.querySelector('.wcp-pop'))
            && state.properties && state.properties.handle === renderedHandle) {
            propsRenderPending = true;
            return;
        }
        propsRenderPending = false;
        const active = document.activeElement;
        const draft = active && active.dataset && active.dataset.draft
            && el.propsViewport.contains(active) && renderedHandle
            ? {
                handle: renderedHandle,
                prop: active.dataset.draft,
                value: active.value,
                values: Array.from(el.propsViewport.querySelectorAll('[data-draft]'))
                    .filter(function (box) {
                        return (box.dataset.draftGroup || box.dataset.draft)
                            === (active.dataset.draftGroup || active.dataset.draft);
                    })
                    .map(function (box) { return { key: box.dataset.draft, value: box.value }; }),
                committed: active.dataset.committed === '1',
                save: active.saveDraft,
                start: active.selectionStart,
                end: active.selectionEnd,
            }
            : null;

        propsRendering = true;
        try {
            renderPropertiesNow();
        } finally {
            propsRendering = false;
        }
        const handle = state.properties && state.properties.handle;
        renderedHandle = handle || null;

        if (!draft) { return; }
        if (handle !== draft.handle) {
            if (!draft.committed && draft.save) { draft.save(draft.value); }
            return;
        }
        const boxes = el.propsViewport.querySelectorAll('[data-draft]');
        if (!draft.committed) {
            for (const box of Array.from(boxes)) {
                const saved = draft.values.find(function (value) { return value.key === box.dataset.draft; });
                if (saved) { box.value = saved.value; }
            }
        }
        for (const box of Array.from(boxes)) {
            if (box.dataset.draft !== draft.prop) { continue; }
            // A committed value is the app's to report back, not ours to keep.
            // Carry the flag so the stale box is not later restored as a draft.
            if (!draft.committed) { box.value = draft.value; } else { box.dataset.committed = '1'; }
            box.focus();
            if (draft.committed) { break; }
            try { box.setSelectionRange(draft.start, draft.end); } catch (e) { /* not a text box */ }
            break;
        }

    }

    document.addEventListener('colorclosed', function () {
        if (propsRenderPending) { renderProperties(); }
    });

    function renderPropertiesNow() {
        el.propsHeader.textContent = '';
        el.propsViewport.textContent = '';
        const payload = state.properties;

        if (!payload || payload.error) {
            el.propsControls.classList.add('hidden');
            const empty = document.createElement('div');
            empty.className = 'props-empty';
            empty.textContent = payload && payload.error
                ? payload.error
                : 'Select an element to inspect its properties.';
            el.propsViewport.appendChild(empty);
            return;
        }

        el.propsHeader.appendChild(buildPropsIdentity());

        if (payload.source && payload.source.file) {
            el.propsHeader.appendChild(buildSourceLink(payload.source));
        }

        // The adorner itself is drawn over the live app; this is the numeric
        // half of it, which the in-app overlay cannot show without covering
        // the very layout it is describing.
        if (state.layoutOn && state.layout && state.layout.handle === state.selected) {
            el.propsHeader.appendChild(buildLayoutBox(state.layout, payload));
        }

        const all = payload.props || [];
        if (all.length === 0) {
            el.propsControls.classList.add('hidden');
            const empty = document.createElement('div');
            empty.className = 'props-empty';
            empty.textContent = 'This element reported no properties.';
            el.propsViewport.appendChild(empty);
            return;
        }

        el.propsControls.classList.remove('hidden');
        syncPropControls();

        let shown = 0;
        for (let g = 0; g < groupCount(); g++) {
            const members = all.filter(function (prop) {
                return propGroupIndex(prop) === g
                    && propMatchesFilter(prop)
                    && propRowIsRendered(prop);
            });
            if (members.length === 0) { continue; }
            members.sort(compareProps);
            shown += members.length;
            el.propsViewport.appendChild(buildPropGroup(groupTitle(g), members, payload));
        }

        if (shown === 0) {
            const empty = document.createElement('div');
            empty.className = 'props-empty';
            empty.textContent = state.propFilter
                ? 'No property matches this filter.'
                : 'Nothing is set on this element.';
            el.propsViewport.appendChild(empty);
        }

        el.propCount.textContent = shown + (shown === 1 ? ' property' : ' properties');
        el.propsViewport.appendChild(buildShowAllLink(all.length));
    }

    /** A collapsible group header plus its rows. */
    /**
     * Category headings are labels, not expanders. Every category stays open:
     * with a caret on each property row as well, a second level of carets read
     * as clutter without buying anything — the categories are short and the
     * filter already narrows the list.
     */
    function buildPropGroup(title, members, payload) {
        const section = document.createElement('div');
        section.className = 'pgroup-section';

        const head = document.createElement('div');
        head.className = 'pgroup';
        head.setAttribute('role', 'heading');
        head.setAttribute('aria-level', '3');

        const label = document.createElement('span');
        label.textContent = title;
        head.appendChild(label);

        const count = document.createElement('span');
        count.className = 'pgroup-count';
        count.textContent = String(members.length);
        head.appendChild(count);

        section.appendChild(head);

        const body = document.createElement('div');
        body.className = 'pgroup-body';
        for (const prop of members) {
            const rows = [];
            flattenProps([prop], 0, rows);
            for (const entry of rows) {
                body.appendChild(buildPropRow(entry.prop, entry.depth, payload));
            }
        }
        section.appendChild(body);

        return section;
    }

    /** The native's "Show all N properties" / "Show common properties only". */
    function buildShowAllLink(total) {
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'plink';
        link.textContent = state.propShowAll
            ? 'Show common properties only'
            : 'Show all ' + total + ' properties';
        link.addEventListener('click', function () {
            state.propShowAll = !state.propShowAll;
            persist();
            renderProperties();
        });
        return link;
    }

    function syncPropControls() {
        const set = state.propView === 'set';
        el.pviewComputed.setAttribute('aria-pressed', set ? 'false' : 'true');
        el.pviewSet.setAttribute('aria-pressed', set ? 'true' : 'false');
        el.pviewComputed.classList.toggle('active', !set);
        el.pviewSet.classList.toggle('active', set);
    }

    function setPropView(view) {
        if (state.propView === view) { return; }
        state.propView = view;
        persist();
        renderProperties();
    }

    function flattenProps(props, depth, out, parent) {
        for (const raw of props) {
            const prop = parent ? Object.assign({}, raw, { parent: parent }) : raw;
            out.push({ prop: prop, depth: depth });
            if (prop.children && prop.children.length) {
                flattenProps(prop.children, depth + 1, out, rowKey(prop));
            }
        }
    }

    /** Sub-property rows (a brush's Color) are keyed by path so they never collide with the element's own. */
    function rowKey(prop) {
        return prop.parent ? prop.parent + '.' + prop.name : prop.name;
    }

    function isResourceAuthored(prop) {
        return prop.authoredKind === 'staticResource' || prop.authoredKind === 'themeResource';
    }

    function size(value) {
        if (!value) { return '-'; }
        return num(value.w) + ' \\u00D7 ' + num(value.h);
    }

    function point(value) {
        if (!value) { return '-'; }
        return num(value.x) + ', ' + num(value.y);
    }

    function num(value) {
        if (value === undefined || value === null) { return '-'; }
        return String(Math.round(value * 100) / 100);
    }

    /**
     * Box model, named and measured the way the in-app adorner draws it:
     * an outer margin rect, the element's own border box, and the content
     * rect left after padding is taken off.
     *
     * Layout.get reports sizes and offsets but carries no margin or padding
     * of its own (only the *parent's* padding), so those two come from the
     * element's Margin/Padding properties, which is the same pair the native
     * adorner reads before mapping its rects.
     */
    function buildLayoutBox(layout, payload) {
        const box = document.createElement('div');
        box.className = 'lay-box';

        const margin = thicknessOf(payload, 'Margin');
        const padding = thicknessOf(payload, 'Padding');
        const border = layout.actual || layout.render || null;

        const marginRing = ring('margin', margin);
        const paddingRing = ring('padding', padding);

        const core = document.createElement('div');
        core.className = 'lay-core';
        const content = border
            ? { w: border.w - padding[0] - padding[2], h: border.h - padding[1] - padding[3] }
            : null;
        const contentLabel = content ? size(content) : '-';
        core.textContent = 'content ' + contentLabel;
        core.setAttribute('aria-label', 'Content size ' + contentLabel);

        paddingRing.appendChild(core);
        marginRing.appendChild(paddingRing);
        box.appendChild(marginRing);

        const facts = document.createElement('dl');
        facts.className = 'lay-facts';
        if (border) { fact(facts, 'Border box', size(border)); }
        fact(facts, 'Desired', size(layout.desired));
        fact(facts, 'Offset', point(layout.offset));
        if (layout.parent) {
            const p = layout.parent;
            fact(facts, 'Parent', shortTypeName(p.type) + ' ' + size({ w: p.w, h: p.h }));
            if (p.orientation) { fact(facts, 'Orientation', p.orientation); }
            if (p.spacing) { fact(facts, 'Spacing', p.spacing); }
            if (p.padding) { fact(facts, 'Parent padding', p.padding); }
            if (p.childCount !== undefined) {
                fact(facts, 'Child', (Number(p.childIndex) + 1) + ' of ' + p.childCount);
            }
        }
        if (layout.grid) {
            const g = layout.grid;
            fact(facts, 'Grid cell', 'row ' + (g.row || '0') + ', column ' + (g.column || '0'));
            if (g.rowSpan || g.columnSpan) {
                fact(facts, 'Grid span', (g.rowSpan || '1') + ' \\u00D7 ' + (g.columnSpan || '1'));
            }
        }
        box.appendChild(facts);
        const why = layoutExplanation(layout, payload);
        if (why) {
            const text = document.createElement('div');
            text.className = 'lay-why';
            text.textContent = why;
            box.appendChild(text);
        }
        return box;
    }

    function numericProp(payload, name) {
        const prop = ((payload && payload.props) || []).find(function (p) { return p.name === name; });
        const value = prop ? Number(String(prop.value).trim()) : NaN;
        return isFinite(value) ? value : NaN;
    }

    /** Plain-language reason the element is not the size it asked for, as the native adorner explains it. */
    function layoutExplanation(layout, payload) {
        const actual = layout.actual || layout.render;
        if (!actual) { return ''; }
        const lines = [];
        const axes = [
            { key: 'w', size: 'Width', max: 'MaxWidth', word: 'wide', parent: layout.parent && layout.parent.w },
            { key: 'h', size: 'Height', max: 'MaxHeight', word: 'tall', parent: layout.parent && layout.parent.h },
        ];
        for (const axis of axes) {
            const got = Number(actual[axis.key]);
            if (!isFinite(got)) { continue; }
            const asked = numericProp(payload, axis.size);
            const cap = numericProp(payload, axis.max);
            const wanted = layout.desired ? Number(layout.desired[axis.key]) : NaN;
            if (isFinite(asked) && got < asked - 0.5) {
                let reason = 'layout gave it less room';
                if (isFinite(cap) && cap < asked) { reason = axis.max + ' caps it at ' + num(cap); }
                else if (isFinite(axis.parent) && axis.parent < asked) {
                    reason = 'the parent ' + shortTypeName(layout.parent.type) + ' is only ' + num(axis.parent) + ' ' + axis.word;
                }
                lines.push('Asked for ' + num(asked) + ' ' + axis.word + ', got ' + num(got) + ': ' + reason + '.');
            } else if (!isFinite(asked) && isFinite(wanted) && wanted > got + 0.5) {
                lines.push('Its content wants ' + num(wanted) + ' ' + axis.word + ' but only gets ' + num(got)
                    + ', so it is clipped. Give it more ' + (axis.key === 'w' ? 'width' : 'height') + ' or let the content wrap.');
            }
        }
        return lines.join(' ');
    }

    /** One labelled rect of the box model, with its four edge values. */
    function ring(name, edges) {
        const node = document.createElement('div');
        node.className = 'lay-ring ' + name;

        const label = document.createElement('div');
        label.className = 'lay-tag';
        label.textContent = name;
        node.appendChild(label);

        const sides = ['top', 'right', 'bottom', 'left'];
        // thickness order is left, top, right, bottom.
        const bySide = [edges[1], edges[2], edges[3], edges[0]];
        for (let i = 0; i < sides.length; i++) {
            const edge = document.createElement('div');
            edge.className = 'lay-edge ' + sides[i];
            edge.textContent = num(bySide[i]);
            edge.setAttribute('aria-label', name + ' ' + sides[i] + ' ' + num(bySide[i]));
            node.appendChild(edge);
        }
        return node;
    }

    /**
     * XAML thickness, as left, top, right, bottom. Accepts the one-, two- and
     * four-number forms; anything unparseable reads as zero so the diagram
     * still renders rather than collapsing.
     */
    function parseThickness(value) {
        const parts = String(value === undefined || value === null ? '' : value)
            .split(',')
            .map(function (p) { return Number(p.trim()); })
            .filter(function (n) { return isFinite(n); });
        if (parts.length === 1) { return [parts[0], parts[0], parts[0], parts[0]]; }
        if (parts.length === 2) { return [parts[0], parts[1], parts[0], parts[1]]; }
        if (parts.length === 4) { return parts; }
        return [0, 0, 0, 0];
    }

    function thicknessOf(payload, name) {
        const props = (payload && payload.props) || [];
        for (const prop of props) {
            if (prop.name === name) { return parseThickness(prop.value); }
        }
        return [0, 0, 0, 0];
    }

    /**
     * Who you are looking at: the element's type, its name when it has one,
     * and the chain of ancestors that leads to it. The native window puts this
     * above the list because a property grid on its own is ambiguous -- half a
     * dozen Borders in a page look identical until you can see their parents.
     */
    function buildPropsIdentity() {
        const host = document.createElement('div');
        host.className = 'props-identity';

        const node = nodeForHandle(state.selected);
        if (!node) { return host; }

        const badge = document.createElement('div');
        badge.className = 'props-badge';

        const type = document.createElement('span');
        type.className = 'props-type';
        type.textContent = shortTypeName(node.type);
        badge.appendChild(type);

        if (node.name) {
            const name = document.createElement('span');
            name.className = 'props-name';
            name.textContent = '#' + node.name;
            badge.appendChild(name);
        }
        host.appendChild(badge);

        const path = ancestorPath(state.selected);
        if (path.length) { host.appendChild(buildBreadcrumb(path)); }
        return host;
    }

    /** Ancestors of a handle, outermost first, excluding the element itself. */
    function ancestorPath(handle) {
        let found = null;

        function walk(node, trail) {
            if (found) { return; }
            if (node.handle === handle) { found = trail; return; }
            const next = trail.concat(node);
            for (const child of node.children || []) { walk(child, next); }
        }

        for (const root of state.roots) { walk(root, []); }
        return found || [];
    }

    function crumbLabel(node) {
        return shortTypeName(node.type) + (node.name ? ' #' + node.name : '');
    }

    /**
     * Long chains are elided to first, last two. The full path is one click
     * away rather than permanently eating the top of the pane.
     */
    function buildBreadcrumb(path) {
        const host = document.createElement('div');
        host.className = 'props-crumbs';

        const expanded = state.crumbFor === state.selected && state.crumbOpen;
        const visible = (expanded || path.length <= 4)
            ? path.map(crumbLabel)
            : [crumbLabel(path[0]), '\\u2026',
                crumbLabel(path[path.length - 2]), crumbLabel(path[path.length - 1])];

        const trail = document.createElement('span');
        trail.className = 'props-crumb-trail';
        trail.textContent = visible.join(' \\u203A ');
        trail.title = path.map(crumbLabel).join(' \\u203A ');
        host.appendChild(trail);

        if (path.length > 4) {
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'props-crumb-toggle';
            toggle.textContent = expanded
                ? 'Show less'
                : 'Show all ' + path.length + ' ancestors';
            toggle.addEventListener('click', function () {
                state.crumbFor = state.selected;
                state.crumbOpen = !expanded;
                renderProperties();
            });
            host.appendChild(toggle);
        }
        return host;
    }

    function fact(list, label, value) {
        const dt = document.createElement('dt');
        dt.textContent = label;
        const dd = document.createElement('dd');
        dd.textContent = value;
        list.appendChild(dt);
        list.appendChild(dd);
    }

    function buildSourceLink(source) {
        const wrapper = document.createElement('div');
        wrapper.className = 'prop-source';

        const label = document.createElement('span');
        label.textContent = 'Declared in ';
        wrapper.appendChild(label);

        const link = document.createElement('button');
        link.className = 'link';
        link.type = 'button';
        link.textContent = fileLabel(source.file) + (source.line ? ':' + source.line : '');
        link.title = source.file;
        link.addEventListener('click', function () {
            vscode.postMessage({
                type: 'goToSource',
                file: source.file,
                line: source.line,
                column: source.column,
            });
        });
        wrapper.appendChild(link);

        // Recovery lives next to the link that can fail, not in a far-off status.
        const reveal = document.createElement('button');
        reveal.type = 'button';
        reveal.className = 'link prop-source-action';
        reveal.textContent = 'Reveal';
        reveal.setAttribute('aria-label', 'Reveal source file in File Explorer');
        reveal.addEventListener('click', function () {
            vscode.postMessage({ type: 'revealSource', file: source.file });
        });
        wrapper.appendChild(reveal);

        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'link prop-source-action';
        copy.textContent = 'Copy path';
        copy.setAttribute('aria-label', 'Copy path of source file');
        copy.addEventListener('click', function () {
            vscode.postMessage({ type: 'copySourcePath', file: source.file });
        });
        wrapper.appendChild(copy);
        return wrapper;
    }

    /**
     * One property row, matching the native window's 14/126/star grid. The name
     * column is deliberately fixed-width so every value starts on the same
     * vertical edge; letting it reflow is the defect that width was chosen to
     * fix. The expansion card below the row carries everything else.
     */
    function buildPropRow(prop, depth, payload) {
        const wrap = document.createElement('div');
        wrap.className = 'prow';
        wrap.dataset.prop = rowKey(prop);

        const line = document.createElement('div');
        line.className = 'prow-line';
        line.style.paddingLeft = (4 + depth * INDENT_PX) + 'px';

        const open = state.openProps.has(rowKey(prop));
        // A live write from any client (this panel, the CLI) counts as a change, not only ours.
        const edited = !prop.parent && (isEdited(payload.handle, prop.name) || prop.valueSource === 'DevTools');
        const toggle = function () { togglePropExpand(prop, payload); };

        // Decorative: the value button below is the one keyboard stop and
        // carries aria-expanded, so the caret must not be a second control.
        const chevron = document.createElement('span');
        chevron.className = 'pchevron' + (open ? ' open' : '');
        chevron.textContent = '\\uE76C';
        chevron.setAttribute('aria-hidden', 'true');
        line.appendChild(chevron);

        const name = document.createElement('span');
        name.className = 'pname';
        name.title = prop.name;
        name.textContent = prop.name;
        if (prop.binding) {
            const badge = document.createElement('span');
            badge.className = 'badge';
            badge.textContent = 'binding';
            badge.title = prop.binding;
            name.appendChild(badge);
        }
        line.appendChild(name);

        const cell = document.createElement('div');
        cell.className = 'pvalue-cell';

        // The changed marker is a sibling of the button, never inside it, so
        // assistive tech does not read status as part of the action.
        const dot = document.createElement('span');
        dot.className = 'pdot';
        dot.textContent = '\\u25CF';
        dot.setAttribute('aria-hidden', 'true');
        if (!edited) { dot.classList.add('hidden'); }
        cell.appendChild(dot);

        const value = document.createElement('button');
        value.type = 'button';
        value.className = 'pvalue';
        if (prop.redacted) {
            value.classList.add('redacted');
            value.textContent = '(value hidden)';
        } else {
            value.textContent = prop.value;
            value.title = prop.value;
        }
        // The focus announcement has to carry the value, not just the name.
        value.setAttribute('aria-label', prop.name + ': '
            + (prop.redacted ? 'value hidden' : (String(prop.value || '') || 'empty'))
            + (prop.binding ? ', bound to ' + prop.binding : '')
            + (edited ? ', changed' : ''));
        value.setAttribute('aria-expanded', open ? 'true' : 'false');
        cell.appendChild(value);
        line.appendChild(cell);

        // The whole header row expands, matching the native window.
        line.addEventListener('click', toggle);

        wrap.appendChild(line);

        if (open) { wrap.appendChild(buildExpansion(prop, payload)); }
        return wrap;
    }

    function editKey(handle, name) { return String(handle) + '|' + name; }

    function isEdited(handle, name) {
        return Object.prototype.hasOwnProperty.call(state.edited, editKey(handle, name));
    }

    /**
     * Remembers what a property was before its first edit. Bounded, oldest
     * first, so a long session of selecting and editing cannot grow forever.
     */
    function recordOriginal(handle, prop) {
        const key = editKey(handle, prop.name);
        if (Object.prototype.hasOwnProperty.call(state.edited, key)) { return; }
        state.edited[key] = {
            value: prop.value,
            wasSet: sourceIsSetHere(prop.valueSource) || isAuthored(prop),
        };
        const keys = Object.keys(state.edited);
        for (let i = 0; i < keys.length - MAX_EDITED; i++) { delete state.edited[keys[i]]; }
    }

    /**
     * Puts the pre-edit value back. A property that was never set locally is
     * cleared instead, so it falls back to its style or default again.
     */
    function restoreOriginal(handle, prop) {
        const key = editKey(handle, prop.name);
        const record = state.edited[key];
        if (!record) { return; }
        delete state.edited[key];
        if (record.wasSet) {
            vscode.postMessage({
                type: 'setProperty',
                handle: handle,
                name: prop.name,
                value: String(record.value),
                writeType: prop.writeType || prop.valueType,
            });
        } else {
            vscode.postMessage({ type: 'clearProperty', handle: handle, name: prop.name });
        }
        renderProperties();
    }

    function clearValue(handle, prop) {
        recordOriginal(handle, prop);
        state.clearing[editKey(handle, prop.name)] = prop.valueSource || '';
        vscode.postMessage({ type: 'clearProperty', handle: handle, name: prop.name });
        renderProperties();
    }

    /** Clearing a binding deletes it, and clearing an unset value does nothing. */
    function canClear(prop, payload) {
        const kind = activeKind(prop);
        if (kind === 'binding' || kind === 'xbind' || prop.binding) { return false; }
        return sourceIsSetHere(prop.valueSource) || isAuthored(prop)
            || isEdited(payload.handle, prop.name);
    }

    /**
     * Re-reads open binding and resource cards whose property changed in a reload.
     * Unchanged ones keep their diagnosis and any pending Restore confirmation.
     */
    function refreshOpenDiagnostics(previousProps) {
        const payload = state.properties;
        if (!payload || !payload.handle) { return; }
        const before = new Map((previousProps || []).map(p => [p.name, p]));
        for (const prop of payload.props || []) {
            const old = before.get(prop.name);
            if (old && old.value === prop.value && old.valueSource === prop.valueSource) { continue; }
            if (state.restoreConfirm === prop.name) { state.restoreConfirm = null; }
            if (!state.openProps.has(prop.name)) {
                delete state.bindings[prop.name];
                delete state.resources[prop.name];
                continue;
            }
            if (wantsDiagnosis(prop)) {
                vscode.postMessage({ type: 'diagnoseBinding', handle: payload.handle, name: prop.name });
            }
            if (isResourceAuthored(prop)) {
                vscode.postMessage({ type: 'resolveResource', handle: payload.handle, name: prop.name });
            }
        }
    }

    /** A live write took over an authored binding, so only Restore binding applies. */
    function bindingReplaced(prop) {
        return (prop.authoredKind === 'binding' || prop.authoredKind === 'xBind')
            && prop.valueSource === 'DevTools';
    }

    /** A rejected first write changed nothing, so it must not leave an EDITED marker. */
    function forgetRejectedEdit(handle, name) {
        const payload = state.properties;
        if (!payload || payload.handle !== handle) { return; }
        const prop = (payload.props || []).find(p => p.name === name);
        if (prop && prop.valueSource === 'DevTools') { return; }
        delete state.edited[editKey(handle, name)];
        renderProperties();
    }

    /** A property back on its live or compiled binding no longer carries our edit, so forget it. */
    function dropRestoredBindingEdits(handle, props) {
        for (const prop of props || []) {
            const bound = prop.binding || prop.authoredKind === 'binding' || prop.authoredKind === 'xBind';
            if (!bound || prop.valueSource === 'DevTools') { continue; }
            // A kind applied without a write yet is the user's choice, not a restored edit.
            if (!state.edited[editKey(handle, prop.name)]) { continue; }
            delete state.edited[editKey(handle, prop.name)];
            delete state.applied[prop.name];
        }
    }

    /** Diagnosing also captures the binding for Restore, so a replaced one is skipped. */
    function wantsDiagnosis(prop) {
        return !!prop.binding && !bindingReplaced(prop);
    }

    function togglePropExpand(prop, payload) {
        const key = rowKey(prop);
        // The header is rebuilt, so keyboard focus is put back on it rather than lost to the page.
        const hadFocus = el.propsViewport.contains(document.activeElement);
        const refocus = function () {
            if (!hadFocus) { return; }
            const rows = el.propsViewport.querySelectorAll('.prow');
            for (const row of Array.from(rows)) {
                if (row.dataset.prop !== key) { continue; }
                const button = row.querySelector('.pvalue');
                if (button) { button.focus(); }
                return;
            }
        };
        if (state.openProps.has(key)) {
            state.openProps.delete(key);
        } else {
            state.openProps.add(key);
            // Sub-property rows are read-only; the engine cannot address them by path.
            if (prop.parent) { renderProperties(); refocus(); return; }
            // Binding diagnosis is expensive and needs the managed agent, so it
            // is requested only when the card is actually opened.
            if (wantsDiagnosis(prop) && !state.bindings[prop.name]) {
                vscode.postMessage({
                    type: 'diagnoseBinding',
                    handle: payload.handle,
                    name: prop.name,
                });
            }
            if (isResourceAuthored(prop) && !state.resources[prop.name]) {
                vscode.postMessage({
                    type: 'resolveResource',
                    handle: payload.handle,
                    name: prop.name,
                });
            }
        }
        renderProperties();
        refocus();
    }

    /**
     * A Clear value that put the app back on the value it started with is no
     * longer a change. Only judged once the clear has landed (the value source
     * moved), so a poll racing the write cannot drop a real edit's marker.
     */
    function dropSettledEdits(handle, props) {
        for (const prop of props || []) {
            const key = editKey(handle, prop.name);
            if (!Object.prototype.hasOwnProperty.call(state.clearing, key)) { continue; }
            if (prop.valueSource === state.clearing[key]) { continue; }
            delete state.clearing[key];
            const record = state.edited[key];
            if (record && String(prop.value) === String(record.value)) { delete state.edited[key]; }
        }
    }

    /** The kinds the native KIND dropdown can offer for a given property. */
    function kindsFor(prop) {
        const kinds = [];
        const type = (prop.valueType || prop.writeType || '').toLowerCase();
        // The engine names the authored markup, so trust it rather than
        // guessing a binding from the value type.
        if (prop.authoredKind === 'xBind') { kinds.push('xbind'); }
        if (prop.enumValues && prop.enumValues.length) { kinds.push('enum'); }
        if (type.indexOf('boolean') !== -1) { kinds.push('bool'); }
        if (type.indexOf('brush') !== -1 || type.indexOf('color') !== -1) { kinds.push('color'); }
        if (fieldNamesFor(prop)) { kinds.push('fields'); }
        kinds.push('text');
        // The RPC cannot assign a resource or install a binding, so these kinds only describe authored ones.
        if (isResourceAuthored(prop)) { kinds.push('resource'); }
        if (prop.binding || prop.valueSource === 'Binding' || prop.authoredKind === 'binding') { kinds.push('binding'); }
        return kinds;
    }

    /** The markup the app authored, parsed back into path and mode. */
    function authoredPath(prop) {
        if (prop.authoredKey) { return prop.authoredKey; }
        const markup = prop.authored || prop.binding || '';
        const named = /Path\\s*=\\s*([^,}\\s]+)/.exec(markup);
        if (named) { return named[1]; }
        const first = /^\\{\\s*(?:x:)?Bind(?:ing)?\\s+([^,=}\\s]+)\\s*[,}]/.exec(markup);
        return first ? first[1] : '';
    }

    function authoredMode(prop) {
        const match = /Mode\\s*=\\s*([A-Za-z]+)/.exec(prop.authored || prop.binding || '');
        return match ? match[1] : '';
    }

    const KIND_LABELS = {
        text: 'Text',
        bool: 'True / False',
        enum: 'One of a set',
        color: 'Color',
        fields: 'Separate fields',
        resource: 'A resource key',
        binding: 'A binding',
        xbind: 'An x:Bind expression',
    };

    /** Comma-grouped values (Thickness, Point, GridLength) get per-field boxes. */
    function fieldNamesFor(prop) {
        if (prop.fields && prop.fields.length) { return prop.fields; }
        const type = (prop.valueType || '').toLowerCase();
        if (type.indexOf('thickness') !== -1) { return ['Left', 'Top', 'Right', 'Bottom']; }
        if (type.indexOf('cornerradius') !== -1) { return ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft']; }
        if (type.indexOf('point') !== -1 || type.indexOf('size') !== -1) { return ['X', 'Y']; }
        return null;
    }

    function activeKind(prop) {
        const staged = state.staged[prop.name];
        if (staged) { return staged.kind; }
        if (state.applied[prop.name]) { return state.applied[prop.name]; }
        return currentKind(prop);
    }

    /** What the value is now, as the native window reports it; a live write makes it a literal. */
    function currentKind(prop) {
        const kinds = kindsFor(prop);
        if (prop.valueSource === 'DevTools') {
            return kinds.find(function (k) { return k !== 'xbind' && k !== 'binding' && k !== 'resource'; }) || 'text';
        }
        if (prop.authoredKind === 'xBind') { return 'xbind'; }
        if (prop.binding || prop.valueSource === 'Binding' || prop.authoredKind === 'binding') { return 'binding'; }
        if (isResourceAuthored(prop)) { return 'resource'; }
        return kinds[0];
    }

    function caption(text, spaced) {
        const div = document.createElement('div');
        div.className = 'pcap' + (spaced ? ' spaced' : '');
        div.textContent = text;
        return div;
    }

    function note(text) {
        const div = document.createElement('div');
        div.className = 'pnote';
        div.textContent = text;
        return div;
    }
`;
